import type { ReactNode } from "react"
import type { TFunction } from "i18next"
import {
	AlignCenterIcon,
	ArrowDownToLineIcon,
	BetweenHorizontalEndIcon,
	BookmarkIcon,
	BracesIcon,
	CalendarIcon,
	CircleCheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	FileDiffIcon,
	ImageIcon,
	LinkIcon,
	MessageSquarePlusIcon,
	MessagesSquareIcon,
	MinusIcon,
	OmegaIcon,
	PaletteIcon,
	PanelBottomIcon,
	PanelTopIcon,
	RefreshCwIcon,
	SeparatorHorizontalIcon,
	Settings2Icon,
	SigmaIcon,
	SuperscriptIcon,
	TableCellsMergeIcon,
	TableIcon,
	TableOfContentsIcon
} from "lucide-react"
import type { DocxEditorCommandType } from "@filen/office/core/docx/edit"
import type { DocxMarkupMode } from "@filen/office/dom/docx"
import type { DocxToolbarCommand, DocxToolbarSlotProps } from "@/features/preview/components/docxEditor.logic"
import { ConvertNotesMenu, FormControlMenu, PageNumbersMenu, PicturesMenu, TableMenu } from "@/features/preview/components/docxInsertMenu"
import { slotCommand } from "@/features/preview/components/docxRibbon.logic"
import { DocxCommandButton } from "@/features/preview/components/docxRibbonControls"
import { DecideMenu, MarkupMenu, NewCommentButton, StepButton, TrackChangesButton } from "@/features/preview/components/docxReviewMenu"
import {
	TableAlignment,
	TableDesign,
	TableMerge,
	TableRowsColumns,
	type DocxTableTabProps
} from "@/features/preview/components/docxTableMenu"
import type { RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"

// The Word ribbon's Insert, References, Review and Table tabs as groups (officeRibbon.tsx fits them): each group once
// a command of it is labelled, its controls from the tab's own files. Widths are what the controls take, as
// ribbonFit estimates them.

function has(commands: readonly DocxToolbarCommand[], ...types: DocxEditorCommandType[]): boolean {
	return types.some(type => slotCommand(commands, type) !== undefined)
}

function commandButton(props: DocxToolbarSlotProps, type: DocxEditorCommandType, icon: ReactNode, input: boolean, text: boolean) {
	return (
		<DocxCommandButton
			key={type}
			{...props}
			type={type}
			icon={icon}
			input={input}
			text={text}
		/>
	)
}

// `comments` the Review tab's commands (a new comment is offered on both).
export function docxInsertGroups(
	props: DocxToolbarSlotProps,
	comments: readonly DocxToolbarCommand[],
	t: TFunction<"preview">
): RibbonGroup[] {
	const groups: RibbonGroup[] = []
	const button = (type: DocxEditorCommandType, icon: ReactNode, input: boolean, text: boolean) =>
		commandButton(props, type, icon, input, text)

	if (has(props.commands, "insert.pageBreak")) {
		groups.push({
			id: "pages",
			label: t("previewDocxRibbonPages"),
			icon: SeparatorHorizontalIcon,
			width: 110,
			priority: 1,
			single: true,
			content: button("insert.pageBreak", <SeparatorHorizontalIcon />, false, true)
		})
	}

	if (has(props.commands, "table.insert")) {
		groups.push({
			id: "tables",
			label: t("previewDocxRibbonTables"),
			icon: TableIcon,
			width: 82,
			priority: 6,
			single: true,
			content: <TableMenu {...props} />
		})
	}

	if (has(props.commands, "image.insert")) {
		groups.push({
			id: "illustrations",
			label: t("previewOfficeRibbonIllustrations"),
			icon: ImageIcon,
			width: 92,
			priority: 6,
			single: true,
			content: <PicturesMenu {...props} />
		})
	}

	if (has(props.commands, "link.set", "bookmark.add")) {
		groups.push({
			id: "links",
			label: t("previewOfficeRibbonLinks"),
			icon: LinkIcon,
			width: 150,
			priority: 5,
			content: (
				<>
					{button("link.set", <LinkIcon />, true, true)}
					{button("bookmark.add", <BookmarkIcon />, true, true)}
				</>
			)
		})
	}

	if (has(comments, "comment.add")) {
		groups.push({
			id: "comments",
			label: t("previewOfficeRibbonComments"),
			icon: MessageSquarePlusIcon,
			width: 120,
			priority: 4,
			single: true,
			content: (
				<NewCommentButton
					{...props}
					commands={comments}
				/>
			)
		})
	}

	if (has(props.commands, "header.edit", "footer.edit", "insert.pageNumber", "insert.pageCount")) {
		groups.push({
			id: "headerFooter",
			label: t("previewDocxRibbonHeaderFooter"),
			icon: PanelTopIcon,
			width: 190,
			priority: 3,
			content: (
				<>
					{button("header.edit", <PanelTopIcon />, false, true)}
					{button("footer.edit", <PanelBottomIcon />, false, true)}
					<PageNumbersMenu {...props} />
				</>
			)
		})
	}

	if (has(props.commands, "insert.date", "insert.field", "control.insert")) {
		groups.push({
			id: "text",
			label: t("previewDocxRibbonText"),
			icon: BracesIcon,
			width: 104,
			priority: 2,
			content: (
				<>
					{button("insert.date", <CalendarIcon />, true, false)}
					{button("insert.field", <BracesIcon />, true, false)}
					<FormControlMenu {...props} />
				</>
			)
		})
	}

	if (has(props.commands, "equation.insert", "insert.symbol", "insert.horizontalLine")) {
		groups.push({
			id: "symbols",
			label: t("previewDocxRibbonSymbols"),
			icon: OmegaIcon,
			width: 90,
			priority: 2,
			content: (
				<>
					{button("equation.insert", <SigmaIcon />, true, false)}
					{button("insert.symbol", <OmegaIcon />, true, false)}
					{button("insert.horizontalLine", <MinusIcon />, false, false)}
				</>
			)
		})
	}

	return groups
}

// The table of contents, footnotes and endnotes, updating fields.
export function docxReferencesGroups(props: DocxToolbarSlotProps, t: TFunction<"preview">): RibbonGroup[] {
	const groups: RibbonGroup[] = []
	const button = (type: DocxEditorCommandType, icon: ReactNode, input: boolean, text: boolean) =>
		commandButton(props, type, icon, input, text)

	if (has(props.commands, "toc.insert", "toc.update")) {
		groups.push({
			id: "toc",
			label: t("previewDocxRibbonToc"),
			icon: TableOfContentsIcon,
			width: 220,
			priority: 3,
			content: (
				<>
					{button("toc.insert", <TableOfContentsIcon />, true, true)}
					{button("toc.update", <RefreshCwIcon />, false, true)}
				</>
			)
		})
	}

	if (has(props.commands, "note.insertFootnote", "note.insertEndnote", "note.convertAll", "note.options")) {
		groups.push({
			id: "notes",
			label: t("previewDocxInsertNotes"),
			icon: SuperscriptIcon,
			width: 290,
			priority: 2,
			content: (
				<>
					{button("note.insertFootnote", <SuperscriptIcon />, false, true)}
					{button("note.insertEndnote", <ArrowDownToLineIcon />, false, true)}
					<ConvertNotesMenu {...props} />
					{button("note.options", <Settings2Icon />, true, false)}
				</>
			)
		})
	}

	if (has(props.commands, "field.updateAll")) {
		groups.push({
			id: "fields",
			label: t("previewDocxRibbonFields"),
			icon: RefreshCwIcon,
			width: 140,
			priority: 1,
			single: true,
			content: button("field.updateAll", <RefreshCwIcon />, false, true)
		})
	}

	return groups
}

// Comments, tracking (`markup` null for a document without comments or tracked changes) and changes.
export function docxReviewGroups(
	props: DocxToolbarSlotProps,
	markup: DocxMarkupMode | null,
	onMarkupChange: (mode: DocxMarkupMode) => void,
	t: TFunction<"preview">
): RibbonGroup[] {
	const groups: RibbonGroup[] = []
	const track = has(props.commands, "review.track")

	if (has(props.commands, "comment.add", "comment.prev", "comment.next")) {
		groups.push({
			id: "comments",
			label: t("previewOfficeRibbonComments"),
			icon: MessagesSquareIcon,
			width: 176,
			priority: 4,
			content: (
				<>
					<NewCommentButton {...props} />
					<StepButton
						{...props}
						type="comment.prev"
						icon={<ChevronLeftIcon />}
					/>
					<StepButton
						{...props}
						type="comment.next"
						icon={<ChevronRightIcon />}
					/>
				</>
			)
		})
	}

	if (track || markup !== null) {
		groups.push({
			id: "tracking",
			label: t("previewDocxRibbonTracking"),
			icon: FileDiffIcon,
			width: (track ? 136 : 0) + (markup === null ? 0 : 44),
			priority: 5,
			content: (
				<>
					<TrackChangesButton {...props} />
					{markup === null ? null : (
						<MarkupMenu
							markup={markup}
							onMarkupChange={onMarkupChange}
						/>
					)}
				</>
			)
		})
	}

	if (has(props.commands, "review.prev", "review.next", "review.accept", "review.reject", "review.acceptAll", "review.rejectAll")) {
		groups.push({
			id: "changes",
			label: t("previewDocxRibbonChanges"),
			icon: CircleCheckIcon,
			width: 230,
			priority: 3,
			content: (
				<>
					<StepButton
						{...props}
						type="review.prev"
						icon={<ChevronLeftIcon />}
					/>
					<StepButton
						{...props}
						type="review.next"
						icon={<ChevronRightIcon />}
					/>
					<DecideMenu
						{...props}
						accept
					/>
					<DecideMenu
						{...props}
						accept={false}
					/>
				</>
			)
		})
	}

	return groups
}

// The contextual Table tab, while the caret is in a table.
export function docxTableGroups(props: DocxTableTabProps, t: TFunction<"preview">): RibbonGroup[] {
	if (props.snapshot?.context.table == null) {
		return []
	}

	const groups: RibbonGroup[] = []

	if (
		has(
			props.commands,
			"table.row.insertAbove",
			"table.row.insertBelow",
			"table.column.insertLeft",
			"table.column.insertRight",
			"table.delete"
		)
	) {
		groups.push({
			id: "rowsColumns",
			label: t("previewDocxRibbonRowsColumns"),
			icon: BetweenHorizontalEndIcon,
			width: 166,
			priority: 5,
			content: <TableRowsColumns {...props} />
		})
	}

	if (has(props.commands, "table.cells.merge", "table.cell.split", "table.distributeColumns")) {
		groups.push({
			id: "merge",
			label: t("previewDocxRibbonMerge"),
			icon: TableCellsMergeIcon,
			width: 92,
			priority: 4,
			content: <TableMerge {...props} />
		})
	}

	if (has(props.commands, "table.row.header", "table.cell.shading", "table.style")) {
		groups.push({
			id: "design",
			label: t("previewDocxRibbonTableDesign"),
			icon: PaletteIcon,
			width: 108,
			priority: 3,
			content: <TableDesign {...props} />
		})
	}

	if (has(props.commands, "table.align", "table.cell.vAlign")) {
		groups.push({
			id: "alignment",
			label: t("previewOfficeRibbonAlignment"),
			icon: AlignCenterIcon,
			width: 90,
			priority: 2,
			content: <TableAlignment {...props} />
		})
	}

	return groups
}
