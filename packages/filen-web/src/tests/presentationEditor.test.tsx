// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor, within } from "@testing-library/react"
import { createRef, type ReactElement } from "react"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import type { DeckOp } from "@filen/office/core/presentation"
import type {
	CommandResult,
	OpenInfo,
	PresentationEvent,
	PresentationOpenOptions,
	PresentationSessionApi,
	SaveResult,
	SlideRender,
	SourceSpec
} from "@filen/office/dom/presentation"
import type { PresentationConnection } from "@filen/office/react/presentation"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import type { PresentationSaveSource } from "@/features/drive/lib/previewSave.logic"
import type { PresentationEditing } from "@/features/presentation/hooks/usePresentationSession"

// The presentation editor around an open deck: its ribbon (the tabs that have groups, Home's groups in order, the
// reduced set of a deck that can only be viewed), the slide commands from the ribbon, the slide list's keys, menu and
// section headers, the save state, the File menu and the overlay's save source.

interface FakeEngine {
	listener: ((event: PresentationEvent) => void) | null
	opens: { source: SourceSpec; options: PresentationOpenOptions }[]
	commands: DeckOp[]
	answer: CommandResult
	steps: string[]
	saves: { reason: string }[]
}

// Typing in an open body the worker has not answered yet, as the text store reports it; the commands the shell sent
// through the text store and the link-key listeners registered on it; the props the open body's editor was given; the
// user's keymap overrides.
interface Typing {
	pending: boolean
	notify: () => void
	commands: unknown[]
	linkListeners: number
	editorProps: Record<string, unknown>[]
	overrides: Record<string, string>
	// A body open in the text editor, as the store reports it (a test's stand-in controller).
	active?: unknown
}

const { sdk, engine, settings, toasts, typing } = vi.hoisted(() => ({
	typing: ((): Typing => ({ pending: false, notify: () => undefined, commands: [], linkListeners: 0, editorProps: [], overrides: {} }))(),
	sdk: {
		openRangePort: vi.fn(() => Promise.resolve()),
		openLinkedRangePortAnon: vi.fn(() => Promise.resolve()),
		cancelPreviewDownload: vi.fn(() => Promise.resolve())
	},
	engine: ((): FakeEngine => ({
		listener: null,
		opens: [],
		commands: [],
		answer: { ok: true, revision: 1, dirty: true },
		steps: [],
		saves: []
	}))(),
	settings: { loaded: true, autosave: true, authorName: null },
	toasts: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() }
}))

vi.mock("@/lib/keymap/registry", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/keymap/registry")>()),
	useOverrides: () => typing.overrides
}))
vi.mock("comlink", () => ({ transfer: (value: unknown) => value }))
vi.mock("sonner", () => ({ toast: toasts }))
vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))
vi.mock("@/features/office/lib/officeSettings", () => ({
	loadOfficeSettings: () => Promise.resolve(),
	useOfficeSettings: () => settings,
	saveOfficeAutosave: () => Promise.resolve()
}))
vi.mock("@filen/office/react/presentation", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/office/react/presentation")>().then(actual => ({
		...actual,
		createTextEditing: () => {
			const real = actual.createTextEditing()
			const listeners = new Set<() => void>()

			typing.notify = () => {
				for (const listener of listeners) listener()
			}

			return Object.create(real, {
				pending: { get: () => typing.pending || real.pending },
				active: { get: () => typing.active ?? real.active },
				command: {
					value: (op: unknown, session: Parameters<typeof real.command>[1]) => {
						typing.commands.push(op)

						return real.command(op as Parameters<typeof real.command>[0], session)
					}
				},
				onLinkRequest: {
					value: (listener: () => void) => {
						typing.linkListeners++

						const off = real.onLinkRequest(listener)

						return () => {
							typing.linkListeners--
							off()
						}
					}
				},
				subscribe: {
					value: (listener: () => void) => {
						listeners.add(listener)

						const off = real.subscribe(listener)

						return () => {
							listeners.delete(listener)
							off()
						}
					}
				}
			}) as typeof real
		}
	}))),
	// The selection layer and the text editor stand in: a button enters the first shape's text, the editor keeps its props.
	ShapeEditLayer: ({ onEnterText }: { onEnterText?: (shape: { slide: number; id: number }) => void }) => (
		<button
			type="button"
			onClick={() => onEnterText?.({ slide: 1, id: 4 })}
		>
			enter text
		</button>
	),
	PresentationTextEditor: (props: Record<string, unknown>) => {
		typing.editorProps.push(props)

		return null
	},
	paintSlide: (_render: unknown, context: { document: Document }) => ({
		root: context.document.createElement("div"),
		release: () => undefined
	})
}))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/features/presentation/lib/presentationEngine", () => ({
	presentationPool: {},
	connectPresentation: (
		_pool: unknown,
		source: SourceSpec,
		listener: (event: PresentationEvent) => void,
		options: PresentationOpenOptions
	): PresentationConnection => {
		engine.listener = listener
		engine.opens.push({ source, options })

		const session = {
			render: (refs: number[]) => Promise.resolve(refs.map(ref => slideRender(ref))),
			thumbnails: () => new Promise(() => undefined),
			image: () => Promise.resolve(null),
			command: (op: DeckOp) => {
				engine.commands.push(op)

				return Promise.resolve(engine.answer)
			},
			undo: () => {
				engine.steps.push("undo")

				return Promise.resolve({ ok: true, revision: 0, dirty: false })
			},
			redo: () => {
				engine.steps.push("redo")

				return Promise.resolve({ ok: true, revision: 1, dirty: true })
			},
			save: (options: { reason: string }) => {
				engine.saves.push({ reason: options.reason })

				return new Promise<SaveResult>(() => undefined)
			},
			close: () => undefined
		} as unknown as PresentationSessionApi

		return { session, unlock: () => undefined, dispose: () => undefined }
	}
}))

const { PresentationViewer } = await import("@/features/presentation/components/presentationViewer")
const { DEFAULT_OFFICE_VIEW_SETTINGS, setOfficeViewSettings } = await import("@/features/office/lib/officeViewSettings")

registerAllActions()

const UUID = "aaaaaaaa-0000-0000-0000-000000000078"
const LAYOUT_TITLE = 900
const LAYOUT_CONTENT = 901
const MASTER = 800

function slideRender(ref: number): SlideRender {
	return {
		ref,
		index: ref - 1,
		revision: 0,
		hidden: false,
		layout: ref === 1 ? LAYOUT_TITLE : LAYOUT_CONTENT,
		background: { width: 960, height: 540, itemCount: 0 },
		layers: [],
		notesText: "",
		animated: false
	} as unknown as SlideRender
}

function info(change: Partial<OpenInfo> = {}): OpenInfo {
	return {
		format: "pptx",
		variant: "pptx",
		slides: [
			{ ref: 1, hidden: false },
			{ ref: 2, hidden: false },
			{ ref: 3, hidden: false }
		],
		layouts: [
			{ ref: LAYOUT_TITLE, master: MASTER, type: "title", name: "Title Slide" },
			{ ref: LAYOUT_CONTENT, master: MASTER, type: "obj", name: "Title and Content" }
		],
		size: { cx: 12_192_000, cy: 6_858_000 },
		notesSize: { cx: 6_858_000, cy: 9_144_000 },
		sections: [],
		customShows: [],
		protection: { writeProtected: false, encrypted: false },
		gate: [],
		editable: true,
		locks: 0,
		packageBytes: 5000,
		source: "range",
		...change
	} as unknown as OpenInfo
}

function editing(change: Partial<PresentationEditing> = {}): PresentationEditing & { saveRef: { current: PresentationSaveSource | null } } {
	return {
		writable: true,
		renamed: false,
		onDirtyChange: vi.fn(),
		saveRef: createRef<PresentationSaveSource | null>(),
		onSave: vi.fn(() => true),
		onAutosave: vi.fn(() => true),
		...change
	}
}

function render(ui: ReactElement) {
	return renderUi(ui, { wrapper: queryClientWrapper(createTestQueryClient()) })
}

function emit(event: PresentationEvent): Promise<void> {
	return act(async () => {
		engine.listener?.(event)
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

async function openEditor(change: Partial<OpenInfo> = {}, edit = editing(), name = "deck.pptx", inOverlay = false) {
	const viewer = (
		<PresentationViewer
			item={linkedFileItem(name, {
				uuid: UUID,
				mime: { Decrypted: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
				size: 5000n
			})}
			alt={name}
			variant="drive"
			editing={edit}
		/>
	)

	// The preview overlay is itself an open dialog around the editor.
	render(
		inOverlay ? (
			<div
				role="dialog"
				data-open=""
			>
				{viewer}
			</div>
		) : (
			viewer
		)
	)
	await waitFor(() => {
		expect(engine.opens).toHaveLength(1)
	})
	await emit({ type: "opened", info: info(change) })
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})

	return edit
}

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

function rail(): HTMLElement {
	return screen.getByRole("listbox", { name: "Slides" })
}

afterEach(() => {
	typing.active = undefined
	cleanup()
	vi.clearAllMocks()
	engine.listener = null
	engine.opens = []
	engine.commands = []
	engine.steps = []
	engine.saves = []
	engine.answer = { ok: true, revision: 1, dirty: true }
	settings.autosave = true
	setOfficeViewSettings(DEFAULT_OFFICE_VIEW_SETTINGS)
	typing.pending = false
	typing.commands = []
	typing.editorProps = []
	typing.overrides = {}
})

describe("presentation editor ribbon", () => {
	it("opens an editable deck in the editor with the tabs that have commands, and Home's groups in order", async () => {
		await openEditor()

		expect(engine.opens[0]?.options.viewOnly).toBe(false)

		const tabs = screen.getAllByRole("tab").map(tab => tab.textContent)

		expect(tabs.slice(0, 2)).toEqual(["Home", "Insert"])
		expect(tabs).toContain("View")
		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
				.slice(0, 3)
		).toEqual(["Undo", "Clipboard", "Slides"])
		expect(screen.getByRole("button", { name: "File" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Present" })).toBeTruthy()
	})

	it("opens without the slide thumbnails or notes when this device's settings say so", async () => {
		// As read on this device during boot.
		setOfficeViewSettings({ slideRail: false, notesPane: false })
		await openEditor()

		expect(screen.queryByRole("listbox", { name: "Slides" })).toBeNull()
		expect(screen.queryByRole("textbox", { name: "Speaker notes" })).toBeNull()
	})

	it("shows a deck that can only be viewed with the reduced tabs, its reasons, and no save", async () => {
		await openEditor({ gate: ["signed"], editable: false })

		const tabs = screen.getAllByRole("tab").map(tab => tab.textContent)

		expect(tabs).not.toContain("Home")
		expect(tabs).not.toContain("Insert")
		expect(tabs).toContain("View")
		fireEvent.click(screen.getByRole("button", { name: "View only" }))
		expect(await screen.findByText("It's digitally signed; a change would break the signature.")).toBeTruthy()
		expect(screen.getByText("Read-only: this presentation is digitally signed, and editing it would break the signature.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "File" }))
		expect(screen.queryByRole("menuitem", { name: /^Save/u })).toBeNull()
		expect(screen.queryByRole("menuitemcheckbox", { name: /Save automatically/u })).toBeNull()
	})

	it("opens a file it may not save (in the trash) view-only, saying why", async () => {
		await openEditor({ editable: false }, editing({ writable: false }))

		expect(engine.opens[0]?.options.viewOnly).toBe(true)
		expect(screen.queryByRole("tab", { name: "Home" })).toBeNull()
	})

	it("adds a slide after the current one on the layout PowerPoint picks, and shows it", async () => {
		await openEditor()

		// Slide 1 is a title slide: the new one takes its master's Title and Content.
		fireEvent.click(within(commands()).getByRole("button", { name: "New slide" }))
		await waitFor(() => {
			expect(engine.commands).toEqual([{ family: "slide", kind: "add", at: 1, layout: LAYOUT_CONTENT }])
		})
	})

	it("refuses a command with its typed reason", async () => {
		await openEditor()
		engine.answer = { ok: false, refusal: "locked" }

		fireEvent.click(within(commands()).getByRole("button", { name: "Delete slide" }))
		await waitFor(() => {
			expect(toasts.error).toHaveBeenCalledWith("That part of the presentation is locked and can't be changed here.")
		})
	})

	it("enables Undo and Redo from the history the session reports, and runs them", async () => {
		await openEditor()

		const undo = within(commands()).getByRole("button", { name: "Undo" })

		expect(undo.hasAttribute("disabled")).toBe(true)
		await emit({ type: "changed", revision: 1, dirty: true, canUndo: true, canRedo: false, slides: [] })
		expect(undo.hasAttribute("disabled")).toBe(false)
		fireEvent.click(undo)
		await waitFor(() => {
			expect(engine.steps).toEqual(["undo"])
		})
	})
})

describe("presentation editor slide show keys", () => {
	it("starts the show with F5 and Shift+F5, and takes no editor key while it runs", async () => {
		await openEditor()

		const f5 = new KeyboardEvent("keydown", { key: "F5", code: "F5", bubbles: true, cancelable: true })

		act(() => {
			rail().dispatchEvent(f5)
		})
		expect(f5.defaultPrevented).toBe(true)

		const stage = await screen.findByRole("region", { name: "Slide show" })

		for (const key of ["m", "d", "z"]) fireEvent.keyDown(stage, { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, metaKey: true })

		fireEvent.keyDown(stage, { key: "Escape", code: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("region", { name: "Slide show" })).toBeNull()
		})
		expect(engine.commands).toEqual([])
		expect(engine.steps).toEqual([])

		fireEvent.keyDown(rail(), { key: "F5", code: "F5", shiftKey: true })
		expect(await screen.findByRole("region", { name: "Slide show" })).toBeTruthy()
	})
})

describe("presentation editor slide list", () => {
	it("deletes, moves, extends and duplicates with the keys, on the selection", async () => {
		await openEditor()

		const list = rail()

		fireEvent.keyDown(list, { key: "ArrowDown", code: "ArrowDown", shiftKey: true })
		fireEvent.keyDown(list, { key: "Delete", code: "Delete" })
		await waitFor(() => {
			expect(engine.commands.at(-1)).toEqual({ family: "slide", kind: "delete", slides: [1, 2] })
		})

		fireEvent.click(screen.getByRole("option", { name: "Slide 3 of 3" }))
		fireEvent.keyDown(list, { key: "ArrowUp", code: "ArrowUp", ctrlKey: true })
		await waitFor(() => {
			expect(engine.commands.at(-1)).toEqual({ family: "slide", kind: "move", slides: [3], to: 1 })
		})

		fireEvent.keyDown(list, { key: "d", code: "KeyD", ctrlKey: true })
		await waitFor(() => {
			expect(engine.commands.at(-1)).toEqual({ family: "slide", kind: "duplicate", slide: 3, at: 3 })
		})

		// Ctrl+Shift+D, PowerPoint's Duplicate Slide wherever the focus is.
		const count = engine.commands.length

		fireEvent.keyDown(list, { key: "D", code: "KeyD", ctrlKey: true, shiftKey: true })
		await waitFor(() => {
			expect(engine.commands.length).toBe(count + 1)
		})
		expect(engine.commands.at(-1)).toMatchObject({ family: "slide", kind: "duplicate" })

		fireEvent.keyDown(list, { key: "m", code: "KeyM", ctrlKey: true })
		await waitFor(() => {
			expect(engine.commands.at(-1)).toMatchObject({ family: "slide", kind: "add" })
		})
	})

	it("adds a slide with Ctrl+M from a slide's text or the notes, and takes no other editor key there", async () => {
		await openEditor()

		const region = screen.getByRole("region", { name: "deck.pptx" })
		const host = document.createElement("div")
		const body = document.createElement("div")
		const field = document.createElement("input")

		host.setAttribute("data-fo-text-editor", "")
		body.setAttribute("contenteditable", "true")
		Object.defineProperty(body, "isContentEditable", { value: true })
		host.append(body)
		region.append(host, field)

		// Duplicate and undo stay the text body's; another text field takes none.
		fireEvent.keyDown(body, { key: "D", code: "KeyD", ctrlKey: true, metaKey: true, shiftKey: true })
		fireEvent.keyDown(body, { key: "z", code: "KeyZ", ctrlKey: true, metaKey: true })
		fireEvent.keyDown(field, { key: "m", code: "KeyM", ctrlKey: true })
		expect(engine.commands).toEqual([])
		expect(engine.steps).toEqual([])

		const key = new KeyboardEvent("keydown", { key: "m", code: "KeyM", ctrlKey: true, bubbles: true, cancelable: true })

		act(() => {
			body.dispatchEvent(key)
		})
		expect(key.defaultPrevented).toBe(true)
		await waitFor(() => {
			expect(engine.commands.at(-1)).toMatchObject({ family: "slide", kind: "add" })
		})
		expect(engine.commands).toHaveLength(1)
		host.remove()
		field.remove()
	})

	it("shows the deck's sections before their slides and adds one at the current slide", async () => {
		await openEditor({
			sections: [
				{ id: "{A}", name: "Intro", slides: [1] },
				{ id: "{B}", name: "Body", slides: [2, 3] }
			] as never
		})

		expect([...document.querySelectorAll(".fo-slide-rail-section")].map(header => header.textContent)).toEqual(["Intro", "Body"])
		expect(screen.getByRole("option", { name: "Section Body, Slide 2 of 3" })).toBeTruthy()

		fireEvent.click(screen.getByRole("option", { name: "Slide 3 of 3" }))
		fireEvent.click(within(commands()).getByRole("button", { name: "Section" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Add section" }))

		const field = await screen.findByLabelText("Section name")

		fireEvent.change(field, { target: { value: "End" } })
		fireEvent.click(screen.getByRole("button", { name: "Add" }))
		await waitFor(() => {
			expect(engine.commands.at(-1)).toMatchObject({
				family: "slide",
				kind: "setSections",
				sections: [{ name: "Intro" }, { name: "Body", slides: [2] }, { name: "End", slides: [3] }]
			})
		})
	})
})

describe("presentation editor ribbon Escape", () => {
	it("gives the slide focus with Escape on a ribbon control, keeping the key from closing the preview", async () => {
		await openEditor({}, editing(), "deck.pptx", true)

		const tab = screen.getAllByRole("tab")[0]

		if (tab === undefined) throw new Error("no tab")

		act(() => {
			tab.focus()
		})
		expect(fireEvent.keyDown(tab, { key: "Escape" })).toBe(false)
		expect(document.activeElement?.hasAttribute("data-preview-surface")).toBe(true)
		expect(screen.getByRole("region", { name: "deck.pptx" }).contains(document.activeElement)).toBe(true)
	})
})

describe("presentation editor pane Escape", () => {
	it("gives the slide focus with Escape in the slide rail, keeping the key from closing the preview", async () => {
		await openEditor({}, editing(), "deck.pptx", true)

		const option = within(screen.getByRole("listbox", { name: "Slides" })).getAllByRole("option")[0]

		if (option === undefined) throw new Error("no slide")

		act(() => {
			option.focus()
		})
		expect(fireEvent.keyDown(option, { key: "Escape" })).toBe(false)
		expect(document.activeElement?.hasAttribute("data-preview-surface")).toBe(true)
	})
})

describe("presentation editor find", () => {
	it("opens find and replace with their keys and from the ribbon inside the preview overlay", async () => {
		await openEditor({}, editing(), "deck.pptx", true)

		const slide = screen.getByRole("region", { name: "deck.pptx" })

		fireEvent.keyDown(slide, { key: "f", code: "KeyF", ctrlKey: true, metaKey: true })
		expect(await screen.findByRole("searchbox", { name: "Find" })).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Close find" }))
		await waitFor(() => {
			expect(screen.queryByRole("searchbox", { name: "Find" })).toBeNull()
		})
		fireEvent.click(within(commands()).getByRole("button", { name: /^Find/u }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Replace" }))
		expect(await screen.findByRole("searchbox", { name: "Find" })).toBeTruthy()
		expect(screen.getByRole("textbox", { name: "Replace with" })).toBeTruthy()
	})

	it("takes its keys with focus on the preview overlay itself (left there after a click in Safari and macOS Firefox)", async () => {
		await openEditor({}, editing(), "deck.pptx", true)

		const overlay = screen.getByRole("region", { name: "deck.pptx" }).closest<HTMLElement>('[role="dialog"]')

		if (overlay === null) throw new Error("no overlay")

		fireEvent.keyDown(overlay, { key: "f", code: "KeyF", ctrlKey: true, metaKey: true })
		expect(await screen.findByRole("searchbox", { name: "Find" })).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Close find" }))

		// F6 goes to the ribbon from there too.
		fireEvent.keyDown(overlay, { key: "F6", code: "F6" })
		expect(document.activeElement?.closest("[data-office-ribbon]")).not.toBeNull()
	})

	it("gives focus back to the open body's editor when Find closes, else to the slide", async () => {
		await openEditor({}, editing(), "deck.pptx", true)

		const region = screen.getByRole("region", { name: "deck.pptx" })
		// The notes editor, open and focused (its body is the store's active one).
		const host = document.createElement("div")
		const body = document.createElement("div")

		host.setAttribute("data-fo-text-editor", "")
		body.setAttribute("contenteditable", "true")
		body.tabIndex = 0
		host.append(body)
		region.append(host)
		typing.active = {
			shape: { slide: 256, id: 2 },
			defaults: { paragraph: () => ({}) },
			format: () => ({ run: {}, paragraph: {}, bodyPr: {} }),
			run: () => true,
			setBodyPr: () => undefined,
			subscribe: () => () => undefined
		}
		body.focus()

		fireEvent.keyDown(body, { key: "f", code: "KeyF", ctrlKey: true, metaKey: true })
		fireEvent.keyDown(await screen.findByRole("searchbox", { name: "Find" }), { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("searchbox", { name: "Find" })).toBeNull()
		})
		expect(document.activeElement).toBe(body)

		// No body open: the slide.
		typing.active = undefined
		host.remove()
		fireEvent.keyDown(region, { key: "f", code: "KeyF", ctrlKey: true, metaKey: true })
		fireEvent.keyDown(await screen.findByRole("searchbox", { name: "Find" }), { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("searchbox", { name: "Find" })).toBeNull()
		})
		// The slide's area (the canvas around the slide editor).
		expect(document.activeElement?.hasAttribute("data-preview-surface")).toBe(true)
		expect(region.contains(document.activeElement)).toBe(true)
	})

	it("stands down for a key pressed in a dialog over the editor", async () => {
		await openEditor({}, editing(), "deck.pptx", true)
		render(
			<div
				role="dialog"
				data-open=""
			>
				<input aria-label="Other" />
			</div>
		)
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Other" }), { key: "f", code: "KeyF", ctrlKey: true, metaKey: true })
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0))
		})
		expect(screen.queryByRole("searchbox", { name: "Find" })).toBeNull()
	})
})

describe("presentation editor saving", () => {
	it("says there are unsaved changes, tells the overlay, and gives it a save source", async () => {
		const edit = await openEditor()

		expect(edit.saveRef.current).not.toBeNull()
		await emit({ type: "changed", revision: 1, dirty: true, slides: [] })
		expect(screen.getByText("Unsaved changes")).toBeTruthy()
		expect(edit.onDirtyChange).toHaveBeenLastCalledWith(true)

		fireEvent.click(screen.getByRole("button", { name: "File" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Save/u }))
		expect(edit.onSave).toHaveBeenCalledTimes(1)

		await act(async () => {
			await edit.saveRef.current?.({ auto: false })
		})
		expect(engine.saves).toEqual([{ reason: "user" }])
		expect(screen.getByText("Saving…")).toBeTruthy()
	})

	it("tells the overlay a clean deck is unsaved while typing the worker has not answered is pending", async () => {
		const edit = await openEditor()

		expect(edit.onDirtyChange).toHaveBeenLastCalledWith(false)
		act(() => {
			typing.pending = true
			typing.notify()
		})
		expect(edit.onDirtyChange).toHaveBeenLastCalledWith(true)
		act(() => {
			typing.pending = false
			typing.notify()
		})
		expect(edit.onDirtyChange).toHaveBeenLastCalledWith(false)
	})

	it("sends commands through the text store, so an open body's answer reseeds it", async () => {
		await openEditor()
		fireEvent.click(within(commands()).getByRole("button", { name: "Delete slide" }))
		await waitFor(() => {
			expect(typing.commands).toHaveLength(1)
		})
		expect(engine.commands).toEqual(typing.commands)
	})

	it("gives the open body's editor the user's text keys and listens for its link key", async () => {
		typing.overrides = { "presentation.text.underline": "mod+shift+u" }
		await openEditor()
		expect(typing.linkListeners).toBeGreaterThan(0)
		fireEvent.click(screen.getByRole("button", { name: "enter text" }))
		expect(typing.editorProps.at(-1)?.["bindings"]).toMatchObject({ underline: "mod+shift+u", bold: "mod+b" })
	})

	it("never autosaves a deck over 256 MB, and says so", async () => {
		await openEditor({ packageBytes: 300 * 1024 * 1024 })

		expect(
			screen.getByText("This presentation is too large to save automatically. Save your changes with Ctrl+S or File → Save.")
		).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "File" }))

		const autosave = await screen.findByRole("menuitemcheckbox", { name: /Save automatically/u })

		expect(autosave.getAttribute("aria-checked")).toBe("false")
		expect(autosave.hasAttribute("data-disabled")).toBe(true)
		expect(within(autosave).getByText("Off for presentations over 256 MB")).toBeTruthy()
	})
})

describe("presentation editor zoom", () => {
	// The slide view measures 640 × 360 px: a 1280 × 720 px slide fits at 50 %.
	function measureView(): void {
		for (const name of ["clientWidth", "clientHeight"] as const)
			vi.spyOn(HTMLElement.prototype, name, "get").mockImplementation(function (this: HTMLElement) {
				return this.hasAttribute("data-fo-slide-view") ? (name === "clientWidth" ? 640 : 360) : 0
			})
	}

	function view(): HTMLElement {
		const element = document.querySelector<HTMLElement>("[data-fo-slide-view]")

		if (element === null) throw new Error("no slide view")

		return element
	}

	function frameWidth(): number {
		return Number.parseFloat(view().querySelector<HTMLElement>(".fo-slide-frame")?.style.width ?? "")
	}

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("zooms with Ctrl+Plus and Ctrl+Minus on every layout's plus key, and fits again with Ctrl+Alt+O", async () => {
		measureView()
		await openEditor()
		expect(frameWidth()).toBeCloseTo(640)
		expect(view().hasAttribute("data-fo-zoomed")).toBe(false)

		const plus = new KeyboardEvent("keydown", { key: "=", code: "Equal", ctrlKey: true, bubbles: true, cancelable: true })

		act(() => {
			view().dispatchEvent(plus)
		})
		// Kept from the browser's page zoom.
		expect(plus.defaultPrevented).toBe(true)
		expect(frameWidth()).toBeCloseTo(1280 * 0.67)
		expect(view().hasAttribute("data-fo-zoomed")).toBe(true)

		fireEvent.keyDown(view(), { key: "+", code: "Equal", ctrlKey: true, shiftKey: true })
		expect(frameWidth()).toBeCloseTo(1280 * 0.75)
		fireEvent.keyDown(view(), { key: "+", code: "NumpadAdd", ctrlKey: true })
		expect(frameWidth()).toBeCloseTo(1280 * 0.8)
		fireEvent.keyDown(view(), { key: "-", code: "Minus", ctrlKey: true })
		expect(frameWidth()).toBeCloseTo(1280 * 0.75)
		expect(screen.getByRole("button", { name: "Zoom level, 75%" })).toBeTruthy()

		fireEvent.keyDown(view(), { key: "o", code: "KeyO", ctrlKey: true, altKey: true })
		expect(frameWidth()).toBeCloseTo(640)
		expect(view().hasAttribute("data-fo-zoomed")).toBe(false)

		// Alt turns the letter into another character (a Mac's Option+O): the physical key is read.
		fireEvent.keyDown(view(), { key: "=", code: "Equal", ctrlKey: true })
		fireEvent.keyDown(view(), { key: "ø", code: "KeyO", ctrlKey: true, altKey: true })
		expect(frameWidth()).toBeCloseTo(640)
		expect(engine.commands).toEqual([])
	})

	it("zooms with Ctrl+wheel from the zoom shown, and from View ▸ Zoom and Fit to Window", async () => {
		measureView()
		await openEditor()

		const canvas = view().closest<HTMLElement>("[data-preview-surface]")

		if (canvas === null) throw new Error("no canvas")

		const wheel = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })

		act(() => {
			canvas.dispatchEvent(wheel)
		})
		expect(wheel.defaultPrevented).toBe(true)
		expect(frameWidth()).toBeCloseTo(1280 * 0.65)

		fireEvent.click(screen.getByRole("tab", { name: "View" }))

		const zoom = within(commands()).getByRole("group", { name: "Zoom" })

		fireEvent.click(within(zoom).getByRole("button", { name: "Zoom in" }))
		expect(frameWidth()).toBeCloseTo(1280 * 0.67)
		fireEvent.click(within(zoom).getByRole("button", { name: "Fit to Window" }))
		expect(frameWidth()).toBeCloseTo(640)
		expect(within(zoom).getByRole("button", { name: "Fit to Window" }).getAttribute("aria-pressed")).toBe("true")
	})
})
