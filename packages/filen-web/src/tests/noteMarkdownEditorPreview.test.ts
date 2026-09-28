// @vitest-environment jsdom

// The md editor's live preview parses the whole document on every render it gets, so it must follow
// typing only once typing pauses, and not at all while hidden. CodeMirror, the split pane and the
// renderer are stubbed down to what carries that contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { Note } from "@filen/sdk-rs"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"

const { renderedPreviews, actions } = vi.hoisted(() => ({
	renderedPreviews: [] as string[],
	actions: new Map<string, (event: KeyboardEvent) => void>()
}))

vi.mock("@/features/preview/components/codeMirrorSource", () => ({
	CodeMirrorSource: ({ onValueChange }: { onValueChange: (value: string) => void }) =>
		createElement("textarea", {
			"aria-label": "source",
			onChange: (event: { target: { value: string } }) => {
				onValueChange(event.target.value)
			}
		})
}))

vi.mock("@/features/preview/components/markdownRenderer", () => ({
	MarkdownRenderer: ({ text }: { text: string }) => {
		renderedPreviews.push(text)

		return createElement("output", null, text)
	}
}))

vi.mock("@/features/notes/components/markdownSplitPane", () => ({
	MarkdownSplitPane: ({ left, right, rightHidden }: { left: ReactNode; right: ReactNode; rightHidden: boolean }) =>
		createElement("div", null, left, rightHidden ? null : right)
}))

vi.mock("@/lib/keymap/useAction", () => ({
	IN_EDITORS: {},
	useAction: (id: string, handler: (event: KeyboardEvent) => void) => {
		actions.set(id, handler)
	}
}))

const { NoteMarkdownEditor } = await import("@/features/notes/components/noteMarkdownEditor")

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
	isInflight: false,
	sizeReached: false,
	onChange
}

function type(value: string): void {
	fireEvent.change(screen.getByLabelText("source"), { target: { value } })
}

function togglePreview(): void {
	act(() => {
		actions.get("editor.togglePreview")?.(new KeyboardEvent("keydown"))
	})
}

beforeEach(() => {
	vi.useFakeTimers()
	renderedPreviews.length = 0
	onChange.mockClear()
	render(createElement(NoteMarkdownEditor, { note, controller }))
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("NoteMarkdownEditor — preview", () => {
	it("enqueues every keystroke but renders the preview once, after typing pauses", () => {
		type("# a")
		type("# ab")
		type("# abc")

		expect(onChange.mock.calls.map(([value]) => value)).toEqual(["# a", "# ab", "# abc"])
		expect(screen.getByRole("status").textContent).toBe("# seed")

		act(() => {
			vi.advanceTimersByTime(200)
		})

		expect(screen.getByRole("status").textContent).toBe("# abc")
		expect(renderedPreviews.filter(text => text !== "# seed")).toEqual(["# abc"])
	})

	it("skips the preview while hidden and catches up when shown again", () => {
		togglePreview()
		type("# hidden edit")

		act(() => {
			vi.advanceTimersByTime(1000)
		})

		expect(screen.queryByRole("status")).toBeNull()
		expect(renderedPreviews).toEqual(["# seed"])

		togglePreview()

		expect(screen.getByRole("status").textContent).toBe("# hidden edit")
	})
})
