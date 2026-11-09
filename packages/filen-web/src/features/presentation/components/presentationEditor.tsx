import { startTransition, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { toast } from "sonner"
import { EyeIcon, PresentationIcon } from "lucide-react"
import { addSlideOp, type ShapeRef, type SlideRef } from "@filen/office/core/presentation"
import {
	createShapeSelection,
	createTextEditing,
	firstPlaceholder,
	paintEditorSlide,
	paintSlide,
	PresentationTextEditor,
	selectedShapes,
	selectionKinds,
	SlideView,
	useShapeSelection,
	type PresentationDocument,
	type PresentationStore,
	type ShapeSelection,
	type TextEditing,
	type TextNavigation
} from "@filen/office/react/presentation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { InputDialog } from "@/components/dialogs/inputDialog"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { OfficeRibbon, type RibbonGroup, type RibbonTab } from "@/features/office/components/ribbon/officeRibbon"
import { usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"
import { onRibbonEscape, ribbonLanding } from "@/features/office/components/ribbon/ribbonFocus"
import { keepFocus } from "@/features/office/lib/officeControls"
import { usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { SlideCanvasContextMenu, SlideListContextMenu } from "@/features/presentation/components/contextMenu"
import { DeckNotes } from "@/features/presentation/components/deckChrome"
import {
	actionLabel,
	DEFAULT_SLIDE_SIZE,
	isTextField,
	onPageKey,
	presentationViewOnlyReasons,
	viewOnlyKey,
	type PresentationViewOnlyReason
} from "@/features/presentation/components/deckChrome.logic"
import { LegacyPresentationBar, type LegacySaveCopy } from "@/features/presentation/components/legacyView"
import { PresentationNotesPane } from "@/features/presentation/components/notesPane"
import { SmartArtPrompts, SmartArtTextPane } from "@/features/presentation/components/smartartTextPane"
import { AnimationPane, AnimationPreview } from "@/features/presentation/components/animationPane"
import { PresentationCommentsPane } from "@/features/presentation/components/commentsPane"
import { SelectionPane } from "@/features/presentation/components/selectionPane"
import { createSelectionPane, type SelectionPaneStore } from "@/features/presentation/lib/selectionPane"
import { PresentationFileMenu } from "@/features/presentation/components/presentationFileMenu"
import { usePresentationFind } from "@/features/presentation/components/presentationFind"
import { PresentationMediaFrames } from "@/features/presentation/components/mediaFrame"
import { PresentationShapeLayer } from "@/features/presentation/components/ribbon/arrange"
import { ribbonSlide } from "@/features/presentation/lib/ribbonSlide"
import { usePresentationPictureDrop, usePresentationPictures } from "@/features/presentation/components/ribbon/insertObjects"
import { usePresentationClipboard } from "@/features/presentation/hooks/usePresentationClipboard"
import { fileSource } from "@/features/preview/lib/docxImages"
import { PresentationTableRange, tableCellAt } from "@/features/presentation/components/ribbon/table"
import { presentationTextLabels } from "@/features/presentation/components/ribbon/homeText.logic"
import { TextLinkHost } from "@/features/presentation/components/ribbon/homeTextControls"
import { RibbonDialogsHost } from "@/features/presentation/components/ribbon/ribbonDialogs"
import { PresentationSlideRail } from "@/features/presentation/components/slideRail"
import {
	presentationTabGroups,
	presentationTabs,
	type PresentationContextualTabId,
	type PresentationRibbonContext,
	type PresentationRibbonEditor,
	type PresentationSelectionKind,
	type PresentationTabId
} from "@/features/presentation/components/ribbon/tabs"
import {
	PresentationEditorContext,
	refusalKey,
	usePresentationSession,
	type PresentationEditing,
	type PresentationEditor as Editor,
	type PresentationEditorScope
} from "@/features/presentation/hooks/usePresentationSession"
import { useDeckPresentation, type DeckKeyEvent } from "@/features/presentation/hooks/useDeckPresentation"
import { presentationEditorKey } from "@/features/presentation/lib/keymap/editor"
import {
	presentationWheelZoom,
	presentationZoom,
	type PresentationZoom,
	type PresentationZoomChange
} from "@/features/presentation/lib/zoom"
import { useLatestRef } from "@/lib/useLatestRef"
import { PresentationStatusZoom } from "@/features/presentation/components/ribbon/view"
import { usePresentationTextBindings } from "@/features/presentation/lib/keymap/text"
import { DocxFindField } from "@/features/preview/components/docxToolbar"
import { keyForEditor } from "@/lib/keymap/dialogGuard"
import { useEditorLayerKeys } from "@/lib/keymap/editorLayerKeys"
import { useOverrides } from "@/lib/keymap/registry"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"
import type { PreviewKey } from "@/lib/i18n"
import { PresentationMotionPaths } from "@/features/presentation/components/ribbon/motionPaths"

// The presentation editor: the ribbon (File, then the tabs whose groups the deck offers: in a deck that can only be
// viewed that is the View tab and the read-only groups of others), the slide list with its edit commands (selection,
// drag, keys, context menu, section headers), the slide and its notes. Commands are ops the presentation worker
// applies; the overlay saves (Mod+S, File ▸ Save, autosave by the deck's size, lib/autosavePolicy.ts) and the worker
// streams the package to the upload, so no deck is ever whole on this page.

export interface PresentationEditorProps {
	store: PresentationStore
	document: PresentationDocument
	alt: string
	item: DriveItem
	variant: DriveVariant | undefined
	editing: PresentationEditing
	// Save as .pptx of a PowerPoint 97–2003 deck, where a copy may be saved beside the file.
	saveCopy?: LegacySaveCopy | undefined
}

function ViewOnlyBadge({ reasons }: { reasons: readonly PresentationViewOnlyReason[] }) {
	const { t } = useTranslation("preview")

	return (
		<Popover>
			<Badge
				variant="outline"
				className="cursor-pointer text-muted-foreground hover:bg-muted"
				render={<PopoverTrigger aria-label={t("previewPptxEditorViewOnly")} />}
			>
				<EyeIcon data-icon="inline-start" />
				<span className="max-sm:hidden">{t("previewPptxEditorViewOnly")}</span>
			</Badge>
			<PopoverContent
				align="end"
				className="gap-2"
			>
				<p className="font-medium">{t("previewPptxEditorViewOnlyTitle")}</p>
				<ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
					{reasons.map(reason => (
						<li key={reason}>{t(viewOnlyKey(reason))}</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	)
}

// Unsaved changes, or the save under way: always shown while either holds (PowerPoint's save state).
function SaveState({ saving, dirty }: { saving: boolean; dirty: boolean }) {
	const { t } = useTranslation("preview")

	if (saving) {
		return (
			<span
				role="status"
				className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
			>
				<Spinner className="size-3" />
				<span className="max-sm:hidden">{t("previewPptxEditorSaving")}</span>
			</span>
		)
	}

	if (!dirty) return null

	return (
		<span
			role="status"
			className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
			title={t("previewPptxEditorUnsaved")}
		>
			<span
				aria-hidden="true"
				className="size-2 rounded-full bg-primary"
			/>
			<span className="max-sm:sr-only">{t("previewPptxEditorUnsaved")}</span>
		</span>
	)
}

const TAB_LABELS: Record<PresentationTabId | PresentationContextualTabId, PreviewKey> = {
	home: "previewOfficeRibbonTabHome",
	insert: "previewOfficeRibbonTabInsert",
	design: "previewPptxRibbonTabDesign",
	transitions: "previewPptxRibbonTabTransitions",
	animations: "previewPptxRibbonTabAnimations",
	slideShow: "previewPptxRibbonTabSlideShow",
	review: "previewOfficeRibbonTabReview",
	view: "previewOfficeRibbonTabView",
	arrange: "previewPptxRibbonTabArrange",
	shapeFormat: "previewPptxRibbonTabShapeFormat",
	picture: "previewPptxRibbonTabPicture",
	table: "previewPptxRibbonTabTable",
	chart: "previewPptxRibbonTabChart",
	video: "previewPptxRibbonTabVideo",
	audio: "previewPptxRibbonTabAudio",
	smartartDesign: "previewPptxRibbonTabSmartArtDesign",
	smartartFormat: "previewPptxRibbonTabSmartArtFormat"
}

const NO_KINDS: ReadonlySet<PresentationSelectionKind> = new Set()
const NO_GROUPS: readonly RibbonGroup[] = []

// The ribbon, its own component with props that hold still while the user pages slides: the slide in view reaches it
// only while shapes on it are selected (`render`, what its commands act on), so a slide switch with nothing selected
// gives its groups the same context and the whole command row is skipped. `commands` false: the command row's groups
// are not mounted yet (the first mount paints the slide and the rail first).
function PresentationRibbon({
	editable,
	info,
	session,
	render,
	kinds,
	shapes,
	command,
	text,
	tab,
	onTab,
	commands,
	file,
	status,
	replacement
}: {
	editable: boolean
	info: PresentationDocument["info"]
	session: PresentationDocument["session"]
	render: PresentationRibbonEditor["render"]
	// What the selection holds (the constant empty set while nothing is selected).
	kinds: ReadonlySet<PresentationSelectionKind>
	shapes: ShapeSelection
	command: PresentationRibbonEditor["command"]
	text: TextEditing
	tab: string
	onTab: (tab: string) => void
	commands: boolean
	file: ReactNode
	status: ReactNode
	replacement: ReactNode
}) {
	const { t } = useTranslation("preview")
	// The context's: the default namespace's, as the group files are given it (they pass ns: "preview").
	const { t: groupT } = useTranslation()
	const phone = usePhoneWidth()
	// A text ribbon editor too (TextLinkHost): its text store is always there.
	const editor = info === undefined || session === undefined ? undefined : { info, render, selection: shapes, command, session, text }
	const context: PresentationRibbonContext = {
		editable,
		phone,
		selection: kinds,
		t: groupT,
		...(editor === undefined ? {} : { editor })
	}
	// A tab with nothing to offer here (its slice has no commands yet, or none for a deck that can only be viewed) is
	// not shown.
	const shownTabs = presentationTabs(context).filter(shown => presentationTabGroups(shown, context).length > 0)
	const tabs: RibbonTab[] = shownTabs.map(shown => ({
		id: shown.id,
		label: t(TAB_LABELS[shown.id]),
		...("selection" in shown ? { contextual: true } : {})
	}))
	const active = shownTabs.find(shown => shown.id === tab) ?? shownTabs[0]
	const groups = active === undefined || !commands ? NO_GROUPS : presentationTabGroups(active, context)

	return (
		<>
			<OfficeRibbon
				label={t("previewOfficeRibbon")}
				commandsLabel={t("previewOfficeRibbonCommands")}
				tabs={tabs}
				tab={active?.id ?? ""}
				onTab={onTab}
				file={file}
				status={status}
				groups={groups}
				replacement={replacement}
			/>
			{/* The body's link key (Mod+K) opens the link dialog, as the ribbon's Link does. */}
			{editor === undefined || !editable ? null : (
				<TextLinkHost
					editor={editor}
					editable={editable}
				/>
			)}
			{/* The dialogs the ribbon's commands open, outliving the overflow menu they may run from. */}
			{editor === undefined ? null : <RibbonDialogsHost editor={editor} />}
		</>
	)
}

// A key the editor takes: React's from its root, or the page's for one pressed elsewhere in its layer.
type EditorKeyEvent = DeckKeyEvent & { readonly target: EventTarget | null; readonly defaultPrevented: boolean }

// F6 and Shift+F6 move between the ribbon and the slide, as PowerPoint's panes.
function onPaneKey(event: EditorKeyEvent, root: Element, focusSlide: () => void): boolean {
	if (event.key !== "F6" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false

	const ribbon = root.querySelector("[data-office-ribbon]")

	if (ribbon === null) return false

	event.preventDefault()

	if (event.target instanceof Node && ribbon.contains(event.target)) focusSlide()
	else ribbonLanding(ribbon)?.focus()

	return true
}

// The keys the editor takes wherever it has focus (outside a text being typed in, bar New Slide from a slide's text or
// the notes, as PowerPoint); the rail's own take the selection.
function onEditorKey(
	event: EditorKeyEvent,
	editor: Editor,
	overrides: Readonly<Record<string, string>>,
	zoom: (change: PresentationZoomChange) => void,
	selectionPane: SelectionPaneStore,
	focusSlide: () => void
): void {
	if (event.defaultPrevented) return

	const action = presentationEditorKey(event, overrides)

	// Alt+F10 opens the Selection Pane (into it) and closes it, wherever the editor has focus, as PowerPoint does.
	if (action === "presentation.selectionPane") {
		event.preventDefault()
		selectionPane.toggle(true)

		// Closed from inside it: focus goes back to the slide rather than to nowhere.
		if (!selectionPane.getSnapshot().open && event.target instanceof Element && event.target.closest("[data-selection-pane]") !== null)
			focusSlide()

		return
	}

	if (isTextField(event.target)) {
		if (
			action === "presentation.newSlide" &&
			editor.editable &&
			event.target instanceof Element &&
			event.target.closest("[data-fo-text-editor]") !== null
		) {
			event.preventDefault()
			editor.slides.add()
		}

		return
	}

	switch (action) {
		case "presentation.undo":
			event.preventDefault()
			editor.undo()
			return
		case "presentation.redo":
			event.preventDefault()
			editor.redo()
			return
		case "presentation.newSlide":
			event.preventDefault()
			editor.slides.add()
			return
		case "presentation.duplicateSlide":
			event.preventDefault()
			editor.slides.duplicate()
			return
		// Kept from the browser, whose own Ctrl+Plus would scale the ribbon with the slide.
		case "presentation.zoomIn":
			event.preventDefault()
			zoom("in")
			return
		case "presentation.zoomOut":
			event.preventDefault()
			zoom("out")
			return
		case "presentation.zoomFit":
			event.preventDefault()
			zoom("fit")
			return
		default:
			return
	}
}

// The rail's keys: Delete, the moves and Select all act on the slides selected there.
function onRailKey(event: KeyboardEvent<HTMLDivElement>, editor: Editor, overrides: Readonly<Record<string, string>>): boolean {
	const action = presentationEditorKey(event, overrides)
	const run = (command: () => void): boolean => {
		event.preventDefault()
		// The editor's root would page slides or run the key again.
		event.stopPropagation()
		command()

		return true
	}

	if (!editor.editable) return false

	switch (action) {
		case "presentation.deleteSlide":
			return run(editor.slides.remove)
		case "presentation.moveSlideUp":
			return run(() => {
				editor.slides.nudge(-1)
			})
		case "presentation.moveSlideDown":
			return run(() => {
				editor.slides.nudge(1)
			})
		case "presentation.moveSlideFirst":
			return run(() => {
				editor.slides.nudge("first")
			})
		case "presentation.moveSlideLast":
			return run(() => {
				editor.slides.nudge("last")
			})
		case "presentation.selectAllSlides":
			return run(editor.selectAll)
		default:
			return false
	}
}

function noticesToasts(deck: PresentationDocument, store: PresentationStore, t: TFunction<"preview">): void {
	for (const notice of deck.notices) {
		if (notice.kind === "saveReverted") {
			toast.warning(t("previewPptxEditorSaveReverted", { count: notice.ops }))
			store.dismissNotice(notice)
		} else if (notice.kind === "jumpsRewritten") {
			toast.info(t("previewPptxEditorJumpsRewritten", { count: notice.count }))
			store.dismissNotice(notice)
		}
	}
}

export function PresentationEditor({ store, document: deck, alt, item, variant, editing, saveCopy }: PresentationEditorProps) {
	const { writable, renamed, onDirtyChange, saveRef, onSave, onAutosave } = editing

	const { t } = useTranslation("preview")
	const phone = usePhoneWidth()
	// The body's keys, with the user's overrides.
	const textBindings = usePresentationTextBindings()
	const downloads = usePreviewDownloadable()
	const overrides = useOverrides()
	const [railOpen, setRailOpen] = useState(true)
	// The media play controls' layer, above the selection layer.
	const [mediaControls, setMediaControls] = useState<HTMLDivElement | null>(null)
	const [notesOpen, setNotesOpen] = useState(true)
	const [selectedTab, setSelectedTab] = useState<string>("home")
	const [sectionDialog, setSectionDialog] = useState<"add" | "rename" | null>(null)
	// The shapes selected on the slide in view (the canvas, the ribbon and the keys share it), one per open deck.
	const [shapes] = useState(createShapeSelection)
	const shapeState = useShapeSelection(shapes)
	// The body open in the text editor (one store per deck: the ribbon's text groups read it), and its shape.
	const [text] = useState(createTextEditing)
	// The Selection Pane's state, this editor's own (closed when the deck opens).
	const [selectionPane] = useState(createSelectionPane)
	const [editingText, setEditingText] = useState<ShapeRef | undefined>(undefined)
	// Where a double-click entered the body (slide px): the first caret goes there; "all": Enter, its text selected.
	const [textAt, setTextAt] = useState<{ readonly x: number; readonly y: number } | "all" | undefined>(undefined)
	// Screen px per slide px, as the slide view shows it (fitting, or at the zoom).
	const [scale, setScale] = useState(1)
	// Fit to the window, or a zoom; this session's only, never written to the file.
	const [zoomMode, setZoomMode] = useState<PresentationZoom>("fit")
	// Read by the wheel's steps, which build on the zoom shown.
	const scaleRef = useLatestRef(scale)
	const zoomBy = (change: PresentationZoomChange): void => {
		setZoomMode(previous => presentationZoom(previous, scaleRef.current, change))
	}
	// The find field in place of the command row (Mod+F; with its replace field, the editors' replace key).
	const [find, setFind] = useState({ open: false, replace: false, focus: 0 })
	// The ribbon's command row mounts in a transition after the first paint: its controls are most of the editor's
	// mount, which a transition renders in slices instead of one long task.
	const [commands, setCommands] = useState(false)
	const canvasRef = useRef<HTMLDivElement | null>(null)
	const rootRef = useRef<HTMLDivElement | null>(null)
	const info = deck.info
	const reasons = presentationViewOnlyReasons(info?.gate ?? [], info?.format, variant, { writable, renamed })
	const editor = usePresentationSession({
		store,
		document: deck,
		text,
		writable: writable && reasons.length === 0,
		onAutosave: reasons.length === 0 ? onAutosave : undefined
	})
	const count = deck.slides.length
	const index = editor.current
	const ref: SlideRef | undefined = editor.currentRef
	const render = ref === undefined ? undefined : deck.renders.get(ref)
	const size = info?.size ?? DEFAULT_SLIDE_SIZE

	useEffect(() => {
		store.setWindow(index)
	}, [store, index])

	// The body a cell or placeholder key went to (the one it left is closed, its text sent): another cell or
	// placeholder, a cell of a row added at the table's bottom, or the first placeholder of a new slide on this layout.
	const navigateText = (to: TextNavigation): void => {
		setTextAt(undefined)

		if (to.kind === "open") {
			shapes.set([to.shape.id])
			setEditingText(to.shape)

			return
		}

		setEditingText(undefined)

		if (to.kind === "addRow") {
			void editor.command({ family: "table", kind: "insertRows", target: to.table, at: to.at, count: 1 }).then(result => {
				if (result.ok) setEditingText(to.shape)
			})

			return
		}

		const layout = render?.layout

		if (layout === undefined) return

		const at = index + 1

		void editor.run(addSlideOp(at, layout), at).then(ok => {
			const added = ok ? store.getSnapshot().slides[at]?.ref : undefined

			if (added === undefined) return

			// Its first placeholder opens once the new slide has rendered.
			const open = (): boolean => {
				const shown = store.getSnapshot().renders.get(added)

				if (shown === undefined) return false

				const first = firstPlaceholder(shown)

				if (first !== undefined) {
					shapes.set([first.id])
					setEditingText(first)
				}

				return true
			}

			if (open()) return

			const off = store.subscribe(() => {
				if (open()) off()
			})
		})
	}

	// The slide takes focus as the deck opens (unless something else already has it), so keys page slides from the
	// start instead of reaching the preview's own file paging.
	useEffect(() => {
		const active = document.activeElement

		if (active === null || active === document.body || active.contains(canvasRef.current))
			canvasRef.current?.focus({ preventScroll: true })
	}, [])

	useEffect(() => {
		startTransition(() => {
			setCommands(true)
		})
	}, [])

	useEffect(() => {
		noticesToasts(deck, store, t)
	}, [deck, store, t])

	// Typing the worker has not answered yet is unsaved too: closing or leaving in that window asks.
	const typing = useSyncExternalStore(
		listener => text.subscribe(listener),
		() => text.pending
	)
	const dirty = deck.dirty || typing

	useEffect(() => {
		onDirtyChange(dirty)
	}, [dirty, onDirtyChange])

	// The overlay saves through this while the deck can be saved here.
	const saveSource = editor.editable ? editor.saveSource : undefined

	useEffect(() => {
		if (saveSource === undefined) {
			return undefined
		}

		saveRef.current = saveSource

		return () => {
			if (saveRef.current === saveSource) {
				saveRef.current = null
			}
		}
	}, [saveRef, saveSource])

	const go = (next: number): void => {
		if (next >= 0) editor.go(next)
	}

	const show = useDeckPresentation({ store, deck, index, go, focusSlide: canvasRef, editable: editor.editable })
	const findControls = usePresentationFind({
		session: deck.session,
		info,
		editor: {
			text,
			selection: shapes,
			show: go,
			openText: shape => {
				setTextAt(undefined)
				setEditingText(shape)
			},
			command: editor.command
		},
		onReplaced: count => {
			toast.success(t("previewPptxFindReplaced", { count }))
		}
	})
	const openFind = (replace: boolean): void => {
		setFind(previous =>
			previous.open
				? { ...previous, replace: previous.replace || replace, focus: previous.focus + 1 }
				: { open: true, replace, focus: 0 }
		)
	}

	// Find opens for keys pressed in the editor's layer, never in a dialog over it.
	const onFindKey = (
		keyboardEvent: { readonly target: EventTarget | null; readonly defaultPrevented: boolean; preventDefault: () => void },
		replace: boolean
	): void => {
		const root = rootRef.current
		// The editor's own layer (keyForEditor): the preview overlay is itself a dialog, and a dialog over the editor portals
		// out of it.
		if (root === null || keyboardEvent.defaultPrevented || !keyForEditor(root, keyboardEvent.target)) {
			return
		}

		keyboardEvent.preventDefault()
		openFind(replace)
	}

	useAction(
		"editor.find",
		keyboardEvent => {
			onFindKey(keyboardEvent, false)
		},
		IN_EDITORS
	)
	useAction(
		"editor.replace",
		keyboardEvent => {
			onFindKey(keyboardEvent, true)
		},
		IN_EDITORS
	)
	const focusCanvas = (): void => {
		canvasRef.current?.focus()
	}

	// The document's focus (Find closing, Escape on the ribbon): the body being edited (the notes or a slide's text), as
	// PowerPoint does; else the slide.
	const focusDocument = (): void => {
		const body =
			text.active === undefined
				? null
				: (rootRef.current?.querySelector<HTMLElement>("[data-fo-text-editor] [contenteditable]") ?? null)

		;(body ?? canvasRef.current)?.focus({ preventScroll: true })
	}

	// The same keys pressed elsewhere in the editor's layer (focus left on the preview overlay itself after a click, as
	// Safari and macOS Firefox do): the show's, the panes' and the editor's shortcuts. Paging stays the slide's own.
	useEditorLayerKeys(rootRef, (event, root) => {
		if (show.onKey(event) || onPaneKey(event, root, focusCanvas)) return

		onEditorKey(event, editor, overrides, zoomBy, selectionPane, focusCanvas)
	})

	// Ctrl/Cmd+wheel (a trackpad pinch) zooms the slide, as the document editor's page; a plain wheel scrolls. A native
	// non-passive listener, so the browser's own page zoom stays out.
	useEffect(() => {
		const canvas = canvasRef.current

		if (canvas === null) return undefined

		const onWheel = (event: WheelEvent): void => {
			if (!event.ctrlKey && !event.metaKey) return

			event.preventDefault()

			const { deltaY } = event

			setZoomMode(previous => presentationWheelZoom(previous, scaleRef.current, deltaY))
		}

		canvas.addEventListener("wheel", onWheel, { passive: false })

		return () => {
			canvas.removeEventListener("wheel", onWheel)
		}
	}, [scaleRef])
	const scope: PresentationEditorScope = {
		editor,
		view: {
			railOpen,
			notesOpen,
			toggleRail: () => {
				setRailOpen(open => !open)
			},
			toggleNotes: () => {
				setNotesOpen(open => !open)
			},
			startShow: show.startShow,
			startShowFrom: show.startShowFrom,
			startPresenter: show.startPresenter,
			save: () => {
				onSave()
			},
			askSection: setSectionDialog,
			openFind,
			zoom: { scale, fit: zoomMode === "fit", set: zoomBy }
		}
	}
	const session = deck.session
	// The slide's editor (its selection layer); the ribbon builds its own (PresentationRibbon).
	const slideEditor: PresentationRibbonEditor | undefined =
		info === undefined || session === undefined
			? undefined
			: { info, render, selection: shapes, command: editor.command, session, text }
	// Pictures pasted or dropped on the slide go in as inserted pictures.
	const pictureDrop = usePresentationPictureDrop(slideEditor)
	const pictures = usePresentationPictures(slideEditor)
	const clipboard = usePresentationClipboard({
		editor,
		selection: shapes,
		slideEditor,
		rootRef,
		takePictures: files => {
			void pictures.take(files.map(fileSource))
		},
		t
	})
	const scoped: PresentationEditorScope = { ...scope, clipboard, selectionPane }
	const ribbonRender = shapeState.slide === ref && shapeState.ids.length > 0 ? render : undefined
	const kinds = ribbonRender === undefined ? NO_KINDS : selectionKinds(selectedShapes(ribbonRender, shapeState))
	const fileMenu = (
		<PresentationFileMenu
			context={{
				editable: editor.editable,
				downloads,
				item,
				...(info === undefined ? {} : { format: info.format }),
				...(session === undefined ? {} : { session }),
				...(saveCopy === undefined ? {} : { saveCopy }),
				text
			}}
		/>
	)
	const status = (
		<>
			<SaveState
				saving={editor.saving}
				dirty={deck.dirty}
			/>
			{reasons.length > 0 ? <ViewOnlyBadge reasons={reasons} /> : null}
			{count === 0 ? null : <PresentationStatusZoom />}
			<Button
				variant="ghost"
				size="sm"
				className="shrink-0 gap-1 px-2"
				disabled={count === 0}
				onMouseDown={keepFocus}
				onClick={show.startShow}
			>
				<PresentationIcon />
				<span className="text-xs max-sm:sr-only">{t("previewPptxRibbonPresent")}</span>
			</Button>
		</>
	)
	const replacement = find.open ? (
		<div className="flex min-w-0 flex-1 justify-center">
			<DocxFindField
				key={find.replace ? "replace" : "find"}
				find={findControls}
				focus={find.focus}
				onClosed={() => {
					setFind({ open: false, replace: false, focus: 0 })
					focusDocument()
				}}
				replaceOpen={find.replace}
			/>
		</div>
	) : undefined
	const tier = editor.autosave.tier
	const autosaveNotice =
		editor.editable && tier.kind === "off"
			? [t(tier.reason === "encrypted" ? "previewPptxEditorAutosaveOffEncryptedNotice" : "previewPptxEditorAutosaveOffLargeNotice")]
			: []

	return (
		<PresentationEditorContext value={scoped}>
			<div
				ref={rootRef}
				role="region"
				aria-label={alt}
				className="flex size-full flex-col"
				onKeyDownCapture={event => {
					onRibbonEscape(event, event.currentTarget, focusDocument, "capture")
				}}
				onKeyDown={event => {
					// The show's keys first: while it runs the editor takes none (no edit reaches the deck under it).
					if (show.onKey(event)) return

					if (
						onRibbonEscape(event, event.currentTarget, focusDocument, "bubble") ||
						onPaneKey(event, event.currentTarget, focusCanvas)
					)
						return

					onEditorKey(event, editor, overrides, zoomBy, selectionPane, focusCanvas)
					onPageKey(event, show.showing, step => {
						go(step === "first" ? 0 : step === "last" ? count - 1 : index + step)
					})
				}}
			>
				<PresentationRibbon
					editable={editor.editable}
					info={info}
					session={session}
					render={ribbonSlide(render, ref, shapeState)}
					kinds={kinds}
					shapes={shapes}
					command={editor.command}
					text={text}
					tab={selectedTab}
					onTab={setSelectedTab}
					commands={commands}
					file={fileMenu}
					status={status}
					replacement={replacement}
				/>
				<LegacyPresentationBar
					format={info?.format}
					saveCopy={saveCopy}
				/>
				<DeckNotes
					deck={deck}
					extra={autosaveNotice}
				/>
				<div className={phone ? "flex min-h-0 flex-1 flex-col-reverse" : "flex min-h-0 flex-1"}>
					{railOpen && count > 0 ? (
						<SlideListContextMenu>
							<PresentationSlideRail
								document={deck}
								store={store}
								current={index}
								onSelect={editor.go}
								{...(editor.editable
									? {
											edit: {
												selected: editor.selectedIndices,
												onExtend: editor.extend,
												onMove: editor.slides.moveTo,
												onCommandKey: event => onRailKey(event, editor, overrides)
											}
										}
									: {})}
							/>
						</SlideListContextMenu>
					) : null}
					{show.showing ? null : (
						<SmartArtTextPane
							editor={slideEditor}
							editable={editor.editable}
							phone={phone}
						/>
					)}
					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						<SlideCanvasContextMenu
							editor={slideEditor}
							disabled={show.showing}
							onEditText={shape => {
								setTextAt(undefined)
								setEditingText(shape)
							}}
						>
							<div
								ref={canvasRef}
								data-preview-surface
								data-fo-slide-canvas
								tabIndex={0}
								{...(slideEditor === undefined ? {} : pictureDrop)}
								className="relative min-h-0 flex-1 bg-muted/40 p-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
							>
								{count === 0 ? (
									<p className="flex size-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
										{t("previewPptxEmptyDeck")}
									</p>
								) : show.showing ? null : (
									<SlideView
										render={render}
										size={size}
										painter={editor.editable ? paintEditorSlide : paintSlide}
										{...(session === undefined ? {} : { session })}
										label={t("previewPptxSlideLabel", { current: index + 1, total: count })}
										actionLabel={(action, layer) => actionLabel(t, action, layer)}
										mode={editor.editable ? "edit" : "view"}
										actions={show.actions}
										className="size-full"
										{...(zoomMode === "fit" ? {} : { zoom: zoomMode })}
										onScale={setScale}
										overlay={
											slideEditor === undefined ? (
												<PresentationMediaFrames
													render={render}
													session={session}
													scale={scale}
													notices={deck.notices}
													actions={show.actions}
												/>
											) : (
												<>
													{/* The media under the selection layer; their play controls in the layer above it (below). */}
													<PresentationMediaFrames
														render={render}
														session={slideEditor.session}
														scale={scale}
														notices={deck.notices}
														actions={show.actions}
														controlsHost={mediaControls}
													/>
													<PresentationShapeLayer
														editor={slideEditor}
														scale={scale}
														onEnterText={(shape, at, options) => {
															setTextAt(at ?? (options?.selectAll === true ? "all" : undefined))
															// A table opens the cell under the press.
															setEditingText(tableCellAt(render, shape, at))
														}}
													/>
													<PresentationTableRange
														editor={slideEditor}
														scale={scale}
													/>
													<PresentationMotionPaths
														editor={slideEditor}
														scale={scale}
													/>
													<div
														ref={setMediaControls}
														className="pointer-events-none absolute inset-0"
													/>
													<SmartArtPrompts
														editor={slideEditor}
														scale={scale}
													/>
													{editingText === undefined || editingText.slide !== ref ? null : (
														<PresentationTextEditor
															key={`${String(editingText.slide)}:${String(editingText.id)}:${editingText.cell === undefined ? "" : `${String(editingText.cell.row)}:${String(editingText.cell.col)}`}`}
															session={slideEditor.session}
															shape={editingText}
															scale={scale}
															editing={text}
															bindings={textBindings}
															labels={presentationTextLabels(t)}
															{...(render === undefined ? {} : { render })}
															{...(textAt === undefined
																? {}
																: textAt === "all"
																	? { selectAll: true }
																	: { at: textAt })}
															readOnly={!editor.editable}
															onNavigate={navigateText}
															onExit={() => {
																setEditingText(undefined)
															}}
															onRefused={reason => {
																toast.error(t(refusalKey(reason)))
															}}
														/>
													)}
												</>
											)
										}
									/>
								)}
								{show.showing ? null : show.refusedNote("canvas")}
								{show.showing || slideEditor === undefined ? null : <AnimationPreview editor={slideEditor} />}
							</div>
						</SlideCanvasContextMenu>
						{notesOpen && count > 0 ? (
							<PresentationNotesPane
								text={render?.notesText ?? ""}
								phone={phone}
								{...(editor.editable && slideEditor !== undefined
									? {
											editor: slideEditor,
											otherEditing: editingText !== undefined,
											onEditStart: () => {
												setEditingText(undefined)
											}
										}
									: {})}
							/>
						) : null}
					</div>
					{show.showing ? null : (
						<AnimationPane
							editor={slideEditor}
							editable={editor.editable}
							phone={phone}
						/>
					)}
					{show.showing ? null : (
						<PresentationCommentsPane
							editor={slideEditor}
							editable={editor.editable}
							phone={phone}
						/>
					)}
					{/* Docked right of the slide, as PowerPoint's. */}
					{show.showing ? null : (
						<SelectionPane
							editor={slideEditor}
							store={selectionPane}
							editable={editor.editable}
							phone={phone}
							onLeave={focusCanvas}
						/>
					)}
				</div>
				{show.layer}
				<InputDialog
					open={sectionDialog !== null}
					pending={false}
					title={t(sectionDialog === "rename" ? "previewPptxEditorRenameSectionTitle" : "previewPptxEditorAddSectionTitle")}
					body={
						sectionDialog === "rename"
							? t("previewPptxEditorRenameSectionBody", { name: editor.slides.section?.name ?? "" })
							: t("previewPptxEditorAddSectionBody")
					}
					label={t("previewPptxEditorSectionName")}
					initialValue={sectionDialog === "rename" ? (editor.slides.section?.name ?? "") : t("previewPptxEditorUntitledSection")}
					submitLabel={t(sectionDialog === "rename" ? "previewPptxEditorSectionRename" : "previewPptxEditorSectionAdd")}
					validate={value => value.trim() !== ""}
					onOpenChange={open => {
						if (!open) setSectionDialog(null)
					}}
					onSubmit={value => {
						if (sectionDialog === "rename") editor.slides.renameSection(value)
						else editor.slides.addSection(value)

						setSectionDialog(null)
					}}
				/>
			</div>
		</PresentationEditorContext>
	)
}
