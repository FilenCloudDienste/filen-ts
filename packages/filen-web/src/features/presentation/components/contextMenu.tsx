import { useRef, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	BringToFrontIcon,
	CopyPlusIcon,
	EyeOffIcon,
	GroupIcon,
	MousePointerClickIcon,
	PaintBucketIcon,
	PlusIcon,
	RotateCcwIcon,
	SendToBackIcon,
	TextCursorInputIcon,
	TextQuoteIcon,
	Trash2Icon,
	UngroupIcon
} from "lucide-react"
import {
	canGroup,
	canUngroup,
	canZOrder,
	resetSlideOps,
	setLayoutOps,
	zOrderOp,
	type ShapeRef,
	type SlideRef,
	type ZOrder
} from "@filen/office/core/presentation"
import type { PresentationLayoutInfo } from "@filen/office/dom/presentation"
import { boundsOf, slideShapes } from "@filen/office/react/presentation"
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
import { contextMenuPoint, isContextMenuKey } from "@/features/presentation/components/contextMenu.logic"
import { isTextField, layoutLabel, layoutsByMaster } from "@/features/presentation/components/deckChrome.logic"
import { BackgroundDialog } from "@/features/presentation/components/design/backgroundDialog"
import { actionDialog, altTextDialog, runGrouping, useArrange } from "@/features/presentation/components/ribbon/arrange"
import { useRibbonDialog } from "@/features/presentation/components/ribbon/ribbonDialogs"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
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
					{layoutLabel(t, layout)}
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

// ---- the slide canvas ---------------------------------------------------------------------------------------------

// The slide's context menu (right click, a long press on touch, Shift+F10 or the Menu key), as PowerPoint's: on
// shapes (the selection layer selects what a right click lands on first) Edit Text, Group, the stacking order, Alt
// Text and Action; on the slide itself New Slide, Layout, Reset Slide and Format Background, on the slide in view. A
// body being edited and the fields keep the browser's own menu (its spelling suggestions). No menu in a deck that
// can only be viewed, nor while the show runs.

const Z_FRONT: readonly { readonly to: ZOrder; readonly label: "previewPptxBringToFront" | "previewPptxBringForward" }[] = [
	{ to: "front", label: "previewPptxBringToFront" },
	{ to: "forward", label: "previewPptxBringForward" }
]
const Z_BACK: readonly { readonly to: ZOrder; readonly label: "previewPptxSendToBack" | "previewPptxSendBackward" }[] = [
	{ to: "back", label: "previewPptxSendToBack" },
	{ to: "backward", label: "previewPptxSendBackward" }
]

// A press in a body being edited or in a field: the browser's menu there.
function inText(target: EventTarget | null): boolean {
	return isTextField(target) || (target instanceof Element && target.closest("[data-fo-text-editor]") !== null)
}

// How long after a key opened the menu the browser's own menu event for that key is still taken as its echo.
const KEY_ECHO_MS = 1000

// The menu's items; their dialogs show in the ribbon's dialog host, which outlives the menu.
function CanvasMenuItems({ ribbon, onEditText }: { ribbon: PresentationRibbonEditor; onEditText: () => void }) {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()
	const openDialog = useRibbonDialog(ribbon).open
	const { slide, selected, ids, order, run } = useArrange(ribbon)

	if (scope === undefined) return null

	const { editor } = scope
	const current = editor.currentRef

	if (slide !== undefined && selected.length > 0) {
		const only = selected.length === 1 ? selected[0] : undefined
		const chosen = new Set(ids)
		const zItems = (items: typeof Z_FRONT | typeof Z_BACK) =>
			items.map(item => (
				<ContextMenuItem
					key={item.to}
					disabled={!canZOrder(order, chosen, item.to)}
					onClick={() => {
						run(zOrderOp(slide, ids, item.to))
					}}
				>
					{t(item.label)}
				</ContextMenuItem>
			))

		return (
			<>
				{only !== undefined && (only.role === "shape" || only.role === "placeholder") ? (
					<>
						<ContextMenuItem
							onClick={() => {
								onEditText()
							}}
						>
							<TextCursorInputIcon />
							{t("previewPptxEditorMenuEditText")}
						</ContextMenuItem>
						<ContextMenuSeparator />
					</>
				) : null}
				<ContextMenuSub>
					<ContextMenuSubTrigger disabled={!canGroup(selected) && !canUngroup(selected)}>
						<GroupIcon />
						{t("previewPptxGroup")}
					</ContextMenuSubTrigger>
					<ContextMenuSubContent data-preview-surface>
						<ContextMenuItem
							disabled={!canGroup(selected)}
							onClick={() => {
								runGrouping(ribbon, slide, selected, order, "group")
							}}
						>
							<GroupIcon />
							{t("previewPptxGroup")}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={!canUngroup(selected)}
							onClick={() => {
								runGrouping(ribbon, slide, selected, order, "ungroup")
							}}
						>
							<UngroupIcon />
							{t("previewPptxUngroup")}
						</ContextMenuItem>
					</ContextMenuSubContent>
				</ContextMenuSub>
				<ContextMenuSub>
					<ContextMenuSubTrigger disabled={Z_FRONT.every(item => !canZOrder(order, chosen, item.to))}>
						<BringToFrontIcon />
						{t("previewPptxBringToFront")}
					</ContextMenuSubTrigger>
					<ContextMenuSubContent data-preview-surface>{zItems(Z_FRONT)}</ContextMenuSubContent>
				</ContextMenuSub>
				<ContextMenuSub>
					<ContextMenuSubTrigger disabled={Z_BACK.every(item => !canZOrder(order, chosen, item.to))}>
						<SendToBackIcon />
						{t("previewPptxSendToBack")}
					</ContextMenuSubTrigger>
					<ContextMenuSubContent data-preview-surface>{zItems(Z_BACK)}</ContextMenuSubContent>
				</ContextMenuSub>
				<ContextMenuSeparator />
				<ContextMenuItem
					disabled={only === undefined}
					onClick={() => {
						if (only !== undefined) openDialog(altTextDialog(only, slide))
					}}
				>
					<TextQuoteIcon />
					{t("previewPptxAltText")}
				</ContextMenuItem>
				<ContextMenuItem
					disabled={only === undefined}
					onClick={() => {
						if (only !== undefined) openDialog(actionDialog(only, slide))
					}}
				>
					<MousePointerClickIcon />
					{t("previewPptxAction")}
				</ContextMenuItem>
			</>
		)
	}

	const deckOrder = editor.document.slides.map(entry => entry.ref)
	const onSlide = current === undefined ? [] : [current]

	return (
		<>
			<ContextMenuItem
				disabled={editor.layouts.length === 0}
				onClick={() => {
					editor.slides.add()
				}}
			>
				<PlusIcon />
				{t("previewPptxEditorMenuNewSlide")}
			</ContextMenuItem>
			<ContextMenuSub>
				<ContextMenuSubTrigger disabled={current === undefined || editor.layouts.length === 0}>
					{t("previewPptxEditorMenuLayout")}
				</ContextMenuSubTrigger>
				<ContextMenuSubContent
					data-preview-surface
					className="max-h-[min(28rem,var(--available-height))] overflow-y-auto"
				>
					<LayoutSubItems
						layouts={editor.layouts}
						checked={editor.currentLayout}
						onChoose={layout => {
							void editor.run(setLayoutOps(deckOrder, onSlide, layout))
						}}
					/>
				</ContextMenuSubContent>
			</ContextMenuSub>
			<ContextMenuItem
				disabled={current === undefined}
				onClick={() => {
					void editor.run(resetSlideOps(deckOrder, onSlide))
				}}
			>
				<RotateCcwIcon />
				{t("previewPptxEditorMenuReset")}
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				disabled={current === undefined}
				onClick={() => {
					openDialog((_live, close) => (
						<BackgroundDialog
							open
							onOpenChange={next => {
								if (!next) close()
							}}
						/>
					))
				}}
			>
				<PaintBucketIcon />
				{t("previewPptxDesignFormatBackground")}
			</ContextMenuItem>
		</>
	)
}

// Always this one tree around the canvas (it stays mounted as the session arrives); disabled, the browser's menu.
export function SlideCanvasContextMenu({
	editor: ribbon,
	disabled,
	onEditText,
	children
}: {
	// The slide's editor (undefined until the deck has a session).
	editor: PresentationRibbonEditor | undefined
	// The show is running.
	disabled: boolean
	onEditText: (shape: ShapeRef) => void
	children: ReactNode
}) {
	const editable = usePresentationEditor()?.editor.editable === true
	// The menu event a key dispatched, and when the key was pressed (the browser may send its own event for it).
	const ownRef = useRef<Event | null>(null)
	const keyedRef = useRef<number | undefined>(undefined)
	// Edit Text gives focus to the body: the closing menu gives none back.
	const keepFocusRef = useRef(false)
	const inside = (event: { readonly currentTarget: Element; readonly target: EventTarget }): boolean =>
		event.target instanceof Node && event.currentTarget.contains(event.target)

	return (
		<ContextMenu
			disabled={disabled || !editable || ribbon === undefined}
			onOpenChange={open => {
				if (open) keepFocusRef.current = false
			}}
		>
			<ContextMenuTrigger
				render={<div className="contents" />}
				onKeyDown={event => {
					if (
						ribbon === undefined ||
						!editable ||
						disabled ||
						event.defaultPrevented ||
						!isContextMenuKey(event) ||
						!inside(event) ||
						inText(event.target)
					)
						return

					event.preventDefault()

					const trigger = event.currentTarget
					const frame = trigger.querySelector(".fo-slide-frame") ?? trigger.firstElementChild
					const render = ribbon.render
					const state = ribbon.selection.getSnapshot()
					const ids = new Set(render?.ref === state.slide ? state.ids : [])
					const bounds = slideShapes(render)
						.filter(shape => ids.has(shape.id))
						.map(shape => boundsOf(shape.xfrm))

					const at = contextMenuPoint(
						frame?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 },
						ribbon.info.size,
						bounds
					)
					const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y })

					keyedRef.current = event.timeStamp
					ownRef.current = menu
					trigger.dispatchEvent(menu)
					ownRef.current = null
				}}
				onContextMenuCapture={event => {
					const keyed = keyedRef.current

					// The browser's own event for the key that opened the menu: the menu is open where the key put it.
					if (event.nativeEvent !== ownRef.current && keyed !== undefined && event.timeStamp - keyed < KEY_ECHO_MS) {
						keyedRef.current = undefined
						event.preventDefault()
						event.stopPropagation()
					}
				}}
				onContextMenu={event => {
					if (ribbon === undefined || !editable || disabled || !inside(event)) return

					if (inText(event.target)) {
						// Kept from the menu's handler and from its listener on the document.
						event.preventBaseUIHandler()
						event.stopPropagation()

						return
					}

					// Beside the slide (outside the selection layer): the slide's menu, as on empty slide.
					if (
						event.nativeEvent !== ownRef.current &&
						event.target instanceof Element &&
						event.target.closest("[data-fo-shape-edit]") === null
					)
						ribbon.selection.clear()
				}}
				onTouchStart={event => {
					if (inText(event.target)) event.preventBaseUIHandler()
				}}
			>
				{children}
			</ContextMenuTrigger>
			<ContextMenuContent
				data-preview-surface
				finalFocus={() => !keepFocusRef.current}
			>
				{ribbon === undefined ? null : (
					<CanvasMenuItems
						ribbon={ribbon}
						onEditText={() => {
							const state = ribbon.selection.getSnapshot()
							const id = state.ids.length === 1 ? state.ids[0] : undefined

							if (state.slide === undefined || id === undefined) return

							keepFocusRef.current = true
							onEditText({ slide: state.slide, id })
						}}
					/>
				)}
			</ContextMenuContent>
		</ContextMenu>
	)
}
