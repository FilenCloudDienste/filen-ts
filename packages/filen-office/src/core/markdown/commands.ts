import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange, type StateCommand } from "@codemirror/state"

// Markdown formatting for the editor's shortcuts (editor.bold and friends), as plain CodeMirror commands
// over every selection range.
export const MARKDOWN_MARKERS = {
	bold: "**",
	strikethrough: "~~",
	code: "`"
} as const

type Span = { from: number; to: number }
type Deletion = { from: number; to: number }

// One formatting toggle over a span of text: the deletions that take the formatting off (null when the
// span is not formatted), and the strings that put it on.
type Format = {
	unwrap: (state: EditorState, span: Span) => Deletion[] | null
	wrap: (state: EditorState, span: Span) => { open: string; close: string }
	// Code spans may hold a line break, so they split only at blank lines; emphasis splits at every line.
	joinLines: boolean
}

const SPACE = /\s/u

// The non-blank, whitespace-trimmed parts of [from, to]: one per line, or one per paragraph with
// `joinLines`. CommonMark ignores a closing delimiter preceded by whitespace, and no inline span crosses
// a paragraph, so markers only ever go around these.
function segments(state: EditorState, from: number, to: number, joinLines: boolean): Span[] {
	const text = state.sliceDoc(from, to)
	const spans: Span[] = []
	let lineStart = 0
	let previousBlank = true

	while (lineStart <= text.length) {
		const newline = text.indexOf("\n", lineStart)
		const lineEnd = newline === -1 ? text.length : newline
		let start = lineStart
		let end = lineEnd

		while (start < end && SPACE.test(text.charAt(start))) {
			start++
		}

		while (end > start && SPACE.test(text.charAt(end - 1))) {
			end--
		}

		const last = spans[spans.length - 1]

		if (start === end) {
			previousBlank = true
		} else if (joinLines && !previousBlank && last !== undefined) {
			last.to = from + end
		} else {
			spans.push({ from: from + start, to: from + end })
			previousBlank = false
		}

		if (newline === -1) {
			break
		}

		lineStart = newline + 1
	}

	return spans
}

// Toggles `format` on one selection range. Every non-blank line (or paragraph) is formatted on its
// own; the selection is taken off only when every part is formatted, otherwise the unformatted parts
// get it. A selection that is exactly one part keeps the content selected with the markers outside it;
// any other keeps covering the whole edited span so a second toggle finds the same parts.
function toggleFormat(range: SelectionRange, state: EditorState, format: Format) {
	const spans = range.empty ? [] : segments(state, range.from, range.to, format.joinLines)

	if (spans.length === 0) {
		// Nothing but whitespace (or nothing) selected: an empty pair at the cursor, or the cursor inside
		// an empty pair takes the pair out again.
		const cursor = { from: range.head, to: range.head }
		const deletions = format.unwrap(state, cursor)

		if (deletions !== null) {
			const changes = state.changes(deletions)

			return { changes, range: EditorSelection.cursor(changes.mapPos(range.head, -1)) }
		}

		const { open, close } = format.wrap(state, cursor)

		return {
			changes: { from: range.head, insert: open + close },
			range: EditorSelection.cursor(range.head + open.length)
		}
	}

	const unwraps = spans.map(span => format.unwrap(state, span))
	const allWrapped = unwraps.every(deletions => deletions !== null)
	const changes = state.changes(
		spans.flatMap((span, index): ChangeSpec[] => {
			const deletions = unwraps[index] ?? null

			if (allWrapped) {
				return deletions ?? []
			}

			if (deletions !== null) {
				return []
			}

			const { open, close } = format.wrap(state, span)

			return [
				{ from: span.from, insert: open },
				{ from: span.to, insert: close }
			]
		})
	)
	const only = spans.length === 1 ? spans[0] : undefined
	const exact = only !== undefined && only.from === range.from && only.to === range.to

	return {
		changes,
		range: EditorSelection.range(changes.mapPos(range.from, exact ? 1 : -1), changes.mapPos(range.to, exact ? -1 : 1))
	}
}

// Whether `span` is already wrapped in `marker`: "outside" when the markers sit just outside it,
// "inside" when they are its own first and last characters.
function wrapping(state: EditorState, span: Span, marker: string): "outside" | "inside" | null {
	const size = marker.length

	if (state.sliceDoc(span.from - size, span.from) === marker && state.sliceDoc(span.to, span.to + size) === marker) {
		return "outside"
	}

	const text = state.sliceDoc(span.from, span.to)

	return text.length >= size * 2 && text.startsWith(marker) && text.endsWith(marker) ? "inside" : null
}

function markerDeletions(span: Span, marker: string, wrapped: "outside" | "inside"): Deletion[] {
	const size = marker.length

	return wrapped === "outside"
		? [
				{ from: span.from - size, to: span.from },
				{ from: span.to, to: span.to + size }
			]
		: [
				{ from: span.from, to: span.from + size },
				{ from: span.to - size, to: span.to }
			]
}

// A command applying `edit` to every selection range as one user input.
function byRange(edit: (range: SelectionRange, state: EditorState) => { changes: ChangeSpec; range: SelectionRange }): StateCommand {
	return ({ state, dispatch }) => {
		if (state.readOnly) {
			return false
		}

		dispatch(
			state.update(
				state.changeByRange(range => edit(range, state)),
				{ scrollIntoView: true, userEvent: "input" }
			)
		)

		return true
	}
}

function backtickRunBefore(state: EditorState, pos: number): number {
	let start = pos

	while (start > 0 && state.sliceDoc(start - 1, start) === "`") {
		start--
	}

	return pos - start
}

function backtickRunAfter(state: EditorState, pos: number): number {
	const length = state.doc.length
	let end = pos

	while (end < length && state.sliceDoc(end, end + 1) === "`") {
		end++
	}

	return end - pos
}

// The backtick runs in `text`: the longest one, and whether one is exactly `size` long (which would
// close a code span with a `size` fence early).
function backtickRuns(text: string, size: number): { longest: number; hasSize: boolean } {
	let longest = 0
	let hasSize = false
	let run = 0

	for (let index = 0; index <= text.length; index++) {
		if (text.charCodeAt(index) === 96) {
			run++

			continue
		}

		if (run > 0) {
			longest = Math.max(longest, run)
			hasSize ||= run === size
			run = 0
		}
	}

	return { longest, hasSize }
}

// Inline code per CommonMark 6.1: the fence is one backtick longer than the longest run inside, and
// content starting or ending with a backtick gets one space of padding on each side (which a renderer
// strips again). Unwrapping takes off both fences in full, with their padding.
const inlineCode: Format = {
	joinLines: true,
	unwrap: (state, span) => {
		const text = state.sliceDoc(span.from, span.to)
		const lead = text.length - text.replace(/^`+/u, "").length

		if (lead > 0 && lead < text.length) {
			const trail = text.length - text.replace(/`+$/u, "").length
			let start = lead
			let end = text.length - trail

			if (trail === lead) {
				if (
					end - start >= 2 &&
					text.charAt(start) === " " &&
					text.charAt(end - 1) === " " &&
					text.slice(start, end).trim() !== ""
				) {
					start++
					end--
				}

				if (!backtickRuns(text.slice(start, end), lead).hasSize) {
					return [
						{ from: span.from, to: span.from + start },
						{ from: span.from + end, to: span.to }
					]
				}
			}
		}

		const before = backtickRunBefore(state, span.from)

		if (before > 0 && before === backtickRunAfter(state, span.to)) {
			return backtickRuns(text, before).hasSize
				? null
				: [
						{ from: span.from - before, to: span.from },
						{ from: span.to, to: span.to + before }
					]
		}

		if (
			(text.startsWith("`") || text.endsWith("`")) &&
			state.sliceDoc(span.from - 1, span.from) === " " &&
			state.sliceDoc(span.to, span.to + 1) === " "
		) {
			const fence = backtickRunBefore(state, span.from - 1)

			if (fence > 0 && fence === backtickRunAfter(state, span.to + 1) && !backtickRuns(text, fence).hasSize) {
				return [
					{ from: span.from - 1 - fence, to: span.from },
					{ from: span.to, to: span.to + 1 + fence }
				]
			}
		}

		return null
	},
	wrap: (state, span) => {
		const text = state.sliceDoc(span.from, span.to)
		const fence = "`".repeat(backtickRuns(text, 0).longest + 1)
		const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""

		return { open: fence + pad, close: pad + fence }
	}
}

function markerFormat(marker: string): Format {
	return {
		joinLines: false,
		unwrap: (state, span) => {
			const wrapped = wrapping(state, span, marker)

			return wrapped === null ? null : markerDeletions(span, marker, wrapped)
		},
		wrap: () => ({ open: marker, close: marker })
	}
}

// The code marker gets the CommonMark code-span rules; every other marker is a plain symmetric pair.
export function toggleInlineMarker(marker: string): StateCommand {
	const format = marker === MARKDOWN_MARKERS.code ? inlineCode : markerFormat(marker)

	return byRange((range, state) => toggleFormat(range, state, format))
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

// A single `*` pair, not one half of a bold `**` (which a `*` test alone would unwrap).
function italicStarWrapping(state: EditorState, span: Span): "outside" | "inside" | null {
	const wrapped = wrapping(state, span, "*")

	if (wrapped === "outside") {
		return state.sliceDoc(span.from - 2, span.from - 1) === "*" && state.sliceDoc(span.to + 1, span.to + 2) === "*" ? null : wrapped
	}

	return wrapped === "inside" && wrapping(state, span, "**") === "inside" ? null : wrapped
}

// Italic takes either marker off. It goes on as `_`, except mid-word (a word character right before or
// after the trimmed span), where CommonMark ignores `_` and only `*` renders.
const italic: Format = {
	joinLines: false,
	unwrap: (state, span) => {
		const underscore = wrapping(state, span, "_")

		if (underscore !== null) {
			return markerDeletions(span, "_", underscore)
		}

		const star = italicStarWrapping(state, span)

		return star === null ? null : markerDeletions(span, "*", star)
	},
	wrap: (state, span) => {
		const marker =
			WORD_CHAR.test(state.sliceDoc(span.from - 1, span.from)) || WORD_CHAR.test(state.sliceDoc(span.to, span.to + 1)) ? "*" : "_"

		return { open: marker, close: marker }
	}
}

export const toggleItalic: StateCommand = byRange((range, state) => toggleFormat(range, state, italic))

const URL_PLACEHOLDER = "url"

// Turns each selection into a markdown link. Selected text becomes the label with the url placeholder
// selected, ready to be typed over; a selected url becomes the target with the cursor in the empty label;
// nothing selected gives an empty link with the cursor in its label.
export const insertLink: StateCommand = byRange((range, state) => {
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
