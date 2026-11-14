import type * as Mupdf from "mupdf"
import { matchPdfFont, type PdfFontMatch } from "../../../core/pdfedit/fontMatch"
import type { TextOverlayFrame } from "../../../core/pdfedit/textLayout"
import { readStext, type PdfQuad, type PdfRect, type StextChar, type StextLine, type StextPage } from "./stext"

// What a click on a page can edit: the text block (or line) under the point, read from MuPDF's structured text, with
// what the editor is prefilled with (text, size, colour, bold/italic, the closest bundled family) and the frame the
// new text is laid out in. Text that cannot be replaced faithfully is refused: glyphs drawn as shapes (no text under
// the point, but filled outlines), Type 3 fonts (glyphs are drawings), vertical writing, and baselines that bend
// (characters off their line, or lines of one block not parallel). Everything here is display space (points, y down,
// as the page is shown) and plain data, so a target crosses the worker boundary as it is.

export interface TextEditChar {
	readonly c: string
	readonly x: number
	readonly y: number
	readonly quad: PdfQuad
}

export interface TextEditTarget {
	// The text the editor starts with: the block's lines joined by line feeds, a space where glyphs leave a word gap.
	readonly text: string
	// The glyphs the edit replaces, in reading order, and each one's offset in `text`.
	readonly chars: readonly TextEditChar[]
	readonly offsets: readonly number[]
	// Where the new text goes (core/pdfedit/textLayout.ts); width null for a single line, which never wraps.
	readonly frame: TextOverlayFrame
	// Axis-aligned bounds of the glyphs, for placing the editor; `angle` is the baseline's rotation, degrees clockwise.
	readonly bounds: PdfRect
	readonly angle: number
	readonly size: number
	readonly color: number
	readonly font: PdfFontMatch
	// The document's font name, as MuPDF reports it.
	readonly fontName: string
	// The page's display size, the size of the overlay page the new text is laid out on.
	readonly pageWidth: number
	readonly pageHeight: number
}

export type TextEditRefusal = "cantEdit"

export type TextEditHit =
	| { readonly kind: "target"; readonly target: TextEditTarget }
	| { readonly kind: "refused"; readonly reason: TextEditRefusal }
	// Nothing at the point: the place for new text ("Add text").
	| { readonly kind: "none" }

export interface HitTestOptions {
	// "block" (default): the whole block under the point; "line": only the line.
	readonly unit?: "block" | "line"
}

// Points of slack around a block's box when hit-testing.
const HIT_SLACK = 2
// A character further off its line's baseline than this share of its size bends the line.
const BASELINE_TOLERANCE = 0.25
// Lines whose directions' cross product exceeds this are not parallel.
const PARALLEL_TOLERANCE = 0.02
// A gap wider than this share of the size between two glyphs is a word space.
const WORD_GAP = 0.2
// Filled outlines no taller than this (points) under the point read as text drawn as shapes.
const SHAPE_TEXT_MAX_HEIGHT = 72
const TYPE3_NAME = /^Type3\b/u

export function hitTestText(page: Mupdf.PDFPage, point: readonly [number, number], options: HitTestOptions = {}): TextEditHit {
	const stext = readStext(page)
	const [px, py] = point

	for (const block of stext.blocks) {
		if (!inside(block.bbox, px, py, HIT_SLACK) || block.lines.every(line => line.chars.length === 0)) continue

		const lines = options.unit === "line" ? block.lines.filter(line => inside(line.bbox, px, py, HIT_SLACK)).slice(0, 1) : block.lines
		const chosen = lines.length === 0 ? block.lines : lines
		const bounds = page.getBounds()

		return targetOf(stext, chosen, bounds[2], bounds[3])
	}

	// No text under the point: outlines there are text drawn as shapes (or a drawing; neither can be edited as text).
	const shapes = readStext(page, true).vectors.some(
		vector => !vector.rectangle && vector.bbox[3] - vector.bbox[1] <= SHAPE_TEXT_MAX_HEIGHT && inside(vector.bbox, px, py, 0)
	)

	return shapes ? { kind: "refused", reason: "cantEdit" } : { kind: "none" }
}

// The part of a target from text offset `start` to `end` (a word or a selection inside the block), laid out on the
// first selected glyph's baseline from its start edge, without wrapping. Null when the range holds no glyph.
export function narrowTarget(target: TextEditTarget, start: number, end: number): TextEditTarget | null {
	const chars: TextEditChar[] = []
	const offsets: number[] = []

	target.offsets.forEach((offset, index) => {
		const char = target.chars[index]

		if (char !== undefined && offset >= start && offset < end) {
			chars.push(char)
			offsets.push(offset - start)
		}
	})

	const first = chars[0]

	if (first === undefined) return null

	const [dx, dy] = target.frame.direction
	const startEdge = Math.min(...chars.map(char => along(char.quad[0], char.quad[1], first, dx, dy)))
	const origin: [number, number] = [first.x + startEdge * dx, first.y + startEdge * dy]

	return {
		...target,
		text: target.text.slice(start, end),
		chars,
		offsets,
		frame: { ...target.frame, origin, width: null },
		bounds: quadBounds(chars.map(char => char.quad))
	}
}

// The frame for new text placed at `point` (the top-left of the first line, display space), horizontal.
export function newTextFrame(point: readonly [number, number], size: number, width: number | null = null): TextOverlayFrame {
	return { origin: [point[0], point[1] + size * 0.8], direction: [1, 0], width, lineHeight: size * 1.2 }
}

function targetOf(stext: StextPage, lines: readonly StextLine[], pageWidth: number, pageHeight: number): TextEditHit {
	const used = lines.filter(line => line.chars.length > 0)
	const firstLine = used[0]
	const firstChar = firstLine?.chars[0]

	if (firstLine === undefined || firstChar === undefined) return { kind: "none" }

	const length = Math.hypot(firstLine.dir[0], firstLine.dir[1]) || 1
	const dx = firstLine.dir[0] / length
	const dy = firstLine.dir[1] / length

	for (const line of used) {
		if (line.wmode !== 0) return refused()
		if (Math.abs(line.dir[0] * dy - line.dir[1] * dx) > PARALLEL_TOLERANCE * Math.hypot(line.dir[0], line.dir[1])) return refused()

		const head = line.chars[0]

		for (const char of line.chars) {
			if (TYPE3_NAME.test(stext.fonts[char.font]?.name ?? "")) return refused()
			if (head !== undefined && Math.abs(across(char.x, char.y, head, dx, dy)) > BASELINE_TOLERANCE * Math.max(char.size, 1))
				return refused()
		}
	}

	let text = ""
	const chars: TextEditChar[] = []
	const offsets: number[] = []
	const styleCounts = new Map<string, { count: number; char: StextChar }>()
	let minAlong = Infinity
	let maxAlong = -Infinity

	used.forEach((line, index) => {
		if (index > 0) text += "\n"

		let previous: StextChar | undefined

		for (const char of logicalOrder(line, dx, dy)) {
			if (previous !== undefined && previous.c !== " " && char.c !== " " && gap(previous, char, dx, dy) > WORD_GAP * char.size)
				text += " "

			offsets.push(text.length)
			chars.push({ c: char.c, x: char.x, y: char.y, quad: char.quad })
			text += char.c
			previous = char

			const key = `${String(char.font)}/${String(Math.round(char.size * 10))}/${String(char.color)}`
			const style = styleCounts.get(key)

			if (style === undefined) styleCounts.set(key, { count: 1, char })
			else style.count++

			for (const [x, y] of [
				[char.quad[0], char.quad[1]],
				[char.quad[2], char.quad[3]]
			] as const) {
				const position = along(x, y, firstChar, dx, dy)

				minAlong = Math.min(minAlong, position)
				maxAlong = Math.max(maxAlong, position)
			}
		}
	})

	let dominant: StextChar = firstChar
	let best = 0

	for (const { count, char } of styleCounts.values()) {
		if (count > best) {
			best = count
			dominant = char
		}
	}

	const lastLine = used[used.length - 1] ?? firstLine
	const lastHead = lastLine.chars[0] ?? firstChar
	const lineHeight = used.length > 1 ? across(lastHead.x, lastHead.y, firstChar, dx, dy) / (used.length - 1) : dominant.size * 1.2
	const traits = stext.fonts[dominant.font] ?? { name: "", bold: false, italic: false, serif: false, mono: false }

	return {
		kind: "target",
		target: {
			text,
			chars,
			offsets,
			frame: {
				// The first line's baseline at the block's start edge.
				origin: [firstChar.x + minAlong * dx, firstChar.y + minAlong * dy],
				direction: [dx, dy],
				width: used.length > 1 ? maxAlong - minAlong : null,
				lineHeight: lineHeight > 0 ? lineHeight : dominant.size * 1.2
			},
			bounds: quadBounds(chars.map(char => char.quad)),
			angle: (Math.atan2(dy, dx) * 180) / Math.PI,
			size: dominant.size,
			color: dominant.color,
			font: matchPdfFont(traits),
			fontName: traits.name,
			pageWidth,
			pageHeight
		}
	}
}

function refused(): TextEditHit {
	return { kind: "refused", reason: "cantEdit" }
}

// Runs of right-to-left glyphs stored left to right (as most producers draw them) are reversed into reading order.
function logicalOrder(line: StextLine, dx: number, dy: number): StextChar[] {
	const out: StextChar[] = []
	const chars = line.chars

	for (let k = 0; k < chars.length;) {
		const char = chars[k]

		if (char === undefined) break

		if ((char.bidi & 1) === 0) {
			out.push(char)
			k++
			continue
		}

		let end = k

		while (end < chars.length && ((chars[end]?.bidi ?? 0) & 1) === 1) end++

		const run = chars.slice(k, end)
		const head = run[0]
		const tail = run[run.length - 1]
		const visual = head !== undefined && tail !== undefined && along(tail.x, tail.y, head, dx, dy) > 0

		out.push(...(visual ? run.reverse() : run))
		k = end
	}

	return out
}

function along(x: number, y: number, from: { readonly x: number; readonly y: number }, dx: number, dy: number): number {
	return (x - from.x) * dx + (y - from.y) * dy
}

function across(x: number, y: number, from: { readonly x: number; readonly y: number }, dx: number, dy: number): number {
	return (y - from.y) * dx - (x - from.x) * dy
}

// Distance along the baseline between two glyphs' facing edges.
function gap(a: StextChar, b: StextChar, dx: number, dy: number): number {
	const aEnd = Math.max(along(a.quad[0], a.quad[1], a, dx, dy), along(a.quad[2], a.quad[3], a, dx, dy))
	const aStart = Math.min(along(a.quad[0], a.quad[1], a, dx, dy), along(a.quad[2], a.quad[3], a, dx, dy))
	const bStart = Math.min(along(b.quad[0], b.quad[1], a, dx, dy), along(b.quad[2], b.quad[3], a, dx, dy))
	const bEnd = Math.max(along(b.quad[0], b.quad[1], a, dx, dy), along(b.quad[2], b.quad[3], a, dx, dy))

	return bStart >= aStart ? bStart - aEnd : aStart - bEnd
}

function inside(rect: PdfRect, x: number, y: number, slack: number): boolean {
	return x >= rect[0] - slack && x <= rect[2] + slack && y >= rect[1] - slack && y <= rect[3] + slack
}

export function quadBounds(quads: readonly PdfQuad[]): PdfRect {
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity

	for (const quad of quads) {
		for (let k = 0; k < 8; k += 2) {
			x0 = Math.min(x0, quad[k] ?? x0)
			x1 = Math.max(x1, quad[k] ?? x1)
			y0 = Math.min(y0, quad[k + 1] ?? y0)
			y1 = Math.max(y1, quad[k + 1] ?? y1)
		}
	}

	return [x0, y0, x1, y1]
}
