import { EditorSelection, type EditorState, type SelectionRange, type StateCommand } from "@codemirror/state"

// Markdown formatting for the editor's shortcuts (editor.bold and friends), as plain CodeMirror commands
// over every selection range.
export const MARKDOWN_MARKERS = {
	bold: "**",
	strikethrough: "~~",
	code: "`"
} as const

// Whether `range` is already wrapped in `marker`: "outside" when the markers sit just outside the
// selection, "inside" when they are its own first and last characters.
function wrapping(state: EditorState, range: SelectionRange, marker: string): "outside" | "inside" | null {
	const size = marker.length

	if (state.sliceDoc(range.from - size, range.from) === marker && state.sliceDoc(range.to, range.to + size) === marker) {
		return "outside"
	}

	const text = state.sliceDoc(range.from, range.to)

	return text.length >= size * 2 && text.startsWith(marker) && text.endsWith(marker) ? "inside" : null
}

// Wraps `range` in `marker`, or unwraps it when `wrapping` found it wrapped. An empty selection gets an
// empty pair with the cursor inside, and the cursor inside an empty pair takes the pair out again.
function toggleRange(range: SelectionRange, marker: string, wrapped: "outside" | "inside" | null) {
	const size = marker.length

	if (wrapped === "outside") {
		return {
			changes: [
				{ from: range.from - size, to: range.from },
				{ from: range.to, to: range.to + size }
			],
			range: EditorSelection.range(range.from - size, range.to - size)
		}
	}

	if (wrapped === "inside") {
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
}

export function toggleInlineMarker(marker: string): StateCommand {
	return ({ state, dispatch }) => {
		if (state.readOnly) {
			return false
		}

		const transaction = state.changeByRange(range => toggleRange(range, marker, wrapping(state, range, marker)))

		dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "input" }))

		return true
	}
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

// A single `*` pair, not one half of a bold `**` (which a `*` test alone would unwrap).
function italicStarWrapping(state: EditorState, range: SelectionRange): "outside" | "inside" | null {
	const wrapped = wrapping(state, range, "*")

	if (wrapped === "outside") {
		return state.sliceDoc(range.from - 2, range.from - 1) === "*" && state.sliceDoc(range.to + 1, range.to + 2) === "*" ? null : wrapped
	}

	return wrapped === "inside" && wrapping(state, range, "**") === "inside" ? null : wrapped
}

// Italic takes either marker off. It goes on as `_`, except mid-word (a word character right before or
// after the selection), where CommonMark ignores `_` and only `*` renders.
export const toggleItalic: StateCommand = ({ state, dispatch }) => {
	if (state.readOnly) {
		return false
	}

	const transaction = state.changeByRange(range => {
		const underscore = wrapping(state, range, "_")

		if (underscore !== null) {
			return toggleRange(range, "_", underscore)
		}

		const star = italicStarWrapping(state, range)

		if (star !== null) {
			return toggleRange(range, "*", star)
		}

		const midWord = WORD_CHAR.test(state.sliceDoc(range.from - 1, range.from)) || WORD_CHAR.test(state.sliceDoc(range.to, range.to + 1))

		return toggleRange(range, midWord ? "*" : "_", null)
	})

	dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "input" }))

	return true
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
