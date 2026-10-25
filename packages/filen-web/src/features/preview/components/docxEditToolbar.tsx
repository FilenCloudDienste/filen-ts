import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import {
	AlignCenterIcon,
	AlignJustifyIcon,
	AlignLeftIcon,
	AlignRightIcon,
	BoldIcon,
	ClipboardPasteIcon,
	CodeIcon,
	CopyIcon,
	FileCogIcon,
	ImageIcon,
	ItalicIcon,
	ListIcon,
	ListIndentDecreaseIcon,
	ListIndentIncreaseIcon,
	ListOrderedIcon,
	LockIcon,
	MoveHorizontalIcon,
	PilcrowIcon,
	Redo2Icon,
	RemoveFormattingIcon,
	ScissorsIcon,
	SearchIcon,
	SmartphoneIcon,
	StrikethroughIcon,
	TypeIcon,
	UnderlineIcon,
	Undo2Icon,
	ZoomInIcon,
	ZoomOutIcon,
	type LucideIcon
} from "lucide-react"
import {
	parseDocxEditorCommand,
	type DocxEditorCommand,
	type DocxEditorCommandInfo,
	type DocxEditorSnapshot,
	type DocxFontChoice,
	type DocxParagraphStyle,
	type LockReason
} from "@filen/office/core/docx/edit"
import type { DocxMarkupMode } from "@filen/office/dom/docx"
import { cn } from "@filen/shared"
import {
	COMMAND_LABELS,
	LINE_SPACINGS,
	commandActive,
	drawingItems,
	keepFocus,
	lockReasonKey,
	rowCommands,
	shortcutKeys,
	single,
	slotCommands,
	styleLabel,
	type DocxInputRequest,
	type DocxPainterState,
	type DocxRequestInput,
	type DocxSurface,
	type DocxSwatch,
	type DocxToolbarCommand,
	type DocxToolbarSlotProps
} from "@/features/preview/components/docxEditor.logic"
import { DocxDrawingMenu, DocxPictureCrop } from "@/features/preview/components/docxDrawingMenu"
import { DocxFormatControls, DocxFormatPainter } from "@/features/preview/components/docxFormatControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { DocxBreaksMenu } from "@/features/preview/components/docxInsertMenu"
import { docxInsertGroups, docxReferencesGroups, docxReviewGroups, docxTableGroups } from "@/features/preview/components/docxRibbonGroups"
import { reflowCommands } from "@/features/preview/components/docxReflow.logic"
import type { DocxFindControls, DocxViewOnlyReason } from "@/features/preview/components/docxViewer.logic"
import { DocxFindField, PasswordBadge, ViewOnlyBadge, type PasswordIntegrity } from "@/features/preview/components/docxToolbar"
import { OfficeRibbon, type RibbonGroup, type RibbonTab } from "@/features/office/components/ribbon/officeRibbon"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Kbd, KbdKeys } from "@/lib/keymap/kbd"

// The Word document editor's ribbon (officeRibbon.tsx), as Word for the web's simplified ribbon: File, Home
// (undo, clipboard, font, paragraph, styles, editing), Insert, Layout, References, Review, View, and the contextual
// Table and Picture tabs while the selection is in a table or on a picture. Mod+F swaps the command row for the
// find field. Everything shown comes from the editing session's snapshot; everything done is one of its commands. A
// feature's commands appear on its tab (docxEditor.logic.ts DocxToolbarSlot) once they are labelled.

const ICONS: Readonly<Record<string, LucideIcon>> = {
	bold: BoldIcon,
	italic: ItalicIcon,
	underline: UnderlineIcon,
	strikethrough: StrikethroughIcon,
	"clear-formatting": RemoveFormattingIcon,
	"align-start": AlignLeftIcon,
	"align-center": AlignCenterIcon,
	"align-end": AlignRightIcon,
	"align-justify": AlignJustifyIcon,
	"list-bullet": ListIcon,
	"list-numbered": ListOrderedIcon,
	indent: ListIndentIncreaseIcon,
	outdent: ListIndentDecreaseIcon,
	undo: Undo2Icon,
	redo: Redo2Icon
}

const HISTORY = rowCommands("history")
const FORMAT = rowCommands("format")
const ALIGN = rowCommands("align")
const LISTS = rowCommands("list")
const HOME_SLOT = slotCommands("home")
const INSERT_SLOT = slotCommands("insert")
const LAYOUT_SLOT = slotCommands("layout")
const REFERENCES_SLOT = slotCommands("references")
const REVIEW_SLOT = slotCommands("review")
const VIEW_SLOT = slotCommands("view")
const TABLE_SLOT = slotCommands("table")
const PICTURE_SLOT = slotCommands("picture")
// Layout's Breaks: its section breaks with Insert's page and line breaks.
const BREAKS = [...INSERT_SLOT, ...LAYOUT_SLOT]
const LINE_SPACING = COMMAND_LABELS["paragraph.lineSpacing"] !== undefined
const PARAGRAPH_DIALOG = COMMAND_LABELS["paragraph.indent"] !== undefined || COMMAND_LABELS["paragraph.spacing"] !== undefined
const PAGE_SETUP = COMMAND_LABELS["page.setup"] !== undefined

// A button's width with its gap, a dropdown trigger's, as the browsers lay them out (ribbonFit's estimates).
const BUTTON = 30
const MENU = 44

// The editor's own clipboard commands (the context menu's), for the Clipboard group.
export interface DocxRibbonClipboard {
	cut: () => void
	copy: () => void
	// Text only: the clipboard's text without its formatting or pictures (Keep text only).
	paste: (textOnly: boolean) => void
}

export interface DocxEditToolbarProps {
	// The File menu (Download as, autosave), first in the tab row; absent when it offers nothing.
	fileMenu?: ReactNode
	snapshot: DocxEditorSnapshot | undefined
	// The host's read-only state on top of the session's (a save writing, a file that cannot be saved).
	readOnly: boolean
	apple: boolean
	execute: (command: DocxEditorCommand) => void
	clipboard: DocxRibbonClipboard
	viewOnly: readonly DocxViewOnlyReason[]
	// Opened with its password: its integrity, and whether saves keep the password now (the session can save).
	encrypted?: { integrity: PasswordIntegrity; saving: boolean } | undefined
	find: { open: boolean; replace: boolean; focus: number; controls: DocxFindControls }
	onFindOpen: (replace: boolean) => void
	onFindClosed: () => void
	markup: DocxMarkupMode | null
	onMarkupChange: (mode: DocxMarkupMode) => void
	zoom: number
	onZoom: (change: "in" | "out" | "fit") => void
	// The reflowed (mobile) view instead of pages.
	reflow: boolean
	onReflowChange: (reflow: boolean) => void
	surface: DocxSurface
	// The paragraph styles the picker offers (offeredParagraphStyles), the document's fonts and the theme part
	// of the colour pickers: the same for the editor's lifetime.
	styles: readonly DocxParagraphStyle[]
	fonts: readonly DocxFontChoice[]
	theme: readonly (readonly DocxSwatch[])[]
	painter: DocxPainterState
	onPainterCancel: () => void
	// Every field shows its code (view.fieldCodes).
	fieldCodes: boolean
	// The input request channel the tabs take part in (docxEditor.logic.ts DocxInputRequest).
	inputRequest: DocxInputRequest | null
	requestInput: DocxRequestInput
	onInputDone: (nonce: number) => void
}

// A command without arguments (every one but style.set, which the style picker sends).
function run(info: DocxEditorCommandInfo, execute: (command: DocxEditorCommand) => void): void {
	const command = parseDocxEditorCommand({ type: info.type })

	if (command !== undefined) {
		execute(command)
	}
}

// Whether a ribbon command is off: no session yet, a write while read-only, or the session says so.
function commandDisabled(info: DocxEditorCommandInfo, snapshot: DocxEditorSnapshot | undefined, readOnly: boolean): boolean {
	return snapshot === undefined || (readOnly && info.write) || !snapshot.enabled[info.type]
}

// Takes what it shows as plain values (never the snapshot, new on every keystroke), so a keystroke that
// changes neither re-renders nothing below it.
function CommandButton({
	command,
	active,
	disabled,
	apple,
	execute
}: {
	command: DocxToolbarCommand
	active: boolean
	disabled: boolean
	apple: boolean
	execute: (command: DocxEditorCommand) => void
}) {
	const { t } = useTranslation("preview")
	const { info, label } = command
	const Icon = ICONS[info.icon ?? ""] ?? BoldIcon
	const toggle = info.group === "format" && info.type !== "format.clear"

	return (
		<TooltipIconButton
			label={t(label)}
			disabled={disabled}
			pressed={toggle || info.group === "align" || info.type === "list.bullet" || info.type === "list.numbered" ? active : undefined}
			className={cn(active && "bg-accent text-foreground")}
			shortcut={info.shortcut === undefined ? undefined : <KbdKeys keys={shortcutKeys(info.shortcut, apple)} />}
			onMouseDown={keepFocus}
			onClick={() => {
				run(info, execute)
			}}
		>
			<Icon />
		</TooltipIconButton>
	)
}

const STYLE_MIXED = "mixed"
const STYLE_CUSTOM = "custom"

function StylePicker({
	styles,
	style,
	styleName,
	disabled,
	execute
}: {
	styles: readonly DocxParagraphStyle[]
	style: DocxEditorSnapshot["paragraph"]["style"]
	styleName: string
	disabled: boolean
	execute: (command: DocxEditorCommand) => void
}) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const value = style ?? STYLE_MIXED
	const labelOf = (option: DocxParagraphStyle): string => {
		const label = styleLabel(option)

		return label.key === "previewDocxStyleHeading" ? t(label.key, { level: label.level }) : t(label.key)
	}
	// A style the document's protection locks shows as the selection's own, not as an offer.
	const offered = styles.includes(value as DocxParagraphStyle)
	const shown = offered || value === STYLE_MIXED ? value : STYLE_CUSTOM
	const items = [
		...styles.map(option => ({ value: option, label: labelOf(option) })),
		{ value: STYLE_CUSTOM, label: value === STYLE_CUSTOM ? styleName : labelOf(value as DocxParagraphStyle) },
		{ value: STYLE_MIXED, label: t("previewDocxStyleMixed") }
	]

	return (
		<Select
			items={items}
			value={shown}
			disabled={disabled}
			onOpenChange={focus.opened}
			onOpenChangeComplete={focus.settled}
			onValueChange={next => {
				const chosen = styles.find(option => option === next)

				if (chosen !== undefined) {
					execute({ type: "style.set", style: chosen })
					focus.ran()
				}
			}}
		>
			<SelectTrigger
				size="sm"
				aria-label={t("previewDocxParagraphStyle")}
				className="w-36 shrink-0"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent data-preview-surface>
				<SelectGroup>
					{styles.map(option => (
						<SelectItem
							key={option}
							value={option}
						>
							{labelOf(option)}
						</SelectItem>
					))}
					{shown === STYLE_CUSTOM ? (
						<SelectItem value={STYLE_CUSTOM}>{items.find(item => item.value === STYLE_CUSTOM)?.label}</SelectItem>
					) : null}
					{shown === STYLE_MIXED ? <SelectItem value={STYLE_MIXED}>{t("previewDocxStyleMixed")}</SelectItem> : null}
				</SelectGroup>
			</SelectContent>
		</Select>
	)
}

function LockedBadge({ reason }: { reason: LockReason }) {
	const { t } = useTranslation("preview")

	return (
		<Popover>
			<Badge
				variant="outline"
				className="cursor-pointer text-muted-foreground hover:bg-muted"
				render={<PopoverTrigger aria-label={t("previewDocxLocked")} />}
			>
				<LockIcon data-icon="inline-start" />
				<span className="max-sm:hidden">{t("previewDocxLocked")}</span>
			</Badge>
			<PopoverContent
				align="start"
				className="gap-2"
			>
				<p className="font-medium">{t("previewDocxLockedTitle")}</p>
				<p className="text-muted-foreground">{t(lockReasonKey(reason))}</p>
			</PopoverContent>
		</Popover>
	)
}

// Paste ▾ (the clipboard as it is, or its text alone), Cut, Copy: the editor's own clipboard commands.
function ClipboardControls({
	clipboard,
	editable,
	copyable,
	apple
}: {
	clipboard: DocxRibbonClipboard
	editable: boolean
	copyable: boolean
	apple: boolean
}) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()

	return (
		<>
			<DropdownMenu onOpenChange={focus.opened}>
				<RibbonMenuTrigger
					label={t("previewDocxPaste")}
					icon={<ClipboardPasteIcon />}
					disabled={!editable}
					shortcut={<KbdKeys keys={shortcutKeys("mod+v", apple)} />}
				/>
				<DropdownMenuContent
					finalFocus={focus.finalFocus}
					data-preview-surface
				>
					<DropdownMenuItem
						onClick={() => {
							clipboard.paste(false)
						}}
					>
						{t("previewDocxPaste")}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							clipboard.paste(true)
						}}
					>
						{t("previewDocxRibbonPasteText")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<TooltipIconButton
				label={t("previewDocxCut")}
				disabled={!editable || !copyable}
				shortcut={<KbdKeys keys={shortcutKeys("mod+x", apple)} />}
				onMouseDown={keepFocus}
				onClick={clipboard.cut}
			>
				<ScissorsIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewDocxCopy")}
				disabled={!copyable}
				shortcut={<KbdKeys keys={shortcutKeys("mod+c", apple)} />}
				onMouseDown={keepFocus}
				onClick={clipboard.copy}
			>
				<CopyIcon />
			</TooltipIconButton>
		</>
	)
}

// Line spacing ▾: Word's multiples.
function LineSpacingMenu({
	value,
	disabled,
	execute
}: {
	value: number | null
	disabled: boolean
	execute: (command: DocxEditorCommand) => void
}) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewDocxLineSpacing")}
				icon={<MoveHorizontalIcon className="rotate-90" />}
				disabled={disabled}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				<DropdownMenuRadioGroup
					value={value === null ? "" : String(value)}
					onValueChange={(next: string) => {
						execute({ type: "paragraph.lineSpacing", rule: "auto", value: Number(next) })
						focus.ran()
					}}
				>
					{LINE_SPACINGS.map(spacing => (
						<DropdownMenuRadioItem
							key={spacing}
							value={String(spacing)}
							closeOnClick
						>
							{t("previewDocxLineSpacingValue", {
								value: spacing / 240,
								formatParams: { value: { minimumFractionDigits: 1 } }
							})}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// Find ▾: find, or find and replace.
function FindMenu({ onFindOpen }: { onFindOpen: (replace: boolean) => void }) {
	const { t } = useTranslation("preview")

	return (
		<DropdownMenu>
			<RibbonMenuTrigger
				label={t("previewDocxFindAction")}
				icon={<SearchIcon />}
				shortcut={<Kbd action="editor.find" />}
			/>
			<DropdownMenuContent data-preview-surface>
				<DropdownMenuItem
					onClick={() => {
						onFindOpen(false)
					}}
				>
					{t("previewDocxFindAction")}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => {
						onFindOpen(true)
					}}
				>
					{t("previewDocxFindReplaceAction")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function tabsOf(t: TFunction<"preview">, table: boolean, picture: boolean): RibbonTab[] {
	return [
		{ id: "home", label: t("previewOfficeRibbonTabHome") },
		{ id: "insert", label: t("previewOfficeRibbonTabInsert") },
		{ id: "layout", label: t("previewDocxRibbonTabLayout") },
		...(REFERENCES_SLOT.length > 0 ? [{ id: "references", label: t("previewDocxRibbonTabReferences") }] : []),
		{ id: "review", label: t("previewOfficeRibbonTabReview") },
		{ id: "view", label: t("previewOfficeRibbonTabView") },
		...(table ? [{ id: "table", label: t("previewDocxTableGroup"), contextual: true }] : []),
		...(picture ? [{ id: "picture", label: t("previewDocxPictureGroup"), contextual: true }] : [])
	]
}

export function DocxEditToolbar(props: DocxEditToolbarProps) {
	const { t } = useTranslation("preview")
	const { snapshot, readOnly, apple, execute, find } = props
	const [selected, setSelected] = useState("home")
	const locked = snapshot?.selection.locked ?? null
	const table = TABLE_SLOT.length > 0 && snapshot?.context.table != null
	const picture = PICTURE_SLOT.length > 0 && snapshot?.context.drawing != null
	const pictureItems = picture ? drawingItems(PICTURE_SLOT, props.surface) : []
	const tabs = tabsOf(t, table, pictureItems.length > 0)
	// A contextual tab whose object is no longer selected gives way to Home.
	const tab = tabs.some(entry => entry.id === selected) ? selected : "home"
	const percent = Math.round(props.zoom * 100)
	const editable = snapshot !== undefined && !readOnly && !snapshot.readOnly
	const commandOff = (type: DocxEditorCommandInfo["type"]): boolean => snapshot === undefined || readOnly || !snapshot.enabled[type]
	const slotProps = (commands: readonly DocxToolbarCommand[]): DocxToolbarSlotProps => ({
		// Mobile view shows no headers or footers: it does not offer editing them.
		commands: reflowCommands(commands, props.surface === "reflow"),
		snapshot,
		readOnly,
		apple,
		execute,
		surface: props.surface,
		inputRequest: props.inputRequest,
		requestInput: props.requestInput,
		onInputDone: props.onInputDone
	})
	const button = (command: DocxToolbarCommand): ReactNode => (
		<CommandButton
			key={command.info.type}
			command={command}
			active={snapshot !== undefined && commandActive(snapshot, command.info.type)}
			disabled={commandDisabled(command.info, snapshot, readOnly)}
			apple={apple}
			execute={execute}
		/>
	)
	const lineSpacing = single(snapshot?.values.lineSpacing ?? null)
	const lineSpacingMenu = LINE_SPACING ? (
		<LineSpacingMenu
			value={lineSpacing?.rule === "auto" ? lineSpacing.value : null}
			disabled={commandOff("paragraph.lineSpacing")}
			execute={execute}
		/>
	) : null
	const paragraphDialog = (text: boolean): ReactNode =>
		PARAGRAPH_DIALOG ? (
			<RibbonButton
				label={t("previewDocxParagraphAction")}
				icon={<PilcrowIcon />}
				text={text ? t("previewDocxParagraphAction") : undefined}
				disabled={commandOff("paragraph.indent") && commandOff("paragraph.spacing")}
				onClick={() => {
					props.requestInput("paragraph.indent")
				}}
			/>
		) : null
	const groups: RibbonGroup[] = []

	switch (tab) {
		case "home":
			groups.push(
				{
					id: "history",
					label: t("previewOfficeRibbonUndo"),
					icon: Undo2Icon,
					width: HISTORY.length * BUTTON,
					priority: Infinity,
					content: HISTORY.map(button)
				},
				{
					id: "clipboard",
					label: t("previewOfficeRibbonClipboard"),
					icon: ClipboardPasteIcon,
					width: MENU + 3 * BUTTON,
					priority: 3,
					content: (
						<>
							<ClipboardControls
								clipboard={props.clipboard}
								editable={editable}
								copyable={snapshot !== undefined}
								apple={apple}
							/>
							<DocxFormatPainter
								commands={HOME_SLOT}
								snapshot={snapshot}
								readOnly={readOnly}
								execute={execute}
								painter={props.painter}
								onPainterCancel={props.onPainterCancel}
							/>
						</>
					)
				},
				{
					id: "font",
					label: t("previewOfficeRibbonFont"),
					icon: TypeIcon,
					width: 346,
					priority: 6,
					content: (
						<DocxFormatControls
							{...slotProps(HOME_SLOT)}
							part="font"
							fonts={props.fonts}
							theme={props.theme}
							painter={props.painter}
							onPainterCancel={props.onPainterCancel}
						/>
					)
				},
				{
					id: "formatting",
					label: t("previewOfficeRibbonFormatting"),
					icon: BoldIcon,
					width: (FORMAT.length + 2) * BUTTON,
					priority: 7,
					content: (
						<DocxFormatControls
							{...slotProps(HOME_SLOT)}
							part="style"
							fonts={props.fonts}
							theme={props.theme}
							painter={props.painter}
							onPainterCancel={props.onPainterCancel}
						>
							{FORMAT.map(button)}
						</DocxFormatControls>
					)
				},
				{
					id: "paragraph",
					label: t("previewDocxRibbonParagraph"),
					icon: PilcrowIcon,
					width: (LISTS.length + ALIGN.length) * BUTTON + (LINE_SPACING ? MENU : 0) + (PARAGRAPH_DIALOG ? BUTTON : 0),
					priority: 5,
					content: (
						<>
							{LISTS.map(button)}
							{ALIGN.map(button)}
							{lineSpacingMenu}
							{paragraphDialog(false)}
						</>
					)
				},
				{
					id: "styles",
					label: t("previewDocxRibbonStyles"),
					icon: TypeIcon,
					width: 146,
					priority: 4,
					single: true,
					content: (
						<StylePicker
							styles={props.styles}
							style={snapshot?.paragraph.style ?? null}
							styleName={snapshot?.paragraph.styleName ?? ""}
							disabled={snapshot === undefined || readOnly || !snapshot.enabled["style.set"]}
							execute={execute}
						/>
					)
				},
				{
					id: "editing",
					label: t("previewOfficeRibbonEditing"),
					icon: SearchIcon,
					width: MENU,
					priority: 2,
					single: true,
					content: <FindMenu onFindOpen={props.onFindOpen} />
				}
			)
			break
		case "insert":
			groups.push(...docxInsertGroups(slotProps(INSERT_SLOT), REVIEW_SLOT, t))
			break
		case "layout":
			if (PAGE_SETUP) {
				groups.push({
					id: "pageSetup",
					label: t("previewDocxRibbonPageSetup"),
					icon: FileCogIcon,
					width: 116,
					priority: 3,
					single: true,
					content: (
						<RibbonButton
							label={t("previewDocxPageSetupAction")}
							icon={<FileCogIcon />}
							text={t("previewDocxPageSetupAction")}
							disabled={commandOff("page.setup")}
							onClick={() => {
								props.requestInput("page.setup")
							}}
						/>
					)
				})
			}

			groups.push(
				{
					id: "breaks",
					label: t("previewDocxInsertBreaks"),
					icon: FileCogIcon,
					width: 96,
					priority: 2,
					single: true,
					content: <DocxBreaksMenu {...slotProps(BREAKS)} />
				},
				{
					id: "paragraph",
					label: t("previewDocxRibbonParagraph"),
					icon: PilcrowIcon,
					width: MENU + 110,
					priority: 4,
					content: (
						<>
							{lineSpacingMenu}
							{paragraphDialog(true)}
						</>
					)
				}
			)
			break
		case "references":
			groups.push(...docxReferencesGroups(slotProps(REFERENCES_SLOT), t))
			break
		case "review":
			groups.push(...docxReviewGroups(slotProps(REVIEW_SLOT), props.markup, props.onMarkupChange, t))
			break
		case "view": {
			const reflow = VIEW_SLOT.find(command => command.info.type === "view.reflow")
			const fieldCodes = VIEW_SLOT.find(command => command.info.type === "view.fieldCodes")

			groups.push({
				id: "zoom",
				label: t("previewOfficeRibbonZoom"),
				icon: ZoomInIcon,
				width: 3 * BUTTON,
				priority: 3,
				content: (
					<>
						<RibbonButton
							label={t("previewDocxZoomOutAction")}
							icon={<ZoomOutIcon />}
							onClick={() => {
								props.onZoom("out")
							}}
						/>
						<RibbonButton
							label={t("previewDocxZoomInAction")}
							icon={<ZoomInIcon />}
							onClick={() => {
								props.onZoom("in")
							}}
						/>
						<RibbonButton
							label={t("previewDocxFitWidth")}
							icon={<MoveHorizontalIcon />}
							onClick={() => {
								props.onZoom("fit")
							}}
						/>
					</>
				)
			})

			if (reflow !== undefined) {
				groups.push({
					id: "views",
					label: t("previewDocxRibbonViews"),
					icon: SmartphoneIcon,
					width: 116,
					priority: 2,
					single: true,
					content: (
						<RibbonButton
							label={t(reflow.label)}
							icon={<SmartphoneIcon />}
							text={t(reflow.label)}
							pressed={props.reflow}
							onClick={() => {
								props.onReflowChange(!props.reflow)
							}}
						/>
					)
				})
			}

			if (fieldCodes !== undefined) {
				groups.push({
					id: "show",
					label: t("previewOfficeRibbonShow"),
					icon: CodeIcon,
					width: 150,
					priority: 1,
					single: true,
					content: (
						<RibbonButton
							label={t(fieldCodes.label)}
							icon={<CodeIcon />}
							text={t(fieldCodes.label)}
							pressed={props.fieldCodes}
							disabled={snapshot?.enabled["view.fieldCodes"] !== true}
							onClick={() => {
								execute({ type: "view.fieldCodes" })
							}}
						/>
					)
				})
			}

			break
		}
		case "table":
			groups.push(...docxTableGroups({ ...slotProps(TABLE_SLOT), theme: props.theme }, t))
			break
		case "picture":
			groups.push({
				id: "picture",
				label: t("previewDocxPictureGroup"),
				icon: ImageIcon,
				width: pictureItems.length * 38,
				priority: 3,
				content: (
					<DocxDrawingMenu
						{...slotProps(PICTURE_SLOT)}
						items={pictureItems}
					/>
				)
			})
			break
	}

	return (
		<>
			<OfficeRibbon
				label={t("previewOfficeRibbon")}
				commandsLabel={t("previewOfficeRibbonCommands")}
				tabs={tabs}
				tab={tab}
				onTab={setSelected}
				file={props.fileMenu}
				status={
					<>
						{props.viewOnly.length > 0 ? <ViewOnlyBadge reasons={props.viewOnly} /> : null}
						{props.encrypted === undefined ? null : (
							<PasswordBadge
								integrity={props.encrypted.integrity}
								saving={props.encrypted.saving}
							/>
						)}
						{locked === null ? null : <LockedBadge reason={locked} />}
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										variant="ghost"
										size="xs"
										aria-label={t("previewDocxFitWidthAction", { percent })}
										className="w-12 shrink-0 px-0 text-muted-foreground tabular-nums max-sm:hidden"
										onMouseDown={keepFocus}
										onClick={() => {
											props.onZoom("fit")
										}}
									>
										{t("previewDocxZoomIndicator", { percent })}
									</Button>
								}
							/>
							<TooltipContent>{t("previewDocxFitWidth")}</TooltipContent>
						</Tooltip>
					</>
				}
				groups={groups}
				replacement={
					find.open ? (
						<div className="flex min-w-0 flex-1 justify-center">
							<DocxFindField
								key={find.replace ? "replace" : "find"}
								find={find.controls}
								focus={find.focus}
								onClosed={props.onFindClosed}
								replaceOpen={find.replace}
							/>
						</div>
					) : undefined
				}
			/>
			{picture ? <DocxPictureCrop {...slotProps(PICTURE_SLOT)} /> : null}
		</>
	)
}
