import type { PagedEditor } from "@filen/office/core/docx/paged"
import { plainText, plainTextRange, replaceSelectionText, type ClientPoint } from "@filen/office/react/docx/editor"
import type { TransformHost } from "@/features/assistant/transform/host"

// What the host reads of the editor's view: where the selection's ends are on screen, and its focus.
export interface DocxTransformView {
	selectionPoints(): { readonly start: ClientPoint | undefined; readonly end: ClientPoint | undefined }
	focus(): void
}

// The selection's box from its two ends on screen (each the bottom of its line, with the line's height).
function endsRect(view: DocxTransformView | null): DOMRect | null {
	const ends = view?.selectionPoints()
	const points = [ends?.start, ends?.end].filter(point => point !== undefined)

	if (points.length === 0) {
		return null
	}

	const left = Math.min(...points.map(point => point.x))
	const top = Math.min(...points.map(point => point.y - point.height))

	return new DOMRect(left, top, Math.max(...points.map(point => point.x)) - left, Math.max(...points.map(point => point.y)) - top)
}

// The selection transform's side of the Word document editor: the story being edited, a selection of plain text only
// (no table structure, field, picture, comment anchor or tracked change, which a plain-text result would lose),
// replaced through the story's own dispatch as one undo step (protection, tracked changes and read-only apply). The
// editor and its view are attached after each commit, so the host never reads them during a render.
export function docxTransform(): {
	host: TransformHost
	attach: (editor: PagedEditor | undefined, view: DocxTransformView | null) => void
} {
	let editor: PagedEditor | undefined
	let view: DocxTransformView | null = null

	const host: TransformHost = {
		selection: () => {
			const current = editor
			const selection = current?.selection()

			if (current === undefined || selection === undefined || selection.empty) {
				return null
			}

			const range = { from: selection.from, to: selection.to }
			const doc = current.state.doc

			if (selection.node || !plainTextRange(doc, range)) {
				return "unsupported"
			}

			const story = current.activeStory
			const unchanged = () => editor === current && current.activeStory === story && current.state.doc === doc

			return {
				// No list numbers: they are the paragraph's, not text the replacement would hold.
				text: plainText(doc, range.from, range.to, () => ""),
				current: unchanged,
				replace: (text: string) => {
					if (!unchanged() || !replaceSelectionText(current, text, range)) {
						return null
					}

					view?.focus()

					return { undo: null }
				},
				rect: () => (unchanged() ? endsRect(view) : null)
			}
		},
		selectionRect: () => {
			const selection = editor?.selection()

			return selection === undefined || selection.empty ? null : endsRect(view)
		},
		focus: () => {
			view?.focus()
		}
	}

	return {
		host,
		attach: (nextEditor, nextView) => {
			editor = nextEditor
			view = nextView
		}
	}
}
