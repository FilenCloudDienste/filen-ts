// VML's CSS-like `style` attribute and its value syntaxes, parsed into numbers and enums only: nothing here
// is ever passed on as CSS text.

// px per unit (96 px per inch).
const PX_PER_UNIT: Readonly<Record<string, number>> = {
	pt: 96 / 72,
	in: 96,
	cm: 96 / 2.54,
	mm: 96 / 25.4,
	pc: 16,
	pi: 16,
	px: 1,
	emu: 1 / 9525
}

// Real lengths are a few dozen characters; longer text is refused before LENGTH runs (it backtracks on long
// digit runs).
const MAX_LENGTH_TEXT = 64

const LENGTH = /^(-?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*(pt|in|cm|mm|pc|pi|px|emu)?$/

// A parsed length: `value` in px when `unit` is true, else a bare number (px at the top level, coordinate
// units inside a group).
export interface Length {
	readonly value: number
	readonly unit: boolean
}

export function parseLength(text: string | undefined): Length | undefined {
	if (text === undefined) return undefined

	const trimmed = text.trim()

	if (trimmed.length > MAX_LENGTH_TEXT) return undefined

	const match = LENGTH.exec(trimmed.toLowerCase())

	if (match === null) return undefined

	const value = Number.parseFloat(match[1] ?? "0")
	const unit = match[2]

	if (!Number.isFinite(value)) return undefined

	return unit === undefined ? { value, unit: false } : { value: value * (PX_PER_UNIT[unit] ?? 1), unit: true }
}

// A length in px; bare numbers are px.
export function lengthPx(text: string | undefined, fallback: number): number {
	return parseLength(text)?.value ?? fallback
}

// The declarations of a style attribute, property names lower-cased; later declarations win.
export function parseStyle(style: string | undefined): Map<string, string> {
	const out = new Map<string, string>()

	if (style === undefined) return out

	for (const declaration of style.split(";")) {
		const colon = declaration.indexOf(":")

		if (colon <= 0) continue

		const name = declaration.slice(0, colon).trim().toLowerCase()
		const value = declaration.slice(colon + 1).trim()

		if (name !== "" && value !== "") out.set(name, value)
	}

	return out
}

// VML fractions: "0.5", ".5", "50%", or fixed point "32768f" (1/65536 units).
export function parseFractionValue(text: string | undefined, fallback: number): number {
	if (text === undefined) return fallback

	const trimmed = text.trim().toLowerCase()

	if (trimmed === "") return fallback

	const value = Number.parseFloat(trimmed)

	if (!Number.isFinite(value)) return fallback
	if (trimmed.endsWith("f")) return value / 65536
	if (trimmed.endsWith("%")) return value / 100

	return value
}

// "x,y" pairs ("10,20", "10pt,20pt", ",5"): empty members are 0.
export function parsePair(text: string | undefined, fallback: readonly [number, number]): [Length, Length] {
	const zero: Length = { value: 0, unit: false }

	if (text === undefined)
		return [
			{ value: fallback[0], unit: false },
			{ value: fallback[1], unit: false }
		]

	const [x, y] = text.split(",")

	return [
		parseLength(x === undefined || x.trim() === "" ? "0" : x) ?? zero,
		parseLength(y === undefined || y.trim() === "" ? "0" : y) ?? zero
	]
}

// "1000,1000" -> numbers, empty members `fallback`.
export function parseNumbers(text: string | undefined, fallback: readonly number[]): number[] {
	if (text === undefined) return [...fallback]

	return text.split(",").map((part, index) => {
		const value = Number.parseFloat(part.trim())

		return part.trim() === "" || !Number.isFinite(value) ? (fallback[index] ?? 0) : value
	})
}

export type HorizontalPosition = "absolute" | "left" | "center" | "right" | "inside" | "outside"
export type HorizontalRelative =
	"margin" | "page" | "text" | "char" | "left-margin-area" | "right-margin-area" | "inner-margin-area" | "outer-margin-area"
export type VerticalPosition = "absolute" | "top" | "center" | "bottom" | "inside" | "outside"
export type VerticalRelative =
	"margin" | "page" | "text" | "line" | "top-margin-area" | "bottom-margin-area" | "inner-margin-area" | "outer-margin-area"
export type VmlWrapType = "square" | "tight" | "through" | "topAndBottom" | "none"
export type VmlWrapSide = "both" | "left" | "right" | "largest"
export type VmlTextAnchor =
	| "top"
	| "middle"
	| "bottom"
	| "top-center"
	| "middle-center"
	| "bottom-center"
	| "top-baseline"
	| "bottom-baseline"
	| "top-center-baseline"
	| "bottom-center-baseline"

// The placement of a top-level VML shape, from its style and w10:wrap. Lengths in px.
export interface VmlPlacement {
	readonly width: number
	readonly height: number
	readonly position: "static" | "absolute" | "relative"
	readonly left: number
	readonly top: number
	readonly marginLeft: number
	readonly marginTop: number
	readonly horizontal: HorizontalPosition | undefined
	readonly horizontalRelative: HorizontalRelative | undefined
	readonly vertical: VerticalPosition | undefined
	readonly verticalRelative: VerticalRelative | undefined
	readonly zIndex: number
	readonly rotation: number
	readonly flipH: boolean
	readonly flipV: boolean
	readonly hidden: boolean
	readonly wrapStyle: "square" | "none" | undefined
	readonly wrapDistance: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
	// mso-width-percent / mso-height-percent in 1000ths, 0 when absent.
	readonly widthPercent: number
	readonly heightPercent: number
	readonly textAnchor: VmlTextAnchor | undefined
	readonly wrap: { readonly type: VmlWrapType; readonly side: VmlWrapSide | undefined } | undefined
	readonly allowInCell: boolean
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
	return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

const HORIZONTAL: readonly HorizontalPosition[] = ["absolute", "left", "center", "right", "inside", "outside"]
const HORIZONTAL_RELATIVE: readonly HorizontalRelative[] = [
	"margin",
	"page",
	"text",
	"char",
	"left-margin-area",
	"right-margin-area",
	"inner-margin-area",
	"outer-margin-area"
]
const VERTICAL: readonly VerticalPosition[] = ["absolute", "top", "center", "bottom", "inside", "outside"]
const VERTICAL_RELATIVE: readonly VerticalRelative[] = [
	"margin",
	"page",
	"text",
	"line",
	"top-margin-area",
	"bottom-margin-area",
	"inner-margin-area",
	"outer-margin-area"
]
const TEXT_ANCHORS: readonly VmlTextAnchor[] = [
	"top",
	"middle",
	"bottom",
	"top-center",
	"middle-center",
	"bottom-center",
	"top-baseline",
	"bottom-baseline",
	"top-center-baseline",
	"bottom-center-baseline"
]
const WRAP_TYPES: readonly VmlWrapType[] = ["square", "tight", "through", "topAndBottom", "none"]
const WRAP_SIDES: readonly VmlWrapSide[] = ["both", "left", "right", "largest"]

export interface Flip {
	readonly flipH: boolean
	readonly flipV: boolean
}

// The style's "flip" ("x", "y", "x y") plus the rotation in degrees.
export function parseTransform(style: ReadonlyMap<string, string>): Flip & { readonly rotation: number } {
	const flip = (style.get("flip") ?? "").toLowerCase()
	// Degrees, or fixed point ("5898240f", 1/65536 degree).
	const rotation = parseFractionValue(style.get("rotation"), 0)

	return { rotation, flipH: flip.includes("x"), flipV: flip.includes("y") }
}

export function readPlacement(
	style: ReadonlyMap<string, string>,
	wrap: { readonly type: string | undefined; readonly side: string | undefined } | undefined,
	allowInCell: boolean,
	size: { readonly width: number; readonly height: number }
): VmlPlacement {
	const position = style.get("position")
	const transform = parseTransform(style)
	const wrapType = oneOf(wrap?.type, WRAP_TYPES)
	const wrapStyle = style.get("mso-wrap-style")

	return {
		width: size.width,
		height: size.height,
		position: position === "absolute" || position === "relative" ? position : "static",
		left: lengthPx(style.get("left"), 0),
		top: lengthPx(style.get("top"), 0),
		marginLeft: lengthPx(style.get("margin-left"), 0),
		marginTop: lengthPx(style.get("margin-top"), 0),
		horizontal: oneOf(style.get("mso-position-horizontal"), HORIZONTAL),
		horizontalRelative: oneOf(style.get("mso-position-horizontal-relative"), HORIZONTAL_RELATIVE),
		vertical: oneOf(style.get("mso-position-vertical"), VERTICAL),
		verticalRelative: oneOf(style.get("mso-position-vertical-relative"), VERTICAL_RELATIVE),
		zIndex: Number.parseInt(style.get("z-index") ?? "0", 10) || 0,
		rotation: transform.rotation,
		flipH: transform.flipH,
		flipV: transform.flipV,
		hidden: style.get("visibility") === "hidden",
		wrapStyle: wrapStyle === "square" || wrapStyle === "none" ? wrapStyle : undefined,
		wrapDistance: {
			left: lengthPx(style.get("mso-wrap-distance-left"), 0),
			top: lengthPx(style.get("mso-wrap-distance-top"), 0),
			right: lengthPx(style.get("mso-wrap-distance-right"), 0),
			bottom: lengthPx(style.get("mso-wrap-distance-bottom"), 0)
		},
		widthPercent: Number.parseFloat(style.get("mso-width-percent") ?? "0") || 0,
		heightPercent: Number.parseFloat(style.get("mso-height-percent") ?? "0") || 0,
		textAnchor: oneOf(style.get("v-text-anchor"), TEXT_ANCHORS),
		wrap: wrapType === undefined ? undefined : { type: wrapType, side: oneOf(wrap?.side, WRAP_SIDES) },
		allowInCell
	}
}
