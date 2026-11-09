import type { SheetBorderLine, SheetPatternType, SheetRenderStyle } from "../protocol"
import { builtinFormatCode } from "../numfmt/builtins"
import { numFmt, SYSTEM_DATE_TIME, SYSTEM_SHORT_DATE } from "../numfmt/format"
import { NUMFMT_EN_US, type NumFmtLocale } from "../numfmt/locale"
import type { NumFmt } from "../numfmt/parse"
import type {
	XlsxAlignment,
	XlsxBorderEdge,
	XlsxCellProtection,
	XlsxColor,
	XlsxFill,
	XlsxFont,
	XlsxStyleTable,
	XlsxTheme,
	XlsxXf
} from "../../xlsx/model/types"
import { XfApply } from "./xfApply"
import { resolveColor } from "./color"
import { SYSTEM_BACKGROUND, SYSTEM_FOREGROUND, workbookPalette } from "./palette"

// What a cell format (an xf of cellXfs, ECMA-376 Part 1 §18.8.10) resolves to: the render style a grid draws,
// the number format and the protection. Resolved once per style id and cached; the table is append-only, so a
// cached id never goes stale.

export type SheetStyleSource = Pick<
	XlsxStyleTable,
	"numFmts" | "fonts" | "fills" | "borders" | "cellStyleXfs" | "cellXfs" | "indexedColors"
>

export interface SheetStylesOptions {
	// The language of the built-in formats whose code depends on it (NumFmtLocale.builtins).
	readonly locale?: NumFmtLocale
	// Built-in 14 and 22 show the system short date (numFmt), as Excel shows them. Off for sources whose date styles
	// name their own pattern (OpenDocument).
	readonly systemDates?: boolean
}

type Building = { -readonly [K in keyof SheetRenderStyle]: SheetRenderStyle[K] }

const EMPTY_XF: XlsxXf = { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, xfId: 0, flags: 0 }
const NO_STYLE: SheetRenderStyle = {}

export class SheetStyles {
	readonly palette: readonly number[]
	private readonly source: SheetStyleSource
	private readonly theme: XlsxTheme | null
	private readonly locale: NumFmtLocale
	private readonly renderStyles: (SheetRenderStyle | undefined)[] = []
	private readonly codes: (string | undefined)[] = []
	private readonly formats: (NumFmt | undefined)[] = []
	private readonly systemDates: boolean

	constructor(source: SheetStyleSource, theme: XlsxTheme | null, options: SheetStylesOptions = {}) {
		this.source = source
		this.theme = theme
		this.locale = options.locale ?? NUMFMT_EN_US
		this.systemDates = options.systemDates ?? true
		this.palette = workbookPalette(source.indexedColors)
	}

	// An index the table does not have reads as the first (as a missing `s` does).
	private key(index: number): number {
		return index >= 0 && index < this.source.cellXfs.length ? index : 0
	}

	private xf(index: number): XlsxXf {
		return this.source.cellXfs[this.key(index)] ?? EMPTY_XF
	}

	// The cell style's xf (cellStyleXfs) an xf inherits from, if any.
	private styleXf(xf: XlsxXf): XlsxXf | undefined {
		return xf.xfId >= 0 ? this.source.cellStyleXfs[xf.xfId] : undefined
	}

	// A cell xf shows its own font, fill, border and number format (MS-OI29500 §2.1.721: in cellXfs an apply*
	// attribute only says whether a later change of the cell style reaches the cell, and a cell differing from its
	// style has it set). Its alignment and protection, written as children, come from the cell style when the cell
	// has none and does not apply its own.
	private inherited<T>(xf: XlsxXf, own: T | undefined, bit: number, of: (style: XlsxXf) => T | undefined): T | undefined {
		if (own !== undefined || (xf.flags & bit) !== 0) return own

		const style = this.styleXf(xf)

		return style === undefined ? undefined : of(style)
	}

	alignment(index: number): XlsxAlignment | undefined {
		const xf = this.xf(index)

		return this.inherited(xf, xf.alignment, XfApply.ALIGNMENT, style => style.alignment)
	}

	protection(index: number): XlsxCellProtection | undefined {
		const xf = this.xf(index)

		return this.inherited(xf, xf.protection, XfApply.PROTECTION, style => style.protection)
	}

	// Cells are locked unless their format says otherwise (§18.8.33).
	locked(index: number): boolean {
		return this.protection(index)?.locked !== false
	}

	formulaHidden(index: number): boolean {
		return this.protection(index)?.hidden === true
	}

	// An entry typed into the cell is text (quotePrefix, §18.8.45).
	quotePrefix(index: number): boolean {
		return (this.xf(index).flags & XfApply.QUOTE_PREFIX) !== 0
	}

	// The number format code: the workbook's own record for the id, else the built-in one (§18.8.30), else General.
	numFmtCode(index: number): string {
		const key = this.key(index)
		let code = this.codes[key]

		if (code === undefined) {
			const id = this.xf(key).numFmtId

			code = this.source.numFmts.get(id) ?? builtinFormatCode(id, this.locale) ?? "General"
			this.codes[key] = code
		}

		return code
	}

	// The compiled format a cell shows through: built-in 14 and 22 show the system short date (formatNumberInto
	// takes it from the locale); the code stays the table's.
	numFmt(index: number): NumFmt {
		const key = this.key(index)
		let format = this.formats[key]

		if (format === undefined) {
			const id = this.xf(key).numFmtId
			const own = !this.systemDates || this.source.numFmts.has(id) || this.locale.builtins[id] !== undefined

			format = !own && id === 14 ? SYSTEM_SHORT_DATE : !own && id === 22 ? SYSTEM_DATE_TIME : numFmt(this.numFmtCode(key))
			this.formats[key] = format
		}

		return format
	}

	// A colour of this workbook as 0xRRGGBB (theme and tint applied), or -1.
	color(color: XlsxColor | undefined, auto?: number): number {
		return resolveColor(color, this.theme, this.palette, auto)
	}

	renderStyle(index: number): SheetRenderStyle {
		const key = this.key(index)
		let style = this.renderStyles[key]

		if (style === undefined) {
			style = this.source.cellXfs.length === 0 ? NO_STYLE : this.build(this.xf(key))
			this.renderStyles[key] = style
		}

		return style
	}

	private build(xf: XlsxXf): SheetRenderStyle {
		const style: Building = {}
		const font = this.source.fonts[xf.fontId] ?? this.source.fonts[0]

		if (font !== undefined) this.applyFont(style, font)

		const fill = this.source.fills[xf.fillId]

		if (fill !== undefined) this.applyFill(style, fill)

		const border = this.source.borders[xf.borderId]

		if (border !== undefined) {
			const line = (edge: XlsxBorderEdge | undefined): SheetBorderLine | undefined =>
				edge?.style === undefined ? undefined : { style: edge.style, color: this.edgeColor(edge.color) }
			const top = line(border.top)
			const right = line(border.right)
			const bottom = line(border.bottom)
			const left = line(border.left)
			const diagonal = line(border.diagonal)

			if (top !== undefined) style.top = top
			if (right !== undefined) style.right = right
			if (bottom !== undefined) style.bottom = bottom
			if (left !== undefined) style.left = left

			if (diagonal !== undefined) {
				if (border.diagonalUp === true) style.diagonalUp = diagonal
				if (border.diagonalDown === true) style.diagonalDown = diagonal
			}
		}

		const alignment = this.inherited(xf, xf.alignment, XfApply.ALIGNMENT, parent => parent.alignment)

		if (alignment !== undefined) applyAlignment(style, alignment)

		return style
	}

	private edgeColor(color: XlsxColor | undefined): number {
		const rgb = this.color(color)

		return rgb < 0 ? (this.palette[SYSTEM_FOREGROUND] ?? 0) : rgb
	}

	// A font of the theme's scheme (§18.8.35 scheme) shows the theme's major or minor font.
	private applyFont(style: Building, font: XlsxFont): void {
		const name =
			font.scheme === "major" && this.theme !== null && this.theme.majorFont !== ""
				? this.theme.majorFont
				: font.scheme === "minor" && this.theme !== null && this.theme.minorFont !== ""
					? this.theme.minorFont
					: font.name

		if (name !== undefined && name !== "") style.font = name
		if (font.size !== undefined && font.size > 0) style.size = font.size
		if (font.bold === true) style.bold = true
		if (font.italic === true) style.italic = true
		if (font.strike === true) style.strike = true
		if (font.underline !== undefined && font.underline !== "none") style.underline = font.underline
		if (font.vertAlign === "superscript" || font.vertAlign === "subscript") style.script = font.vertAlign

		const color = this.color(font.color)

		if (color >= 0 && font.color?.auto !== true) style.color = color
	}

	// Fills (§18.8.20): a solid pattern is its foreground colour; another pattern draws its foreground over its
	// background; a gradient shows as the average of its stops along the gradient.
	private applyFill(style: Building, fill: XlsxFill): void {
		const foreground = this.palette[SYSTEM_FOREGROUND] ?? 0
		const background = this.palette[SYSTEM_BACKGROUND] ?? 0xffffff

		if (fill.kind === "pattern") {
			if (fill.pattern === "none") return

			const fg = this.color(fill.fg, foreground)
			const bg = this.color(fill.bg, background)

			if (fill.pattern === "solid") {
				style.fill = fg >= 0 ? fg : foreground

				return
			}

			style.pattern = {
				type: fill.pattern as SheetPatternType,
				color: fg >= 0 ? fg : foreground,
				background: bg >= 0 ? bg : background
			}

			return
		}

		const stops = fill.stops
			.map(stop => ({ position: Math.max(0, Math.min(1, stop.position)), color: this.color(stop.color, foreground) }))
			.filter(stop => stop.color >= 0)
			.sort((a, b) => a.position - b.position)

		if (stops.length === 0) return

		style.fill = averageGradient(stops)
	}
}

// The mean colour of a piecewise-linear gradient over [0, 1], each channel separately; the first and last stops
// extend to the ends.
function averageGradient(stops: readonly { readonly position: number; readonly color: number }[]): number {
	const first = stops[0] as { position: number; color: number }

	if (stops.length === 1) return first.color

	let red = 0
	let green = 0
	let blue = 0
	const add = (color: number, weight: number): void => {
		red += ((color >> 16) & 0xff) * weight
		green += ((color >> 8) & 0xff) * weight
		blue += (color & 0xff) * weight
	}

	add(first.color, first.position)

	for (let i = 1; i < stops.length; i++) {
		const a = stops[i - 1] as { position: number; color: number }
		const b = stops[i] as { position: number; color: number }
		const span = b.position - a.position

		add(a.color, span / 2)
		add(b.color, span / 2)
	}

	const last = stops[stops.length - 1] as { position: number; color: number }

	add(last.color, 1 - last.position)

	const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))

	return (channel(red) << 16) | (channel(green) << 8) | channel(blue)
}

// Alignment (§18.8.1): textRotation 1-90 is counter-clockwise, 91-180 clockwise (90 - value), 255 stacked.
function applyAlignment(style: Building, alignment: XlsxAlignment): void {
	if (alignment.horizontal !== undefined && alignment.horizontal !== "general") style.align = alignment.horizontal
	if (alignment.vertical !== undefined && alignment.vertical !== "bottom") style.valign = alignment.vertical
	if (alignment.wrapText === true) style.wrap = true
	if (alignment.shrinkToFit === true) style.shrink = true
	if (alignment.indent !== undefined && alignment.indent > 0) style.indent = alignment.indent

	const rotation = alignment.textRotation

	if (rotation !== undefined && rotation > 0 && (rotation <= 180 || rotation === 255))
		style.rotation = rotation === 255 || rotation <= 90 ? rotation : 90 - rotation

	if (alignment.readingOrder === 2) style.rightToLeft = true
}
