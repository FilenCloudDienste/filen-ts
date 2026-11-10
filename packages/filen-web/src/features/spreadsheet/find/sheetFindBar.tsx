import { useEffect, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { SlidersHorizontalIcon } from "lucide-react"
import type { SheetGridHandle, SheetGridState } from "@filen/office/react/sheet"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { DocxFindField } from "@/features/preview/components/docxToolbar"
import { setSheetFindStep, useSheetFindOpen } from "@/features/spreadsheet/find/findState"
import { useSheetFind, type SheetFindOptions } from "@/features/spreadsheet/find/useSheetFind"

// The find bar (Mod+F; Mod+H with the replace field): the document editor's find field, with Excel's find options
// beside it (match entire cell contents, within the sheet or the workbook, look in values or formulas). A row of its
// own under the toolbar, at its end, while it is open.
export function SheetFindBar({
	grid,
	gridRef,
	canEdit
}: {
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	canEdit: boolean
}) {
	const open = useSheetFindOpen(grid.model)

	if (open === null) {
		return null
	}

	return (
		<OpenFindBar
			// A Mod+H while finding opens the replace field: the field starts again with it.
			key={open.mode}
			grid={grid}
			gridRef={gridRef}
			canEdit={canEdit}
			mode={open.mode}
			focus={open.focus}
		/>
	)
}

function OpenFindBar({
	grid,
	gridRef,
	canEdit,
	mode,
	focus
}: {
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	canEdit: boolean
	mode: "find" | "replace"
	focus: number
}) {
	const { t } = useTranslation("preview")
	// Replacing looks in formulas, as Excel's Replace does.
	const [options, setOptions] = useState<SheetFindOptions>({
		wholeCell: false,
		lookIn: mode === "replace" ? "formulas" : "values",
		within: "sheet"
	})
	const find = useSheetFind({ grid, gridRef, canEdit, options })

	// Shift+F4 from the grid steps these matches.
	useEffect(() =>
		setSheetFindStep(grid.model, direction => {
			if (find.count === 0) {
				return false
			}

			find.step(direction)

			return true
		})
	)

	return (
		<div
			role="search"
			aria-label={t("previewSheetFindBar")}
			className="flex shrink-0 items-center justify-end gap-1 overflow-x-auto border-b border-border px-2 py-1"
		>
			<DocxFindField
				find={find}
				focus={focus}
				replaceOpen={mode === "replace"}
				replaceAction="sheet.replace"
				onClosed={() => undefined}
			/>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("previewSheetFindOptions")}
						>
							<SlidersHorizontalIcon />
						</Button>
					}
				/>
				<DropdownMenuContent align="end">
					<DropdownMenuCheckboxItem
						checked={options.wholeCell}
						onCheckedChange={checked => {
							setOptions({ ...options, wholeCell: checked })
						}}
					>
						{t("previewSheetFindWholeCell")}
					</DropdownMenuCheckboxItem>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuLabel>{t("previewSheetFindWithin")}</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={options.within}
							onValueChange={(value: string) => {
								setOptions({ ...options, within: value === "workbook" ? "workbook" : "sheet" })
							}}
						>
							<DropdownMenuRadioItem value="sheet">{t("previewSheetFindWithinSheet")}</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="workbook">{t("previewSheetFindWithinWorkbook")}</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuLabel>{t("previewSheetFindLookIn")}</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={options.lookIn}
							onValueChange={(value: string) => {
								setOptions({ ...options, lookIn: value === "formulas" ? "formulas" : "values" })
							}}
						>
							{/* Replace looks in what was typed: Excel's Replace offers Formulas alone. */}
							{mode === "replace" ? null : (
								<DropdownMenuRadioItem value="values">{t("previewSheetFindLookInValues")}</DropdownMenuRadioItem>
							)}
							<DropdownMenuRadioItem value="formulas">{t("previewSheetFindLookInFormulas")}</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}
