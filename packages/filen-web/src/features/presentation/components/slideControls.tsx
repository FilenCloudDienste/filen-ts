import { useTranslation } from "react-i18next"
import {
	ChevronDownIcon,
	CopyPlusIcon,
	EyeOffIcon,
	LayoutTemplateIcon,
	PanelLeftIcon,
	PlusIcon,
	Redo2Icon,
	SearchIcon,
	RotateCcwIcon,
	SquareSplitVerticalIcon,
	StickyNoteIcon,
	Trash2Icon,
	Undo2Icon
} from "lucide-react"
import type { SlideRef } from "@filen/office/core/presentation"
import type { PresentationLayoutInfo } from "@filen/office/dom/presentation"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { keepFocus } from "@/features/office/lib/officeControls"
import { layoutLabel, layoutsByMaster } from "@/features/presentation/components/deckChrome.logic"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import { presentationShortcutKeys } from "@/features/presentation/lib/keymap/editor"
import { Kbd, KbdKeys } from "@/lib/keymap/kbd"
import { useOverrides } from "@/lib/keymap/registry"

// The presentation editor's own ribbon controls (the Home, Insert and View group files list them): Undo and Redo,
// New slide with its layout menu, Layout, Section, Reset, Duplicate, Delete and Hide, and the panes. Each reads the
// editor where it renders (PresentationEditorContext), so a group file stays a pure list of groups.

export function UndoControls() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()
	const overrides = useOverrides()

	if (scope === undefined) return null

	const { editor } = scope

	return (
		<>
			<TooltipIconButton
				label={t("previewPptxRibbonUndo")}
				disabled={!editor.canUndo}
				shortcut={<KbdKeys keys={presentationShortcutKeys("presentation.undo", overrides)} />}
				onMouseDown={keepFocus}
				onClick={editor.undo}
			>
				<Undo2Icon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewPptxRibbonRedo")}
				disabled={!editor.canRedo}
				shortcut={<KbdKeys keys={presentationShortcutKeys("presentation.redo", overrides)} />}
				onMouseDown={keepFocus}
				onClick={editor.redo}
			>
				<Redo2Icon />
			</TooltipIconButton>
		</>
	)
}

// The deck's layouts by master: a heading per master when there are several.
function LayoutItems({
	layouts,
	onChoose,
	checked
}: {
	layouts: readonly PresentationLayoutInfo[]
	onChoose: (layout: SlideRef) => void
	// A radio list with this layout checked; absent: plain items.
	checked?: SlideRef | undefined
}) {
	const { t } = useTranslation("preview")
	const groups = layoutsByMaster(layouts)

	return groups.map((group, index) => (
		<DropdownMenuGroup key={group.master}>
			{index > 0 ? <DropdownMenuSeparator /> : null}
			{groups.length > 1 ? <DropdownMenuLabel>{t("previewPptxRibbonMasterNumber", { number: index + 1 })}</DropdownMenuLabel> : null}
			{checked === undefined ? (
				group.layouts.map(layout => (
					<DropdownMenuItem
						key={layout.ref}
						onClick={() => {
							onChoose(layout.ref)
						}}
					>
						{layoutLabel(t, layout)}
					</DropdownMenuItem>
				))
			) : (
				<DropdownMenuRadioGroup
					value={String(checked)}
					onValueChange={(value: string) => {
						const chosen = group.layouts.find(layout => String(layout.ref) === value)

						if (chosen !== undefined) onChoose(chosen.ref)
					}}
				>
					{group.layouts.map(layout => (
						<DropdownMenuRadioItem
							key={layout.ref}
							value={String(layout.ref)}
							closeOnClick
						>
							{layoutLabel(t, layout)}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			)}
		</DropdownMenuGroup>
	))
}

// New slide (PowerPoint's split button): the button adds a slide on the layout PowerPoint picks, the arrow lists the
// layouts.
export function NewSlideControl() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()
	const overrides = useOverrides()

	if (scope === undefined) return null

	const { editor } = scope
	const disabled = !editor.editable || editor.layouts.length === 0

	return (
		<span className="flex shrink-0 items-center">
			<RibbonButton
				label={t("previewPptxRibbonNewSlide")}
				icon={<PlusIcon />}
				text={t("previewPptxRibbonNewSlide")}
				disabled={disabled}
				shortcut={<KbdKeys keys={presentationShortcutKeys("presentation.newSlide", overrides)} />}
				onClick={() => {
					editor.slides.add()
				}}
			/>
			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger
						render={
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={t("previewPptxRibbonNewSlideLayout")}
										disabled={disabled}
										className="w-5 shrink-0"
										onMouseDown={keepFocus}
									>
										<ChevronDownIcon className="size-3" />
									</Button>
								}
							/>
						}
					/>
					<TooltipContent>{t("previewPptxRibbonNewSlideLayout")}</TooltipContent>
				</Tooltip>
				<DropdownMenuContent
					align="start"
					data-preview-surface
					className="max-h-[min(28rem,var(--available-height))] overflow-y-auto"
				>
					<LayoutItems
						layouts={editor.layouts}
						onChoose={layout => {
							editor.slides.add(layout)
						}}
					/>
				</DropdownMenuContent>
			</DropdownMenu>
		</span>
	)
}

export function LayoutMenu() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()

	if (scope === undefined) return null

	const { editor } = scope

	return (
		<DropdownMenu>
			<RibbonMenuTrigger
				label={t("previewPptxRibbonLayout")}
				icon={<LayoutTemplateIcon />}
				disabled={!editor.editable || editor.layouts.length === 0 || editor.selection.length === 0}
			/>
			<DropdownMenuContent
				align="start"
				data-preview-surface
				className="max-h-[min(28rem,var(--available-height))] overflow-y-auto"
			>
				<LayoutItems
					layouts={editor.layouts}
					checked={editor.currentLayout ?? editor.layouts[0]?.ref}
					onChoose={layout => {
						editor.slides.setLayout(layout)
					}}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// Add, rename and remove a section.
function SectionItems() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()

	if (scope === undefined) return null

	const { editor, view } = scope
	const section = editor.slides.section

	return (
		<>
			<DropdownMenuItem
				disabled={editor.document.slides.length === 0}
				onClick={() => {
					view.askSection("add")
				}}
			>
				{t("previewPptxEditorAddSection")}
			</DropdownMenuItem>
			<DropdownMenuItem
				disabled={section === undefined}
				onClick={() => {
					view.askSection("rename")
				}}
			>
				{t("previewPptxEditorRenameSection")}
			</DropdownMenuItem>
			<DropdownMenuItem
				disabled={section === undefined}
				onClick={editor.slides.removeSection}
			>
				{t("previewPptxEditorRemoveSection")}
			</DropdownMenuItem>
		</>
	)
}

export function SectionMenu() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()

	// Sections are a PresentationML feature: an OpenDocument presentation has none.
	if (scope === undefined || scope.editor.document.info?.format !== "pptx") return null

	return (
		<DropdownMenu>
			<RibbonMenuTrigger
				label={t("previewPptxRibbonSection")}
				icon={<SquareSplitVerticalIcon />}
				disabled={!scope.editor.editable}
			/>
			<DropdownMenuContent
				align="start"
				data-preview-surface
			>
				<SectionItems />
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function SlideButtons() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()
	const overrides = useOverrides()

	if (scope === undefined) return null

	const { editor } = scope
	const none = !editor.editable || editor.selection.length === 0
	const hidden = editor.document.slides.some(slide => slide.hidden && editor.selection.includes(slide.ref))

	return (
		<>
			<TooltipIconButton
				label={t("previewPptxRibbonReset")}
				disabled={none}
				onMouseDown={keepFocus}
				onClick={editor.slides.reset}
			>
				<RotateCcwIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewPptxRibbonDuplicate")}
				disabled={none}
				shortcut={<KbdKeys keys={presentationShortcutKeys("presentation.duplicateSlide", overrides)} />}
				onMouseDown={keepFocus}
				onClick={editor.slides.duplicate}
			>
				<CopyPlusIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewPptxRibbonDelete")}
				disabled={none}
				shortcut={<KbdKeys keys={presentationShortcutKeys("presentation.deleteSlide", overrides)} />}
				onMouseDown={keepFocus}
				onClick={editor.slides.remove}
			>
				<Trash2Icon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewPptxRibbonHide")}
				disabled={none}
				pressed={hidden}
				onMouseDown={keepFocus}
				onClick={editor.slides.toggleHidden}
			>
				<EyeOffIcon />
			</TooltipIconButton>
		</>
	)
}

export function PaneToggles() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()

	if (scope === undefined) return null

	const { view, editor } = scope
	const empty = editor.document.slides.length === 0

	return (
		<>
			<RibbonButton
				label={t("previewPptxRailToggle")}
				icon={<PanelLeftIcon />}
				disabled={empty}
				pressed={view.railOpen}
				onClick={view.toggleRail}
			/>
			<RibbonButton
				label={t(view.notesOpen ? "previewPptxNotesHide" : "previewPptxNotesShow")}
				icon={<StickyNoteIcon />}
				disabled={empty}
				pressed={view.notesOpen}
				onClick={view.toggleNotes}
			/>
		</>
	)
}

// Find ▾ (Home ▸ Editing, as the document editor's): find, or find and replace, in the field over the command row.
export function FindMenu() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()

	if (scope === undefined) return null

	const { view } = scope

	return (
		<DropdownMenu>
			<RibbonMenuTrigger
				label={t("previewPptxFindAction")}
				icon={<SearchIcon />}
				shortcut={<Kbd action="editor.find" />}
			/>
			<DropdownMenuContent data-preview-surface>
				<DropdownMenuItem
					onClick={() => {
						view.openFind(false)
					}}
				>
					{t("previewPptxFindAction")}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => {
						view.openFind(true)
					}}
				>
					{t("previewPptxFindReplaceAction")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
