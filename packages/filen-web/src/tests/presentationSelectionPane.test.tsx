// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type OutlineShape, type SlideOutline } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, type ShapeSelection } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { SelectionPane } from "@/features/presentation/components/selectionPane"
import { arrangeGroups } from "@/features/presentation/components/ribbon/arrange"
import { homeArrangeGroups } from "@/features/presentation/components/ribbon/homeArrange"
import type { PresentationRibbonContext, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { PresentationEditorContext, type PresentationEditorScope } from "@/features/presentation/hooks/usePresentationSession"
import { presentationEditorKey } from "@/features/presentation/lib/keymap/editor"
import { createSelectionPane, stableOutline, type SelectionPaneStore } from "@/features/presentation/lib/selectionPane"
import { previewPptxArrange } from "@/locales/en/previewPptx/arrange"
import { clearUserCombo, setUserCombo } from "@/lib/keymap/registry"
import { registerAllActions } from "@/lib/keymap/actions"
import "@/lib/i18n"

// The Selection Pane: the slide's objects front-most first with groups' members under them, read once per render of
// the slide while the pane is open; a row's click selects on the slide, its eye hides or shows, F2 or a double-click
// renames, Show All / Hide All and the arrows act on the slide, a drag restacks, and PowerPoint's keys work in the list.

i18n.addResourceBundle("en", "preview", previewPptxArrange, true, false)

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

registerAllActions()

const ref = slideRef(256)
const INFO = { format: "pptx", slides: [{ ref, hidden: false }], size: { cx: 9144000, cy: 5143500 }, editable: true } as unknown as OpenInfo

const SHAPES: readonly OutlineShape[] = [
	{ id: 2, name: "Title 1", hidden: false, role: "placeholder" },
	{ id: 3, name: "Box A", hidden: false, role: "shape" },
	{ id: 4, name: "Box B", hidden: true, role: "shape" },
	{
		id: 6,
		name: "Group 5",
		hidden: false,
		role: "group",
		children: [
			{ id: 7, name: "Inner 1", hidden: false, role: "shape" },
			{ id: 8, name: "Inner 2", hidden: false, role: "shape" }
		]
	},
	{ id: 9, name: "", hidden: false, role: "picture" }
]

function renderOf(revision: number): SlideRender {
	return { ref, index: 0, revision, hidden: false, background: {}, layers: [], notesText: "", animated: false } as unknown as SlideRender
}

let ops: DeckOp[]
let shapes: readonly OutlineShape[]
const outline = vi.fn((slide: number) => Promise.resolve<SlideOutline>({ slide: slide as never, revision: 1, shapes }))

interface Mounted {
	readonly store: SelectionPaneStore
	readonly selection: ShapeSelection
	readonly left: { count: number }
	rerender(revision: number): void
}

function mount(editable = true): Mounted {
	const selection = createShapeSelection()
	const store = createSelectionPane()
	const session = { outline } as unknown as PresentationSessionApi
	const left = { count: 0 }

	selection.show(ref)
	store.setOpen(true)
	ops = []

	const editorAt = (revision: number): PresentationRibbonEditor => ({
		info: INFO,
		render: renderOf(revision),
		selection,
		session,
		command: (op: DeckOp): Promise<CommandResult> => {
			ops.push(op)

			return Promise.resolve({ ok: true, revision: ops.length + 1, dirty: true })
		}
	})
	const pane = (revision: number) => (
		<SelectionPane
			editor={editorAt(revision)}
			store={store}
			editable={editable}
			phone={false}
			onLeave={() => {
				left.count++
			}}
		/>
	)
	const view = render(pane(1))

	return {
		store,
		selection,
		left,
		rerender: revision => {
			view.rerender(pane(revision))
		}
	}
}

// A drag event at a pointer height (the test DOM's drag events carry no pointer position of their own).
function at(event: Event, clientY: number): Event {
	Object.defineProperty(event, "clientY", { value: clientY })

	return event
}

const tree = () => screen.getByRole("tree")
const row = (name: string | RegExp): HTMLElement => within(tree()).getByRole("treeitem", { name })
const names = (): string[] =>
	within(tree())
		.getAllByRole("treeitem")
		.map(item => item.getAttribute("aria-label") ?? "")

beforeEach(() => {
	shapes = SHAPES
	outline.mockClear()
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe("the Selection Pane", () => {
	it("lists the front-most first, members under their group, an unnamed object by what it is, a hidden one said so", async () => {
		mount()

		await waitFor(() => {
			expect(names()).toEqual(["Picture 9", "Group 5", "Inner 2", "Inner 1", "Box B, hidden", "Box A", "Title 1"])
		})
		expect(row("Group 5").getAttribute("aria-expanded")).toBe("true")
		expect(row("Inner 2").getAttribute("aria-level")).toBe("2")
		expect(screen.getByRole("heading", { name: "Selection" })).toBeDefined()
	})

	it("describes its keys in this platform's spelling, the stacking ones as bound", async () => {
		mount()

		await waitFor(() => {
			expect(names().length).toBeGreaterThan(0)
		})

		const help = document.getElementById(tree().getAttribute("aria-describedby") ?? "")?.textContent ?? ""

		// Off a Mac, Mod is Ctrl; nothing is left hardcoded for a Mac's Command.
		expect(help).toContain("Space selects, Ctrl+Space adds to the selection.")
		expect(help).toContain("F2 renames, Ctrl+Shift+S shows or hides")
		expect(help).not.toContain("{{")
	})

	it("is asked again only for a new render of the slide, and not at all while closed", async () => {
		const m = mount()

		await waitFor(() => {
			expect(outline).toHaveBeenCalledTimes(1)
		})
		m.rerender(1)
		expect(outline).toHaveBeenCalledTimes(1)

		shapes = SHAPES.map(shape => (shape.id === 4 ? { ...shape, hidden: false } : shape))
		m.rerender(2)
		await waitFor(() => {
			expect(names()).toContain("Box B")
		})
		expect(outline).toHaveBeenCalledTimes(2)

		act(() => {
			m.store.setOpen(false)
		})
		m.rerender(3)
		expect(outline).toHaveBeenCalledTimes(2)
		expect(screen.queryByRole("tree")).toBeNull()
	})

	it("a click selects on the slide, Ctrl adds an object of the same level, a hidden one is chosen in the pane only", async () => {
		const m = mount()

		fireEvent.click(await screen.findByRole("treeitem", { name: "Box A" }))
		expect(m.selection.getSnapshot().ids).toEqual([3])
		fireEvent.click(row("Title 1"), { ctrlKey: true })
		expect(m.selection.getSnapshot().ids).toEqual([3, 2])
		expect(row("Title 1").getAttribute("aria-selected")).toBe("true")
		// A member with Ctrl is not of the selection's level: it is selected alone.
		fireEvent.click(row("Inner 1"), { ctrlKey: true })
		expect(m.selection.getSnapshot().ids).toEqual([7])
		fireEvent.click(row("Box B, hidden"))
		expect(m.selection.getSnapshot().ids).toEqual([])
		expect(row("Box B, hidden").getAttribute("aria-selected")).toBe("true")
		// The slide's selection changed elsewhere: the pane's hidden choice goes.
		act(() => {
			m.selection.set([9])
		})
		expect(row("Box B, hidden").getAttribute("aria-selected")).toBe("false")
		expect(row("Picture 9").getAttribute("aria-selected")).toBe("true")
	})

	it("Shift selects the range of a level", async () => {
		const m = mount()

		fireEvent.click(await screen.findByRole("treeitem", { name: "Picture 9" }))
		fireEvent.click(row("Box A"), { shiftKey: true })
		// Picture 9, Group 5 and Box A are drawn; Box B is hidden (held by the pane); the group's members are another level.
		expect(m.selection.getSnapshot().ids).toEqual([9, 6, 3])
		expect(row("Box B, hidden").getAttribute("aria-selected")).toBe("true")
		expect(row("Inner 1").getAttribute("aria-selected")).toBe("false")
	})

	it("the eye hides and shows one object; Show All and Hide All the whole slide", async () => {
		mount()

		fireEvent.click(await screen.findByRole("button", { name: "Hide Box A" }))
		fireEvent.click(screen.getByRole("button", { name: "Show Box B" }))
		fireEvent.click(screen.getByRole("button", { name: "Show All" }))
		fireEvent.click(screen.getByRole("button", { name: "Hide All" }))
		expect(ops).toEqual([
			{ family: "shape", kind: "setHidden", slide: ref, shapes: [3], hidden: true },
			{ family: "shape", kind: "setHidden", slide: ref, shapes: [4], hidden: false },
			{ family: "shape", kind: "setHidden", slide: ref, shapes: [4], hidden: false },
			{ family: "shape", kind: "setHidden", slide: ref, shapes: [2, 3, 6, 7, 8, 9], hidden: true }
		])
	})

	it("F2 and a double-click rename; Enter keeps the new name, Escape the old one", async () => {
		mount()

		const box = await screen.findByRole("treeitem", { name: "Box A" })

		box.focus()
		fireEvent.keyDown(box, { key: "F2" })

		const field = screen.getByRole("textbox", { name: "Name of Box A" })

		fireEvent.change(field, { target: { value: "  Logo " } })
		fireEvent.keyDown(field, { key: "Enter" })
		expect(ops).toEqual([{ family: "shape", kind: "setName", target: { slide: ref, id: 3 }, name: "Logo" }])

		fireEvent.doubleClick(row("Title 1"))

		const other = screen.getByRole("textbox", { name: "Name of Title 1" })

		fireEvent.change(other, { target: { value: "Heading" } })
		fireEvent.keyDown(other, { key: "Escape" })
		expect(screen.queryByRole("textbox")).toBeNull()
		expect(ops).toHaveLength(1)
	})

	it("PowerPoint's keys: arrows move, Left and Right collapse and expand, Space selects, Ctrl+Shift+S, F and B act", async () => {
		const m = mount()

		const top = await screen.findByRole("treeitem", { name: "Picture 9" })

		top.focus()
		fireEvent.keyDown(top, { key: "ArrowDown" })
		await waitFor(() => {
			expect(document.activeElement).toBe(row("Group 5"))
		})
		fireEvent.keyDown(row("Group 5"), { key: "ArrowLeft" })
		expect(row("Group 5").getAttribute("aria-expanded")).toBe("false")
		expect(names()).not.toContain("Inner 1")
		fireEvent.keyDown(row("Group 5"), { key: "ArrowRight" })
		expect(names()).toContain("Inner 1")
		fireEvent.keyDown(row("Group 5"), { key: "ArrowRight" })
		await waitFor(() => {
			expect(document.activeElement).toBe(row("Inner 2"))
		})
		fireEvent.keyDown(row("Inner 2"), { key: "ArrowLeft" })
		await waitFor(() => {
			expect(document.activeElement).toBe(row("Group 5"))
		})
		fireEvent.keyDown(row("Group 5"), { key: "ArrowDown" })
		fireEvent.keyDown(row("Inner 2"), { key: "ArrowDown" })
		fireEvent.keyDown(row("Inner 1"), { key: "ArrowDown" })
		fireEvent.keyDown(row("Box B, hidden"), { key: "ArrowDown" })
		fireEvent.keyDown(row("Box A"), { key: " " })
		expect(m.selection.getSnapshot().ids).toEqual([3])
		fireEvent.keyDown(row("Box A"), { key: "s", code: "KeyS", ctrlKey: true, shiftKey: true })
		fireEvent.keyDown(row("Box A"), { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true })
		// The slide's own bring forward key restacks here too.
		fireEvent.keyDown(row("Box A"), { key: "]", code: "BracketRight", ctrlKey: true })
		expect(ops).toEqual([
			{ family: "shape", kind: "setHidden", slide: ref, shapes: [3], hidden: true },
			{ family: "shape", kind: "zOrder", slide: ref, shapes: [3], to: "forward" },
			{ family: "shape", kind: "zOrder", slide: ref, shapes: [3], to: "forward" }
		])
		fireEvent.keyDown(row("Box A"), { key: "Escape" })
		expect(m.left.count).toBe(1)
	})

	it("restacks on the keys the user moved the object actions to, and no longer on the old ones", async () => {
		const m = mount()

		await screen.findByRole("tree")
		act(() => {
			m.selection.set([3])
		})
		await act(() => setUserCombo("presentation.objects.bringForward", "alt+shift+f"))
		fireEvent.keyDown(row("Box A"), { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true })
		fireEvent.keyDown(row("Box A"), { key: "]", code: "BracketRight", ctrlKey: true })
		expect(ops).toEqual([])
		fireEvent.keyDown(row("Box A"), { key: "F", code: "KeyF", altKey: true, shiftKey: true })
		expect(ops).toEqual([{ family: "shape", kind: "zOrder", slide: ref, shapes: [3], to: "forward" }])
		await act(() => clearUserCombo("presentation.objects.bringForward"))
	})

	it("the arrows are offered while the chosen objects can move that way", async () => {
		const m = mount()

		await screen.findByRole("tree")
		act(() => {
			m.selection.set([9])
		})
		expect(screen.getByRole("button", { name: "Bring forward" }).hasAttribute("disabled")).toBe(true)
		fireEvent.click(screen.getByRole("button", { name: "Send backward" }))
		expect(ops).toEqual([{ family: "shape", kind: "zOrder", slide: ref, shapes: [9], to: "backward" }])
	})

	it("a row dragged above another of its level restacks in front of it; onto another level it does not", async () => {
		mount()

		const transfer = { setData: vi.fn(), getData: vi.fn(), types: [], effectAllowed: "", dropEffect: "" }

		// Every row 100 px down, 28 px tall: a pointer at its top half drops above it.
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 100, height: 28 } as DOMRect)

		fireEvent.dragStart(await screen.findByRole("treeitem", { name: "Title 1" }), { dataTransfer: transfer })
		fireEvent(row("Box A"), at(createEvent.dragOver(row("Box A"), { dataTransfer: transfer }), 101))
		expect(row("Box A").getAttribute("data-drop")).toBe("above")
		fireEvent(row("Box A"), at(createEvent.drop(row("Box A"), { dataTransfer: transfer }), 101))
		expect(ops).toEqual([{ family: "shape", kind: "zOrder", slide: ref, shapes: [2], to: 1 }])

		fireEvent.dragStart(row("Title 1"), { dataTransfer: transfer })
		fireEvent(row("Inner 1"), at(createEvent.drop(row("Inner 1"), { dataTransfer: transfer }), 101))
		expect(ops).toHaveLength(1)
	})

	it("in a deck that can only be viewed it lists, but changes nothing", async () => {
		mount(false)

		await screen.findByRole("tree")
		expect(screen.getByRole("button", { name: "Hide Box A" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Show All" }).hasAttribute("disabled")).toBe(true)
		expect(row("Box A").getAttribute("draggable")).toBe("false")
		fireEvent.keyDown(row("Box A"), { key: "F2" })
		expect(screen.queryByRole("textbox")).toBeNull()
	})
})

describe("the Selection Pane's state", () => {
	it("keeps the objects an answer did not change, so their rows are not drawn again", () => {
		const next = SHAPES.map(shape => ({
			...shape,
			...(shape.children === undefined ? {} : { children: shape.children.map(c => ({ ...c })) })
		}))

		expect(stableOutline(SHAPES, next)).toBe(SHAPES)

		const renamed = next.map(shape => (shape.id === 3 ? { ...shape, name: "Logo" } : shape))
		const kept = stableOutline(SHAPES, renamed)

		expect(kept).not.toBe(SHAPES)
		expect(kept[0]).toBe(SHAPES[0])
		expect(kept[3]).toBe(SHAPES[3])
		expect(kept[1]?.name).toBe("Logo")
	})

	it("asks nothing while closed and forgets the list when closed", async () => {
		const store = createSelectionPane()
		const session = { outline } as unknown as PresentationSessionApi

		store.request(session, ref, 1)
		expect(outline).not.toHaveBeenCalled()
		store.setOpen(true)
		store.request(session, ref, 1)
		store.request(session, ref, 1)
		expect(outline).toHaveBeenCalledTimes(1)
		await waitFor(() => {
			expect(store.getSnapshot().outline?.shapes).toBe(SHAPES)
		})
		store.setOpen(false)
		expect(store.getSnapshot().outline).toBeUndefined()
	})

	it("Alt+F10 is the Selection Pane's key", () => {
		const key = { key: "F10", code: "F10", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true }

		expect(presentationEditorKey(key, {}, false)).toBe("presentation.selectionPane")
		expect(presentationEditorKey(key, {}, true)).toBe("presentation.selectionPane")
		expect(presentationEditorKey({ ...key, altKey: false }, {}, false)).toBeUndefined()
	})
})

describe("the Selection Pane's ribbon entries", () => {
	function ribbon(groups: typeof arrangeGroups, tab: string, store: SelectionPaneStore): ShapeSelection {
		const selection = createShapeSelection()

		selection.show(ref)
		ops = []

		const context: PresentationRibbonContext = {
			editable: true,
			phone: false,
			selection: new Set(),
			t: i18n.t.bind(i18n),
			editor: {
				info: INFO,
				render: renderOf(1),
				selection,
				session: {} as PresentationSessionApi,
				command: (op: DeckOp): Promise<CommandResult> => {
					ops.push(op)

					return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
				}
			}
		}

		render(
			<PresentationEditorContext value={{ selectionPane: store } as unknown as PresentationEditorScope}>
				<OfficeRibbon
					label="Ribbon"
					commandsLabel="Commands"
					tabs={[{ id: tab, label: tab }]}
					tab={tab}
					onTab={() => undefined}
					file={null}
					groups={groups(context)}
				/>
			</PresentationEditorContext>
		)

		return selection
	}

	const commands = (): HTMLElement => screen.getByRole("toolbar", { name: "Commands" })

	it("Home ▸ Arrange holds Order Objects, Group Objects and the Selection Pane, which opens and closes it", async () => {
		const store = createSelectionPane()

		ribbon(homeArrangeGroups, "home", store)
		fireEvent.click(within(commands()).getByRole("button", { name: "Arrange" }))
		expect(await screen.findByRole("menuitem", { name: "Bring to front" })).toBeDefined()
		expect(screen.getByRole("menuitem", { name: "Group" })).toBeDefined()
		fireEvent.click(screen.getByRole("menuitem", { name: "Selection Pane" }))
		expect(store.getSnapshot().open).toBe(true)
	})

	it("the Arrange tab's Selection Pane button toggles the pane and shows it pressed", () => {
		const store = createSelectionPane()

		ribbon(arrangeGroups, "arrange", store)

		const button = within(commands()).getByRole("button", { name: "Selection Pane" })

		fireEvent.click(button)
		expect(store.getSnapshot().open).toBe(true)
		expect(within(commands()).getByRole("button", { name: "Selection Pane" }).getAttribute("aria-pressed")).toBe("true")
		fireEvent.click(within(commands()).getByRole("button", { name: "Selection Pane" }))
		expect(store.getSnapshot().open).toBe(false)
	})
})
