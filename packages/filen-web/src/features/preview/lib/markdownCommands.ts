import { EditorSelection, type StateCommand } from "@codemirror/state"

// Markdown formatting for the editor's shortcuts (editor.bold and friends), as plain CodeMirror commands
// over every selection range. Italic is `_`, not `*`: a `*` toggle would read the inner half of a bold
// `**` as its own marker and unwrap it.
export const MARKDOWN_MARKERS = {
	bold: "**",
	italic: "_",
	strikethrough: "~~",
	code: "`"
} as const

// Wraps each selection in `marker`, or unwraps it when it is already wrapped, the markers either just
// outside the selection or its own first and last characters. An empty selection gets an empty pair with
// the cursor inside, and the cursor inside an empty pair takes the pair out again.
export function toggleInlineMarker(marker: string): StateCommand {
	return ({ state, dispatch }) => {
		if (state.readOnly) {
			return false
		}

		const size = marker.length
		const transaction = state.changeByRange(range => {
			const text = state.sliceDoc(range.from, range.to)

			if (state.sliceDoc(range.from - size, range.from) === marker && state.sliceDoc(range.to, range.to + size) === marker) {
				return {
					changes: [
						{ from: range.from - size, to: range.from },
						{ from: range.to, to: range.to + size }
					],
					range: EditorSelection.range(range.from - size, range.to - size)
				}
			}

			if (text.length >= size * 2 && text.startsWith(marker) && text.endsWith(marker)) {
				return {
					changes: [
						{ from: range.from, to: range.from + size },
						{ from: range.to - size, to: range.to }
					],
					range: EditorSelection.range(range.from, range.to - size * 2)
				}
			}

			return {
				changes: [
					{ from: range.from, insert: marker },
					{ from: range.to, insert: marker }
				],
				range: EditorSelection.range(range.from + size, range.to + size)
			}
		})

		dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "input" }))

		return true
	}
}

const URL_PLACEHOLDER = "url"

// Turns each selection into a markdown link. Selected text becomes the label with the url placeholder
// selected, ready to be typed over; a selected url becomes the target with the cursor in the empty label;
// nothing selected gives an empty link with the cursor in its label.
export const insertLink: StateCommand = ({ state, dispatch }) => {
	if (state.readOnly) {
		return false
	}

	const transaction = state.changeByRange(range => {
		const text = state.sliceDoc(range.from, range.to)

		if (text.length === 0 || /^https?:\/\/\S+$/.test(text)) {
			const target = text.length === 0 ? URL_PLACEHOLDER : text

			return {
				changes: { from: range.from, to: range.to, insert: `[](${target})` },
				range: EditorSelection.cursor(range.from + 1)
			}
		}

		const urlStart = range.to + 3

		return {
			changes: [
				{ from: range.from, insert: "[" },
				{ from: range.to, insert: `](${URL_PLACEHOLDER})` }
			],
			range: EditorSelection.range(urlStart, urlStart + URL_PLACEHOLDER.length)
		}
	})

	dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "input" }))

	return true
}
