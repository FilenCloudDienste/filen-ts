import { Fragment, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { AxisFlag, resetTargets, type LayerKey, type SheetAxis, type SheetAxisLayout, type SheetCommand } from "@filen/office/core/sheet"
import { axisEntry, axisMove, celllessSheet, wholeAxis, type SheetGridState } from "@filen/office/react/sheet"
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger
} from "@/components/ui/context-menu"
import { useEscapeClosesMenu } from "@/features/spreadsheet/components/menuEscape"
import { useLocalPane } from "@/features/spreadsheet/menus/localPane"
import { FREEZE_ITEMS, MERGE_ITEMS, freezeEnabled, freezeTo, selectionHasMerge } from "@/features/spreadsheet/menus/structureCommands"
import { useMergeCommands } from "@/features/spreadsheet/menus/useMergeCommands"
import { selectionSpans, spanCount, unhideSpans } from "@/features/spreadsheet/menus/structure.logic"
import type { SheetRibbonActions } from "@/features/spreadsheet/toolbar/sheetToolbar"

// The structural items, in menu order; a separator follows each axis's delete. `after` inserts past the
// selection's end rather than at its start.
const STRUCTURE_ITEMS = [
	{ key: "previewSpreadsheetInsertRowsAbove", type: "axis.insert", axis: "rows", after: false },
	{ key: "previewSpreadsheetInsertRowsBelow", type: "axis.insert", axis: "rows", after: true },
	{ key: "previewSpreadsheetDeleteRows", type: "axis.delete", axis: "rows", after: false },
	{ key: "previewSpreadsheetInsertColumnsLeft", type: "axis.insert", axis: "cols", after: false },
	{ key: "previewSpreadsheetInsertColumnsRight", type: "axis.insert", axis: "cols", after: true },
	{ key: "previewSpreadsheetDeleteColumns", type: "axis.delete", axis: "cols", after: false }
] as const

const HIDE_ITEMS = [
	{ axis: "rows", hide: "previewSheetHideRows", unhide: "previewSheetUnhideRows" },
	{ axis: "cols", hide: "previewSheetHideColumns", unhide: "previewSheetUnhideColumns" }
] as const

// The ribbon's own handlers, so the clipboard with its refusals, and the dialogs, are reached one way.
export type SheetGridMenuActions = Pick<SheetRibbonActions, "copy" | "paste" | "insertCells" | "deleteCells"> & {
	formatCells: () => void
}

// An entry may stand for a run of rows or columns: looked up, never listed one by one.
function hiddenIn(layout: SheetAxisLayout): (index: number) => boolean {
	return index => ((axisEntry(layout, index)?.flags ?? 0) & AxisFlag.HIDDEN) !== 0
}

// The grid's menu, in Excel's order: cut, copy and paste (`actions`), cells, rows and columns inserted, deleted,
// hidden and shown, contents cleared, cells formatted, panes frozen, cells merged, sizes reset. Read-only, it holds
// only copy, the size resets (and a text file's frozen panes, which it keeps beside the
// file: `localPane`, the file's key, for a text file). Features add groups of their own (`items`, each followed by a
// separator), shown read-only too: an item that edits checks for itself.
export function SheetGridMenu({
	grid,
	canEdit,
	run,
	text,
	localPane,
	items,
	actions,
	onOpenChange,
	children
}: {
	grid: SheetGridState
	canEdit: boolean
	run: (command: SheetCommand) => void
	// A text file: no formats, merges or hidden rows; its panes freeze though it is read-only.
	text?: boolean
	localPane?: LayerKey
	items?: readonly { readonly id: string; readonly node: ReactNode }[]
	actions?: SheetGridMenuActions
	// Hears the menu open and close (the touch menu's ⋯ opens it with finger-sized items).
	onOpenChange?: (open: boolean) => void
	children: ReactNode
}) {
	const { t } = useTranslation("preview")
	const { sheet, selection, layout } = grid
	const range = selection.ranges[selection.ranges.length - 1]
	const textFile = text === true
	const merges = useMergeCommands(grid)
	const [menuOpen, setOpen] = useState(false)
	const setMenuOpen = (open: boolean): void => {
		setOpen(open)
		onOpenChange?.(open)
	}

	useEscapeClosesMenu(menuOpen, () => {
		setMenuOpen(false)
	})

	useLocalPane(grid, localPane ?? { kind: "session", id: "" }, textFile && localPane !== undefined)

	function resets(axis: SheetAxis): number[] {
		if (range === undefined || layout === null) {
			return []
		}

		const sizes = axis === "cols" ? layout.cols : layout.rows

		return axis === "cols"
			? resetTargets(range.startCol, range.endCol, layout.colCount, hiddenIn(sizes))
			: resetTargets(range.startRow, range.endRow, layout.rowCount, hiddenIn(sizes))
	}

	// Through the grid's model, as a header drag is: sizes the file cannot hold are the app's to reset. A refusal
	// reaches the model's refusal handler; a session that died says so by its own event.
	function reset(axis: SheetAxis, indices: number[]): void {
		grid.model.resize(sheet, axis, Uint32Array.from(indices), new Float32Array(indices.length).fill(Number.NaN)).catch(() => undefined)
	}

	// A chartsheet or dialog sheet has no cells: only the features' groups (its chart's) are shown.
	const cellless = celllessSheet(grid, sheet)
	const freezes = (canEdit || textFile) && !cellless
	// Excel's Insert… and Delete… ask how cells shift; whole rows or columns have their own items below.
	const cellDialogs = actions !== undefined && wholeAxis(selection) === null

	return (
		<>
			<ContextMenu
				open={menuOpen}
				onOpenChange={setMenuOpen}
			>
				<ContextMenuTrigger className="flex min-h-0 flex-1 flex-col">{children}</ContextMenuTrigger>
				<ContextMenuContent aria-label={t("previewSheetGridMenu")}>
					{actions !== undefined && range !== undefined && !cellless ? (
						<>
							{canEdit ? (
								<ContextMenuItem
									onClick={() => {
										actions.copy(true)
									}}
								>
									{t("previewSheetTouchCut")}
								</ContextMenuItem>
							) : null}
							<ContextMenuItem
								onClick={() => {
									actions.copy(false)
								}}
							>
								{t("previewSheetTouchCopy")}
							</ContextMenuItem>
							{canEdit ? (
								<>
									<ContextMenuItem
										onClick={() => {
											actions.paste(false)
										}}
									>
										{t("previewSheetTouchPaste")}
									</ContextMenuItem>
									{/* A text file holds no formats: its paste is values already. */}
									{textFile ? null : (
										<ContextMenuItem
											onClick={() => {
												actions.paste(true)
											}}
										>
											{t("previewSheetRibbonPasteValues")}
										</ContextMenuItem>
									)}
								</>
							) : null}
							<ContextMenuSeparator />
						</>
					) : null}
					{canEdit && range !== undefined && !cellless ? (
						<>
							{cellDialogs ? (
								<>
									<ContextMenuItem onClick={actions.insertCells}>{t("previewSheetRibbonInsertCells")}</ContextMenuItem>
									<ContextMenuItem onClick={actions.deleteCells}>{t("previewSheetRibbonDeleteCells")}</ContextMenuItem>
									<ContextMenuSeparator />
								</>
							) : null}
							{STRUCTURE_ITEMS.map(item => {
								// Every range's rows (columns), each inserted at or deleted on its own.
								const move = axisMove(item.type, sheet, item.axis, selection.ranges, item.after)
								const count = "spans" in move ? move.spans.reduce((sum, span) => sum + span.count, 0) : move.count

								return (
									<Fragment key={item.key}>
										<ContextMenuItem
											onClick={() => {
												run(move)
											}}
										>
											{t(item.key, { count })}
										</ContextMenuItem>
										{item.type === "axis.delete" ? <ContextMenuSeparator /> : null}
									</Fragment>
								)
							})}
							{textFile ? null : (
								<>
									{HIDE_ITEMS.map(item => {
										const spans = selectionSpans(selection.ranges, item.axis)
										const shown = unhideSpans(spans, layout, item.axis)

										return (
											<Fragment key={item.axis}>
												<ContextMenuItem
													onClick={() => {
														run({ type: "axis.hide", sheet, axis: item.axis, spans, hidden: true })
													}}
												>
													{t(item.hide, { count: spanCount(spans) })}
												</ContextMenuItem>
												<ContextMenuItem
													disabled={shown === null}
													onClick={() => {
														if (shown !== null) {
															run({ type: "axis.hide", sheet, axis: item.axis, spans: shown, hidden: false })
														}
													}}
												>
													{t(item.unhide)}
												</ContextMenuItem>
											</Fragment>
										)
									})}
									<ContextMenuSeparator />
									<ContextMenuSub>
										<ContextMenuSubTrigger>{t("previewSheetMerge")}</ContextMenuSubTrigger>
										<ContextMenuSubContent>
											{MERGE_ITEMS.map(item => (
												<ContextMenuItem
													key={item.mode}
													onClick={() => {
														merges.merge(item.mode)
													}}
												>
													{t(item.key)}
												</ContextMenuItem>
											))}
											<ContextMenuItem
												disabled={!selectionHasMerge(grid)}
												onClick={merges.unmerge}
											>
												{t("previewSheetUnmerge")}
											</ContextMenuItem>
										</ContextMenuSubContent>
									</ContextMenuSub>
								</>
							)}
							<ContextMenuItem
								onClick={() => {
									run({ type: "cells.clear", sheet, ranges: selection.ranges, what: "contents" })
								}}
							>
								{t("previewSpreadsheetClearCells")}
							</ContextMenuItem>
							{actions === undefined || textFile ? null : (
								<ContextMenuItem onClick={actions.formatCells}>{t("previewSheetFormatCells")}</ContextMenuItem>
							)}
							<ContextMenuSeparator />
						</>
					) : null}
					{items?.map(group => (
						<Fragment key={group.id}>
							{group.node}
							<ContextMenuSeparator />
						</Fragment>
					))}
					{freezes ? (
						<>
							<ContextMenuSub>
								<ContextMenuSubTrigger>{t("previewSheetFreeze")}</ContextMenuSubTrigger>
								<ContextMenuSubContent>
									{FREEZE_ITEMS.map(item => (
										<ContextMenuItem
											key={item.target}
											disabled={!freezeEnabled(grid, item.target)}
											onClick={() => {
												freezeTo(grid, item.target)
											}}
										>
											{t(item.key)}
										</ContextMenuItem>
									))}
								</ContextMenuSubContent>
							</ContextMenuSub>
							<ContextMenuSeparator />
						</>
					) : null}
					{cellless || !grid.model.canResize() ? null : (
						<ResetItems
							resets={resets}
							onReset={reset}
						/>
					)}
				</ContextMenuContent>
			</ContextMenu>
			{merges.dialog}
		</>
	)
}

// Its own component so the targets are worked out only while the menu is open.
function ResetItems({ resets, onReset }: { resets: (axis: SheetAxis) => number[]; onReset: (axis: SheetAxis, indices: number[]) => void }) {
	const { t } = useTranslation("preview")
	const cols = resets("cols")
	const rows = resets("rows")

	return (
		<>
			<ContextMenuItem
				disabled={cols.length === 0}
				onClick={() => {
					onReset("cols", cols)
				}}
			>
				{t("previewSpreadsheetResetColumnWidth", { count: cols.length })}
			</ContextMenuItem>
			<ContextMenuItem
				disabled={rows.length === 0}
				onClick={() => {
					onReset("rows", rows)
				}}
			>
				{t("previewSpreadsheetResetRowHeight", { count: rows.length })}
			</ContextMenuItem>
		</>
	)
}
