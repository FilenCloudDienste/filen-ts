import { useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import type { SheetCommand, SheetRefusalReason, SheetSessionApi, SheetValidationAlert, SheetValidationRule } from "@filen/office/core/sheet"
import {
	CF_BAR_DECORATOR,
	CF_ICON_DECORATOR,
	type SheetEntryCheck,
	type SheetGridExtension,
	type SheetGridHandle,
	type SheetGridModel,
	type SheetGridState,
	type SheetShortcut
} from "@filen/office/react/sheet"
import { ContextMenuItem } from "@/components/ui/context-menu"
import type { SheetBodyExtension } from "@/features/spreadsheet/components/sheetExtension"
import { useValidationAlert, type ValidationVerdict } from "@/features/spreadsheet/data/dvAlert"
import { NEW_RULE } from "@/features/spreadsheet/data/dvDialog.logic"
import { ValidationDialog } from "@/features/spreadsheet/data/dvDialog"
import { ValidationOverlay } from "@/features/spreadsheet/data/dvOverlay"
import { listCellKey, listShown } from "@/features/spreadsheet/data/dvOverlay.logic"

// Conditional formatting and data validation in the sheet view: the grid draws the formats' bars and icons (the
// session evaluates the rules), a typed entry is checked against its cell's validation before it is written, a list
// validation's values open from beside the cell (or with Alt+Down), its input message shows under it, and the grid's
// menu opens the Data validation dialog.

// Where a typed entry goes once checked: the session's answer, then the user's for an alert.
export async function checkEntry(
	session: SheetSessionApi,
	entry: SheetEntryCheck,
	ask: (alert: SheetValidationAlert) => Promise<ValidationVerdict>
): Promise<ValidationVerdict> {
	let alert: SheetValidationAlert | null

	try {
		alert = await session.query("validation.check", { sheet: entry.sheet, row: entry.row, col: entry.col, input: entry.text })
	} catch {
		// The session failed (a "failed" event says so): the entry goes on to be refused there.
		return "commit"
	}

	return alert === null ? "commit" : ask(alert)
}

export function useSheetConditional({
	grid,
	model,
	gridRef,
	session,
	canEdit,
	text,
	run
}: {
	grid: SheetGridState
	model: SheetGridModel
	gridRef: RefObject<SheetGridHandle | null>
	session: SheetSessionApi
	canEdit: boolean
	// A text file (csv, tsv): it holds no formats or validations.
	text: boolean
	run: (command: SheetCommand) => void
}): SheetBodyExtension {
	const { t } = useTranslation("preview")
	const alerts = useValidationAlert(gridRef, grid.editing !== null)
	const [rule, setRule] = useState<SheetValidationRule | null>(null)
	// The cell whose list validation's values are open (dvOverlay.listCellKey).
	const [openList, setOpenList] = useState<string | null>(null)
	const { sheet, selection } = grid
	const checking = canEdit && !text
	const gridExtension: SheetGridExtension = {
		id: "conditional",
		decorators: [CF_BAR_DECORATOR, CF_ICON_DECORATOR],
		// Asked before a typed entry is written.
		entry: entry => (checking ? checkEntry(session, entry, alerts.ask) : "commit")
	}

	function openDialog(): void {
		const { row, col } = selection.active

		session.query("validation.rule", { sheet, row, col }).then(
			found => {
				setRule(found ?? NEW_RULE)
			},
			() => undefined
		)
	}

	async function apply(next: SheetValidationRule | null): Promise<SheetRefusalReason | null> {
		void model.intent()

		const result = await model.command(
			{ type: "validation.set", sheet, ranges: selection.ranges, rule: next, at: selection.active },
			false
		)

		return result.ok ? null : result.refusal.reason
	}

	// Alt+Down on a cell with a list validation opens its values (a filter header's menu takes it first).
	function shortcut(key: SheetShortcut): boolean {
		if (key !== "openDropdown" || text || !listShown(grid, canEdit)) return false

		setOpenList(listCellKey(sheet, selection.active.row, selection.active.col))

		return true
	}

	return {
		id: "conditional",
		grid: gridExtension,
		shortcut,
		overlay: text ? null : (
			<ValidationOverlay
				grid={grid}
				gridRef={gridRef}
				session={session}
				canEdit={canEdit}
				run={run}
				openList={openList}
				onOpenList={setOpenList}
			/>
		),
		...(checking && {
			ribbon: { dataValidation: openDialog },
			menuItems: (
				<ContextMenuItem
					data-sheet-menu="validation"
					onClick={openDialog}
				>
					{t("previewSheetDataValidation")}
				</ContextMenuItem>
			)
		}),
		dialogs: (
			<>
				{alerts.dialog}
				<ValidationDialog
					rule={rule}
					onClose={() => {
						setRule(null)
					}}
					onApply={apply}
					onClear={() => {
						void apply(null)
					}}
				/>
			</>
		)
	}
}
