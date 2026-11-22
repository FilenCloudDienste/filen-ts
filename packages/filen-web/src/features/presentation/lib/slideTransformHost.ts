import { replaceSlideText, slidePlainRange, slideRangeText, type TextEditing } from "@filen/office/react/presentation"
import type { TransformHost } from "@/features/assistant/transform/host"

// The selection transform's side of a deck's text editing: the body open in the text editor (a slide's or the speaker
// notes', which share the store), a selection of plain text only (a slide number, a date field or math would be lost),
// replaced as one transaction the controller sends as its own undo step. Also the deck's selection reader for the
// assistant's document context (read-only decks too: it only reads).

// The open editor's element on the page (one body is edited at a time).
function editorElement(): HTMLElement | null {
	return document.querySelector<HTMLElement>("[data-fo-text-editor]")
}

// Where the painted selection is on screen: the union of its highlight boxes, else the body's box.
function paintedSelectionRect(): DOMRect | null {
	const box = editorElement()?.querySelector<HTMLElement>(".fo-text-edit-box") ?? null

	if (box === null) {
		return null
	}

	const marks = [...(box.children[1]?.children ?? [])].map(mark => mark.getBoundingClientRect()).filter(rect => rect.width > 0)

	if (marks.length === 0) {
		return box.getBoundingClientRect()
	}

	const left = Math.min(...marks.map(rect => rect.left))
	const top = Math.min(...marks.map(rect => rect.top))

	return new DOMRect(left, top, Math.max(...marks.map(rect => rect.right)) - left, Math.max(...marks.map(rect => rect.bottom)) - top)
}

function focusEditor(): void {
	editorElement()?.querySelector<HTMLElement>(".fo-text-sink [contenteditable]")?.focus({ preventScroll: true })
}

export function slideTransform(text: TextEditing, editable: () => boolean): TransformHost {
	const selected = (): string => {
		const state = text.active?.state

		return state === undefined || state.selection.empty ? "" : slideRangeText(state.doc, state.selection)
	}

	return {
		selectedChars: () => selected().length,
		selectedText: () => selected(),
		selection: () => {
			const controller = text.active

			if (controller === undefined || controller.closed || !editable() || controller.state.selection.empty) {
				return null
			}

			const doc = controller.state.doc
			const range = { from: controller.state.selection.from, to: controller.state.selection.to }

			if (!slidePlainRange(doc, range)) {
				return "unsupported"
			}

			const current = () => text.active === controller && !controller.closed && controller.state.doc === doc

			return {
				text: slideRangeText(doc, range),
				current,
				replace: (replacement: string) => {
					const tr = current() ? replaceSlideText(controller.state, range, replacement) : null

					if (tr === null) {
						return null
					}

					// Not typing: a burst of its own, so one undo takes it back.
					controller.dispatch(tr)
					void text.flush()
					focusEditor()

					return { undo: null }
				},
				rect: () => (current() ? paintedSelectionRect() : null)
			}
		},
		selectionRect: () => (text.active === undefined || text.active.state.selection.empty ? null : paintedSelectionRect()),
		focus: focusEditor
	}
}
