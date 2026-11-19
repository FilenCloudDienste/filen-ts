import type { SheetRenderStyle } from "../../core/sheet/protocol"
import type { SheetGridModel } from "./model"
import { TEXT_PADDING } from "./paint/cells"
import { layoutText, textFont, type TextMeasurer, type TextRun } from "./paint/text"
import { entryRuns, entryText, type GridTile } from "./tiles"

// The height a row needs for a wrapped cell, as the grid draws it: one measure for the fit after an edit (rowFit)
// and the explicit autofit (autofit), so neither shrinks a row the other grew.

// A line of text, as a multiple of its font's size.
export const LINE_HEIGHT = 1.2
// The row's padding beyond its lines.
export const ROW_PADDING = 2

// The height at 100 % of a held tile's wrapped entry in a column `colWidth` px wide at 100 %: its rich runs and its
// indent included, each line as tall as its largest run.
export function wrappedCellHeight(
	model: SheetGridModel,
	tile: GridTile,
	entry: number,
	style: SheetRenderStyle,
	colWidth: number,
	measurer: TextMeasurer,
	base: SheetRenderStyle,
	fallback: string
): number {
	const raw = entryRuns(tile, entry)
	const runs: TextRun[] | null = raw === null ? null : []

	for (let k = 0; raw !== null && runs !== null && k + 1 < raw.length; k += 2)
		runs.push({ start: raw[k] ?? 0, style: model.style(raw[k + 1] ?? 0) })

	const indent = (style.indent ?? 0) > 0 ? (style.indent ?? 0) * measurer.width(textFont(style, base, fallback, 1).css, "   ") : 0
	const width = Math.max(1, colWidth - 2 * TEXT_PADDING - 1 - indent)
	const lines = layoutText(measurer, entryText(tile, entry), runs, style, { wrap: true, width, base, fallback, scale: 1 })

	return lines.reduce((sum, line) => sum + Math.round(line.px * LINE_HEIGHT), 0) + ROW_PADDING
}
