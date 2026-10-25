import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeftRightIcon, HashIcon, ImageIcon, SeparatorHorizontalIcon, SquareCheckIcon, TableIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { TABLE_GRID, useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import {
	commandEntry,
	commandOff,
	slotCommand,
	variantEntries,
	type DocxCommandProps
} from "@/features/preview/components/docxRibbon.logic"
import { DocxCommandMenu } from "@/features/preview/components/docxRibbonControls"
import { RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import type { PreviewKey } from "@/lib/i18n"

// The Word ribbon's Insert, Layout and References dropdowns (docxRibbonGroups.tsx places them): tables, pictures,
// page numbers, form controls, breaks and converting notes. Items needing input ask for it through the input channel
// (the dialogs in docxInsertDialogs.tsx, the picture sources in docxImageInsert.tsx).

// Insert ▸ Table: a grid of sizes to click.
function TableGrid({ disabled, onPick }: { disabled: boolean; onPick: (cols: number, rows: number) => void }) {
	const { t } = useTranslation("preview")
	const [hover, setHover] = useState<{ cols: number; rows: number } | null>(null)

	return (
		<div className="flex flex-col gap-1 p-1">
			<div
				className="grid gap-0.5"
				style={{ gridTemplateColumns: `repeat(${String(TABLE_GRID.cols)}, 1rem)` }}
				onPointerLeave={() => {
					setHover(null)
				}}
			>
				{Array.from({ length: TABLE_GRID.rows * TABLE_GRID.cols }, (_, index) => {
					const cols = (index % TABLE_GRID.cols) + 1
					const rows = Math.floor(index / TABLE_GRID.cols) + 1
					const lit = hover !== null && cols <= hover.cols && rows <= hover.rows

					return (
						<button
							key={index}
							type="button"
							disabled={disabled}
							aria-label={t("previewDocxInsertTableGrid", { cols, rows })}
							className={cn("size-4 rounded-sm border border-border", lit ? "bg-primary/30" : "bg-background")}
							onPointerEnter={() => {
								setHover({ cols, rows })
							}}
							onFocus={() => {
								setHover({ cols, rows })
							}}
							onClick={() => {
								onPick(cols, rows)
							}}
						/>
					)
				})}
			</div>
			<p
				aria-hidden="true"
				className="h-5 text-center text-xs text-muted-foreground"
			>
				{hover === null ? "" : `${String(hover.cols)} × ${String(hover.rows)}`}
			</p>
		</div>
	)
}

// Table ▾: the size grid and the size dialog.
export function TableMenu(props: DocxCommandProps) {
	const { t } = useTranslation("preview")
	const [open, setOpen] = useState(false)
	const focus = useCommandMenuFocus()
	const off = commandOff(props.commands, props.snapshot, props.readOnly, "table.insert")

	if (slotCommand(props.commands, "table.insert") === undefined) {
		return null
	}

	return (
		<DropdownMenu
			open={open}
			onOpenChange={next => {
				focus.opened(next)
				setOpen(next)
			}}
		>
			<RibbonMenuTrigger
				label={t("previewDocxInsertTable")}
				icon={<TableIcon />}
				text={t("previewDocxInsertTable")}
				disabled={off}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				<TableGrid
					disabled={off}
					onPick={(cols, rows) => {
						setOpen(false)
						props.execute({ type: "table.insert", cols, rows })
						focus.ran()
					}}
				/>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onClick={() => {
						props.requestInput("table.insert")
						focus.kept()
					}}
				>
					{t("previewDocxInsertTableCustom")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// Breaks ▾ (Insert and Layout): page and line breaks, then each kind of section break.
export function DocxBreaksMenu(props: DocxCommandProps) {
	const { t } = useTranslation("preview")
	const label = (key: PreviewKey): string => t(key)
	const entries = [
		...commandEntry(props, "insert.pageBreak", label),
		...commandEntry(props, "insert.lineBreak", label),
		...variantEntries(props, "insert.sectionBreak", label)
	]

	if (entries.length === 0) {
		return null
	}

	return (
		<DocxCommandMenu
			label={t("previewDocxInsertBreaks")}
			icon={<SeparatorHorizontalIcon />}
			text={t("previewDocxInsertBreaks")}
			entries={entries}
			execute={props.execute}
			requestInput={props.requestInput}
		/>
	)
}

export function PicturesMenu(props: DocxCommandProps) {
	const { t } = useTranslation("preview")
	const command = slotCommand(props.commands, "image.insert")

	if (command === undefined) {
		return null
	}

	const disabled = commandOff(props.commands, props.snapshot, props.readOnly, "image.insert")

	return (
		<DocxCommandMenu
			label={t(command.label)}
			icon={<ImageIcon />}
			text={t(command.label)}
			entries={[
				{ label: t("previewDocxPictureFromDevice"), disabled, input: { type: "image.insert", detail: "device" } },
				{ label: t("previewDocxPictureFromDrive"), disabled, input: { type: "image.insert", detail: "drive" } }
			]}
			execute={props.execute}
			requestInput={props.requestInput}
		/>
	)
}

export function PageNumbersMenu(props: DocxCommandProps) {
	const { t } = useTranslation("preview")
	const label = (key: PreviewKey): string => t(key)
	const entries = [...commandEntry(props, "insert.pageNumber", label), ...commandEntry(props, "insert.pageCount", label)]

	return entries.length === 0 ? null : (
		<DocxCommandMenu
			label={t("previewDocxInsertPageNumbers")}
			icon={<HashIcon />}
			entries={entries}
			execute={props.execute}
			requestInput={props.requestInput}
		/>
	)
}

export function FormControlMenu(props: DocxCommandProps) {
	const { t } = useTranslation("preview")
	const command = slotCommand(props.commands, "control.insert")
	const entries = variantEntries(props, "control.insert", key => t(key))

	return command === undefined || entries.length === 0 ? null : (
		<DocxCommandMenu
			label={t(command.label)}
			icon={<SquareCheckIcon />}
			entries={entries}
			execute={props.execute}
			requestInput={props.requestInput}
		/>
	)
}

export function ConvertNotesMenu(props: DocxCommandProps) {
	const { t } = useTranslation("preview")
	const command = slotCommand(props.commands, "note.convertAll")

	if (command === undefined) {
		return null
	}

	const disabled = commandOff(props.commands, props.snapshot, props.readOnly, "note.convertAll")

	return (
		<DocxCommandMenu
			label={t(command.label)}
			icon={<ArrowLeftRightIcon />}
			entries={[
				{ label: t("previewDocxNoteConvertAllToEndnotes"), disabled, command: { type: "note.convertAll", to: "endnote" } },
				{ label: t("previewDocxNoteConvertAllToFootnotes"), disabled, command: { type: "note.convertAll", to: "footnote" } }
			]}
			execute={props.execute}
			requestInput={props.requestInput}
		/>
	)
}
