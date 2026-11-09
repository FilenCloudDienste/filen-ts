// Free substitutes for the fonts documents name most. Arimo, Tinos, Cousine and Gelasio have measured
// advance widths identical to Arial, Times New Roman, Courier New and Georgia, so lines break where they
// break in Word. Carlito claims Calibri's widths, unverified against Calibri itself; Caladea makes no
// claim for Cambria and is only the closest free match; Selawik is Microsoft's own open fallback for
// Segoe UI, widths unverified. Substitutes apply even when the original is installed, so layout is the
// same on every device. This module is plain data so the table generator can read it.

export type BundledFamily = "carlito" | "caladea" | "arimo" | "tinos" | "cousine" | "gelasio" | "selawik"

export type GenericFamily = "serif" | "sans-serif" | "monospace"

export interface Substitution {
	readonly family: BundledFamily
	readonly generic: GenericFamily
	// Font-size factor bringing the substitute's widths closer to the original's.
	readonly scale: number
	// Horizontal-only factor for a condensed original drawn in a normal-width substitute; heights stay.
	readonly widthScale: number
	// The weight a family name implies ("Segoe UI Semibold"); undefined for regular families.
	readonly weight: number | undefined
	// Use an installed font of the original name first: there is no free width-compatible clone, and only
	// the real font lays out exactly.
	readonly preferLocal: boolean
}

// Size factors for setting Aptos text in Carlito. No free font matches Aptos, and nothing derived from
// Microsoft's font files may ship, so the body scale comes only from page breaks Word recorded
// (w:lastRenderedPageBreak) in the 15 public Word documents of the test corpus with an Aptos theme. Metric,
// fixed before the sweep: the share of those 139 breaks the layout breaks at on exactly the same line; ties
// go to the factor closer to 1.
//   scale   1      1.01   1.015  1.02   1.025  1.03   1.04   1.05   1.06   1.07
//   exact   4.3 %  5.1 %  7.2 %  7.2 %  7.2 %  7.2 %  5.8 %  4.3 %  4.3 %  4.3 %
// Display and Narrow faces have too few recorded breaks to measure and stay 1.
export const UNCALIBRATED_APTOS_SCALE = 1.015
export const UNCALIBRATED_APTOS_DISPLAY_SCALE = 1
export const UNCALIBRATED_APTOS_NARROW_SCALE = 1

// Tahoma set in Arimo: the size factor fitted, with Tahoma's line height, to Word's recorded page breaks in
// the 10 corpus files using it, kept because it beats Arimo's own metrics on files left out of the fit
// (leave one file out: 12.2 % -> 17.1 % of 41 breaks on the same line).
export const CALIBRATED_TAHOMA_SCALE = 1.01

// Arial Narrow set in Arimo, narrowed only horizontally: Arial Narrow's advances are about 82 % of Arial's,
// its heights Arial's. Not fitted to recorded page breaks.
export const ARIAL_NARROW_WIDTH_SCALE = 0.82

function substitute(
	family: BundledFamily,
	generic: GenericFamily,
	options: { scale?: number; widthScale?: number; weight?: number; preferLocal?: boolean } = {}
): Substitution {
	return {
		family,
		generic,
		scale: options.scale ?? 1,
		widthScale: options.widthScale ?? 1,
		weight: options.weight,
		preferLocal: options.preferLocal ?? false
	}
}

// Keyed by the lower-cased family name as documents write it.
export const SUBSTITUTIONS: ReadonlyMap<string, Substitution> = new Map([
	["calibri", substitute("carlito", "sans-serif")],
	// Carlito has no light weight: Calibri Light headings come out in Carlito Regular.
	["calibri light", substitute("carlito", "sans-serif")],
	["cambria", substitute("caladea", "serif")],
	["arial", substitute("arimo", "sans-serif")],
	// Arial was drawn to Helvetica's widths.
	["helvetica", substitute("arimo", "sans-serif")],
	["times new roman", substitute("tinos", "serif")],
	["courier new", substitute("cousine", "monospace")],
	["georgia", substitute("gelasio", "serif")],
	["segoe ui", substitute("selawik", "sans-serif")],
	["segoe ui light", substitute("selawik", "sans-serif", { weight: 300 })],
	["segoe ui semilight", substitute("selawik", "sans-serif", { weight: 350 })],
	["segoe ui semibold", substitute("selawik", "sans-serif", { weight: 600 })],
	["aptos", substitute("carlito", "sans-serif", { scale: UNCALIBRATED_APTOS_SCALE, preferLocal: true })],
	["aptos display", substitute("carlito", "sans-serif", { scale: UNCALIBRATED_APTOS_DISPLAY_SCALE, preferLocal: true })],
	["aptos narrow", substitute("carlito", "sans-serif", { scale: UNCALIBRATED_APTOS_NARROW_SCALE, preferLocal: true })],
	["aptos light", substitute("carlito", "sans-serif", { scale: UNCALIBRATED_APTOS_SCALE, weight: 300, preferLocal: true })],
	["aptos semibold", substitute("carlito", "sans-serif", { scale: UNCALIBRATED_APTOS_SCALE, weight: 600, preferLocal: true })],
	["aptos serif", substitute("tinos", "serif", { preferLocal: true })],
	["aptos mono", substitute("cousine", "monospace", { preferLocal: true })],
	// The Liberation fonts share their metrics with the clones bundled here (both are metric-compatible with
	// Arial, Times New Roman and Courier New); the bundled families are named by documents made with them.
	["liberation sans", substitute("arimo", "sans-serif")],
	["liberation serif", substitute("tinos", "serif")],
	["liberation mono", substitute("cousine", "monospace")],
	["carlito", substitute("carlito", "sans-serif")],
	["caladea", substitute("caladea", "serif")],
	["arimo", substitute("arimo", "sans-serif")],
	["tinos", substitute("tinos", "serif")],
	["cousine", substitute("cousine", "monospace")],
	["gelasio", substitute("gelasio", "serif")],
	["selawik", substitute("selawik", "sans-serif")],
	// Common fonts without a free width-compatible clone: an installed copy when there is one, otherwise the
	// closest bundled family, at a size and with line metrics calibrated from Word's recorded page breaks
	// where the corpus holds enough evidence (assets/fonts/manifest.json calibratedLineMetrics), with the
	// family's own metrics otherwise.
	["tahoma", substitute("arimo", "sans-serif", { scale: CALIBRATED_TAHOMA_SCALE, preferLocal: true })],
	["arial narrow", substitute("arimo", "sans-serif", { widthScale: ARIAL_NARROW_WIDTH_SCALE, preferLocal: true })],
	["consolas", substitute("cousine", "monospace", { preferLocal: true })],
	["palatino linotype", substitute("tinos", "serif", { preferLocal: true })],
	["univers", substitute("arimo", "sans-serif", { preferLocal: true })],
	["univers light", substitute("arimo", "sans-serif", { preferLocal: true })]
])

// w:family in a font table (ECMA-376 ST_FontFamily).
export type FontClass = "roman" | "swiss" | "modern" | "script" | "decorative" | "auto"

// w:pitch (ST_Pitch).
export type FontPitch = "fixed" | "variable" | "default"

export interface FontHints {
	readonly fontClass: FontClass | undefined
	readonly pitch: FontPitch | undefined
	// The 10 PANOSE bytes, when the document gives them.
	readonly panose: Uint8Array | undefined
	// w:charset (a Windows character set number).
	readonly charset: number | undefined
}

export const NO_HINTS: FontHints = { fontClass: undefined, pitch: undefined, panose: undefined, charset: undefined }

export interface Fallback {
	// undefined: no bundled family fits; the platform's generic family draws the text.
	readonly family: BundledFamily | undefined
	readonly generic: GenericFamily
}

// Windows character sets the bundled families cover (ANSI, default, Mac, Greek, Turkish, Vietnamese,
// Baltic, Cyrillic, Central European). Fonts declared for anything else (symbol, CJK, Hebrew, Arabic,
// Thai ...) are left to the platform, whose fonts draw those scripts.
const LATIN_CHARSETS = new Set([0, 1, 77, 161, 162, 163, 186, 204, 238])

// PANOSE (Latin text): byte 0 family kind, byte 1 serif style, byte 3 proportion.
const PANOSE_LATIN_TEXT = 2
const PANOSE_MONOSPACED = 9
// Normal, obtuse and perpendicular sans, flared, rounded.
const PANOSE_FIRST_SANS = 11
const PANOSE_LAST_SANS = 15

// Common sans families with no substitute of their own, by the start of their lower-cased name: without the font
// table's hints (a DrawingML theme font often has none), these are drawn in the bundled sans, not the serif.
const SANS_NAMES: readonly string[] = [
	"arial",
	"avenir",
	"bahnschrift",
	"berlin sans",
	"calibri",
	"candara",
	"century gothic",
	"corbel",
	"dejavu sans",
	"eras",
	"franklin gothic",
	"frutiger",
	"futura",
	"gill sans",
	"helvetica",
	"lato",
	"lucida grande",
	"lucida sans",
	"montserrat",
	"myriad",
	"open sans",
	"optima",
	"roboto",
	"segoe",
	"source sans",
	"tahoma",
	"trebuchet",
	"tw cen",
	"ubuntu",
	"univers",
	"verdana"
]

// Whole words only: "Roboto Mono" and "Courier 10 Pitch" are monospaced, "Monotype Corsiva" is not.
const MONOSPACED_NAME = /\b(?:mono(?:spaced?)?|courier)\b/u

// The font table's classification (w:pitch, w:family, PANOSE proportion) decides; the name only without it.
function monospacedFor(lower: string, hints: FontHints): boolean {
	if (hints.pitch === "fixed") return true
	if (hints.pitch === "variable") return false
	if (hints.fontClass === "modern") return true
	if (hints.fontClass !== undefined && hints.fontClass !== "auto") return false

	const panose = hints.panose

	// Proportion 0 (any) and 1 (no fit) say nothing.
	if (panose !== undefined && panose[0] === PANOSE_LATIN_TEXT && (panose[3] ?? 0) >= 2) return panose[3] === PANOSE_MONOSPACED

	return MONOSPACED_NAME.test(lower)
}

// The bundled family to stand in for a font we have no substitute for, from the font table's hints. Text
// in the East Asian or complex-script slots goes to the platform: the bundled families are Latin fonts.
export function fallbackFor(name: string, hints: FontHints, latinSlot: boolean): Fallback {
	const lower = name.toLowerCase()
	const panose = hints.panose
	const latin = latinSlot && (hints.charset === undefined || LATIN_CHARSETS.has(hints.charset))

	if (monospacedFor(lower, hints)) return { family: latin ? "cousine" : undefined, generic: "monospace" }

	let serif: boolean

	if (hints.fontClass === "roman") serif = true
	else if (hints.fontClass === "swiss" || hints.fontClass === "script" || hints.fontClass === "decorative") serif = false
	else if (panose !== undefined && panose[0] === PANOSE_LATIN_TEXT && (panose[1] ?? 0) >= 2) {
		serif = (panose[1] ?? 0) < PANOSE_FIRST_SANS || (panose[1] ?? 0) > PANOSE_LAST_SANS
	} else {
		serif = !lower.includes("sans") && !SANS_NAMES.some(prefix => lower.startsWith(prefix))
	}

	const generic: GenericFamily = serif ? "serif" : "sans-serif"

	return { family: latin ? (serif ? "tinos" : "arimo") : undefined, generic }
}
