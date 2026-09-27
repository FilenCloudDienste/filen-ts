import type { CellStyle, Color } from "hucre"
import { resolveThemeColor } from "hucre/xlsx"
import type { CellStyleView, HorizontalAlign, VerticalAlign } from "@/features/spreadsheet/lib/model"

// Excel's legacy indexed palette, the first 64 entries (0-7 repeat 8-15); newer files use rgb or theme
// colours, older ones still index into this.
const INDEXED_COLORS = [
	"000000",
	"FFFFFF",
	"FF0000",
	"00FF00",
	"0000FF",
	"FFFF00",
	"FF00FF",
	"00FFFF",
	"000000",
	"FFFFFF",
	"FF0000",
	"00FF00",
	"0000FF",
	"FFFF00",
	"FF00FF",
	"00FFFF",
	"800000",
	"008000",
	"000080",
	"808000",
	"800080",
	"008080",
	"C0C0C0",
	"808080",
	"9999FF",
	"993366",
	"FFFFCC",
	"CCFFFF",
	"660066",
	"FF8080",
	"0066CC",
	"CCCCFF",
	"000080",
	"FF00FF",
	"FFFF00",
	"00FFFF",
	"800080",
	"800000",
	"008080",
	"0000FF",
	"00CCFF",
	"CCFFFF",
	"CCFFCC",
	"FFFF99",
	"99CCFF",
	"FF99CC",
	"CC99FF",
	"FFCC99",
	"3366FF",
	"33CCCC",
	"99CC00",
	"FFCC00",
	"FF9900",
	"FF6600",
	"666699",
	"969696",
	"003366",
	"339966",
	"003300",
	"333300",
	"993300",
	"993366",
	"333399",
	"333333"
]

// A workbook colour as CSS hex, or undefined for "automatic" and anything unresolvable. rgb comes as
// RRGGBB or AARRGGBB.
export function cssColor(color: Color | undefined, themeColors: readonly string[] | undefined): string | undefined {
	if (color === undefined) {
		return undefined
	}

	let hex: string | undefined

	if (color.rgb !== undefined) {
		hex = color.rgb.length === 8 ? color.rgb.slice(2) : color.rgb
	} else if (color.theme !== undefined && themeColors !== undefined && themeColors.length > color.theme) {
		hex = resolveThemeColor([...themeColors], color.theme, color.tint)
	} else if (color.indexed !== undefined) {
		hex = INDEXED_COLORS[color.indexed]
	}

	return hex !== undefined && /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : undefined
}

function horizontal(value: string | undefined): HorizontalAlign | undefined {
	switch (value) {
		case "left":
		case "center":
		case "right":
			return value
		case "centerContinuous":
			return "center"
		default:
			return undefined
	}
}

function vertical(value: string | undefined): VerticalAlign | undefined {
	switch (value) {
		case "top":
		case "bottom":
			return value
		case "center":
			return "middle"
		default:
			return undefined
	}
}

// The drawn part of a workbook format; undefined when nothing of it shows.
export function styleView(
	style: CellStyle | undefined,
	themeColors: readonly string[] | undefined,
	defaultSize: number
): CellStyleView | undefined {
	if (style === undefined) {
		return undefined
	}

	const view: CellStyleView = {}
	const font = style.font

	if (font?.bold === true) view.bold = true
	if (font?.italic === true) view.italic = true
	if (font?.underline !== undefined && font.underline !== false) view.underline = true
	if (font?.strikethrough === true) view.strike = true
	if (font?.size !== undefined && font.size !== defaultSize) view.size = font.size

	const color = cssColor(font?.color, themeColors)

	if (color !== undefined && color !== "#000000") view.color = color

	if (style.fill?.type === "pattern" && style.fill.pattern === "solid") {
		const fill = cssColor(style.fill.fgColor, themeColors)

		if (fill !== undefined) view.fill = fill
	}

	const align = horizontal(style.alignment?.horizontal)
	const valign = vertical(style.alignment?.vertical)

	if (align !== undefined) view.align = align
	if (valign !== undefined) view.valign = valign
	if (style.alignment?.wrapText === true) view.wrap = true
	if (style.numFmt !== undefined && style.numFmt !== "General") view.numFmt = style.numFmt

	return Object.keys(view).length === 0 ? undefined : view
}

// Deduplicates style views into the doc's table, so a million cells in three formats carry three objects.
export class StyleTable {
	readonly styles: CellStyleView[] = []
	private readonly index = new Map<string, number>()

	add(view: CellStyleView | undefined): number | undefined {
		if (view === undefined) {
			return undefined
		}

		const key = JSON.stringify(view)
		let id = this.index.get(key)

		if (id === undefined) {
			id = this.styles.length
			this.styles.push(view)
			this.index.set(key, id)
		}

		return id
	}
}
