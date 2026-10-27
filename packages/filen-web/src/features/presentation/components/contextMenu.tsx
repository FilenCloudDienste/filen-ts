import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CopyPlusIcon, EyeOffIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import type { SlideRef } from "@filen/office/core/presentation"
import type { PresentationLayoutInfo } from "@filen/office/dom/presentation"
import {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger
} from "@/components/ui/context-menu"
import { layoutsByMaster } from "@/features/presentation/components/deckChrome.logic"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import { presentationShortcutKeys } from "@/features/presentation/lib/keymap/editor"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { useOverrides } from "@/lib/keymap/registry"

// The slide list's context menu (right click, or a long press on touch): the slide commands on the selection, as in
// PowerPoint's slide pane: New, Duplicate, Delete, Layout, Reset, Hide, Move (the way touch moves slides) and the
// sections. A right click on a slide outside the selection selects it first. A deck that can only be viewed has no
// menu here.

const MAC = isMacPlatform()

// Plain text at the item's end, as shadcn's menu shortcut: a key chip on the glass menu over a slide is too faint.
function Shortcut({ keys }: { keys: readonly string[] }) {
	return <span className="ml-auto pl-4 text-xs tracking-widest text-muted-foreground">{keys.join(MAC ? "" : "+")}</span>
}

function LayoutSubItems({
	layouts,
	checked,
	onChoose
}: {
	layouts: readonly PresentationLayoutInfo[]
	checked: SlideRef | undefined
	onChoose: (layout: SlideRef) => void
}) {
	const { t } = useTranslation("preview")
	const groups = layoutsByMaster(layouts)

	return groups.map((group, index) => (
		<ContextMenuGroup key={group.master}>
			{index > 0 ? <ContextMenuSeparator /> : null}
			{groups.length > 1 ? <ContextMenuLabel>{t("previewPptxRibbonMasterNumber", { number: index + 1 })}</ContextMenuLabel> : null}
			{group.layouts.map(layout => (
				<ContextMenuCheckboxItem
					key={layout.ref}
					closeOnClick
					checked={layout.ref === checked}
					onCheckedChange={() => {
						onChoose(layout.ref)
					}}
				>
					{layout.name ?? t("previewPptxRibbonLayoutNumber", { number: layout.number })}
				</ContextMenuCheckboxItem>
			))}
		</ContextMenuGroup>
	))
}

export function SlideListContextMenu({ children }: { children: ReactNode }) {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()
	const overrides = useOverrides()

	if (scope?.editor.editable !== true) return children

	const { editor, view } = scope
	const slides = editor.slides
	const any = editor.selection.length > 0
	const index = editor.current
	const count = editor.document.slides.length
	const hidden = editor.document.slides.some(slide => slide.hidden && editor.selection.includes(slide.ref))
	const pptx = editor.document.info?.format === "pptx"
	const firstSelected = editor.document.slides.findIndex(slide => editor.selection.includes(slide.ref))
	const lastSelected = count - 1 - [...editor.document.slides].reverse().findIndex(slide => editor.selection.includes(slide.ref))

	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={<div className="contents" />}
				onContextMenu={event => {
					// The slide right-clicked joins the selection's place, as a click would select it.
					const item = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-fo-index]") : null
					const at = Number(item?.dataset["foIndex"] ?? Number.NaN)

					if (Number.isInteger(at) && !editor.selectedIndices.has(at)) editor.go(at)
				}}
			>
				{children}
			</ContextMenuTrigger>
			<ContextMenuContent data-preview-surface>
				<ContextMenuItem
					disabled={editor.layouts.length === 0}
					onClick={() => {
						slides.add()
					}}
				>
					<PlusIcon />
					{t("previewPptxEditorMenuNewSlide")}
					<Shortcut keys={presentationShortcutKeys("presentation.newSlide", overrides)} />
				</ContextMenuItem>
				<ContextMenuItem
					disabled={!any}
					onClick={slides.duplicate}
				>
					<CopyPlusIcon />
					{t("previewPptxEditorMenuDuplicate")}
					<Shortcut keys={presentationShortcutKeys("presentation.duplicateSlide", overrides)} />
				</ContextMenuItem>
				<ContextMenuItem
					disabled={!any}
					onClick={slides.remove}
				>
					<Trash2Icon />
					{t("previewPptxEditorMenuDelete")}
					<Shortcut keys={presentationShortcutKeys("presentation.deleteSlide", overrides)} />
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuSub>
					<ContextMenuSubTrigger disabled={!any || editor.layouts.length === 0}>
						{t("previewPptxEditorMenuLayout")}
					</ContextMenuSubTrigger>
					<ContextMenuSubContent
						data-preview-surface
						className="max-h-[min(28rem,var(--available-height))] overflow-y-auto"
					>
						<LayoutSubItems
							layouts={editor.layouts}
							checked={editor.currentLayout}
							onChoose={slides.setLayout}
						/>
					</ContextMenuSubContent>
				</ContextMenuSub>
				<ContextMenuItem
					disabled={!any}
					onClick={slides.reset}
				>
					<RotateCcwIcon />
					{t("previewPptxEditorMenuReset")}
				</ContextMenuItem>
				<ContextMenuCheckboxItem
					closeOnClick
					disabled={!any}
					checked={hidden}
					onCheckedChange={slides.toggleHidden}
				>
					<EyeOffIcon />
					{t("previewPptxEditorMenuHide")}
				</ContextMenuCheckboxItem>
				<ContextMenuSub>
					<ContextMenuSubTrigger disabled={!any || count < 2}>{t("previewPptxEditorMenuMove")}</ContextMenuSubTrigger>
					<ContextMenuSubContent data-preview-surface>
						<ContextMenuItem
							disabled={firstSelected <= 0}
							onClick={() => {
								slides.nudge("first")
							}}
						>
							{t("previewPptxEditorMenuMoveFirst")}
							<Shortcut keys={presentationShortcutKeys("presentation.moveSlideFirst", overrides)} />
						</ContextMenuItem>
						<ContextMenuItem
							disabled={firstSelected <= 0}
							onClick={() => {
								slides.nudge(-1)
							}}
						>
							{t("previewPptxEditorMenuMoveUp")}
							<Shortcut keys={presentationShortcutKeys("presentation.moveSlideUp", overrides)} />
						</ContextMenuItem>
						<ContextMenuItem
							disabled={lastSelected >= count - 1}
							onClick={() => {
								slides.nudge(1)
							}}
						>
							{t("previewPptxEditorMenuMoveDown")}
							<Shortcut keys={presentationShortcutKeys("presentation.moveSlideDown", overrides)} />
						</ContextMenuItem>
						<ContextMenuItem
							disabled={lastSelected >= count - 1}
							onClick={() => {
								slides.nudge("last")
							}}
						>
							{t("previewPptxEditorMenuMoveLast")}
							<Shortcut keys={presentationShortcutKeys("presentation.moveSlideLast", overrides)} />
						</ContextMenuItem>
					</ContextMenuSubContent>
				</ContextMenuSub>
				{pptx ? (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem
							disabled={index < 0 || count === 0}
							onClick={() => {
								view.askSection("add")
							}}
						>
							{t("previewPptxEditorAddSection")}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={slides.section === undefined}
							onClick={() => {
								view.askSection("rename")
							}}
						>
							{t("previewPptxEditorRenameSection")}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={slides.section === undefined}
							onClick={slides.removeSection}
						>
							{t("previewPptxEditorRemoveSection")}
						</ContextMenuItem>
					</>
				) : null}
			</ContextMenuContent>
		</ContextMenu>
	)
}
