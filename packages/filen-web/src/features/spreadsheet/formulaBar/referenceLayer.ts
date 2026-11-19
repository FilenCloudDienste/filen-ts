import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type HighlightedReference, type SheetRange } from "@filen/office/core/sheet"
import type { SheetGridLayer } from "@filen/office/react/sheet"

// The references of the formula being typed outlined on the cells they name, each in its colour (Excel's Point mode
// highlights): a translucent fill and a solid edge, over the selection. Only the references to the sheet shown
// (those naming no sheet when it is the edited cell's own).

// A reference's cells as a range, whole columns and rows to the sheet's edge.
function rangeOf(reference: HighlightedReference): SheetRange {
	const area = reference.area
	const top = area.kind === "cols" ? 0 : Math.min(area.startRow, area.endRow)
	const bottom = area.kind === "cols" ? SHEET_MAX_ROWS - 1 : Math.max(area.startRow, area.endRow)
	const left = area.kind === "rows" ? 0 : Math.min(area.startCol, area.endCol)
	const right = area.kind === "rows" ? SHEET_MAX_COLS - 1 : Math.max(area.startCol, area.endCol)

	return { startRow: top, startCol: left, endRow: bottom, endCol: right }
}

// `#rrggbb` at an opacity.
function translucent(color: string, alpha: number): string {
	const value = Number.parseInt(color.slice(1), 16)

	return `rgba(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)}, ${String(alpha)})`
}

export function referenceLayer({
	references,
	ownSheet,
	shownSheet,
	colors
}: {
	references: readonly HighlightedReference[]
	// The edited cell's sheet name, and the sheet shown's.
	ownSheet: string
	shownSheet: string
	colors: readonly string[]
}): SheetGridLayer {
	const same = (name: string | null): boolean => (name ?? ownSheet).toUpperCase() === shownSheet.toUpperCase()
	const shown = references.filter(reference => same(reference.sheet))

	return {
		id: "formulaReferences",
		stage: "chrome",
		paint(canvas, scene) {
			for (const reference of shown) {
				const color = colors[reference.color % colors.length] ?? "#1f5fd6"

				for (const rect of scene.rangeRects(rangeOf(reference))) {
					canvas.fillStyle = translucent(color, 0.12)
					canvas.fillRect(rect.x, rect.y, rect.width, rect.height)
					canvas.strokeStyle = color
					canvas.lineWidth = 2
					canvas.beginPath()
					canvas.rect(rect.x + 1, rect.y + 1, Math.max(0, rect.width - 2), Math.max(0, rect.height - 2))
					canvas.stroke()
				}
			}
		}
	}
}
