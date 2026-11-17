import { useEffect, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { SheetGrid, useSheetGrid, type SheetGridHandle } from "@filen/office/react/sheet"
import { resolveTheme, useTheme } from "@/providers/themeProvider"
import type { TableColumn } from "@/features/preview/lib/sqliteBrowse.logic"
import { sqliteTableModel, type SqliteTableReads } from "@/features/preview/lib/sqliteSource"
import "@filen/office/css/sheet.css"
import "@/features/spreadsheet/sheetTheme.css"

// One table's rows from `base` on in the read-only sheet grid: its first row the column names, frozen. The row count
// grows as counting goes on; the grid is mounted per table and window (its parent keys it).
export function SqliteTableGrid({
	name,
	columns,
	reads,
	rows,
	base,
	gridRef,
	onActive
}: {
	name: string
	columns: readonly TableColumn[]
	reads: SqliteTableReads
	rows: number
	base: number
	gridRef: RefObject<SheetGridHandle | null>
	// The active cell (grid row and column), as it moves.
	onActive: (row: number, col: number) => void
}) {
	const { t } = useTranslation("preview")
	const { theme } = useTheme()
	const [table] = useState(() => sqliteTableModel(reads, name, columns, rows, base))
	const { model } = table
	const { selection } = useSheetGrid(model)
	const { row, col } = selection.active

	useEffect(() => {
		return () => {
			model.dispose()
		}
	}, [model])

	// More rows counted: the layout grows.
	useEffect(() => {
		table.grow(rows)
	}, [table, rows])

	useEffect(() => {
		onActive(row, col)
	}, [onActive, row, col])

	return (
		<SheetGrid
			ref={gridRef}
			grid={model}
			className="min-h-0 flex-1"
			label={t("previewSqliteGrid")}
			editorLabel={t("previewSqliteGridEditor")}
			themeKey={resolveTheme(theme)}
		/>
	)
}
