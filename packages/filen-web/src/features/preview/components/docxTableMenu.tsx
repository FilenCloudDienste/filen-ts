import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	AlignCenterIcon,
	AlignVerticalJustifyCenterIcon,
	BetweenHorizontalEndIcon,
	BetweenHorizontalStartIcon,
	BetweenVerticalEndIcon,
	BetweenVerticalStartIcon,
	Columns3Icon,
	HeadingIcon,
	PaintBucketIcon,
	PaletteIcon,
	TableCellsMergeIcon,
	TableCellsSplitIcon,
	Trash2Icon
} from "lucide-react"
import type { DocxCellVAlign, DocxEditorCommand, DocxEditorCommandType, DocxTableAlign } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import {
	STANDARD_SWATCHES,
	type DocxInputChannelProps,
	type DocxSwatch,
	type DocxToolbarSlotProps
} from "@/features/preview/components/docxEditor.logic"
import { DocxColorButton, DocxColorGrid } from "@/features/preview/components/docxFormatControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { DocxRowsColumnsDialog } from "@/features/preview/components/docxFields"
import { DocxCommandMenu } from "@/features/preview/components/docxRibbonControls"
import type { DocxMenuEntry } from "@/features/preview/components/docxRibbon.logic"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu"
import type { PreviewKey } from "@/lib/i18n"

// The Word ribbon's contextual Table tab controls (docxRibbonGroups.tsx places them), shown while the caret is in a
// table: rows and columns, merging and splitting cells (a rows × columns dialog), the header row, shading (the shared
// colour picker) and the table's style, the table's and the cells' alignment. Column widths are dragged on the pages
// (docxTableBorderDrag.tsx).

export interface DocxTableTabProps extends DocxToolbarSlotProps {
	// The theme part of the shading picker.
	theme: readonly (readonly DocxSwatch[])[]
}

const ALIGNS: readonly { value: DocxTableAlign; label: PreviewKey }[] = [
	{ value: "start", label: "previewDocxTableAlignStart" },
	{ value: "center", label: "previewDocxTableAlignCenter" },
	{ value: "end", label: "previewDocxTableAlignEnd" }
]

const V_ALIGNS: readonly { value: DocxCellVAlign; label: PreviewKey }[] = [
	{ value: "top", label: "previewDocxTableCellTop" },
	{ value: "center", label: "previewDocxTableCellCenter" },
	{ value: "bottom", label: "previewDocxTableCellBottom" }
]

function labelOf(props: DocxToolbarSlotProps, type: DocxEditorCommandType): PreviewKey | undefined {
	return props.commands.find(command => command.info.type === type)?.label
}

function off(props: DocxToolbarSlotProps, type: DocxEditorCommandType): boolean {
	return props.snapshot === undefined || props.readOnly || !props.snapshot.enabled[type]
}

function TableButton({
	type,
	icon,
	pressed,
	...props
}: DocxToolbarSlotProps & { type: DocxEditorCommandType; icon: ReactNode; pressed?: boolean | undefined }) {
	const { t } = useTranslation("preview")
	const label = labelOf(props, type)

	return label === undefined ? null : (
		<RibbonButton
			label={t(label)}
			icon={icon}
			pressed={pressed}
			disabled={off(props, type)}
			onClick={() => {
				if (type === "table.cell.split") {
					props.requestInput(type)
				} else {
					props.execute({ type } as DocxEditorCommand)
				}
			}}
		/>
	)
}

// A choice of one (the table's alignment, the cells' alignment, the table's style).
function ChoiceMenu<T extends string>({
	label,
	icon,
	value,
	disabled,
	options,
	onChoose
}: {
	label: string
	icon: ReactNode
	value: string
	disabled: boolean
	options: readonly { value: T; label: string }[]
	onChoose: (value: T) => void
}) {
	const focus = useCommandMenuFocus()

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={label}
				icon={icon}
				disabled={disabled}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
				className="max-h-80 overflow-y-auto"
			>
				<DropdownMenuRadioGroup
					value={value}
					onValueChange={(next: T) => {
						onChoose(next)
						focus.ran()
					}}
				>
					{options.map(option => (
						<DropdownMenuRadioItem
							key={option.value}
							value={option.value}
							closeOnClick
						>
							{option.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function DeleteMenu(props: DocxToolbarSlotProps) {
	const { t } = useTranslation("preview")
	const entries: DocxMenuEntry[] = (["table.row.delete", "table.column.delete", "table.delete"] as const).flatMap(type => {
		const label = labelOf(props, type)

		return label === undefined ? [] : [{ label: t(label), disabled: off(props, type), command: { type } }]
	})

	return entries.length === 0 ? null : (
		<DocxCommandMenu
			label={t("previewDocxRibbonTableDelete")}
			icon={<Trash2Icon />}
			entries={entries}
			execute={props.execute}
			requestInput={props.requestInput}
		/>
	)
}

function ShadingButton(props: DocxTableTabProps) {
	const { t } = useTranslation("preview")
	const table = props.snapshot?.context.table ?? null
	const label = labelOf(props, "table.cell.shading")

	if (table === null || label === undefined) {
		return null
	}

	return (
		<DocxColorButton
			label={t(label)}
			icon={<PaintBucketIcon />}
			rgb={table.shading === null || table.shading === "mixed" || table.shading.startsWith("theme:") ? undefined : table.shading}
			disabled={off(props, "table.cell.shading")}
		>
			{close => (
				<DocxColorGrid
					theme={props.theme}
					standard={STANDARD_SWATCHES}
					chosen={table.shading === "mixed" ? undefined : (table.shading ?? "none")}
					none={{ label: t("previewOfficeColorNone"), key: "none" }}
					onPick={swatch => {
						const color = swatch?.color

						close()
						// A theme colour keeps its reference (Word writes w:themeFill with the fill).
						props.execute(
							swatch === null
								? { type: "table.cell.shading", fill: null }
								: {
										type: "table.cell.shading",
										fill: swatch.rgb,
										...(color?.kind === "theme"
											? {
													theme: color.theme,
													...(color.tint === undefined ? {} : { tint: color.tint }),
													...(color.shade === undefined ? {} : { shade: color.shade })
												}
											: {})
									}
						)
					}}
				/>
			)}
		</DocxColorButton>
	)
}

// Rows and columns: insert above, below, left and right; Delete ▾.
export function TableRowsColumns(props: DocxToolbarSlotProps) {
	return (
		<>
			<TableButton
				{...props}
				type="table.row.insertAbove"
				icon={<BetweenHorizontalStartIcon />}
			/>
			<TableButton
				{...props}
				type="table.row.insertBelow"
				icon={<BetweenHorizontalEndIcon />}
			/>
			<TableButton
				{...props}
				type="table.column.insertLeft"
				icon={<BetweenVerticalStartIcon />}
			/>
			<TableButton
				{...props}
				type="table.column.insertRight"
				icon={<BetweenVerticalEndIcon />}
			/>
			<DeleteMenu {...props} />
		</>
	)
}

// Merge: merge cells, split cells, distribute columns.
export function TableMerge(props: DocxToolbarSlotProps) {
	return (
		<>
			<TableButton
				{...props}
				type="table.cells.merge"
				icon={<TableCellsMergeIcon />}
			/>
			<TableButton
				{...props}
				type="table.cell.split"
				icon={<TableCellsSplitIcon />}
			/>
			<TableButton
				{...props}
				type="table.distributeColumns"
				icon={<Columns3Icon />}
			/>
		</>
	)
}

// Design: the header row, shading, the table's style.
export function TableDesign(props: DocxTableTabProps) {
	const { t } = useTranslation("preview")
	const table = props.snapshot?.context.table ?? null
	const style = labelOf(props, "table.style")

	return table === null ? null : (
		<>
			<TableButton
				{...props}
				type="table.row.header"
				icon={<HeadingIcon />}
				pressed={table.headerRow}
			/>
			<ShadingButton {...props} />
			{style === undefined || table.styles.length === 0 ? null : (
				<ChoiceMenu
					label={t(style)}
					icon={<PaletteIcon />}
					value={table.styleId ?? ""}
					disabled={off(props, "table.style")}
					options={table.styles.map(entry => ({ value: entry.id, label: entry.name }))}
					onChoose={styleId => {
						props.execute({ type: "table.style", styleId })
					}}
				/>
			)}
		</>
	)
}

// Alignment: the table's, the selected cells'.
export function TableAlignment(props: DocxToolbarSlotProps) {
	const { t } = useTranslation("preview")
	const table = props.snapshot?.context.table ?? null
	const align = labelOf(props, "table.align")
	const cellAlign = labelOf(props, "table.cell.vAlign")

	return table === null ? null : (
		<>
			{align === undefined ? null : (
				<ChoiceMenu
					label={t(align)}
					icon={<AlignCenterIcon />}
					value={table.align ?? ""}
					disabled={off(props, "table.align")}
					options={ALIGNS.map(option => ({ value: option.value, label: t(option.label) }))}
					onChoose={value => {
						props.execute({ type: "table.align", align: value })
					}}
				/>
			)}
			{cellAlign === undefined ? null : (
				<ChoiceMenu
					label={t(cellAlign)}
					icon={<AlignVerticalJustifyCenterIcon />}
					value={table.vAlign === "mixed" ? "" : (table.vAlign ?? "top")}
					disabled={off(props, "table.cell.vAlign")}
					options={V_ALIGNS.map(option => ({ value: option.value, label: t(option.label) }))}
					onChoose={value => {
						props.execute({ type: "table.cell.vAlign", align: value })
					}}
				/>
			)}
		</>
	)
}

export interface DocxTableSplitDialogProps extends DocxInputChannelProps {
	editor: PagedEditor
	// The host's read-only state: nothing is split meanwhile.
	readOnly: boolean
}

// Split cells: the selected cell into rows × columns (table.cell.split's input, from the Table group or the
// context menu).
export function DocxTableSplitDialog({ editor, readOnly, inputRequest, onInputDone }: DocxTableSplitDialogProps) {
	const { t } = useTranslation("preview")

	if (inputRequest?.type !== "table.cell.split") {
		return null
	}

	const nonce = inputRequest.nonce

	return (
		<DocxRowsColumnsDialog
			key={nonce}
			title={t("previewDocxTableSplitTitle")}
			description={t("previewDocxTableSplitBody")}
			submitLabel={t("previewDocxTableSplitAction")}
			initial={{ rows: 1, cols: 2 }}
			accepts={size => size.rows * size.cols > 1}
			// Run here, so a split the table refuses keeps the dialog open and says so.
			onSubmit={size => !readOnly && editor.execute({ type: "table.cell.split", ...size }) === true}
			refusal={t("previewDocxTableSplitRefused")}
			onClose={() => {
				onInputDone(nonce)
			}}
		/>
	)
}
