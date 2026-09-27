// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { EditorView } from "@codemirror/view"

vi.mock("@/features/preview/lib/codeMirrorShared", () => ({
	useCodeMirrorTheme: () => [],
	useLanguageExtension: () => null,
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

// A save in flight locks the editor without remounting it: the buffer, and what was typed before the
// save, stay; nothing can be typed until it settles.
describe("CodeMirrorSource locked", () => {
	it("goes read-only while locked and editable again after, keeping its buffer", () => {
		const props = { text: "saved", tag: "text", alt: "notes.txt", editable: true }
		const { container, rerender } = render(
			<CodeMirrorSource
				{...props}
				locked={false}
			/>
		)
		const view = editorView(container)

		act(() => {
			view.dispatch({ changes: { from: view.state.doc.length, insert: " edited" } })
		})

		expect(view.state.readOnly).toBe(false)

		rerender(
			<CodeMirrorSource
				{...props}
				locked
			/>
		)

		expect(editorView(container)).toBe(view)
		expect(view.state.readOnly).toBe(true)
		expect(view.state.facet(EditorView.editable)).toBe(false)
		expect(view.state.doc.toString()).toBe("saved edited")

		rerender(
			<CodeMirrorSource
				{...props}
				locked={false}
			/>
		)

		expect(view.state.readOnly).toBe(false)
		expect(view.state.facet(EditorView.editable)).toBe(true)
	})

	it("starts read-only when created locked", () => {
		const { container } = render(
			<CodeMirrorSource
				text="saved"
				tag="text"
				alt="notes.txt"
				editable
				locked
			/>
		)

		expect(editorView(container).state.readOnly).toBe(true)
	})
})
