// @vitest-environment jsdom

import { createRef } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { EditorView } from "@codemirror/view"
import { ExternalChange } from "@uiw/react-codemirror"

vi.mock("@/features/preview/lib/codeMirrorShared", () => ({
	languageExtensionFor: () => null,
	useCodeMirrorTheme: () => [],
	useEditorKeymap: () => []
}))

const { CodeMirrorSource } = await import("@/features/preview/components/codeMirrorSource")

function editorView(container: HTMLElement): EditorView {
	const dom = container.querySelector<HTMLElement>(".cm-editor")
	const view = dom === null ? null : EditorView.findFromDOM(dom)

	if (view === null) {
		throw new Error("no editor view")
	}

	return view
}

function append(view: EditorView, text: string): void {
	act(() => {
		view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
	})
}

function removeLast(view: EditorView, count: number): void {
	act(() => {
		view.dispatch({ changes: { from: view.state.doc.length - count, to: view.state.doc.length } })
	})
}

// Dirty tracks the doc against what the editor opened with, and the buffer string is only built for a
// caller that reads it.
describe("CodeMirrorSource buffer", () => {
	it("flips dirty on an edit and back when the edit is undone by hand, keeping contentRef current", () => {
		const onDirtyChange = vi.fn<(dirty: boolean) => void>()
		const contentRef = createRef<(() => string) | null>()
		const { container } = render(
			<CodeMirrorSource
				text="saved"
				tag="text"
				alt="notes.txt"
				editable
				onDirtyChange={onDirtyChange}
				contentRef={contentRef}
			/>
		)
		const view = editorView(container)

		expect(contentRef.current?.()).toBe("saved")

		append(view, "!")

		expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		expect(contentRef.current?.()).toBe("saved!")

		removeLast(view, 1)

		expect(onDirtyChange).toHaveBeenLastCalledWith(false)
		expect(contentRef.current?.()).toBe("saved")
	})

	it("builds the buffer string only when contentRef is read, never per keystroke", () => {
		const contentRef = createRef<(() => string) | null>()
		const { container } = render(
			<CodeMirrorSource
				text="saved"
				tag="text"
				alt="notes.txt"
				editable
				contentRef={contentRef}
			/>
		)
		const view = editorView(container)
		const toString = vi.spyOn(Object.getPrototypeOf(view.state.doc) as { toString: () => string }, "toString")

		append(view, "!")
		append(view, "?")

		expect(toString).not.toHaveBeenCalled()
		expect(contentRef.current?.()).toBe("saved!?")
		expect(toString).toHaveBeenCalledTimes(1)
	})

	// The overlay nulls the channel on a slot change, which can run after this editor's mount effect.
	it("re-arms contentRef on the next edit after an outside reset", () => {
		const contentRef = createRef<(() => string) | null>()
		const { container } = render(
			<CodeMirrorSource
				text="saved"
				tag="text"
				alt="notes.txt"
				editable
				contentRef={contentRef}
			/>
		)
		const view = editorView(container)

		act(() => {
			contentRef.current = null
		})
		append(view, "!")

		expect(contentRef.current?.()).toBe("saved!")
	})

	it("still reads the last buffer once the editor has unmounted", () => {
		const contentRef = createRef<(() => string) | null>()
		const { container, unmount } = render(
			<CodeMirrorSource
				text="saved"
				tag="text"
				alt="notes.txt"
				editable
				contentRef={contentRef}
			/>
		)

		append(editorView(container), "!")
		unmount()

		expect(contentRef.current?.()).toBe("saved!")
	})

	it("never flattens the doc into a string when no caller reads the buffer", () => {
		const onDirtyChange = vi.fn<(dirty: boolean) => void>()
		const { container } = render(
			<CodeMirrorSource
				text="saved"
				tag="text"
				alt="notes.txt"
				editable
				onDirtyChange={onDirtyChange}
			/>
		)
		const view = editorView(container)
		const toString = vi.spyOn(Object.getPrototypeOf(view.state.doc) as { toString: () => string }, "toString")

		append(view, "!")

		expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		expect(toString).not.toHaveBeenCalled()
	})

	it("forwards every change to onValueChange", () => {
		const onValueChange = vi.fn<(value: string) => void>()
		const { container } = render(
			<CodeMirrorSource
				text="a"
				tag="text"
				alt="notes.txt"
				editable
				onValueChange={onValueChange}
			/>
		)
		const view = editorView(container)

		append(view, "b")
		append(view, "c")

		expect(onValueChange.mock.calls.map(([value]) => value)).toEqual(["ab", "abc"])
	})

	it("reports nothing for a read-only mount", () => {
		const onDirtyChange = vi.fn<(dirty: boolean) => void>()
		const contentRef = createRef<(() => string) | null>()
		const { container } = render(
			<CodeMirrorSource
				text="saved"
				tag="text"
				alt="notes.txt"
				onDirtyChange={onDirtyChange}
				contentRef={contentRef}
			/>
		)
		const view = editorView(container)

		append(view, "!")

		expect(onDirtyChange).not.toHaveBeenCalledWith(true)
		expect(contentRef.current).toBeNull()
	})

	// Opening content is not an edit: a CRLF seed must not reach the notes outbox or mark a file dirty.
	it("reports no change for a seed with CRLF or lone CR line breaks until the user edits", () => {
		const onValueChange = vi.fn<(value: string) => void>()
		const onDirtyChange = vi.fn<(dirty: boolean) => void>()
		const { container } = render(
			<CodeMirrorSource
				text={"a\r\nb\rc"}
				tag="text"
				alt="notes.txt"
				editable
				onValueChange={onValueChange}
				onDirtyChange={onDirtyChange}
			/>
		)
		const view = editorView(container)

		expect(view.state.doc.toString()).toBe("a\nb\nc")
		expect(onValueChange).not.toHaveBeenCalled()
		expect(onDirtyChange).not.toHaveBeenCalledWith(true)

		append(view, "!")

		expect(onValueChange.mock.calls.map(([value]) => value)).toEqual(["a\nb\nc!"])
	})

	it("ignores @uiw's own value sync", () => {
		const onValueChange = vi.fn<(value: string) => void>()
		const onDirtyChange = vi.fn<(dirty: boolean) => void>()
		const { container } = render(
			<CodeMirrorSource
				text="saved"
				tag="text"
				alt="notes.txt"
				editable
				onValueChange={onValueChange}
				onDirtyChange={onDirtyChange}
			/>
		)
		const view = editorView(container)

		act(() => {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: "synced" },
				annotations: [ExternalChange.of(true)]
			})
		})

		expect(onValueChange).not.toHaveBeenCalled()
		expect(onDirtyChange).not.toHaveBeenCalledWith(true)
	})
})
