import type { DrawingTheme } from "../drawingml/color"
import { presetColorLower } from "../drawingml/presetColors"

// VML colour values (#rgb, #rrggbb, names, rgb(), system colours, "fill darken(118)") as six hex digits.

// Real values are a few dozen characters; longer text is refused before any pattern runs on it.
const MAX_COLOR_LENGTH = 64

// Windows system colours (the names VML writes for them).
const SYSTEM: ReadonlyMap<string, string> = new Map([
	["buttonface", "F0F0F0"],
	["buttonhighlight", "FFFFFF"],
	["buttonshadow", "A0A0A0"],
	["buttontext", "000000"],
	["captiontext", "000000"],
	["graytext", "6D6D6D"],
	["highlight", "0078D7"],
	["highlighttext", "FFFFFF"],
	["infobackground", "FFFFE1"],
	["infotext", "000000"],
	["menu", "F0F0F0"],
	["menutext", "000000"],
	["scrollbar", "C8C8C8"],
	["threeddarkshadow", "696969"],
	["threedface", "F0F0F0"],
	["threedhighlight", "FFFFFF"],
	["threedlightshadow", "E3E3E3"],
	["threedshadow", "A0A0A0"],
	["window", "FFFFFF"],
	["windowframe", "646464"],
	["windowtext", "000000"]
])

const SCHEME: ReadonlySet<string> = new Set([
	"accent1",
	"accent2",
	"accent3",
	"accent4",
	"accent5",
	"accent6",
	"dk1",
	"lt1",
	"dk2",
	"lt2",
	"tx1",
	"tx2",
	"bg1",
	"bg2",
	"hlink",
	"folHlink"
])

function clampByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)))
}

function hex(r: number, g: number, b: number): string {
	return ((clampByte(r) << 16) | (clampByte(g) << 8) | clampByte(b)).toString(16).padStart(6, "0").toUpperCase()
}

// "fill darken(118)" and friends: a modifier applied to `base` (the fill or line colour).
function modified(expression: string, base: string): string | undefined {
	const match = /^(?:fill|line|shadow)?\s*(darken|lighten|blackwhite|gray|grey)?\s*(?:\(\s*(\d+)\s*\))?$/.exec(expression)

	if (match === null) return undefined

	const value = Number.parseInt(base, 16)
	const r = (value >> 16) & 255
	const g = (value >> 8) & 255
	const b = value & 255
	const amount = Number.parseInt(match[2] ?? "255", 10)

	switch (match[1]) {
		case "darken":
			return hex((r * amount) / 255, (g * amount) / 255, (b * amount) / 255)
		case "lighten":
			return hex(255 - ((255 - r) * amount) / 255, 255 - ((255 - g) * amount) / 255, 255 - ((255 - b) * amount) / 255)
		case "gray":
		case "grey": {
			const gray = 0.3 * r + 0.59 * g + 0.11 * b

			return hex(gray, gray, gray)
		}
		case "blackwhite":
			return 0.3 * r + 0.59 * g + 0.11 * b >= amount ? "FFFFFF" : "000000"
		default:
			return base
	}
}

// A VML colour as six upper-case hex digits; `base` resolves relative expressions ("fill lighten(51)").
export function parseVmlColor(text: string | undefined, theme?: DrawingTheme, base?: string): string | undefined {
	if (text === undefined || text.length > MAX_COLOR_LENGTH) return undefined

	// "black [3213]": the bracketed index names a palette entry; the leading colour is its value.
	const value = text.replace(/\[[^\]]*\]/g, "").trim()
	const lower = value.toLowerCase()

	if (lower === "" || lower === "none" || lower === "transparent") return undefined

	if (lower.startsWith("#")) {
		const digits = lower.slice(1)

		if (/^[0-9a-f]{6}$/.test(digits)) return digits.toUpperCase()
		if (/^[0-9a-f]{3}$/.test(digits)) return digits.replace(/./g, digit => digit + digit).toUpperCase()

		return undefined
	}

	if (/^[0-9a-f]{6}$/.test(lower)) return lower.toUpperCase()

	const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(lower)

	if (rgb !== null) return hex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))

	const named = presetColorLower(lower) ?? SYSTEM.get(lower)

	if (named !== undefined) return named
	if (SCHEME.has(value)) return theme?.scheme(value)
	if (base !== undefined && /^(fill|line|shadow|darken|lighten|gray|grey|blackwhite)\b/.test(lower)) return modified(lower, base)

	return undefined
}
