import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { SheetQueryRequest, SheetSelectionStats, SheetSessionApi } from "@filen/office/core/sheet"
import type { SheetGridState } from "@filen/office/react/sheet"
import { LatestQuery, singleCell, statusSummary } from "@/features/spreadsheet/components/sheetStatusBar.logic"

type StatsRequest = SheetQueryRequest<"selectionStats">

// Excel's status bar under the sheet tabs: the Average, Count and Sum of the selection's cells, worked out in the
// session's worker beside the cells (one walk over the cells the sheet holds, only for a selection of more than one
// cell, only the latest selection asked).
export function SheetStatusBar({ grid, session, cellless }: { grid: SheetGridState; session: SheetSessionApi; cellless: boolean }) {
	const { t } = useTranslation("preview")
	const [stats, setStats] = useState<SheetSelectionStats | null>(null)
	const [query] = useState(
		() =>
			new LatestQuery<StatsRequest, SheetSelectionStats>(
				request => session.query("selectionStats", request),
				result => {
					setStats(result)
				}
			)
	)
	const asked = !cellless && grid.failed === null && !singleCell(grid.selection.ranges)
	const sheet = grid.sheet
	const ranges = grid.selection.ranges
	const version = grid.state.version
	const engine = grid.engine

	useEffect(() => {
		if (!asked) {
			return undefined
		}

		query.request({ sheet, ranges })

		return () => {
			query.cancel()
		}
		// A new version or the engine's results landing change what the cells show: asked again then too.
	}, [query, asked, sheet, ranges, version, engine])

	const summary = asked ? statusSummary(stats) : null

	return (
		<div className="flex h-6 shrink-0 items-center justify-end gap-4 border-t border-border bg-muted/40 px-3 text-xs text-muted-foreground tabular-nums">
			{summary === null ? null : (
				<>
					{summary.average === null ? null : <span>{t("previewSheetStatusAverage", { value: summary.average })}</span>}
					<span>{t("previewSheetStatusCount", { value: summary.count })}</span>
					{summary.sum === null ? null : <span>{t("previewSheetStatusSum", { value: summary.sum })}</span>}
				</>
			)}
		</div>
	)
}
