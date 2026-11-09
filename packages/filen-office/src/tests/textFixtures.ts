import { verticalMetrics, type ResolvedFont } from "../core/fonts/index"
import {
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FRAGMENT_LEVEL_SHIFT,
	LINE_FLOATS,
	LINE_INTS,
	LayoutCursor,
	LineRule,
	MeasureCache,
	ParagraphBuilder,
	ParagraphLayouter,
	StyleTable,
	TextLayout,
	type FontExtents,
	type ParagraphGeometry,
	type PrepareOptions,
	type TextMeasurer,
	type TextStyle
} from "../core/text/index"

// A deterministic measurer: advances in em per character class, a kerning pair, sizes from the CSS font.
export class FakeMeasurer implements TextMeasurer {
	kerningControl: boolean
	calls = 0
	fontSwitches = 0
	strings = 0
	private font = ""

	constructor(kerningControl = true) {
		this.kerningControl = kerningControl
	}

	static advance(c: number): number {
		if (c === 0x20 || c === 0xa0) return 0.25
		if (c === 0x69 || c === 0x6c || c === 0x2e || c === 0x2c || c === 0x2d) return 0.25
		if (c === 0x6d || c === 0x77 || c === 0x4d || c === 0x57) return 0.75
		if (c === 0xad || (c >= 0x200b && c <= 0x200f) || (c >= 0x300 && c < 0x370)) return 0
		if ((c >= 0x2e80 && c < 0xa000) || (c >= 0xff00 && c < 0xff61) || (c >= 0xac00 && c < 0xd7b0)) return 1

		return 0.5
	}

	static width(text: string, size: number, kerning: boolean): number {
		let em = 0

		for (let i = 0; i < text.length; i++) {
			em += FakeMeasurer.advance(text.charCodeAt(i))

			if (kerning && text[i] === "A" && text[i + 1] === "V") em -= 0.1
		}

		return em * size
	}

	measure(font: string, kerning: boolean, texts: readonly string[], count: number, widths: Float64Array): void {
		this.calls++

		if (font !== this.font) {
			this.font = font
			this.fontSwitches++
		}

		const size = sizeOf(font)

		for (let i = 0; i < count; i++) {
			widths[i] = FakeMeasurer.width(texts[i] ?? "", size, kerning || !this.kerningControl)
			this.strings++
		}
	}

	fontExtents(font: string): FontExtents {
		const size = sizeOf(font)

		return { ascent: size * 0.75, descent: size * 0.25 }
	}
}

function sizeOf(font: string): number {
	return Number(/([\d.]+)px/.exec(font)?.[1] ?? "0")
}

// A face with ascent 0.8 em and descent 0.2 em under both line spacing rules: single lines are 1 em.
export function testFont(id = 1, family = "fo-test", scale = 1, widthScale = 1): ResolvedFont {
	return {
		id,
		family,
		generic: "sans-serif",
		weight: 400,
		italic: false,
		scale,
		widthScale,
		metrics: verticalMetrics(1000, 800, -200, 0, 800, -200, 0, 800, 200, false),
		metricsBasis: "font",
		source: "bundled"
	}
}

export interface Harness {
	readonly measurer: FakeMeasurer
	readonly cache: MeasureCache
	readonly styles: StyleTable
	readonly layouter: ParagraphLayouter
	readonly builder: ParagraphBuilder
	readonly out: TextLayout
	readonly base: number
	style(style: Partial<TextStyle>): number
}

export function harness(kerningControl = true): Harness {
	const measurer = new FakeMeasurer(kerningControl)
	const cache = new MeasureCache(measurer)
	const styles = new StyleTable(cache)
	const font = testFont()
	const base = styles.add({ font, size: 20 })

	return {
		measurer,
		cache,
		styles,
		layouter: new ParagraphLayouter(styles),
		builder: new ParagraphBuilder(),
		out: new TextLayout(),
		base,
		style: style => styles.add({ font, size: 20, ...style })
	}
}

export const GEOMETRY: ParagraphGeometry = {
	left: 0,
	width: 100,
	startIndent: 0,
	endIndent: 0,
	firstLineIndent: 0,
	rtl: false,
	alignment: 0,
	tabs: null,
	defaultTabStop: 48,
	lineRule: LineRule.AUTO,
	lineSpacing: 1
}

export interface LineView {
	text: string
	top: number
	height: number
	baseline: number
	x: number
	width: number
	flags: number
	fragments: FragmentView[]
}

export interface FragmentView {
	text: string
	x: number
	width: number
	wordSpacing: number
	letterSpacing: number
	kind: number
	level: number
	info: number
	aux: number
}

export function lines(out: TextLayout, text: string): LineView[] {
	const views: LineView[] = []

	for (let line = 0; line < out.lineCount; line++) {
		const f = line * LINE_FLOATS
		const i = line * LINE_INTS
		const first = out.lineInts[i] ?? 0
		const count = out.lineInts[i + 1] ?? 0
		const fragments: FragmentView[] = []

		for (let k = first; k < first + count; k++) {
			const ff = k * FRAGMENT_FLOATS
			const fi = k * FRAGMENT_INTS
			const info = out.fragmentInts[fi + 3] ?? 0

			fragments.push({
				text: text.slice(out.fragmentInts[fi] ?? 0, out.fragmentInts[fi + 1] ?? 0),
				x: round(out.fragmentFloats[ff] ?? 0),
				width: round(out.fragmentFloats[ff + 1] ?? 0),
				wordSpacing: round(out.fragmentFloats[ff + 2] ?? 0),
				letterSpacing: round(out.fragmentFloats[ff + 3] ?? 0),
				kind: info & FRAGMENT_KIND_MASK,
				level: info >> FRAGMENT_LEVEL_SHIFT,
				info,
				aux: out.fragmentInts[fi + 4] ?? 0
			})
		}

		views.push({
			text: text.slice(out.lineInts[i + 2] ?? 0, out.lineInts[i + 3] ?? 0),
			top: round(out.lineFloats[f] ?? 0),
			height: round(out.lineFloats[f + 1] ?? 0),
			baseline: round(out.lineFloats[f + 2] ?? 0),
			x: round(out.lineFloats[f + 3] ?? 0),
			width: round(out.lineFloats[f + 4] ?? 0),
			flags: out.lineInts[i + 4] ?? 0,
			fragments
		})
	}

	return views
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000
}

// Lays out a whole paragraph built by `build` and returns its lines.
export function layOut(
	h: Harness,
	build: (builder: ParagraphBuilder) => void,
	geometry: Partial<ParagraphGeometry> = {},
	options: Partial<PrepareOptions> = {}
): LineView[] {
	h.builder.reset(h.base)
	build(h.builder)

	const paragraph = h.builder.finish()
	const prepared = h.layouter.prepare(paragraph, { rtl: geometry.rtl ?? false, ...options })

	h.out.reset()
	h.layouter.layout(prepared, { ...GEOMETRY, ...geometry }, h.out, new LayoutCursor(), 0)

	return lines(h.out, paragraph.text)
}

export function texts(views: readonly LineView[]): string[] {
	return views.map(view => view.text)
}
