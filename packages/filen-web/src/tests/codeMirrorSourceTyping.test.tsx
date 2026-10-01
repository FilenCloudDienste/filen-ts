// @vitest-environment jsdom

import { useLayoutEffect, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@testing-library/react"
import { EditorView } from "@codemirror/view"

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

function type(view: EditorView, text: string): void {
	view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: "input.type" })
}

// A keystroke can land after React commits the buffer of the previous one but before its passive
// effects run. The editor must keep that keystroke: its doc is the buffer of record, and nothing may
// write an older buffer back over it once typing pauses.
describe("CodeMirrorSource typing", () => {
	it("keeps a keystroke that lands between a commit and its effects", async () => {
		let view: EditorView | null = null
		let pending: string | null = null

		function Host() {
			const [, setChanges] = useState(0)

			// Runs in the same commit as the editor's own buffer update, before any passive effect.
			useLayoutEffect(() => {
				if (pending !== null && view !== null) {
					const text = pending

					pending = null
					type(view, text)
				}
			})

			return (
				<CodeMirrorSource
					text="saved"
					tag="text"
					alt="notes.txt"
					editable
					onValueChange={() => {
						setChanges(count => count + 1)
					}}
				/>
			)
		}

		const { container } = render(<Host />)

		view = editorView(container)

		const live = view

		act(() => {
			pending = "e"
			type(live, " her")
		})

		expect(live.state.doc.toString()).toBe("saved here")

		// Past the wrapper's typing pause, when a deferred reseed would land.
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 600))
		})

		await waitFor(() => {
			expect(live.state.doc.toString()).toBe("saved here")
		})
	})
})
