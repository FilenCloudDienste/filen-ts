import { useState } from "react"
import { isolateHistory } from "@codemirror/commands"
import type { EditorView } from "@codemirror/view"
import type { TransformHost } from "@/features/assistant/transform/host"

function viewRect(view: EditorView, from: number, to: number): DOMRect | null {
	const start = view.coordsAtPos(from, 1)
	const end = view.coordsAtPos(to, -1)

	if (start === null || end === null) {
		return null
	}

	const top = Math.min(start.top, end.top)

	return new DOMRect(Math.min(start.left, end.left), top, Math.abs(end.right - start.left), Math.max(start.bottom, end.bottom) - top)
}

// The selection transform's side of a CodeMirror editor (CodeMirrorSource's onView): the main selection range, replaced
// as an undo step of its own.
export function codeMirrorTransformHost(view: () => EditorView | null): TransformHost {
	return {
		selection: () => {
			const current = view()

			if (current === null || current.state.readOnly) {
				return null
			}

			const { from, to } = current.state.selection.main

			if (from === to) {
				return null
			}

			const doc = current.state.doc
			const unchanged = () => current.dom.isConnected && current.state.doc === doc

			return {
				text: doc.sliceString(from, to),
				current: unchanged,
				replace: (text: string) => {
					if (!unchanged()) {
						return null
					}

					current.dispatch({
						changes: { from, to, insert: text },
						selection: { anchor: from, head: from + text.length },
						userEvent: "input.assistant",
						annotations: isolateHistory.of("full"),
						scrollIntoView: true
					})
					current.focus()

					return { undo: null }
				},
				rect: () => (unchanged() ? viewRect(current, from, to) : null)
			}
		},
		selectionRect: () => {
			const current = view()

			if (current === null || current.state.readOnly) {
				return null
			}

			const { from, to } = current.state.selection.main

			return from === to ? null : viewRect(current, to, to)
		},
		focus: () => {
			view()?.focus()
		}
	}
}

// One host per editor for its life, with the onView that hands it the view.
export function useCodeMirrorTransformHost(): { host: TransformHost; onView: (view: EditorView | null) => void } {
	const [state] = useState(() => {
		let current: EditorView | null = null

		return {
			host: codeMirrorTransformHost(() => current),
			onView: (view: EditorView | null) => {
				current = view
			}
		}
	})

	return state
}
