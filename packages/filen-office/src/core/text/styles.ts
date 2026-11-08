import { cssFont, type LineSpacingRule, type ResolvedFont } from "../fonts/index"
import { lineAscentDescent } from "../fonts/metrics"
import type { MeasureCache } from "./measure"

export const Caps = { NONE: 0, CAPS: 1, SMALL_CAPS: 2 } as const

export type Caps = (typeof Caps)[keyof typeof Caps]

// Decoration key slots per style in StyleTable.decorations.
export const DECORATION_SLOTS = 5

export const Strike = { NONE: 0, SINGLE: 1, DOUBLE: 2 } as const

export type Strike = (typeof Strike)[keyof typeof Strike]

// Where a style's emphasis marks go (w:em): the line keeps room for them there.
export const MarkRoom = { NONE: 0, ABOVE: 1, BELOW: 2 } as const

export type MarkRoom = (typeof MarkRoom)[keyof typeof MarkRoom]

// The room kept for emphasis marks, as a share of the style's ascent + descent (LibreOffice keeps a quarter of the
// font's line height). Not documented for Word; to calibrate.
export const MARK_ROOM = 0.25

// Lower-case letters of a small-caps run are drawn as capitals at this fraction of the size. Not
// documented for Word; to calibrate.
export const SMALL_CAPS_SCALE = 0.7

// Formatting the layout needs, in px. Decoration fields are keys the caller interns (0 = none): the layout
// only merges equal keys into spans, the renderer maps them to colours and styles.
export interface TextStyle {
	readonly font: ResolvedFont
	// Font size before the substitute's scale.
	readonly size: number
	// Kerning on (Word: w:kern threshold reached). Default true.
	readonly kerning?: boolean
	// Added after every character (w:spacing). Default 0.
	readonly letterSpacing?: number
	// Horizontal glyph scale (w:w / 100). Default 1.
	readonly scaleX?: number
	readonly caps?: Caps
	// Baseline raised (positive) or lowered (w:position, superscript and subscript).
	readonly baselineShift?: number
	readonly underline?: number
	// Underline words only, not the spaces between them.
	readonly underlineWords?: boolean
	readonly strike?: Strike
	readonly highlight?: number
	readonly shading?: number
	readonly border?: number
	// Emphasis marks over or under the text. Default none.
	readonly marks?: MarkRoom
}

// Superscript and subscript as Word draws them by default (w:vertAlign): size and baseline shift as
// fractions of the run's size. Not documented; to calibrate.
export const SUPERSCRIPT_SIZE = 2 / 3
export const SUPERSCRIPT_RISE = 1 / 3
export const SUBSCRIPT_SIZE = 2 / 3
export const SUBSCRIPT_DROP = 0.14

export function verticalAlignment(size: number, kind: "superscript" | "subscript"): { size: number; baselineShift: number } {
	return kind === "superscript"
		? { size: size * SUPERSCRIPT_SIZE, baselineShift: size * SUPERSCRIPT_RISE }
		: { size: size * SUBSCRIPT_SIZE, baselineShift: -size * SUBSCRIPT_DROP }
}

// Ascent and descent in em of a face's default line, adding up to lineSpacingUnits().
export function lineExtents(font: ResolvedFont, rule: LineSpacingRule): { ascent: number; descent: number } | null {
	const m = font.metrics

	if (m === null || m.unitsPerEm <= 0) return null

	const { ascent, descent } = lineAscentDescent(m, rule)

	return { ascent: ascent / m.unitsPerEm, descent: descent / m.unitsPerEm }
}

// Styles interned by identity, with what layout reads per item precomputed into typed arrays.
export class StyleTable {
	readonly cache: MeasureCache
	readonly rule: LineSpacingRule
	private readonly ids = new Map<TextStyle, number>()
	private readonly list: TextStyle[] = []

	// Per style, by index.
	fontKey = new Int32Array(16)
	smallFontKey = new Int32Array(16)
	ascent = new Float64Array(16)
	descent = new Float64Array(16)
	spaceWidth = new Float64Array(16)
	letterSpacing = new Float64Array(16)
	scaleX = new Float64Array(16)
	shift = new Float64Array(16)
	// Room kept above and below the text for emphasis marks (px; 0 without).
	markAbove = new Float64Array(16)
	markBelow = new Float64Array(16)
	caps = new Uint8Array(16)
	// Decoration keys, DECORATION_SLOTS per style: shading, highlight, border, underline, strike.
	decorations = new Int32Array(16 * DECORATION_SLOTS)
	underlineWords = new Uint8Array(16)
	// Any decoration key set.
	decorated = new Uint8Array(16)
	// Em size actually drawn (substitute scale applied).
	em = new Float64Array(16)
	private hyphen = new Float64Array(16)

	constructor(cache: MeasureCache, rule: LineSpacingRule = "gdi") {
		this.cache = cache
		this.rule = rule
	}

	get count(): number {
		return this.list.length
	}

	add(style: TextStyle): number {
		let id = this.ids.get(style)

		if (id !== undefined) return id

		id = this.list.length

		if (id === this.fontKey.length) this.grow()

		const kerning = style.kerning ?? true
		const css = cssFont(style.font, style.size)
		const fontKey = this.cache.font(css, kerning)
		const em = style.size * style.font.scale
		// Published metrics of the original describe it at the nominal size; others the face as drawn.
		const metricsEm = style.font.metricsBasis === "original" ? style.size : em
		const extents = lineExtents(style.font, this.rule)
		const scaleX = style.scaleX ?? 1
		const letterSpacing = style.letterSpacing ?? 0

		this.ids.set(style, id)
		this.list.push(style)
		this.fontKey[id] = fontKey
		this.smallFontKey[id] =
			style.caps === Caps.SMALL_CAPS ? this.cache.font(cssFont(style.font, style.size * SMALL_CAPS_SCALE), kerning) : fontKey
		this.em[id] = em

		if (extents === null) {
			const measured = this.cache.measurer.fontExtents(css)

			this.ascent[id] = measured.ascent
			this.descent[id] = measured.descent
		} else {
			this.ascent[id] = extents.ascent * metricsEm
			this.descent[id] = extents.descent * metricsEm
		}

		const room =
			style.marks === undefined || style.marks === MarkRoom.NONE ? 0 : MARK_ROOM * ((this.ascent[id] ?? 0) + (this.descent[id] ?? 0))

		this.markAbove[id] = style.marks === MarkRoom.ABOVE ? room : 0
		this.markBelow[id] = style.marks === MarkRoom.BELOW ? room : 0
		this.letterSpacing[id] = letterSpacing
		this.scaleX[id] = scaleX
		this.shift[id] = style.baselineShift ?? 0
		this.caps[id] = style.caps ?? Caps.NONE

		const keys = [style.shading ?? 0, style.highlight ?? 0, style.border ?? 0, style.underline ?? 0, style.strike ?? 0]

		this.decorations.set(keys, id * DECORATION_SLOTS)
		this.underlineWords[id] = style.underlineWords === true ? 1 : 0
		this.decorated[id] = keys.some(key => key !== 0) ? 1 : 0
		this.spaceWidth[id] = Math.max(0, this.cache.width(fontKey, " ", 0, 1) + letterSpacing) * scaleX
		this.hyphen[id] = Number.NaN

		return id
	}

	get(id: number): TextStyle {
		const style = this.list[id]

		if (style === undefined) throw new RangeError(`No text style ${id}`)

		return style
	}

	// Width of the hyphen shown where a line breaks at a soft hyphen or hyphenation point.
	hyphenWidth(id: number): number {
		let width = this.hyphen[id] ?? Number.NaN

		if (Number.isNaN(width)) {
			width = Math.max(0, this.cache.width(this.fontKey[id] ?? 0, "-", 0, 1) + (this.letterSpacing[id] ?? 0)) * (this.scaleX[id] ?? 1)
			this.hyphen[id] = width
		}

		return width
	}

	private grow(): void {
		const size = this.fontKey.length * 2
		const int32 = (a: Int32Array): Int32Array<ArrayBuffer> => {
			const out = new Int32Array(size)

			out.set(a)

			return out
		}
		const float64 = (a: Float64Array): Float64Array<ArrayBuffer> => {
			const out = new Float64Array(size)

			out.set(a)

			return out
		}
		const caps = new Uint8Array(size)
		const decorations = new Int32Array(size * DECORATION_SLOTS)
		const underlineWords = new Uint8Array(size)
		const decorated = new Uint8Array(size)

		decorations.set(this.decorations)
		underlineWords.set(this.underlineWords)
		decorated.set(this.decorated)
		this.decorations = decorations
		this.underlineWords = underlineWords
		this.decorated = decorated

		caps.set(this.caps)
		this.fontKey = int32(this.fontKey)
		this.smallFontKey = int32(this.smallFontKey)
		this.ascent = float64(this.ascent)
		this.descent = float64(this.descent)
		this.spaceWidth = float64(this.spaceWidth)
		this.letterSpacing = float64(this.letterSpacing)
		this.scaleX = float64(this.scaleX)
		this.shift = float64(this.shift)
		this.markAbove = float64(this.markAbove)
		this.markBelow = float64(this.markBelow)
		this.em = float64(this.em)
		this.hyphen = float64(this.hyphen)
		this.caps = caps
	}
}
