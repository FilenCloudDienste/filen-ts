import type { SheetRenderStyle } from "../../../core/sheet/protocol"
import type { GridCanvas } from "./canvas"

// Text in cells: the canvas font of a render style, widths measured once per font and text, and a cell's text laid
// out into lines of styled fragments (rich runs, wrapping at spaces, hard breaks only when wrapping, as Excel).

export const PX_PER_POINT = 4 / 3
export const DEFAULT_POINTS = 11

// A family named in a file reaches the canvas font only as a quoted name of plain characters; anything else falls
// back to the theme's stack.
const SAFE_FAMILY = /^[\p{L}\p{N} ._-]{1,64}$/u

export function fontFamily(name: string | undefined, fallback: string): string {
	return name !== undefined && SAFE_FAMILY.test(name) ? `"${name}", ${fallback}` : fallback
}

export interface TextFont {
	readonly css: string
	// Pixels on screen.
	readonly px: number
}

export function textFont(style: SheetRenderStyle, base: SheetRenderStyle, fallback: string, scale: number): TextFont {
	const points = style.size ?? base.size ?? DEFAULT_POINTS
	const script = style.script !== undefined ? 0.65 : 1
	const px = Math.max(1, Math.round(points * PX_PER_POINT * scale * script * 100) / 100)

	return {
		css: `${style.italic === true ? "italic " : ""}${style.bold === true ? "bold " : ""}${String(px)}px ${fontFamily(style.font ?? base.font, fallback)}`,
		px
	}
}

const MEASURE_LIMIT = 8192

// Widths by font then text; each font's table is emptied once it holds MEASURE_LIMIT texts.
export class TextMeasurer {
	private readonly widths = new Map<string, Map<string, number>>()
	private font = ""

	private readonly canvas: GridCanvas

	constructor(canvas: GridCanvas) {
		this.canvas = canvas
	}

	width(font: string, text: string): number {
		let table = this.widths.get(font)

		if (table === undefined) {
			table = new Map()
			this.widths.set(font, table)
		}

		let width = table.get(text)

		if (width === undefined) {
			if (table.size >= MEASURE_LIMIT) table.clear()
			if (this.font !== font) {
				this.canvas.font = font
				this.font = font
			}

			width = this.canvas.measureText(text).width
			table.set(text, width)
		}

		return width
	}

	// A width not kept in the table: probes for a break point, which would otherwise crowd out every other text's.
	measureUncached(font: string, text: string): number {
		this.use(font)

		return this.canvas.measureText(text).width
	}

	// Sets the canvas's font, when it is not that already.
	use(font: string): void {
		if (this.font !== font) {
			this.canvas.font = font
			this.font = font
		}
	}

	// The canvas's font was set elsewhere.
	reset(): void {
		this.font = ""
	}
}

export interface TextFragment {
	readonly text: string
	readonly style: SheetRenderStyle
	readonly font: TextFont
	readonly width: number
}

export interface TextLine {
	readonly fragments: readonly TextFragment[]
	readonly width: number
	// The tallest fragment's font size on the line.
	readonly px: number
}

// A run of the text: from `start` (UTF-16) to the next run's start, in `style` merged over the cell's.
export interface TextRun {
	readonly start: number
	readonly style: SheetRenderStyle
}

function pieces(text: string, runs: readonly TextRun[] | null, cell: SheetRenderStyle): { text: string; style: SheetRenderStyle }[] {
	if (runs === null || runs.length === 0) return [{ text, style: cell }]

	const out: { text: string; style: SheetRenderStyle }[] = []
	const first = runs[0]?.start ?? 0

	if (first > 0) out.push({ text: text.slice(0, first), style: cell })

	for (let i = 0; i < runs.length; i++) {
		const run = runs[i] as TextRun
		const end = i + 1 < runs.length ? (runs[i + 1]?.start ?? text.length) : text.length

		if (end > run.start) out.push({ text: text.slice(run.start, end), style: { ...cell, ...run.style } })
	}

	return out
}

export interface LayoutOptions {
	readonly wrap: boolean
	// The width lines break at (wrap only).
	readonly width: number
	readonly base: SheetRenderStyle
	readonly fallback: string
	readonly scale: number
}

// The lines a cell's text draws as. Without wrapping, line breaks in the text show as nothing (Excel draws the
// text on one line).
function nextPoint(text: string, at: number): number {
	return at + ((text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1)
}

function previousPoint(text: string, at: number): number {
	const low = text.charCodeAt(at - 1)

	return low >= 0xdc00 && low <= 0xdfff && at >= 2 && (text.charCodeAt(at - 2) & 0xfc00) === 0xd800 ? at - 2 : at - 1
}

function advance(text: string, at: number, count: number): number {
	let position = at

	for (let k = 0; k < count && position < text.length; k++) position = nextPoint(text, position)

	return position
}

function codePoints(text: string, from: number, to: number): number {
	let count = 0

	for (let position = from; position < to; position = nextPoint(text, position)) count++

	return count
}

// fitPrefix's width of the prefix it returns.
let fitWidth = 0

// The end of the longest prefix of text from start that fits in width, at least one code point. Probes `hint` code
// points first (the previous line's length, so even lines take about two measurements), gallops from there up or
// down and bisects the last step; probes are not cached.
function fitPrefix(measurer: TextMeasurer, font: string, text: string, start: number, width: number, hint: number): number {
	const first = nextPoint(text, start)
	const measure = (end: number): number => measurer.measureUncached(font, text.slice(start, end))
	let low = first
	let lowWidth = Number.NaN
	let high = -1
	const guess = advance(text, start, Math.max(1, hint))
	const guessWidth = guess > first ? measure(guess) : Number.NaN

	if (guess > first && guessWidth > width) {
		high = guess

		for (let step = 1; ; step *= 2) {
			let probe = high

			for (let k = 0; k < step && probe > first; k++) probe = previousPoint(text, probe)

			if (probe <= first) break

			const probeWidth = measure(probe)

			if (probeWidth <= width) {
				low = probe
				lowWidth = probeWidth
				break
			}

			high = probe
		}
	} else {
		if (guess > first) {
			low = guess
			lowWidth = guessWidth
		}

		for (let step = 1; low < text.length; step *= 2) {
			const probe = advance(text, low, step)
			const probeWidth = measure(probe)

			if (probeWidth > width) {
				high = probe
				break
			}

			low = probe
			lowWidth = probeWidth
		}
	}

	if (high >= 0) {
		for (;;) {
			let middle = (low + high) >>> 1

			if (middle > low && (text.charCodeAt(middle) & 0xfc00) === 0xdc00 && (text.charCodeAt(middle - 1) & 0xfc00) === 0xd800) middle--
			if (middle <= low) middle = nextPoint(text, low)
			if (middle >= high) break

			const middleWidth = measure(middle)

			if (middleWidth <= width) {
				low = middle
				lowWidth = middleWidth
			} else {
				high = middle
			}
		}
	}

	fitWidth = Number.isNaN(lowWidth) ? measure(low) : lowWidth

	return low
}

export function layoutText(
	measurer: TextMeasurer,
	text: string,
	runs: readonly TextRun[] | null,
	cell: SheetRenderStyle,
	options: LayoutOptions
): TextLine[] {
	const lines: TextLine[] = []
	let fragments: TextFragment[] = []
	let width = 0
	let px = textFont(cell, options.base, options.fallback, options.scale).px

	const flush = (): void => {
		lines.push({ fragments, width, px })
		fragments = []
		width = 0
		px = textFont(cell, options.base, options.fallback, options.scale).px
	}

	const place = (piece: string, style: SheetRenderStyle, font: TextFont, known?: number): void => {
		if (piece === "") return

		const pieceWidth = known ?? measurer.width(font.css, piece)
		const last = fragments[fragments.length - 1]

		if (last !== undefined && last.style === style) {
			fragments[fragments.length - 1] = { text: last.text + piece, style, font, width: last.width + pieceWidth }
		} else {
			fragments.push({ text: piece, style, font, width: pieceWidth })
		}

		width += pieceWidth
		px = Math.max(px, font.px)
	}

	for (const { text: part, style } of pieces(text, runs, cell)) {
		const font = textFont(style, options.base, options.fallback, options.scale)

		if (!options.wrap) {
			place(part.replace(/\r?\n|\r/gu, ""), style, font)
			continue
		}

		const paragraphs = part.split(/\r?\n|\r/u)

		paragraphs.forEach((paragraph, p) => {
			if (p > 0) flush()

			// Words with the spaces after them, so a break never starts a line with a space.
			for (const word of paragraph.match(/\S+\s*|\s+/gu) ?? []) {
				const wordWidth = measurer.width(font.css, word.trimEnd())

				if (width > 0 && width + wordWidth > options.width) flush()

				if (wordWidth <= options.width || width > 0) {
					place(word, style, font)
					continue
				}

				// A word longer than the line breaks between characters; the spaces after it stay on its last line.
				const core = word.trimEnd()
				let start = 0
				let hint = 1

				for (;;) {
					const end = fitPrefix(measurer, font.css, core, start, options.width, hint)

					place(core.slice(start, end), style, font, fitWidth)

					if (end >= core.length) break

					flush()
					hint = codePoints(core, start, end)
					start = end
				}

				place(word.slice(core.length), style, font)
			}
		})
	}

	if (fragments.length > 0 || lines.length === 0) flush()

	return lines
}
