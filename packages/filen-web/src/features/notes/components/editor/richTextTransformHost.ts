import type Quill from "quill"
import type { Range } from "quill"
import type { TransformHost } from "@/features/assistant/transform/host"

// Formats of a line, never given to inserted text: the replacement stays in the lines the selection was in.
const LINE_FORMATS = new Set(["header", "list", "blockquote", "code-block", "align", "indent", "direction"])

interface QuillHistory {
	cutoff(): void
}

function boundsRect(quill: Quill, index: number, length: number): DOMRect | null {
	const bounds = quill.getBounds(index, length)

	if (bounds === null) {
		return null
	}

	const box = quill.container.getBoundingClientRect()

	return new DOMRect(box.left + bounds.left, box.top + bounds.top, bounds.width, bounds.height)
}

// The selection transform's side of the rich-text note editor: Quill's own edits with source "user" (only those are
// saved), fenced by history cutoffs so one undo takes the whole replacement back. The inline formats the whole
// selection shared carry over; anything finer is lost to plain text.
export function quillTransformHost(): { host: TransformHost; attach: (quill: Quill | null) => void } {
	let quill: Quill | null = null
	// The last selection: a press on the button or the menu blurs the editor, and Quill reports none without focus.
	let last: Range | null = null
	// Counts every change of the text, so a selection taken earlier knows whether it still holds.
	let revision = 0

	const host: TransformHost = {
		selection: () => {
			const editor = quill
			const range = editor?.getSelection() ?? last

			if (editor === null || !editor.isEnabled() || range === null || range.length === 0) {
				return null
			}

			const { index, length } = range
			const taken = revision
			const current = () => quill === editor && revision === taken

			return {
				text: editor.getText(index, length),
				current,
				replace: (text: string) => {
					if (!current()) {
						return null
					}

					const formats = Object.fromEntries(
						Object.entries(editor.getFormat(index, length)).filter(([name]) => !LINE_FORMATS.has(name))
					)
					const history = editor.getModule("history") as QuillHistory

					history.cutoff()
					editor.deleteText(index, length, "user")
					editor.insertText(index, text, formats, "user")
					history.cutoff()
					editor.setSelection(index, text.length, "user")
					editor.focus()

					return { undo: null }
				},
				rect: () => (current() ? boundsRect(editor, index, length) : null)
			}
		},
		selectionRect: () => {
			const range = quill?.getSelection() ?? null

			return quill === null || range === null || range.length === 0 ? null : boundsRect(quill, range.index + range.length, 0)
		},
		focus: () => {
			if (quill !== null && last !== null) {
				quill.setSelection(last, "silent")
			}

			quill?.focus()
		}
	}

	return {
		host,
		attach: next => {
			quill = next
			last = null

			next?.on("text-change", () => {
				revision++
			})
			next?.on("selection-change", (range: Range | null) => {
				if (range !== null) {
					last = range
				}
			})
		}
	}
}
