import { useSyncExternalStore, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import {
	BoldIcon,
	CodeIcon,
	CodeXmlIcon,
	EyeIcon,
	FileDiffIcon,
	FoldVerticalIcon,
	IndentIncreaseIcon,
	ItalicIcon,
	LinkIcon,
	ListOrderedIcon,
	LockIcon,
	MessageSquareCodeIcon,
	Redo2Icon,
	ReplaceIcon,
	SearchIcon,
	SlidersHorizontalIcon,
	StrikethroughIcon,
	TextCursorInputIcon,
	TypeIcon,
	Undo2Icon,
	UnfoldVerticalIcon,
	WrapTextIcon
} from "lucide-react"
import { redo, toggleComment, undo } from "@codemirror/commands"
import { foldAll, unfoldAll } from "@codemirror/language"
import type { Command } from "@codemirror/view"
import { CODE_LANGUAGES, isCodeLanguageId, type CodeLanguageId } from "@filen/office/core/code"
import { insertLink, MARKDOWN_MARKERS, toggleInlineMarker, toggleItalic } from "@filen/office/core/markdown"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { OfficeCommandBar, type RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { keepFocus } from "@/features/office/lib/officeControls"
import { usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"
import { CommandFileMenu, FullScreenButton } from "@/features/preview/components/commandBarControls"
import { BAR_BUTTON, BAR_MENU } from "@/features/preview/components/commandBar.logic"
import { DocxFindField } from "@/features/preview/components/docxToolbar"
import { shortcutKeys } from "@/features/preview/components/docxEditor.logic"
import { CODE_INDENTS, type CodeChrome, type CodeIndent } from "@/features/preview/lib/codeChrome"
import { CODE_FONT_SIZES, setCodeViewSettings, type CodeViewSettings } from "@/features/preview/lib/codeViewSettings"
import type { TextFileFormat } from "@/features/preview/lib/textFile"
import { fullscreenSupported } from "@/lib/media/fullscreen"
import { Kbd, KbdKeys } from "@/lib/keymap/kbd"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"

// The text and code viewers' command bar (OfficeCommandBar), and the markdown viewer's in both its views: File
// (Download), then the markdown view switch, Undo and Redo, Find (find, replace, go to line), Code (toggle comment,
// fold and unfold all), View changes, markdown Formatting, and View (wrap, line numbers, font size, language,
// indentation, full screen); the position, language, indentation, line ending, encoding and a read-only badge at the
// end. Find and replace take the groups' place while finding (codeFind.ts). The bar renders on what changes rarely
// (find opening, the dirty edge, a setting); a keystroke reaches only the position and the undo and redo buttons,
// each reading the editor's status store (codeChrome.ts).

const APPLE = isMacPlatform()

// Every bundled grammar, by name, for the language menu.
const LANGUAGES: readonly CodeLanguageId[] = Object.keys(CODE_LANGUAGES)
	.filter(isCodeLanguageId)
	.sort((a, b) => CODE_LANGUAGES[a].name.localeCompare(CODE_LANGUAGES[b].name))

function keys(combo: string): ReactNode {
	return <KbdKeys keys={shortcutKeys(combo, APPLE)} />
}

// CodeMirror's fold keys are Ctrl+Alt on every platform.
function foldKeys(bracket: string): ReactNode {
	return <KbdKeys keys={APPLE ? ["⌃", "⌥", bracket] : ["Ctrl", "Alt", bracket]} />
}

function HistoryButton({ chrome, redo: isRedo }: { chrome: CodeChrome; redo: boolean }) {
	const { t } = useTranslation("preview")
	// Its own read of the status, so a keystroke re-renders this button alone, and only when it turns on or off.
	const enabled = useSyncExternalStore(chrome.subscribe, () => (isRedo ? chrome.getStatus().canRedo : chrome.getStatus().canUndo))

	return (
		<RibbonButton
			label={t(isRedo ? "previewCommandBarRedo" : "previewCommandBarUndo")}
			icon={isRedo ? <Redo2Icon /> : <Undo2Icon />}
			disabled={!enabled}
			shortcut={keys(isRedo ? (APPLE ? "mod+shift+z" : "mod+y") : "mod+z")}
			onClick={() => {
				chrome.run(isRedo ? redo : undo)
			}}
		/>
	)
}

// The cursor's line and column and what is selected: the one part of the status a keystroke changes.
export function CodePosition({ chrome }: { chrome: CodeChrome }) {
	const { t } = useTranslation("preview")
	const status = useSyncExternalStore(chrome.subscribe, chrome.getStatus)

	return (
		<span className="whitespace-nowrap">
			{t("previewCommandBarPosition", { line: status.line, column: status.column })}
			{status.selected > 0 ? ` ${t("previewCommandBarSelected", { count: status.selected })}` : null}
		</span>
	)
}

// Find and replace in the groups' place: reads the find store, so counting again re-renders it alone.
function CodeFindField({ chrome, locked }: { chrome: CodeChrome; locked: boolean }) {
	const find = useSyncExternalStore(chrome.find.subscribe, chrome.find.get)

	return (
		<DocxFindField
			// Asked for replace while finding: opened again with its replace field.
			key={find.replace ? "replace" : "find"}
			find={chrome.find.controls(find, locked)}
			focus={find.focus}
			replaceOpen={find.replace}
			onClosed={() => {
				chrome.focus()
			}}
		/>
	)
}

export type MarkdownMode = "rendered" | "source"

// Rendered | Source. Switching is locked while the source has unsaved edits (switching would drop the editor that
// holds them); the switch says why in its tooltip.
function MarkdownModeSwitch({
	mode,
	locked,
	onMode,
	switchRef
}: {
	mode: MarkdownMode
	locked: boolean
	onMode: (mode: MarkdownMode) => void
	// The button that switches away from `mode`, focused after a keyboard switch from the editor.
	switchRef: RefObject<HTMLButtonElement | null> | undefined
}) {
	const { t } = useTranslation("preview")

	return (
		<>
			{(["rendered", "source"] as const).map(option => {
				const active = option === mode
				const disabled = !active && locked

				return (
					<Tooltip key={option}>
						<TooltipTrigger
							render={
								<Button
									ref={active ? undefined : switchRef}
									variant="ghost"
									size="sm"
									aria-label={t(option === "rendered" ? "previewCommandBarRendered" : "previewCommandBarSource")}
									aria-pressed={active}
									disabled={disabled}
									// aria-disabled rather than disabled: the hint below must stay reachable by hover.
									focusableWhenDisabled
									className={
										active
											? "shrink-0 gap-1 bg-accent px-2 text-foreground"
											: "shrink-0 gap-1 px-2 aria-disabled:opacity-50"
									}
									onMouseDown={keepFocus}
									onClick={() => {
										if (!active) {
											onMode(option)
										}
									}}
								>
									{option === "rendered" ? <EyeIcon /> : <CodeIcon />}
									{/* Icons only on a phone. */}
									<span className="text-xs max-sm:hidden">
										{t(option === "rendered" ? "previewCommandBarRendered" : "previewCommandBarSource")}
									</span>
								</Button>
							}
						/>
						<TooltipContent>
							{locked ? t("previewMarkdownToggleDirtyHint") : t("previewCommandBarMarkdownView")}
							{locked ? null : <Kbd action="editor.togglePreview" />}
						</TooltipContent>
					</Tooltip>
				)
			})}
		</>
	)
}

export interface MarkdownBar {
	readonly mode: MarkdownMode
	// Unsaved edits: the switch is locked.
	readonly locked: boolean
	readonly onMode: (mode: MarkdownMode) => void
	readonly switchRef?: RefObject<HTMLButtonElement | null>
}

function markdownGroup(markdown: MarkdownBar, label: string, phone: boolean): RibbonGroup {
	return {
		id: "markdownView",
		label,
		icon: EyeIcon,
		width: phone ? 2 * BAR_BUTTON : 170,
		priority: Infinity,
		content: (
			<MarkdownModeSwitch
				mode={markdown.mode}
				locked={markdown.locked}
				onMode={markdown.onMode}
				switchRef={markdown.switchRef}
			/>
		)
	}
}

function DownloadFile({ onDownload }: { onDownload: (() => void) | null }) {
	const { t } = useTranslation("preview")

	return onDownload === null ? null : (
		<CommandFileMenu>
			<DropdownMenuItem onClick={onDownload}>{t("previewDownloadAction")}</DropdownMenuItem>
		</CommandFileMenu>
	)
}

// The rendered markdown's bar: the view switch alone.
export function MarkdownRenderedBar({ markdown, onDownload }: { markdown: MarkdownBar; onDownload: (() => void) | null }) {
	const { t } = useTranslation("preview")
	const phone = usePhoneWidth()

	return (
		<OfficeCommandBar
			label={t("previewOfficeRibbonCommands")}
			file={<DownloadFile onDownload={onDownload} />}
			groups={[markdownGroup(markdown, t("previewCommandBarMarkdownView"), phone)]}
		/>
	)
}

export interface CodeCommandBarProps {
	chrome: CodeChrome
	editable: boolean
	// A save in flight: read-only until it settles.
	locked: boolean
	dirty: boolean
	// The markdown source's: its view switch and formatting.
	markdown: MarkdownBar | null
	language: CodeLanguageId | ""
	onLanguage: (language: CodeLanguageId | "") => void
	indent: CodeIndent
	onIndent: (indent: CodeIndent) => void
	settings: CodeViewSettings
	format: TextFileFormat
	onGoToLine: () => void
	onViewChanges: () => void
	onDownload: (() => void) | null
}

export function CodeCommandBar({
	chrome,
	editable,
	locked,
	dirty,
	markdown,
	language,
	onLanguage,
	indent,
	onIndent,
	settings,
	format,
	onGoToLine,
	onViewChanges,
	onDownload
}: CodeCommandBarProps) {
	const { t } = useTranslation("preview")
	const finding = useSyncExternalStore(chrome.find.subscribe, chrome.find.isOpen)
	const phone = usePhoneWidth()
	const writable = editable && !locked
	const run = (command: Command) => () => {
		chrome.run(command)
	}
	const indentLabel = (value: CodeIndent): string =>
		value === "tabs" ? t("previewCommandBarIndentTabs") : t("previewCommandBarIndentSpaces", { width: value })
	const languageName = language === "" ? t("previewCommandBarPlainText") : CODE_LANGUAGES[language].name
	const groups: RibbonGroup[] = []

	if (markdown !== null) {
		groups.push(markdownGroup(markdown, t("previewCommandBarMarkdownView"), phone))
	}

	if (editable) {
		groups.push({
			id: "history",
			label: t("previewOfficeRibbonUndo"),
			icon: Undo2Icon,
			width: 2 * BAR_BUTTON,
			priority: 7,
			content: (
				<>
					<HistoryButton
						chrome={chrome}
						redo={false}
					/>
					<HistoryButton
						chrome={chrome}
						redo
					/>
				</>
			)
		})
	}

	groups.push({
		id: "find",
		label: t("previewOfficeRibbonEditing"),
		icon: SearchIcon,
		width: (editable ? 3 : 2) * BAR_BUTTON,
		priority: Infinity,
		content: (
			<>
				<RibbonButton
					label={t("previewEditorFind")}
					icon={<SearchIcon />}
					shortcut={<Kbd action="editor.find" />}
					onClick={() => {
						chrome.find.open(false)
					}}
				/>
				{editable ? (
					<RibbonButton
						label={t("previewEditorReplace")}
						icon={<ReplaceIcon />}
						disabled={locked}
						shortcut={<Kbd action="editor.replace" />}
						onClick={() => {
							chrome.find.open(true)
						}}
					/>
				) : null}
				<RibbonButton
					label={t("previewCommandBarGoToLine")}
					icon={<TextCursorInputIcon />}
					shortcut={keys("mod+alt+g")}
					onClick={onGoToLine}
				/>
			</>
		)
	})

	// Commenting and folding come from the language's grammar: plain text has neither.
	if (language !== "") {
		groups.push({
			id: "code",
			label: t("previewCommandBarCode"),
			icon: CodeXmlIcon,
			width: (editable ? 3 : 2) * BAR_BUTTON,
			priority: 3,
			content: (
				<>
					{editable ? (
						<RibbonButton
							label={t("previewCommandBarToggleComment")}
							icon={<MessageSquareCodeIcon />}
							disabled={locked}
							shortcut={keys("mod+/")}
							onClick={run(toggleComment)}
						/>
					) : null}
					<RibbonButton
						label={t("previewCommandBarFoldAll")}
						icon={<FoldVerticalIcon />}
						shortcut={foldKeys("[")}
						onClick={run(foldAll)}
					/>
					<RibbonButton
						label={t("previewCommandBarUnfoldAll")}
						icon={<UnfoldVerticalIcon />}
						shortcut={foldKeys("]")}
						onClick={run(unfoldAll)}
					/>
				</>
			)
		})
	}

	if (editable) {
		groups.push({
			id: "changes",
			label: t("previewCommandBarViewChanges"),
			icon: FileDiffIcon,
			width: BAR_BUTTON,
			priority: 4,
			single: true,
			content: (
				<RibbonButton
					label={t("previewCommandBarViewChanges")}
					icon={<FileDiffIcon />}
					disabled={!dirty}
					onClick={onViewChanges}
				/>
			)
		})
	}

	if (markdown !== null && editable) {
		groups.push({
			id: "formatting",
			label: t("previewCommandBarFormatting"),
			icon: BoldIcon,
			width: 5 * BAR_BUTTON,
			priority: 5,
			content: (
				<>
					<RibbonButton
						label={t("previewCommandBarBold")}
						icon={<BoldIcon />}
						disabled={!writable}
						shortcut={<Kbd action="editor.bold" />}
						onClick={run(toggleInlineMarker(MARKDOWN_MARKERS.bold))}
					/>
					<RibbonButton
						label={t("previewCommandBarItalic")}
						icon={<ItalicIcon />}
						disabled={!writable}
						shortcut={<Kbd action="editor.italic" />}
						onClick={run(toggleItalic)}
					/>
					<RibbonButton
						label={t("previewCommandBarStrikethrough")}
						icon={<StrikethroughIcon />}
						disabled={!writable}
						shortcut={<Kbd action="editor.strikethrough" />}
						onClick={run(toggleInlineMarker(MARKDOWN_MARKERS.strikethrough))}
					/>
					<RibbonButton
						label={t("previewCommandBarInlineCode")}
						icon={<CodeIcon />}
						disabled={!writable}
						shortcut={<Kbd action="editor.code" />}
						onClick={run(toggleInlineMarker(MARKDOWN_MARKERS.code))}
					/>
					<RibbonButton
						label={t("previewCommandBarLink")}
						icon={<LinkIcon />}
						disabled={!writable}
						shortcut={<Kbd action="editor.link" />}
						onClick={run(insertLink)}
					/>
				</>
			)
		})
	}

	const fullScreen = fullscreenSupported()

	groups.push({
		id: "view",
		label: t("previewOfficeRibbonTabView"),
		icon: SlidersHorizontalIcon,
		width: 2 * BAR_BUTTON + 3 * BAR_MENU + (fullScreen ? BAR_BUTTON : 0),
		priority: 2,
		content: (
			<>
				<RibbonButton
					label={t("previewCommandBarWrap")}
					icon={<WrapTextIcon />}
					pressed={settings.wrap}
					onClick={() => {
						setCodeViewSettings({ wrap: !settings.wrap })
					}}
				/>
				<RibbonButton
					label={t("previewCommandBarLineNumbers")}
					icon={<ListOrderedIcon />}
					pressed={settings.lineNumbers}
					onClick={() => {
						setCodeViewSettings({ lineNumbers: !settings.lineNumbers })
					}}
				/>
				<DropdownMenu>
					<RibbonMenuTrigger
						label={t("previewCommandBarFontSize", { size: settings.fontSize })}
						icon={<TypeIcon />}
					/>
					<DropdownMenuContent
						align="start"
						data-preview-surface
					>
						<DropdownMenuRadioGroup
							value={String(settings.fontSize)}
							onValueChange={(next: string) => {
								setCodeViewSettings({ fontSize: Number(next) })
							}}
						>
							{CODE_FONT_SIZES.map(size => (
								<DropdownMenuRadioItem
									key={size}
									value={String(size)}
									closeOnClick
								>
									{t("previewCommandBarFontSizeOption", { size })}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
				<DropdownMenu>
					<RibbonMenuTrigger
						label={t("previewCommandBarLanguage")}
						icon={<CodeXmlIcon />}
					/>
					<DropdownMenuContent
						align="start"
						data-preview-surface
						className="max-h-[min(24rem,var(--available-height))] overflow-y-auto"
					>
						<DropdownMenuRadioGroup
							value={language}
							onValueChange={(next: string) => {
								onLanguage(isCodeLanguageId(next) ? next : "")
							}}
						>
							<DropdownMenuRadioItem
								value=""
								closeOnClick
							>
								{t("previewCommandBarPlainText")}
							</DropdownMenuRadioItem>
							{LANGUAGES.map(id => (
								<DropdownMenuRadioItem
									key={id}
									value={id}
									closeOnClick
								>
									{CODE_LANGUAGES[id].name}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
				<DropdownMenu>
					<RibbonMenuTrigger
						label={t("previewCommandBarIndent")}
						icon={<IndentIncreaseIcon />}
					/>
					<DropdownMenuContent
						align="start"
						data-preview-surface
					>
						<DropdownMenuRadioGroup
							value={String(indent)}
							onValueChange={(next: string) => {
								onIndent(CODE_INDENTS.find(option => String(option) === next) ?? indent)
							}}
						>
							{CODE_INDENTS.map(option => (
								<DropdownMenuRadioItem
									key={option}
									value={String(option)}
									closeOnClick
								>
									{indentLabel(option)}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
				{fullScreen ? <FullScreenButton /> : null}
			</>
		)
	})

	const ending =
		format.lineEnding === "crlf"
			? "previewCommandBarEolCrlf"
			: format.lineEnding === "cr"
				? "previewCommandBarEolCr"
				: "previewCommandBarEolLf"

	return (
		<OfficeCommandBar
			label={t("previewOfficeRibbonCommands")}
			file={<DownloadFile onDownload={onDownload} />}
			groups={groups}
			replacement={
				finding ? (
					<CodeFindField
						chrome={chrome}
						locked={locked}
					/>
				) : undefined
			}
			status={
				<span className="flex items-center gap-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">
					<CodePosition chrome={chrome} />
					<span>{languageName}</span>
					<span>{indentLabel(indent)}</span>
					<span>
						<span className="sr-only">{t("previewCommandBarEol", { ending: t(ending) })}</span>
						<span aria-hidden="true">{t(ending)}</span>
					</span>
					<span>{t(format.bom ? "previewCommandBarEncodingBom" : "previewCommandBarEncoding")}</span>
					{editable ? null : (
						<Badge
							variant="outline"
							className="text-muted-foreground"
						>
							<LockIcon data-icon="inline-start" />
							{t("previewCommandBarReadOnly")}
						</Badge>
					)}
				</span>
			}
		/>
	)
}
