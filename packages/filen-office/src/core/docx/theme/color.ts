// Colour arithmetic for WordprocessingML and DrawingML. Colours are six upper-case hex digits.

export interface Rgb {
	r: number
	g: number
	b: number
}

export interface Hsl {
	// Hue in degrees [0, 360), saturation and luminance in [0, 1].
	h: number
	s: number
	l: number
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value
}

export function hexToRgb(hex: string): Rgb {
	const value = Number.parseInt(hex, 16)

	return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 }
}

// `truncate` drops the fraction instead of rounding, as Word does for w:themeTint/w:themeShade.
export function rgbToHex(rgb: Rgb, truncate: boolean = false): string {
	const byte = (channel: number): string => {
		const scaled = clamp01(channel) * 255

		return (truncate ? Math.floor(scaled + 1e-6) : Math.round(scaled)).toString(16).padStart(2, "0")
	}

	return (byte(rgb.r) + byte(rgb.g) + byte(rgb.b)).toUpperCase()
}

export function rgbToHsl(rgb: Rgb): Hsl {
	const max = Math.max(rgb.r, rgb.g, rgb.b)
	const min = Math.min(rgb.r, rgb.g, rgb.b)
	const l = (max + min) / 2
	const delta = max - min

	if (delta === 0) return { h: 0, s: 0, l }

	const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
	let h: number

	if (max === rgb.r) {
		h = (rgb.g - rgb.b) / delta + (rgb.g < rgb.b ? 6 : 0)
	} else if (max === rgb.g) {
		h = (rgb.b - rgb.r) / delta + 2
	} else {
		h = (rgb.r - rgb.g) / delta + 4
	}

	return { h: h * 60, s, l }
}

function hueToChannel(p: number, q: number, t: number): number {
	let x = t

	if (x < 0) x += 1
	if (x > 1) x -= 1
	if (x < 1 / 6) return p + (q - p) * 6 * x
	if (x < 1 / 2) return q
	if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6

	return p
}

export function hslToRgb(hsl: Hsl): Rgb {
	const s = clamp01(hsl.s)
	const l = clamp01(hsl.l)

	if (s === 0) return { r: l, g: l, b: l }

	const h = (((hsl.h % 360) + 360) % 360) / 360
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s
	const p = 2 * l - q

	return { r: hueToChannel(p, q, h + 1 / 3), g: hueToChannel(p, q, h), b: hueToChannel(p, q, h - 1 / 3) }
}

// w:themeTint / w:themeShade (§17.3.2.6): 0..255 scale the HSL luminance toward white or black. Truncating
// reproduces Word's palette ("Accent 1, lighter 60%" of 4472C4 is B4C6E7, rounding gives B4C7E7).
export function applyThemeTint(hex: string, tint: number): string {
	const hsl = rgbToHsl(hexToRgb(hex))
	const ratio = tint / 255

	hsl.l = hsl.l * ratio + (1 - ratio)

	return rgbToHex(hslToRgb(hsl), true)
}

export function applyThemeShade(hex: string, shade: number): string {
	const hsl = rgbToHsl(hexToRgb(hex))

	hsl.l = (hsl.l * shade) / 255

	return rgbToHex(hslToRgb(hsl), true)
}

// sRGB <-> linear light (IEC 61966-2-1), for the DrawingML transforms defined on linear RGB.
function toLinear(channel: number): number {
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function fromLinear(channel: number): number {
	return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
}

export type ValuedColorTransformKind =
	| "tint"
	| "shade"
	| "lum"
	| "lumMod"
	| "lumOff"
	| "sat"
	| "satMod"
	| "satOff"
	| "hue"
	| "hueOff"
	| "hueMod"
	| "red"
	| "redOff"
	| "redMod"
	| "green"
	| "greenOff"
	| "greenMod"
	| "blue"
	| "blueOff"
	| "blueMod"
	| "alpha"

// A DrawingML colour transform (§20.1.2.3): values are fractions (val / 100000) and degrees for hue and hueOff.
export type ColorTransform =
	| {
			readonly kind: ValuedColorTransformKind
			readonly value: number
	  }
	| { readonly kind: "comp" | "inv" | "gray" | "gamma" | "invGamma" }

// Applies transforms in document order. Alpha is not representable in a hex colour and is ignored here.
export function applyColorTransforms(hex: string, transforms: readonly ColorTransform[]): string {
	if (transforms.length === 0) return hex

	let rgb = hexToRgb(hex)

	for (const transform of transforms) {
		switch (transform.kind) {
			case "tint": {
				// "A 10% tint is 10% of the input colour combined with 90% white", in linear light.
				const t = transform.value
				const blend = (c: number): number => fromLinear(toLinear(c) * t + (1 - t))

				rgb = { r: blend(rgb.r), g: blend(rgb.g), b: blend(rgb.b) }

				break
			}
			case "shade": {
				const t = transform.value
				const blend = (c: number): number => fromLinear(toLinear(c) * t)

				rgb = { r: blend(rgb.r), g: blend(rgb.g), b: blend(rgb.b) }

				break
			}
			case "lum":
			case "lumMod":
			case "lumOff":
			case "sat":
			case "satMod":
			case "satOff":
			case "hue":
			case "hueMod":
			case "hueOff": {
				const hsl = rgbToHsl(rgb)
				const value = transform.value

				switch (transform.kind) {
					case "lum":
						hsl.l = value
						break
					case "lumMod":
						hsl.l *= value
						break
					case "lumOff":
						hsl.l += value
						break
					case "sat":
						hsl.s = value
						break
					case "satMod":
						hsl.s *= value
						break
					case "satOff":
						hsl.s += value
						break
					case "hue":
						hsl.h = value
						break
					case "hueMod":
						hsl.h *= value
						break
					case "hueOff":
						hsl.h += value
						break
				}

				rgb = hslToRgb(hsl)

				break
			}
			// The component transforms are defined on linear RGB (scRGB).
			case "red":
			case "redOff":
			case "redMod":
			case "green":
			case "greenOff":
			case "greenMod":
			case "blue":
			case "blueOff":
			case "blueMod": {
				const kind = transform.kind
				const channel = kind.startsWith("red") ? "r" : kind.startsWith("green") ? "g" : "b"
				const linear = toLinear(rgb[channel])
				const next = kind.endsWith("Off")
					? linear + transform.value
					: kind.endsWith("Mod")
						? linear * transform.value
						: transform.value

				rgb = { ...rgb, [channel]: fromLinear(clamp01(next)) }

				break
			}
			case "gamma":
				rgb = { r: clamp01(fromLinear(rgb.r)), g: clamp01(fromLinear(rgb.g)), b: clamp01(fromLinear(rgb.b)) }
				break
			case "invGamma":
				rgb = { r: clamp01(toLinear(rgb.r)), g: clamp01(toLinear(rgb.g)), b: clamp01(toLinear(rgb.b)) }
				break
			case "comp": {
				const hsl = rgbToHsl(rgb)

				hsl.h += 180
				rgb = hslToRgb(hsl)

				break
			}
			case "inv":
				rgb = { r: 1 - rgb.r, g: 1 - rgb.g, b: 1 - rgb.b }
				break
			case "gray": {
				const gray = 0.3 * rgb.r + 0.59 * rgb.g + 0.11 * rgb.b

				rgb = { r: gray, g: gray, b: gray }

				break
			}
			case "alpha":
				break
		}
	}

	return rgbToHex(rgb)
}

// ST_HighlightColor (§17.18.40).
export const HIGHLIGHT_COLORS: Readonly<Record<string, string>> = {
	black: "000000",
	blue: "0000FF",
	cyan: "00FFFF",
	green: "00FF00",
	magenta: "FF00FF",
	red: "FF0000",
	yellow: "FFFF00",
	white: "FFFFFF",
	darkBlue: "000080",
	darkCyan: "008080",
	darkGreen: "008000",
	darkMagenta: "800080",
	darkRed: "800000",
	darkYellow: "808000",
	darkGray: "808080",
	lightGray: "C0C0C0"
}

// Share of the pattern colour in each ST_Shd pattern; stripes and crosses are drawn by the renderer but
// average out to these values.
const PATTERN_SHARE: Readonly<Record<string, number>> = {
	clear: 0,
	nil: 0,
	solid: 1,
	horzStripe: 0.5,
	vertStripe: 0.5,
	reverseDiagStripe: 0.5,
	diagStripe: 0.5,
	horzCross: 0.5,
	diagCross: 0.5,
	thinHorzStripe: 0.25,
	thinVertStripe: 0.25,
	thinReverseDiagStripe: 0.25,
	thinDiagStripe: 0.25,
	thinHorzCross: 0.25,
	thinDiagCross: 0.25
}

function patternShare(pattern: string): number {
	const known = PATTERN_SHARE[pattern]

	if (known !== undefined) return known

	const percent = /^pct(\d+)$/.exec(pattern)

	return percent === null ? 0 : Number.parseInt(percent[1] ?? "0", 10) / 100
}

// The flat colour a shading paints: the pattern colour mixed into the fill by the pattern's share. An
// automatic pattern colour is black and an automatic fill is white; undefined means nothing is painted.
export function shadingColor(pattern: string, color: string | undefined, fill: string | undefined): string | undefined {
	const share = patternShare(pattern)

	if (share === 0) return fill
	if (share === 1) return color ?? "000000"

	const front = hexToRgb(color ?? "000000")
	const back = hexToRgb(fill ?? "FFFFFF")

	return rgbToHex({
		r: front.r * share + back.r * (1 - share),
		g: front.g * share + back.g * (1 - share),
		b: front.b * share + back.b * (1 - share)
	})
}
