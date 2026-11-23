// @vitest-environment jsdom

// The md note editor's views, as the file preview's markdown has them: Live preview or Source in the one editor, or
// Read, the rendered note. The editor stays mounted while reading (its buffer is the note's), Read renders the value
// last typed, and the choice is the device's. The view switch is the note header's (portalled into its slot). CodeMirror, the live preview and the renderer are stubbed down to what
// carries that contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { Note } from "@filen/sdk-rs"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import "@/lib/i18n"

const { renderedPreviews, actions, actionOptions, overlayGuard, LIVE } = vi.hoisted(() => ({
	renderedPreviews: [] as string[],
	actions: new Map<string, (event: KeyboardEvent) => void>(),
	actionOptions: new Map<string, unknown>(),
	overlayGuard: () => true,
	LIVE: { live: true }
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

vi.mock("@/features/preview/components/codeMirrorSource", () => ({
	CodeMirrorSource: ({ onValueChange, livePreview }: { onValueChange: (value: string) => void; livePreview: unknown }) =>
		createElement("textarea", {
			"aria-label": "source",
			"data-live": livePreview === LIVE ? "on" : "off",
			onChange: (event: { target: { value: string } }) => {
				onValueChange(event.target.value)
			}
		})
}))

vi.mock("@/features/preview/hooks/useLivePreview", () => ({
	useLivePreview: () => ({ extension: LIVE, node: null })
}))

vi.mock("@/features/preview/components/markdownRenderer", () => ({
	MarkdownRenderer: ({ text }: { text: string }) => {
		renderedPreviews.push(text)

		return createElement("output", null, text)
	}
}))

vi.mock("@/lib/keymap/useAction", () => ({
	IN_EDITORS: { enableOnContentEditable: true },
	IN_EDITORS_AND_FIELDS: { enableOnContentEditable: true },
	OUTSIDE_OVERLAYS: { ignoreEventWhen: overlayGuard },
	useAction: (id: string, handler: (event: KeyboardEvent) => void, options?: unknown) => {
		actions.set(id, handler)
		actionOptions.set(id, options)
	}
}))

const { NoteMarkdownEditor } = await import("@/features/notes/components/noteMarkdownEditor")
const { NoteHeaderSlotContext } = await import("@/features/notes/lib/noteHeaderSlot")
const { getMarkdownView, setMarkdownView } = await import("@/features/preview/lib/markdownView")

const note: Note = {
	uuid: "note-0000-0000-0000-000000000000",
	ownerId: 1n,
	lastEditorId: 1n,
	favorite: false,
	pinned: false,
	tags: [],
	noteType: "md",
	encryptionKey: "note-key",
	title: "md",
	preview: "",
	trash: false,
	archive: false,
	createdTimestamp: 0n,
	editedTimestamp: 0n,
	participants: []
}

const onChange = vi.fn<(value: string) => void>()

const controller: NoteEditorController = {
	status: "ready",
	errorDto: undefined,
	seed: "# seed",
	remountKey: "key",
	readOnly: false,
	sizeReached: false,
	onChange
}

// The note header's slot, as noteEditorPane.tsx provides it.
let headerSlot: HTMLElement

function renderEditor(): void {
	render(createElement(NoteHeaderSlotContext, { value: headerSlot }, createElement(NoteMarkdownEditor, { note, controller })))
}

function editor(): HTMLTextAreaElement {
	return screen.getByLabelText<HTMLTextAreaElement>("source")
}

function type(value: string): void {
	fireEvent.change(editor(), { target: { value } })
}

function press(action: string): void {
	act(() => {
		actions.get(action)?.(new KeyboardEvent("keydown"))
	})
}

beforeEach(() => {
	renderedPreviews.length = 0
	onChange.mockClear()
	setMarkdownView({ edit: "live", read: false })
	headerSlot = document.body.appendChild(document.createElement("header"))
})

afterEach(() => {
	cleanup()
	headerSlot.remove()
})

describe("NoteMarkdownEditor — views", () => {
	it("opens in live preview, enqueuing every keystroke and rendering nothing", () => {
		renderEditor()

		type("# a")
		type("# ab")

		expect(onChange.mock.calls.map(([value]) => value)).toEqual(["# a", "# ab"])
		expect(editor().dataset["live"]).toBe("on")
		expect(renderedPreviews).toEqual([])
	})

	it("puts its compact view switch in the note's header", () => {
		renderEditor()

		const read = screen.getByRole("button", { name: "Read" })
		const editing = screen.getByRole("button", { name: "Editing view: Live preview" })

		expect(headerSlot.contains(read)).toBe(true)
		expect(headerSlot.contains(editing)).toBe(true)
		expect(read.getAttribute("aria-pressed")).toBe("false")
		// Icon only; the editing view's menu goes first, under its short name.
		expect(read.textContent).toBe("")
		expect(editing.textContent).toBe("Live")
		expect(editing.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

		fireEvent.click(read)

		expect(read.getAttribute("aria-pressed")).toBe("true")
	})

	it("shows no view switch outside a note's header", () => {
		render(createElement(NoteMarkdownEditor, { note, controller }))

		expect(screen.queryByRole("button", { name: "Read" })).toBeNull()
		expect(editor()).toBeTruthy()
	})

	it("reads the value last typed, keeping the editor mounted, and remembers the choice", () => {
		renderEditor()

		type("# typed")
		fireEvent.click(screen.getByRole("button", { name: "Read" }))

		expect(screen.getByRole("status").textContent).toBe("# typed")
		expect(editor().closest(".hidden")).not.toBeNull()
		expect(getMarkdownView()).toEqual({ edit: "live", read: true })

		press("editor.togglePreview")

		expect(screen.queryByRole("status")).toBeNull()
		expect(editor().closest(".hidden")).toBeNull()
		expect(getMarkdownView()).toEqual({ edit: "live", read: false })
	})

	it("switches live preview and source in the one editor", () => {
		renderEditor()

		const before = editor()

		press("editor.toggleLivePreview")

		expect(editor()).toBe(before)
		expect(editor().dataset["live"]).toBe("off")
		expect(getMarkdownView()).toEqual({ edit: "source", read: false })

		press("editor.toggleLivePreview")

		expect(editor().dataset["live"]).toBe("on")
	})

	it("opens in the device's choice", () => {
		setMarkdownView({ edit: "source", read: true })
		renderEditor()

		expect(screen.getByRole("status").textContent).toBe("# seed")
		expect(editor().dataset["live"]).toBe("off")
	})
})

// A dialog or menu over the note keeps the key (Ctrl+Shift+V pastes there): the guard runs before any preventDefault.
describe("NoteMarkdownEditor — view keys", () => {
	it("work in the editor and stand down under an open dialog or menu", () => {
		renderEditor()

		expect(actionOptions.get("editor.togglePreview")).toEqual({ enableOnContentEditable: true, ignoreEventWhen: overlayGuard })
		expect(actionOptions.get("editor.toggleLivePreview")).toEqual({ enableOnContentEditable: true, ignoreEventWhen: overlayGuard })
	})
})
