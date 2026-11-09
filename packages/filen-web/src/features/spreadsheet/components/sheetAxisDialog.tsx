import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import type { SheetCommand, SheetRange } from "@filen/office/core/sheet"
import { axisMove, type SheetGridState } from "@filen/office/react/sheet"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { PreviewKey } from "@/lib/i18n"

export type SheetAxisDialogKind = "insert" | "delete"

// What the dialog does with the selection: its cells shifted along rows (down, up) or columns (right, left), or its
// whole rows or columns.
type SheetAxisChoice = "cellsRows" | "cellsCols" | "rows" | "cols"

// Excel's options, in its order.
const CHOICES: Readonly<Record<SheetAxisDialogKind, readonly { readonly value: SheetAxisChoice; readonly key: PreviewKey }[]>> = {
	insert: [
		{ value: "cellsCols", key: "previewSheetShiftCellsRight" },
		{ value: "cellsRows", key: "previewSheetShiftCellsDown" },
		{ value: "rows", key: "previewSheetDialogEntireRow" },
		{ value: "cols", key: "previewSheetDialogEntireColumn" }
	],
	delete: [
		{ value: "cellsCols", key: "previewSheetShiftCellsLeft" },
		{ value: "cellsRows", key: "previewSheetShiftCellsUp" },
		{ value: "rows", key: "previewSheetDialogEntireRow" },
		{ value: "cols", key: "previewSheetDialogEntireColumn" }
	]
}

const VALUES: readonly SheetAxisChoice[] = ["cellsRows", "cellsCols", "rows", "cols"]

// Entire rows (columns): every range's, in one step, as Excel takes a selection of several.
function axisDialogCommand(
	kind: SheetAxisDialogKind,
	choice: SheetAxisChoice,
	sheet: number,
	range: SheetRange,
	ranges: readonly SheetRange[]
): SheetCommand {
	if (choice === "cellsRows" || choice === "cellsCols") {
		return { type: "cells.shift", sheet, range, edit: kind, axis: choice === "cellsRows" ? "rows" : "cols" }
	}

	return axisMove(kind === "insert" ? "axis.insert" : "axis.delete", sheet, choice, ranges)
}

// Excel's Insert and Delete dialogs (Ctrl+Shift+Plus, Ctrl+Minus on cells): the selection's cells inserted or deleted,
// the cells beside them shifting along, or its whole rows or columns.
export function SheetAxisDialog({
	kind,
	grid,
	run,
	onClose
}: {
	kind: SheetAxisDialogKind | null
	grid: SheetGridState
	run: (command: SheetCommand) => void
	onClose: () => void
}) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	// Each dialog keeps its own last choice: one made in Insert never carries into Delete.
	const [choices, setChoices] = useState<Readonly<Record<SheetAxisDialogKind, SheetAxisChoice>>>({
		insert: "cellsRows",
		delete: "cellsRows"
	})
	const choice = choices[kind ?? "insert"]
	const range = grid.selection.ranges[grid.selection.ranges.length - 1]
	const title = t(kind === "delete" ? "previewSheetDeleteDialogTitle" : "previewSheetInsertDialogTitle")

	return (
		<FormDialog
			open={kind !== null}
			pending={false}
			title={title}
			description={t(kind === "delete" ? "previewSheetDeleteDialogBody" : "previewSheetInsertDialogBody")}
			submitLabel={title}
			cancelLabel={t("common:cancel")}
			canSubmit={range !== undefined}
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
			onSubmit={event => {
				event.preventDefault()

				if (kind !== null && range !== undefined) {
					run(axisDialogCommand(kind, choice, grid.sheet, range, grid.selection.ranges))
				}

				onClose()
			}}
		>
			<RadioGroup
				aria-label={title}
				name={`${id}-axis`}
				value={choice}
				onValueChange={next => {
					const value = VALUES.find(candidate => candidate === next) ?? "cellsRows"
					const dialog = kind ?? "insert"

					setChoices(current => ({ ...current, [dialog]: value }))
				}}
			>
				{CHOICES[kind ?? "insert"].map(option => (
					<div
						key={option.value}
						className="flex items-center gap-3"
					>
						<RadioGroupItem
							id={`${id}-${option.value}`}
							value={option.value}
						/>
						<Label htmlFor={`${id}-${option.value}`}>{t(option.key)}</Label>
					</div>
				))}
			</RadioGroup>
		</FormDialog>
	)
}
