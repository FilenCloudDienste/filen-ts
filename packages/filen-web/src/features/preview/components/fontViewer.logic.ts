import type { FontAxis, FontInfo, FontOutlines } from "@filen/office/core/fonts"

// The font viewer's pure parts: which code points the glyph grid shows and where, the specimen's default text, and
// the variation settings the axes' sliders make.

// The specimen's sizes, in CSS pixels.
export const SPECIMEN_SIZES = [12, 18, 24, 36, 48, 72] as const

// Code points a cell cannot show: C0 and C1 controls, DEL, and surrogates.
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
	[0x0, 0x1f],
	[0x7f, 0x9f],
	[0xd800, 0xdfff]
]

// The runs ([first, last] pairs, ascending) without what a cell cannot show.
export function displayableRuns(runs: Uint32Array): Uint32Array {
	const out: number[] = []

	for (let i = 0; i + 1 < runs.length; i += 2) {
		let first = runs[i] ?? 0
		const last = runs[i + 1] ?? 0

		for (const [hiddenFirst, hiddenLast] of HIDDEN_RANGES) {
			if (first > last) break
			if (hiddenLast < first || hiddenFirst > last) continue

			if (hiddenFirst > first) out.push(first, hiddenFirst - 1)

			first = hiddenLast + 1
		}

		if (first <= last) out.push(first, last)
	}

	return Uint32Array.from(out)
}

// Each run's start index in the flattened list, and the total count, for index lookups.
export interface GlyphIndex {
	readonly runs: Uint32Array
	readonly starts: Float64Array
	readonly count: number
}

export function glyphIndex(runs: Uint32Array): GlyphIndex {
	const starts = new Float64Array(runs.length / 2)
	let count = 0

	for (let r = 0; r < starts.length; r++) {
		starts[r] = count
		count += (runs[r * 2 + 1] ?? 0) - (runs[r * 2] ?? 0) + 1
	}

	return { runs, starts, count }
}

// The code point at `index` of the flattened runs (binary search); -1 past the end.
export function codePointAt(index: GlyphIndex, at: number): number {
	if (at < 0 || at >= index.count) return -1

	let low = 0
	let high = index.starts.length - 1

	while (low < high) {
		const middle = (low + high + 1) >>> 1

		if ((index.starts[middle] ?? 0) <= at) low = middle
		else high = middle - 1
	}

	return (index.runs[low * 2] ?? 0) + (at - (index.starts[low] ?? 0))
}

// Whether every code point of `text` is in the runs.
function covers(index: GlyphIndex, text: string): boolean {
	for (const char of text) {
		const codePoint = char.codePointAt(0) ?? 0

		if (codePoint !== 0x20 && !inRuns(index.runs, codePoint)) return false
	}

	return true
}

function inRuns(runs: Uint32Array, codePoint: number): boolean {
	let low = 0
	let high = runs.length / 2 - 1

	while (low <= high) {
		const middle = (low + high) >>> 1

		if ((runs[middle * 2 + 1] ?? 0) < codePoint) low = middle + 1
		else if ((runs[middle * 2] ?? 0) > codePoint) high = middle - 1
		else return true
	}

	return false
}

// Glyphs the default specimen takes from a font that cannot draw the pangram.
const SAMPLE_GLYPHS = 40

// The specimen's text before the user types: the font's own sample text (name ID 19), else `pangram` when the font
// draws it, else its first glyphs.
export function defaultSample(info: FontInfo | null, index: GlyphIndex, pangram: string): string {
	const own = info?.names.find(name => name.id === 19)?.value

	if (own !== undefined && own.trim() !== "") return own
	if (info === null || index.count === 0 || covers(index, pangram)) return pangram

	let text = ""

	for (let at = 0; at < Math.min(index.count, SAMPLE_GLYPHS); at++) text += String.fromCodePoint(codePointAt(index, at))

	return text
}

// "U+0041", at least four hex digits.
export function codePointLabel(codePoint: number): string {
	return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
}

// The CSS font-variation-settings for the axes' values; "normal" with none set.
export function variationSettings(values: ReadonlyMap<string, number>): string {
	if (values.size === 0) return "normal"

	return [...values].map(([tag, value]) => `"${tag.replaceAll('"', "")}" ${String(value)}`).join(", ")
}

// The axes a user may move: not hidden, with a range to move in.
export function adjustableAxes(axes: readonly FontAxis[]): FontAxis[] {
	return axes.filter(axis => !axis.hidden && axis.max > axis.min)
}

// A slider's step: a hundredth of the range, at most 1.
export function axisStep(axis: FontAxis): number {
	return Math.min(1, (axis.max - axis.min) / 100)
}

// What the font's embedding permissions allow, most restrictive bit first (OpenType OS/2 fsType).
export type FontEmbedding = "installable" | "restricted" | "previewPrint" | "editable"

export function fontEmbedding(fsType: number): FontEmbedding {
	if ((fsType & 0x2) !== 0) return "restricted"
	if ((fsType & 0x4) !== 0) return "previewPrint"
	if ((fsType & 0x8) !== 0) return "editable"

	return "installable"
}

// The format line's kind: the container and, for an sfnt, which outlines decide TrueType or OpenType.
export type FontFormat = "trueType" | "openType" | "openType2" | "bitmap" | "woff" | "woff2"

export function fontFormat(info: FontInfo): FontFormat {
	if (info.container === "woff" || info.container === "woff2") return info.container

	return sfntFormat(info.outlines)
}

export function sfntFormat(outlines: FontOutlines): FontFormat {
	switch (outlines) {
		case "trueType":
			return "trueType"
		case "cff":
			return "openType"
		case "cff2":
			return "openType2"
		case "bitmap":
			return "bitmap"
	}
}

const COUNT = new Intl.NumberFormat()

// A count with the runtime locale's grouping.
export function formatCount(value: number): string {
	return COUNT.format(value)
}
