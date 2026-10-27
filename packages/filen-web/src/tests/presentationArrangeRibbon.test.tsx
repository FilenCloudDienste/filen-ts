// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type ShapeLocks, type Xfrm } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, type ShapeSelection } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { actionOfChoice, arrangeGroups } from "@/features/presentation/components/ribbon/arrange"
import type { PresentationRibbonContext } from "@/features/presentation/components/ribbon/tabs"
import { PRESENTATION_OBJECT_ACTIONS, presentationObjectBindings } from "@/features/presentation/lib/keymap/objects"
import "@/lib/i18n"

// The Arrange tab's groups against a fake editor: each command runs as the one op its button names, on the
// shapes selected on the slide in view, and turns off where it cannot apply.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const EMU = 9525
const ref = slideRef(256)
const box = (x: number, y: number): Xfrm => ({ x: x * EMU, y: y * EMU, cx: 100 * EMU, cy: 50 * EMU, rot: 0, flipH: false, flipV: false })

function renderOf(roles: readonly SlideLayer["role"][], locks: Readonly<Record<number, ShapeLocks>> = {}): SlideRender {
	const layers = roles.map(
		(role, index) =>
			({
				shape: { slide: ref, id: index + 2 },
				role,
				drawing: {},
				matrix: [1, 0, 0, 1, 0, 0],
				box: {
					id: index + 2,
					xfrm: box(index * 150, 10),
					...(index === 0 ? { alt: { descr: "Logo" } } : {}),
					...(locks[index + 2] === undefined ? {} : { locks: locks[index + 2] })
				},
				...(index === 1 ? { actions: { click: { kind: "refused", what: "macro", raw: "macro?name=x" } } } : {})
			}) as unknown as SlideLayer
	)

	return { ref, index: 0, revision: 1, hidden: false, background: {}, layers, notesText: "", animated: false } as unknown as SlideRender
}

const INFO = {
	slides: [
		{ ref, hidden: false },
		{ ref: slideRef(257), hidden: false }
	],
	size: { cx: 960 * EMU, cy: 540 * EMU },
	customShows: [],
	editable: true
} as unknown as OpenInfo

let ops: DeckOp[]

function mount(
	roles: readonly SlideLayer["role"][],
	selected: readonly number[],
	locks: Readonly<Record<number, ShapeLocks>> = {}
): ShapeSelection {
	const selection = createShapeSelection()

	selection.show(ref)
	selection.set(selected)
	ops = []

	const context: PresentationRibbonContext = {
		editable: true,
		phone: false,
		selection: new Set(),
		t: i18n.t.bind(i18n),
		editor: {
			info: INFO,
			render: renderOf(roles, locks),
			selection,
			// Arrange never calls the session directly; every command goes through `command`.
			session: {} as PresentationSessionApi,
			command: (op: DeckOp): Promise<CommandResult> => {
				ops.push(op)

				return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
			}
		}
	}

	render(
		<OfficeRibbon
			label="Ribbon"
			commandsLabel="Commands"
			tabs={[{ id: "arrange", label: "Arrange" }]}
			tab="arrange"
			onTab={() => undefined}
			file={null}
			groups={arrangeGroups(context)}
		/>
	)

	return selection
}

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

async function menuItem(trigger: string, item: string): Promise<void> {
	fireEvent.click(within(commands()).getByRole("button", { name: trigger }))
	fireEvent.click(await screen.findByRole("menuitem", { name: item }))
}

describe("presentation Arrange tab", () => {
	it("shows its groups in order, none without an editor", () => {
		mount(["shape", "shape"], [2])

		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Order", "Group", "Align", "Rotate", "Object"])
		expect(arrangeGroups({ editable: true, phone: false, selection: new Set(), t: i18n.t.bind(i18n) })).toEqual([])
	})

	it("brings the selection forward and groups two shapes, selecting the group the next render has", async () => {
		const selection = mount(["shape", "shape", "picture"], [2, 3])

		await menuItem("Bring forward", "Bring to front")
		expect(ops).toEqual([{ family: "shape", kind: "zOrder", slide: ref, shapes: [2, 3], to: "front" }])

		fireEvent.click(within(commands()).getByRole("button", { name: "Group" }))
		expect(ops[1]).toEqual({ family: "shape", kind: "group", slide: ref, shapes: [2, 3] })
		expect(selection.getSnapshot().pending?.before).toEqual(new Set([2, 3, 4]))
		expect(within(commands()).getByRole<HTMLButtonElement>("button", { name: "Ungroup" }).disabled).toBe(true)
	})

	it("aligns a single selected shape to the slide", async () => {
		mount(["shape", "shape"], [2])

		await menuItem("Align", "Align left")
		expect(ops).toEqual([{ family: "shape", kind: "align", slide: ref, shapes: [2], edge: "left", relativeTo: "slide" }])
	})

	it("leaves shapes the file locks against moving out of Align", async () => {
		mount(["shape", "shape", "shape"], [2, 3, 4], { 3: { noMove: true } })

		await menuItem("Align", "Align left")
		expect(ops).toEqual([{ family: "shape", kind: "align", slide: ref, shapes: [2, 4], edge: "left", relativeTo: "selection" }])
	})

	it("ungroups every selected group as one op", () => {
		mount(["group", "group", "shape"], [2, 3])

		fireEvent.click(within(commands()).getByRole("button", { name: "Ungroup" }))
		expect(ops).toEqual([
			{
				family: "batch",
				kind: "batch",
				ops: [
					{ family: "shape", kind: "ungroup", slide: ref, group: 2 },
					{ family: "shape", kind: "ungroup", slide: ref, group: 3 }
				]
			}
		])
	})

	it("rotates and flips the selection", async () => {
		mount(["shape"], [2])

		await menuItem("Rotate", "Flip horizontal")
		expect(ops[0]).toMatchObject({ family: "shape", kind: "setXfrm", target: { slide: ref, id: 2 }, xfrm: { flipH: true } })
	})

	it("edits alt text in its dialog", async () => {
		mount(["picture", "shape"], [2])

		fireEvent.click(within(commands()).getByRole("button", { name: "Alt text…" }))

		const dialog = await screen.findByRole("dialog", { name: "Alt text" })
		const description = within(dialog).getByRole("textbox", { name: "Description" })

		expect((description as HTMLInputElement).value).toBe("Logo")
		fireEvent.change(description, { target: { value: "Company logo" } })
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))

		await waitFor(() => {
			expect(ops).toEqual([{ family: "shape", kind: "setAlt", target: { slide: ref, id: 2 }, alt: { descr: "Company logo" } }])
		})
	})

	it("shows a refused action's reason and keeps it unless another is chosen", async () => {
		mount(["shape", "shape"], [3])

		fireEvent.click(within(commands()).getByRole("button", { name: "Action…" }))

		const dialog = await screen.findByRole("dialog", { name: "Action" })

		expect(dialog.textContent).toContain("a macro")

		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
			await Promise.resolve()
		})
		expect(ops).toEqual([])
	})

	it("builds only http, https and mailto links, and slide jumps to slides the deck has", () => {
		const fields = { slide: String(slideRef(257)), url: "", show: "", returnAfter: false }

		expect(actionOfChoice("url", { ...fields, url: "https://filen.io" }, [ref])).toEqual({ kind: "url", href: "https://filen.io" })
		expect(actionOfChoice("url", { ...fields, url: "javascript:alert(1)" }, [ref])).toBeNull()
		// A link with spaces is stored as the save reads it back; one with a space in its host is no link.
		expect(actionOfChoice("url", { ...fields, url: " https://example.com/my file.pdf " }, [ref])).toEqual({
			kind: "url",
			href: "https://example.com/my%20file.pdf"
		})
		expect(actionOfChoice("url", { ...fields, url: "https://exa mple.com/" }, [ref])).toBeNull()
		expect(actionOfChoice("url", { ...fields, url: "file:///etc/passwd" }, [ref])).toBeNull()
		expect(actionOfChoice("slide", fields, [ref, slideRef(257)])).toEqual({ kind: "slide", slide: slideRef(257) })
		expect(actionOfChoice("slide", fields, [ref])).toBeNull()
		expect(actionOfChoice("none", fields, [ref])).toBeUndefined()
		expect(actionOfChoice("next", fields, [ref])).toEqual({ kind: "internal", jump: "next" })
	})

	it("binds every rebindable canvas command from the keymap list", () => {
		const bindings = presentationObjectBindings()

		expect(Object.keys(bindings).sort()).toEqual(
			["bringForward", "bringToFront", "group", "selectAll", "sendBackward", "sendToBack", "ungroup"].sort()
		)
		expect(PRESENTATION_OBJECT_ACTIONS.map(action => action.id.replace("presentation.objects.", "")).sort()).toEqual(
			Object.keys(bindings).sort()
		)
		expect(presentationObjectBindings((id, fallback) => (id.endsWith("group") ? "alt+g" : fallback)).group).toBe("alt+g")
	})
})
