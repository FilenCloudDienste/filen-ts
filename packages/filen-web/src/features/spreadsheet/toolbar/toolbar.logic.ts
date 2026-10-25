import {
	CellFlag,
	COMMA_STYLE,
	NUMBER_FORMAT_PRESETS,
	PERCENT_STYLE,
	applyTint,
	changedDecimals,
	numFmtCategory,
	themeTints,
	type NumFmtCategory,
	type SheetBorderPreset,
	type SheetBorderStyle,
	type SheetColorInput,
	type SheetFormatChoices,
	type SheetFormatPatch,
	type SheetHorizontalAlign,
	type SheetRenderStyle,
	type SheetRgb,
	type SheetVerticalAlign
} from "@filen/office/core/sheet"
import { SHEET_SHORTCUTS, type SheetShortcut } from "@filen/office/react/sheet"
import { STANDARD_SWATCHES, type DocxSwatch } from "@/features/office/lib/officeControls"
import type { PreviewKey } from "@/lib/i18n"

// What the spreadsheet ribbon shows and sends: the active cell's format as the controls read it, the pickers'
// choices (fonts, sizes, colours, border lines, alignments, number formats) and the changes each control makes.

// --- The active cell ---

export interface ActiveFormat {
	readonly font: string
	readonly size: number
	readonly bold: boolean
	readonly italic: boolean
	readonly underline: boolean
	readonly strike: boolean
	// 0xRRGGBB; undefined for automatic text and no fill.
	readonly color: SheetRgb | undefined
	readonly fill: SheetRgb | undefined
	readonly align: SheetHorizontalAlign | "general"
	readonly valign: SheetVerticalAlign
	readonly wrap: boolean
	readonly shrink: boolean
	// Indent levels.
	readonly indent: number
	// As the file writes it (§18.8.1 textRotation): 0 none, 1-90 counter-clockwise, 91-180 clockwise, 255 stacked.
	readonly rotation: number
	readonly numFmt: string
	// The cell's text as shown (what Increase Decimal starts a General cell from).
	readonly shown: string
}

// Excel's default font for a workbook without one.
const DEFAULT_FONT = "Calibri"
const DEFAULT_SIZE = 11

// A cell's render style over the workbook's default one (style 0), as the toolbar reads it.
export function activeFormat(style: SheetRenderStyle, base: SheetRenderStyle, numFmt: string, shown: string): ActiveFormat {
	return {
		font: style.font ?? base.font ?? DEFAULT_FONT,
		size: style.size ?? base.size ?? DEFAULT_SIZE,
		bold: style.bold === true,
		italic: style.italic === true,
		underline: style.underline !== undefined,
		strike: style.strike === true,
		color: style.color,
		fill: style.fill,
		align: style.align ?? "general",
		valign: style.valign ?? "bottom",
		wrap: style.wrap === true,
		shrink: style.shrink === true,
		indent: style.indent ?? 0,
		// The render style turns clockwise angles negative.
		rotation: style.rotation === undefined ? 0 : style.rotation < 0 ? 90 - style.rotation : style.rotation,
		numFmt,
		shown
	}
}

// The 1900 date system's day 0 (1899-12-30, as serials count past the leap day Excel keeps) and the 1904 system's
// offset from it (ECMA-376 Part 1 §18.17.4).
const DAY_MS = 86_400_000
const EPOCH_1900 = Date.UTC(1899, 11, 30)
const OFFSET_1904 = 1462
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/u

// A cell's number from what editing it starts from (a number, or a date as yyyy-mm-dd[Thh:mm:ss]), for the format
// previews; null for text, a formula or anything else.
export function sampleOf(input: string, flags: number, date1904: boolean): number | null {
	if ((flags & CellFlag.FORMULA) !== 0 || (flags & CellFlag.NUMBER) === 0) {
		return null
	}

	const number = Number(input)

	if (input.trim() !== "" && Number.isFinite(number)) {
		return number
	}

	const iso = ISO.exec(input)

	if (iso === null) {
		return null
	}

	const day = (Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) - EPOCH_1900) / DAY_MS
	const time = (Number(iso[4] ?? 0) * 3600 + Number(iso[5] ?? 0) * 60 + Number(iso[6] ?? 0)) / 86_400
	// Serials before 1900-03-01 count Excel's 1900-02-29 too.
	const serial = day < 61 ? day - 1 + time : day + time

	return date1904 ? serial - OFFSET_1904 : serial
}

// --- Fonts ---

// Excel's font size list.
export const FONT_SIZES: readonly number[] = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]

// Fonts most systems have, offered after the theme's and the workbook's own.
export const COMMON_FONTS: readonly string[] = [
	"Aptos",
	"Arial",
	"Calibri",
	"Cambria",
	"Candara",
	"Consolas",
	"Courier New",
	"Georgia",
	"Segoe UI",
	"Tahoma",
	"Times New Roman",
	"Trebuchet MS",
	"Verdana"
]

export interface FontGroup {
	readonly label: PreviewKey
	readonly fonts: readonly { readonly name: string; readonly theme?: "headings" | "body" }[]
}

// The font picker's groups: the theme's heading and body fonts, the workbook's, then common ones; each font once,
// the first group that has it keeping it.
export function fontGroups(choices: SheetFormatChoices | undefined): FontGroup[] {
	const seen = new Set<string>()
	const take = (name: string): boolean => {
		const key = name.toLowerCase()

		if (name === "" || seen.has(key)) {
			return false
		}

		seen.add(key)

		return true
	}
	const theme: { name: string; theme: "headings" | "body" }[] = []

	if (choices !== undefined && take(choices.majorFont)) {
		theme.push({ name: choices.majorFont, theme: "headings" })
	}

	if (choices !== undefined && take(choices.minorFont)) {
		theme.push({ name: choices.minorFont, theme: "body" })
	}

	const own = (choices?.fonts ?? []).filter(take).map(name => ({ name }))
	const common = COMMON_FONTS.filter(take).map(name => ({ name }))
	const groups: FontGroup[] = []

	if (theme.length > 0) {
		groups.push({ label: "previewSheetFormatThemeFonts", fonts: theme })
	}

	if (own.length > 0) {
		groups.push({ label: "previewSheetFormatWorkbookFonts", fonts: own })
	}

	groups.push({ label: "previewSheetFormatOtherFonts", fonts: common })

	return groups
}

// --- Colours ---

export interface SheetSwatch extends DocxSwatch {
	readonly input: SheetColorInput
}

function hex(rgb: SheetRgb): string {
	return rgb.toString(16).padStart(6, "0").toUpperCase()
}

const THEME_NAMES: readonly PreviewKey[] = [
	"previewOfficeColorBackground1",
	"previewOfficeColorText1",
	"previewOfficeColorBackground2",
	"previewOfficeColorText2",
	"previewOfficeColorAccent1",
	"previewOfficeColorAccent2",
	"previewOfficeColorAccent3",
	"previewOfficeColorAccent4",
	"previewOfficeColorAccent5",
	"previewOfficeColorAccent6"
]

// The colour picker's theme part as rows (the ten theme colours, then each tint variation), from the workbook's
// theme colours (SpreadsheetML theme indices 0-9, §18.8.3) and Excel's tints; colours shown as the grid draws them.
export function themeSwatchRows(themeColors: readonly SheetRgb[]): SheetSwatch[][] {
	const columns = THEME_NAMES.map((name, theme) => {
		const base = themeColors[theme] ?? 0
		const column: SheetSwatch[] = [
			{ key: `theme:${String(theme)}`, rgb: hex(base), label: { name }, color: { kind: "rgb", value: hex(base) }, input: { theme } }
		]

		for (const tint of themeTints(theme)) {
			const rgb = hex(applyTint(base, tint))

			column.push({
				key: `theme:${String(theme)}:${String(tint)}`,
				rgb,
				label: { name, tone: { lighter: tint > 0, percent: Math.round(Math.abs(tint) * 100) } },
				color: { kind: "rgb", value: rgb },
				input: { theme, tint }
			})
		}

		return column
	})

	return (columns[0] ?? []).map((_, row) => columns.flatMap(column => (column[row] === undefined ? [] : [column[row]])))
}

// Excel's standard colours (the same ten as Word's).
export const STANDARD_SHEET_SWATCHES: readonly SheetSwatch[] = STANDARD_SWATCHES.map(swatch => ({
	...swatch,
	input: Number.parseInt(swatch.rgb, 16)
}))

// The swatch showing a colour, for marking the one in effect.
export function swatchKeyOf(rgb: SheetRgb | undefined, swatches: readonly SheetSwatch[]): string | undefined {
	if (rgb === undefined) {
		return undefined
	}

	const wanted = hex(rgb)

	return swatches.find(swatch => swatch.rgb === wanted)?.key
}

// --- Borders ---

export const BORDER_LABELS: Readonly<Record<SheetBorderPreset, PreviewKey>> = {
	bottom: "previewSheetBorderBottom",
	top: "previewSheetBorderTop",
	left: "previewSheetBorderLeft",
	right: "previewSheetBorderRight",
	none: "previewSheetBorderNone",
	all: "previewSheetBorderAll",
	outside: "previewSheetBorderOutside",
	thickOutside: "previewSheetBorderThickOutside",
	bottomDouble: "previewSheetBorderBottomDouble",
	thickBottom: "previewSheetBorderThickBottom",
	topBottom: "previewSheetBorderTopBottom",
	topThickBottom: "previewSheetBorderTopThickBottom",
	topDoubleBottom: "previewSheetBorderTopDoubleBottom",
	inside: "previewSheetBorderInside",
	insideHorizontal: "previewSheetBorderInsideHorizontal",
	insideVertical: "previewSheetBorderInsideVertical",
	diagonalUp: "previewSheetBorderDiagonalUp",
	diagonalDown: "previewSheetBorderDiagonalDown"
}

// Excel's line styles, in its dialog's order, with how a menu draws each (SVG stroke width and dashes).
export const LINE_STYLES: readonly {
	readonly style: SheetBorderStyle
	readonly label: PreviewKey
	readonly width: number
	readonly dash: string
	readonly double?: boolean
}[] = [
	{ style: "hair", label: "previewSheetLineHair", width: 1, dash: "1 1" },
	{ style: "dotted", label: "previewSheetLineDotted", width: 1, dash: "1 2" },
	{ style: "dashDotDot", label: "previewSheetLineDashDotDot", width: 1, dash: "9 3 3 3 3 3" },
	{ style: "dashDot", label: "previewSheetLineDashDot", width: 1, dash: "9 3 3 3" },
	{ style: "dashed", label: "previewSheetLineDashed", width: 1, dash: "3 1" },
	{ style: "thin", label: "previewSheetLineThin", width: 1, dash: "" },
	{ style: "mediumDashDotDot", label: "previewSheetLineMediumDashDotDot", width: 2, dash: "9 3 3 3 3 3" },
	{ style: "slantDashDot", label: "previewSheetLineSlantDashDot", width: 2, dash: "11 1 5 1" },
	{ style: "mediumDashDot", label: "previewSheetLineMediumDashDot", width: 2, dash: "9 3 3 3" },
	{ style: "mediumDashed", label: "previewSheetLineMediumDashed", width: 2, dash: "9 3" },
	{ style: "medium", label: "previewSheetLineMedium", width: 2, dash: "" },
	{ style: "thick", label: "previewSheetLineThick", width: 3, dash: "" },
	{ style: "double", label: "previewSheetLineDouble", width: 1, dash: "", double: true }
]

// --- Alignment ---

export const HORIZONTAL_ALIGNS: readonly { readonly align: SheetHorizontalAlign | "general"; readonly label: PreviewKey }[] = [
	{ align: "general", label: "previewSheetAlignGeneral" },
	{ align: "left", label: "previewSheetAlignLeft" },
	{ align: "center", label: "previewSheetAlignCenter" },
	{ align: "right", label: "previewSheetAlignRight" },
	{ align: "fill", label: "previewSheetAlignFill" },
	{ align: "justify", label: "previewSheetAlignJustify" },
	{ align: "centerContinuous", label: "previewSheetAlignCenterAcross" },
	{ align: "distributed", label: "previewSheetAlignDistributed" }
]

export const VERTICAL_ALIGNS: readonly { readonly valign: SheetVerticalAlign; readonly label: PreviewKey }[] = [
	{ valign: "top", label: "previewSheetAlignTop" },
	{ valign: "center", label: "previewSheetAlignMiddle" },
	{ valign: "bottom", label: "previewSheetAlignBottom" },
	{ valign: "justify", label: "previewSheetAlignJustify" },
	{ valign: "distributed", label: "previewSheetAlignDistributed" }
]

// General is no alignment of the cell's own (null clears it); bottom is the default vertical one.
export function alignPatch(align: SheetHorizontalAlign | "general"): SheetFormatPatch {
	return { align: align === "general" ? null : align }
}

export function valignPatch(valign: SheetVerticalAlign): SheetFormatPatch {
	return { valign: valign === "bottom" ? null : valign }
}

// Excel's most indent levels.
const MAX_INDENT = 15

// Increase or Decrease Indent: a level more or less; an indent needs an alignment that takes one, so General and
// the centred ones become left as in Excel. Null when there is no level to take away.
export function indentPatch(format: Pick<ActiveFormat, "indent" | "align">, delta: 1 | -1): SheetFormatPatch | null {
	const indent = Math.min(MAX_INDENT, Math.max(0, format.indent + delta))

	if (indent === format.indent) {
		return null
	}

	const takes = format.align === "left" || format.align === "right" || format.align === "distributed"

	return indent > 0 && !takes ? { indent, align: "left" } : { indent }
}

// The Orientation menu's angles (textRotation), in Excel's order.
export const ORIENTATIONS: readonly { readonly rotation: number; readonly label: PreviewKey }[] = [
	{ rotation: 45, label: "previewSheetRotationCounterclockwise" },
	{ rotation: 135, label: "previewSheetRotationClockwise" },
	{ rotation: 255, label: "previewSheetRotationVertical" },
	{ rotation: 90, label: "previewSheetRotationUp" },
	{ rotation: 180, label: "previewSheetRotationDown" }
]

// An angle picked again takes the text back to horizontal, as Excel's menu does.
export function rotationPatch(current: number, picked: number): SheetFormatPatch {
	return { rotation: current === picked ? 0 : picked }
}

// --- Number formats ---

const CATEGORY_LABELS_BY_NAME: Readonly<Record<NumFmtCategory, PreviewKey>> = {
	general: "previewSheetNumberGeneral",
	number: "previewSheetNumberNumber",
	currency: "previewSheetNumberCurrency",
	accounting: "previewSheetNumberAccounting",
	date: "previewSheetNumberDate",
	time: "previewSheetNumberTime",
	percentage: "previewSheetNumberPercentage",
	fraction: "previewSheetNumberFraction",
	scientific: "previewSheetNumberScientific",
	text: "previewSheetNumberText",
	custom: "previewSheetNumberCustom"
}

// The Number Format menu's items: Excel's Home tab list (core NUMBER_FORMAT_PRESETS), each with its label.
export const NUMBER_ITEMS: readonly { readonly code: string; readonly label: PreviewKey }[] = NUMBER_FORMAT_PRESETS.map(
	(preset, index) => ({
		code: preset.code,
		label:
			preset.category === "date"
				? index === NUMBER_FORMAT_PRESETS.findIndex(entry => entry.category === "date")
					? "previewSheetNumberShortDate"
					: "previewSheetNumberLongDate"
				: CATEGORY_LABELS_BY_NAME[preset.category]
	})
)

// The Format Cells dialog's categories, in its order.
export const CATEGORIES: readonly NumFmtCategory[] = [
	"general",
	"number",
	"currency",
	"accounting",
	"date",
	"time",
	"percentage",
	"fraction",
	"scientific",
	"text",
	"custom"
]

export const CATEGORY_LABELS: Readonly<Record<NumFmtCategory, PreviewKey>> = CATEGORY_LABELS_BY_NAME

// The menu trigger's label: the item showing the code, else its category's name.
export function numberLabel(code: string): PreviewKey {
	const item = NUMBER_ITEMS.find(entry => entry.code === code)

	return item?.label ?? CATEGORY_LABELS[numFmtCategory(code)]
}

// Increase or Decrease Decimal on a cell of `numFmt` showing `shown`: the change, or null when its format has no
// decimals to change (text, dates, times, fractions).
export function decimalsPatch(numFmt: string, shown: string, delta: 1 | -1, decimal: string): SheetFormatPatch | null {
	const code = changedDecimals(numFmt, delta, shown, decimal)

	return code === null ? null : { numFmt: code }
}

export const PERCENT_PATCH: SheetFormatPatch = { numFmt: PERCENT_STYLE }
export const COMMA_PATCH: SheetFormatPatch = { numFmt: COMMA_STYLE }

// --- View ---

// The View tab's zoom steps (%), within the grid's 10-400.
const ZOOM_STEPS: readonly number[] = [25, 50, 75, 100, 125, 150, 200, 300, 400]

// The next step above (1) or below (-1) `percent`, held at the ends.
export function zoomStep(percent: number, direction: 1 | -1): number {
	if (direction > 0) {
		return ZOOM_STEPS.find(step => step > percent) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? percent
	}

	return ZOOM_STEPS.findLast(step => step < percent) ?? ZOOM_STEPS[0] ?? percent
}

// --- Shortcuts ---

// Keys a chord names by position (KeyboardEvent.code), as printed on a US keyboard.
const CODE_KEYS: Readonly<Record<string, string>> = {
	Equal: "=",
	Minus: "-",
	Backquote: "`",
	Semicolon: ";",
	Quote: "'",
	Period: ".",
	NumpadAdd: "+",
	NumpadSubtract: "-",
	NumpadMultiply: "*"
}

// A grid shortcut's first chord (react/sheet/keys.ts) as the keys a tooltip shows; null for one without a chord.
export function sheetShortcutKeys(action: SheetShortcut, mac: boolean): string[] | null {
	const entry = SHEET_SHORTCUTS.find(candidate => candidate.action === action)
	const chord = (mac ? entry?.mac : entry?.windows)?.[0]

	if (chord === undefined) {
		return null
	}

	const keys: string[] = []

	if (chord.control === true) keys.push(mac ? "⌃" : "Ctrl")
	if (chord.primary === true) keys.push(mac ? "⌘" : "Ctrl")
	if (chord.alt === true) keys.push(mac ? "⌥" : "Alt")
	if (chord.shift === true) keys.push(mac ? "⇧" : "Shift")

	const key = chord.key ?? (chord.code === undefined ? "" : (CODE_KEYS[chord.code] ?? chord.code.replace(/^(Key|Digit)/u, "")))

	keys.push(key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key)

	return keys
}
