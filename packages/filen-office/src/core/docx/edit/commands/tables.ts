import { MAX_TWIPS, choiceArg, field, hexArg, intArg, optional, stringArg, type DocxCommandInfo, type DocxCommandParser } from "./base"
import { DOCX_THEME_COLORS, type DocxThemeColor } from "./formatting"

// Table structure and properties. Commands act on the cells the selection touches.

// Word's limits: 63 columns, 32767 rows.
export const MAX_TABLE_COLUMNS = 63
export const MAX_TABLE_ROWS = 32767

export type DocxTableAlign = "start" | "center" | "end"
export type DocxCellVAlign = "top" | "center" | "bottom"

export type TableCommand =
	| { readonly type: "table.insert"; readonly rows: number; readonly cols: number }
	| { readonly type: "table.delete" }
	| { readonly type: "table.row.insertAbove" }
	| { readonly type: "table.row.insertBelow" }
	| { readonly type: "table.row.delete" }
	| { readonly type: "table.column.insertLeft" }
	| { readonly type: "table.column.insertRight" }
	| { readonly type: "table.column.delete" }
	| { readonly type: "table.cells.merge" }
	| { readonly type: "table.cell.split"; readonly rows: number; readonly cols: number }
	| { readonly type: "table.row.header" }
	| { readonly type: "table.style"; readonly styleId: string }
	| { readonly type: "table.align"; readonly align: DocxTableAlign }
	// Twips; `index` a grid column.
	| { readonly type: "table.column.width"; readonly index: number; readonly twips: number }
	// "RRGGBB", or null for none. A theme colour (with a tint or a shade, 0–255) is written as Word writes one:
	// its reference with the colour it gives, which the editor computes from the document's theme (`fill` where
	// the document has none).
	| {
			readonly type: "table.cell.shading"
			readonly fill: string | null
			readonly theme?: DocxThemeColor
			readonly tint?: number
			readonly shade?: number
	  }
	| { readonly type: "table.cell.vAlign"; readonly align: DocxCellVAlign }
	| { readonly type: "table.distributeColumns" }

const table = { write: true, scope: "story", group: "table", context: "table" } as const

export const TABLE_COMMANDS: readonly DocxCommandInfo<TableCommand["type"]>[] = [
	{
		type: "table.insert",
		labelKey: "docx.table.insert",
		icon: "table-insert",
		// No key of Word's; one a user binds opens the host's size dialog.
		hostShortcut: true,
		write: true,
		scope: "story",
		group: "table",
		input: "tableSize"
	},
	{ type: "table.delete", labelKey: "docx.table.delete", icon: "table-delete", ...table },
	{ type: "table.row.insertAbove", labelKey: "docx.table.row.insertAbove", icon: "row-insert-above", ...table },
	{ type: "table.row.insertBelow", labelKey: "docx.table.row.insertBelow", icon: "row-insert-below", ...table },
	{ type: "table.row.delete", labelKey: "docx.table.row.delete", icon: "row-delete", ...table },
	{ type: "table.column.insertLeft", labelKey: "docx.table.column.insertLeft", icon: "column-insert-left", ...table },
	{ type: "table.column.insertRight", labelKey: "docx.table.column.insertRight", icon: "column-insert-right", ...table },
	{ type: "table.column.delete", labelKey: "docx.table.column.delete", icon: "column-delete", ...table },
	{ type: "table.cells.merge", labelKey: "docx.table.cells.merge", icon: "cells-merge", ...table },
	{ type: "table.cell.split", labelKey: "docx.table.cell.split", icon: "cell-split", input: "tableSize", ...table },
	{ type: "table.row.header", labelKey: "docx.table.row.header", icon: "row-header", ...table },
	{ type: "table.style", labelKey: "docx.table.style", icon: "table-style", input: "choice", ...table },
	{ type: "table.align", labelKey: "docx.table.align", icon: "table-align", input: "choice", ...table },
	{ type: "table.column.width", labelKey: "docx.table.column.width", icon: "column-width", ...table },
	{ type: "table.cell.shading", labelKey: "docx.table.cell.shading", icon: "cell-shading", input: "color", ...table },
	{ type: "table.cell.vAlign", labelKey: "docx.table.cell.vAlign", icon: "cell-valign", input: "choice", ...table },
	{ type: "table.distributeColumns", labelKey: "docx.table.distributeColumns", icon: "columns-distribute", ...table }
]

const TABLE_ALIGNS = new Set<string>(["start", "center", "end"])
const CELL_ALIGNS = new Set<string>(["top", "center", "bottom"])
const THEME_COLORS: ReadonlySet<string> = new Set(DOCX_THEME_COLORS)

function size(value: object): { rows: number; cols: number } | undefined {
	const rows = intArg(value, "rows", 1, MAX_TABLE_ROWS)
	const cols = intArg(value, "cols", 1, MAX_TABLE_COLUMNS)

	return rows === undefined || cols === undefined ? undefined : { rows, cols }
}

export const parseTableCommand: DocxCommandParser<TableCommand> = (type, value) => {
	switch (type) {
		case "table.insert":
		case "table.cell.split": {
			const dimensions = size(value)

			return dimensions === undefined ? undefined : { type, ...dimensions }
		}
		case "table.style": {
			// Style ids Word writes: at most 253 characters.
			const styleId = stringArg(value, "styleId", 253, 1)

			return styleId === undefined ? undefined : { type, styleId }
		}
		case "table.align": {
			const align = choiceArg<DocxTableAlign>(value, "align", TABLE_ALIGNS)

			return align === undefined ? undefined : { type, align }
		}
		case "table.column.width": {
			const index = intArg(value, "index", 0, MAX_TABLE_COLUMNS - 1)
			const twips = intArg(value, "twips", 0, MAX_TWIPS)

			return index === undefined || twips === undefined ? undefined : { type, index, twips }
		}
		case "table.cell.shading": {
			if (field(value, "fill") === null)
				return field(value, "theme") === undefined && field(value, "tint") === undefined && field(value, "shade") === undefined
					? { type, fill: null }
					: undefined

			const fill = hexArg(value, "fill")
			const theme = optional(value, "theme", (holder, key) => choiceArg<DocxThemeColor>(holder, key, THEME_COLORS))
			const tint = optional(value, "tint", (holder, key) => intArg(holder, key, 0, 255))
			const shade = optional(value, "shade", (holder, key) => intArg(holder, key, 0, 255))

			if (fill === undefined || !theme.ok || !tint.ok || !shade.ok) return undefined
			// A tone belongs to a theme colour, and is a tint or a shade.
			if (
				(theme.value === undefined && (tint.value !== undefined || shade.value !== undefined)) ||
				(tint.value !== undefined && shade.value !== undefined)
			)
				return undefined

			return {
				type,
				fill,
				...(theme.value === undefined ? {} : { theme: theme.value }),
				...(tint.value === undefined ? {} : { tint: tint.value }),
				...(shade.value === undefined ? {} : { shade: shade.value })
			}
		}
		case "table.cell.vAlign": {
			const align = choiceArg<DocxCellVAlign>(value, "align", CELL_ALIGNS)

			return align === undefined ? undefined : { type, align }
		}
		default:
			return { type } as TableCommand
	}
}
