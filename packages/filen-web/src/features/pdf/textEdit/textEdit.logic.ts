import type { TextEditTarget } from "@filen/office/dom/pdfedit/textEdit"

// Geometry and keys of the in-place PDF text editor. Targets come from the engine in page display space (points, y
// down); the page surface draws at `scale` CSS px per point.

type BundledFamily = TextEditTarget["font"]["family"]

// What the editor needs of a target; "Add text" makes one with empty text.
export type TextEditorSource = Pick<TextEditTarget, "text" | "frame" | "bounds" | "angle" | "size" | "color" | "font">

export interface TextEditorPlacement {
	// Top-left of the first line's box, CSS px from the page's top-left; the box turns about it by `angle` degrees.
	readonly left: number
	readonly top: number
	readonly width: number
	readonly height: number
	readonly angle: number
	readonly fontSize: number
	readonly lineHeight: number
}

// Of the font size, the part above the baseline the first line's box starts at.
const ASCENT = 0.9
// Room for the caret after the last glyph, CSS px.
const CARET_ROOM = 4

export function editorPlacement(source: TextEditorSource, scale: number): TextEditorPlacement {
	const { frame, size } = source
	const [dx, dy] = frame.direction
	const [ox, oy] = frame.origin
	// The box's width along the baseline: the frame's, or how far the glyphs reach from its start.
	const [x0, y0, x1, y1] = source.bounds
	const reach = Math.max(
		0,
		...[
			[x0, y0],
			[x1, y0],
			[x0, y1],
			[x1, y1]
		].map(([x, y]) => ((x ?? ox) - ox) * dx + ((y ?? oy) - oy) * dy)
	)
	const width = frame.width ?? reach
	const lines = Math.max(1, source.text.split("\n").length)

	return {
		left: (ox + ASCENT * size * dy) * scale,
		top: (oy - ASCENT * size * dx) * scale,
		width: width * scale + CARET_ROOM,
		height: (size * 1.2 + (lines - 1) * frame.lineHeight) * scale,
		angle: source.angle,
		fontSize: size * scale,
		lineHeight: frame.lineHeight * scale
	}
}

export function cssColor(rgb: number): string {
	return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`
}

const GENERIC: Readonly<Record<BundledFamily, string>> = {
	carlito: "sans-serif",
	caladea: "serif",
	arimo: "sans-serif",
	tinos: "serif",
	cousine: "monospace",
	gelasio: "serif",
	selawik: "sans-serif"
}

// The editor shows the text in the family it will be set in, where the page has it, else the same kind of face.
export function editorFontFamily(family: BundledFamily, label: string): string {
	return `"${label}", ${GENERIC[family]}`
}

export interface EditorKeyEvent {
	readonly key: string
	readonly metaKey: boolean
	readonly ctrlKey: boolean
	readonly altKey: boolean
	readonly shiftKey: boolean
	readonly isComposing: boolean
	// Milliseconds since the last composition ended (Infinity: none). Safari fires the keydown of the key that ends
	// a composition just after compositionend, no longer composing.
	readonly sinceCompositionEnd: number
}

const COMPOSITION_END_WINDOW_MS = 100

// Escape cancels, Mod+Enter finishes; keys belonging to an input method's composition never do either. Plain Enter
// is a line break.
export function editorKey(event: EditorKeyEvent, mac: boolean): "done" | "cancel" | null {
	if (event.isComposing || event.sinceCompositionEnd <= COMPOSITION_END_WINDOW_MS) return null
	if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return "cancel"

	const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey

	return event.key === "Enter" && mod && !event.altKey ? "done" : null
}

export function textRows(text: string): number {
	return Math.max(1, text.split("\n").length)
}

// --- The page surface and the engine's display space ---

// What a tool overlay knows of its page's geometry (pdf.js's viewport and the editor's share it).
export interface PageGeometry {
	readonly viewBox: readonly number[]
	readonly scale: number
	convertToViewportPoint(x: number, y: number): unknown[]
	convertToPdfPoint(x: number, y: number): unknown[]
}

// A point of the page box (CSS px from its top-left) in the engine's display space: points from the top-left of the
// page as shown (its crop box), y down.
export function surfaceToDisplay(geometry: PageGeometry, x: number, y: number): [number, number] {
	const [ux, uy] = geometry.convertToPdfPoint(x, y)
	const [x0 = 0, , , y1 = 0] = geometry.viewBox

	return [Number(ux) - x0, y1 - Number(uy)]
}

export function displayToSurface(geometry: PageGeometry, x: number, y: number): [number, number] {
	const [x0 = 0, , , y1 = 0] = geometry.viewBox
	const [sx, sy] = geometry.convertToViewportPoint(x + x0, y1 - y)

	return [Number(sx), Number(sy)]
}

// The CSS transform that lays content drawn at display space × `scale` (as the text editor places itself) onto the
// page box, whatever the view's rotation: display → surface without its scale, which the content applies.
export function displayTransform(geometry: PageGeometry): string {
	const [ox, oy] = displayToSurface(geometry, 0, 0)
	const [ax, ay] = displayToSurface(geometry, 1, 0)
	const [bx, by] = displayToSurface(geometry, 0, 1)
	const s = geometry.scale > 0 ? geometry.scale : 1
	const values = [(ax - ox) / s, (ay - oy) / s, (bx - ox) / s, (by - oy) / s, ox, oy]

	return `matrix(${values.map(String).join(", ")})`
}

// --- What an edit replaces ---

export interface TextChange {
	// The part of the target's text replaced, and what replaces it.
	readonly start: number
	readonly end: number
	readonly text: string
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_'’-]/u

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && WORD_CHAR.test(char)
}

// The words of `before` that `after` changes, as one span: the common start and end are kept, the rest widened to
// whole words, so an edited word is replaced alone and its neighbours stay as drawn. Null when nothing changed.
export function changedSpan(before: string, after: string): TextChange | null {
	if (before === after) return null

	let start = 0

	while (start < before.length && start < after.length && before[start] === after[start]) start++

	let end = before.length
	let endAfter = after.length

	while (end > start && endAfter > start && before[end - 1] === after[endAfter - 1]) {
		end--
		endAfter--
	}

	// Back to the start of the word the change begins in, on to the end of the word it ends in.
	// A word the change touches (inside it, or text joined to its end or start) is replaced whole.
	while (start > 0 && isWordChar(before[start - 1]) && (isWordChar(before[start]) || isWordChar(after[start]))) start--

	while (end < before.length && isWordChar(before[end]) && (isWordChar(before[end - 1]) || isWordChar(after[endAfter - 1]))) {
		end++
		endAfter++
	}

	// Text only inserted between words: it replaces the next word with itself and that word (the last word at the end).
	if (start === end) {
		if (end < before.length) {
			while (end < before.length && !isWordChar(before[end])) {
				end++
				endAfter++
			}

			while (end < before.length && isWordChar(before[end])) {
				end++
				endAfter++
			}
		} else {
			while (start > 0 && !isWordChar(before[start - 1])) start--

			while (start > 0 && isWordChar(before[start - 1])) start--
		}
	}

	return { start, end, text: after.slice(start, endAfter) }
}
