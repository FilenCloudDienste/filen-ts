import { sanitizePdfMathML } from "@/features/preview/lib/pdfMathSanitizer"
import { useEffect, useEffectEvent, useRef, useState, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { loadPdfOutline, type PdfOutlineItem, type PdfViewerCommand, type PdfViewport } from "@filen/office/dom/pdf"
import { PdfPages, usePdfViewer, type PdfDomDocument } from "@filen/office/react/pdf"
import { PDFJS } from "@/features/preview/lib/pdfjsModule"
import { usePublishPreviewDocument } from "@/features/preview/lib/activeDocumentScope"
import { pdfDocumentReader } from "@/features/preview/lib/documentReaders"
import { type DriveItem } from "@/features/drive/lib/item"
import { usePdfFullReadGuard } from "@/features/preview/hooks/usePdfFullReadGuard"
import { usePdfScrollRoom } from "@/features/preview/hooks/usePdfScrollRoom"
import { PDF_FULL_READ_WARN_BYTES } from "@/features/preview/lib/pdfLimits"
import { pdfViewerSetup } from "@/features/preview/lib/pdfViewerSetup"
import { PdfCommandBar, PdfPropertiesDialog } from "@/features/preview/components/pdfCommandBar"
import { toggleViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { onCommandBarF6, onRibbonEscape } from "@/features/office/components/ribbon/ribbonFocus"
import { usePreviewDownload } from "@/features/preview/lib/accessMode"
import { useTrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"
import { isSafeAbsoluteHref } from "@/lib/safeUrl"
import { keyForEditor } from "@/lib/keymap/dialogGuard"
import { useEditorLayerKeys } from "@/lib/keymap/editorLayerKeys"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isPdfHostAction, pdfViewerKey, pdfViewerKeyCommand, type PdfHostAction } from "@/features/preview/lib/pdfKeys.logic"
import { isImeKeydown } from "@filen/shared/keymap"
import { fullscreenSupported } from "@/lib/media/fullscreen"
import { log } from "@/lib/log"
import { LoadingState } from "@/components/loadingState"
import "@filen/office/css/pdf.css"
import "@/features/preview/components/pdfTheme.css"
import { usePdfPrint } from "@/features/pdf/print/usePdfPrint"
import { PdfSignatureStatus, PdfSignedVersionStatus } from "@/features/pdf/signatures/pdfSignatureStatus"
import { type PdfSignatureVerify } from "@/features/pdf/signatures/useSignatureVerifier"
import { type PdfEditView } from "@/features/pdf/session/usePdfEdit"
import { PdfFieldOverlay } from "@/features/pdf/session/fieldOverlay"
import { PdfFormNotices } from "@/features/pdf/forms/formNotices"
import { PdfRibbon } from "@/features/pdf/ribbon/pdfRibbon"
import { PDF_TOOLS } from "@/features/pdf/tools"
import { PdfToolOverlay, PdfToolPanels } from "@/features/pdf/tools/toolHost"
import { PdfLiveRegion } from "@/features/pdf/tools/pdfLiveRegion"
import { PdfPagesNotices, PdfPagesSide } from "@/features/pdf/pages/pagesSurface"
import { PdfPagesSurfaceContext, type PdfPagesSurfaceValue } from "@/features/pdf/pages/pagesSurfaceContext"
import { usePdfPageKeys } from "@/features/pdf/pages/pagesKeys"
import { pageShown } from "@/features/pdf/pages/pagesSurface.logic"
import type { RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"
import { togglePdfPagesRail, usePdfPagesRailOpen } from "@/features/pdf/pages/railOpen"
import { PdfOutlinePane } from "@/features/preview/components/pdfOutlinePane"
import { outlineKeyTarget } from "@/features/preview/lib/pdfOutline.logic"
import { useMediumWidth, usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"
import { closePdfOutlinePane, setPdfRailTab, togglePdfOutlinePane, usePdfOutlinePaneOpen } from "@/features/preview/lib/pdfOutlineOpen"

// The PDF reader every MuPDF and pdf.js document is shown in: the command bar or the editor's ribbon, the pages with
// their find, links, print and properties, and the editor's surfaces when it edits. The PDF viewer and the e-book
// reader share it.

// The column grows to its widest page (w-max) and at least fills the view (min-w-full), so narrower pages stay
// centred while a page zoomed wider than the view overflows to the right only, keeping its left side scrollable.
const CLASS_NAMES = {
	column: "flex w-max min-w-full flex-col items-center gap-4 py-4",
	page: "flex shrink-0 items-center justify-center bg-white shadow-sm",
	canvas: (rendered: boolean) => (rendered ? "block max-w-full" : "invisible"),
	link: "rounded-xs focus-ring-row"
}

export interface PdfReaderShellProps {
	item: DriveItem
	// A one-line notice under the ribbon (the file is too large to edit here).
	notice: ReactNode
	// The document shown: pdf.js's, or the editor's once it took over.
	document: PdfDomDocument
	// pdf.js's document as opened (its signatures are checked once, whatever engine shows the pages later).
	viewerDocument: PdfDomDocument
	edit: PdfEditView | null
	alt: string
	size: number
	// pdf.js holds every byte of the file (it read them all); a reopen of the document drops them. Both this and
	// `resident` stay false while the editor starts from or holds the document, so nothing reopens it then.
	fullyRead: boolean
	// pdf.js reads the file in ranges (it does not hold all of it).
	ranged: boolean
	// pdf.js holds more of a ranged file than the device's resident limit and has had no read pending for a moment.
	resident: boolean
	onReopen: () => void
	signatures: PdfSignatures
	// --- A host's own parts (the e-book reader) ---
	// Groups after the viewer's own in the command bar.
	commandGroups?: readonly RibbonGroup[]
	// Over the pages (a relayout's frozen view).
	pagesOverlay?: ReactNode
	// The page shown changed (1-based).
	onPageChange?: (page: number) => void
	// Filled with the page to keep in place (1-based; a navigation's target while it still scrolls, else the page in
	// view), for a host that lays the document out again.
	anchorRef?: RefObject<(() => number) | null>
	// Goes to `page` (1-based) each time `key` changes.
	goTo?: { readonly page: number; readonly key: number } | null
	// Its own properties dialog instead of the PDF's.
	renderProperties?: (open: boolean, onOpenChange: (open: boolean) => void) => ReactNode
	// False where the whole document is in memory already (a book MuPDF read at open): find and print never ask to
	// read the whole file.
	fullReadGuard?: boolean
	// The pages area's size (its scroller's content box, CSS pixels), each time it changes.
	onPagesResize?: (width: number, height: number) => void
	// False for a document without text (an image's pages): no Find, and its keys stay the browser's.
	searchable?: boolean
	// The drive file's PDF itself (not a signed version, a draft or a book): published as the open document.
	publishes?: boolean
}

// The signature status of the document shown: its verifier (null: none), and either the way to open the byte prefix a
// signature signed, or, while that signed version is shown, the way back.
export type PdfSignatures =
	| { readonly kind: "current"; readonly verify: PdfSignatureVerify | null; readonly onViewSignedVersion: (byteLength: number) => void }
	| { readonly kind: "signedVersion"; readonly onBack: () => void }

export function PdfReaderShell({
	item,
	notice,
	document,
	viewerDocument,
	edit,
	alt,
	size,
	fullyRead,
	ranged,
	resident,
	onReopen,
	signatures,
	commandGroups,
	pagesOverlay,
	onPageChange,
	anchorRef,
	goTo,
	renderProperties,
	fullReadGuard,
	onPagesResize,
	searchable,
	publishes
}: PdfReaderShellProps) {
	const { t } = useTranslation("preview")
	const viewer = usePdfViewer(document)
	const { state } = viewer
	const finder = viewer.finder

	// The pages' text as find reads and keeps it: the editor's document (its changes and applied OCR) once it took over.
	usePublishPreviewDocument(
		publishes === true
			? {
					kind: "pdf",
					position: { page: state.page, pages: document.numPages },
					selection: null,
					editable: edit?.toolContext.editable === true,
					reader: pdfDocumentReader(document.numPages, async page => (await finder.pageText(page)).text)
				}
			: null
	)

	// A host restoring a position (a relayout's anchor): straight there, never smooth-scrolling through the pages between.
	const goToHostPage = useEffectEvent((page: number) => {
		viewer.dispatch({ type: "page.goto", page, instant: true })
	})
	const goToKey = goTo?.key ?? null
	const goToTarget = goTo?.page ?? null

	const pageChanged = useEffectEvent((page: number) => {
		onPageChange?.(page)
	})

	useEffect(() => {
		pageChanged(state.page)
	}, [state.page])

	const anchorPage = viewer.anchorPage

	useEffect(() => {
		if (anchorRef !== undefined) anchorRef.current = anchorPage
	}, [anchorRef, anchorPage])

	useEffect(() => {
		if (goToKey !== null && goToTarget !== null) {
			goToHostPage(goToTarget)
		}
	}, [goToKey, goToTarget])
	const rootRef = useRef<HTMLDivElement | null>(null)
	const [findFocus, setFindFocus] = useState(0)
	const fullRead = usePdfFullReadGuard(fullReadGuard === false ? 0 : size)
	const pagesResized = useEffectEvent((width: number, height: number) => {
		onPagesResize?.(width, height)
	})
	const scroller = viewer.pages.scrollerRef
	const scrollRoom = usePdfScrollRoom(scroller)

	useEffect(() => {
		const element = scroller.current

		if (element === null) {
			return
		}

		const observer = new ResizeObserver(() => {
			pagesResized(element.clientWidth, element.clientHeight)
		})

		observer.observe(element)

		return () => {
			observer.disconnect()
		}
	}, [scroller])
	// The confirmed full reads already followed by a reopen, and the reopens nobody asked for: pdf.js reading
	// everything on its own (a damaged file) would read it all again after a reopen, so that is done once.
	const reopenedAt = useRef(0)
	const unaskedReopens = useRef(0)
	const reopen = useEffectEvent(onReopen)

	// Searching every page of a large file reads all of it: asked first. Everything else goes straight through.
	const dispatch = (command: PdfViewerCommand): void => {
		if (command.type !== "find.query" || command.query.length === 0 || !fullRead.needs("find")) {
			viewer.dispatch(command)

			return
		}

		void fullRead.confirm("find").then(confirmed => {
			viewer.dispatch(confirmed ? command : { type: "find.close" })

			if (confirmed) {
				setFindFocus(focus => focus + 1)
			}
		})
	}

	// A large file pdf.js read completely (a search, printing, its read-everything fallback) is reopened once nothing
	// uses the read bytes any more, keeping page, zoom and scroll: the new document reads pages on demand again.
	useEffect(() => {
		if (!fullyRead || size <= PDF_FULL_READ_WARN_BYTES || state.find.open || fullRead.holds > 0) {
			return
		}

		const asked = fullRead.confirmations > reopenedAt.current

		if (!asked && unaskedReopens.current > 0) {
			return
		}

		if (asked) {
			reopenedAt.current = fullRead.confirmations
		} else {
			unaskedReopens.current++
		}

		reopen()
	}, [fullyRead, size, state.find.open, fullRead.holds, fullRead.confirmations])

	// The page of the last reopen for holding too much: a document that reads more without the view moving (pdf.js
	// reading everything on its own) is not reopened again for it.
	const residentReopenedAt = useRef<number | null>(null)

	// pdf.js never drops a range it read: once a ranged document holds more than the device's limit and the reads have
	// settled, it is reopened, keeping page, zoom and scroll, unless a search or a print still uses what it read.
	useEffect(() => {
		if (!resident || state.find.open || fullRead.holds > 0 || residentReopenedAt.current === state.page) {
			return
		}

		residentReopenedAt.current = state.page
		reopen()
	}, [resident, state.find.open, fullRead.holds, state.page])
	const [outline, setOutline] = useState<readonly PdfOutlineItem[]>([])
	const paneOpen = usePdfOutlinePaneOpen()
	const railOpen = usePdfPagesRailOpen()
	const phone = usePhoneWidth()
	const medium = useMediumWidth()
	const [properties, setProperties] = useState(false)
	const linkGate = useTrustedLinkGate()
	const download = usePreviewDownload()
	const print = usePdfPrint({
		document,
		current: state.page,
		size,
		// Printing after a change renders through the editor: Mod+P and the File menu fetch it meanwhile.
		...(edit === null
			? {}
			: {
					prefetch: () => {
						edit.swap.prefetch()
					}
				}),
		fullRead: {
			confirm: () => fullRead.confirm("print"),
			hold: () => fullRead.hold()
		}
	})

	// One worker round trip per document, cached with it: the Outline menu shows only for a document with bookmarks.
	useEffect(() => {
		let live = true

		void loadPdfOutline(document).then(items => {
			if (live) {
				setOutline(items)
			}
		})

		return () => {
			live = false
		}
	}, [document])

	// Find opens for keys pressed in the layer the document is shown in (the preview overlay), never one over it.
	useAction(
		"editor.find",
		keyboardEvent => {
			const root = rootRef.current

			if (root === null || searchable === false) {
				return
			}

			if (!keyForEditor(root, keyboardEvent.target)) {
				return
			}

			keyboardEvent.preventDefault()

			if (state.find.open) {
				setFindFocus(focus => focus + 1)
			} else {
				dispatch({ type: "find.open" })
			}
		},
		IN_EDITORS,
		[state.find.open, dispatch, searchable]
	)

	// The next and previous match, from anywhere in the layer but the find field (which steps on its own, DocxFindField);
	// with nothing searched yet they open the find field.
	const onFindStepKey = (keyboardEvent: KeyboardEvent, direction: 1 | -1): void => {
		const root = rootRef.current

		if (root === null || searchable === false || keyboardEvent.defaultPrevented || !keyForEditor(root, keyboardEvent.target)) {
			return
		}

		keyboardEvent.preventDefault()

		if (!state.find.open || state.find.query.length === 0) {
			if (state.find.open) {
				setFindFocus(focus => focus + 1)
			} else {
				dispatch({ type: "find.open" })
			}
		} else if (state.find.count > 0) {
			dispatch({ type: direction > 0 ? "find.next" : "find.previous" })
		}
	}

	useAction(
		"editor.findNext",
		keyboardEvent => {
			onFindStepKey(keyboardEvent, 1)
		},
		IN_EDITORS,
		[state.find, dispatch, searchable]
	)
	useAction(
		"editor.findPrevious",
		keyboardEvent => {
			onFindStepKey(keyboardEvent, -1)
		},
		IN_EDITORS,
		[state.find, dispatch, searchable]
	)

	// Undo and redo of the editor's changes, from anywhere in the layer but a field (which keeps its own text undo).
	const editHistory = edit?.history ?? null
	const onHistoryKey = (keyboardEvent: KeyboardEvent, redo: boolean): void => {
		const root = rootRef.current

		if (root === null || editHistory === null || !keyForEditor(root, keyboardEvent.target)) {
			return
		}

		keyboardEvent.preventDefault()

		if (redo ? editHistory.canRedo : editHistory.canUndo) {
			if (redo) {
				editHistory.redo()
			} else {
				editHistory.undo()
			}
		}
	}

	useAction(
		"pdf.undo",
		keyboardEvent => {
			onHistoryKey(keyboardEvent, false)
		},
		IN_EDITORS,
		[editHistory]
	)
	useAction(
		"pdf.redo",
		keyboardEvent => {
			onHistoryKey(keyboardEvent, true)
		},
		IN_EDITORS,
		[editHistory]
	)

	const focusPages = (): void => {
		viewer.pages.scrollerRef.current?.focus()
	}

	// The outline as a tree: the viewer's pane (with its close button) or the editor's rail tab.
	const outlinePane = (onClose: (() => void) | undefined, className: string | undefined): ReactNode => (
		<PdfOutlinePane
			document={document}
			outline={outline}
			page={state.page}
			onGo={to => {
				dispatch({ type: "page.goto", page: to.page, left: to.left, top: to.top })
			}}
			{...(onClose === undefined ? {} : { onClose })}
			{...(className === undefined ? {} : { className })}
		/>
	)

	// The page surfaces (pages rail, Organise, page tools) share the document shown, the editor's engine and the page
	// operations.
	const pagesController = edit?.pages ?? null
	const surface: PdfPagesSurfaceValue | null =
		edit === null
			? null
			: {
					controller: edit.pages,
					document,
					engine: edit.phase.kind === "editing" ? edit.phase.session.engine : null,
					snapshot: edit.snapshot,
					item,
					policy: edit.policy,
					toolContext: edit.toolContext,
					viewRotation: state.rotation,
					online: edit.policy.online,
					ranged
				}

	useEffect(() => {
		pagesController?.viewerPage(state.page - 1, page => pageShown(viewer.pages.scrollerRef.current, page))
	}, [pagesController, state.page, viewer.pages.scrollerRef])

	const goToPage = useEffectEvent((index: number) => {
		viewer.dispatch({ type: "page.goto", page: index + 1 })
	})

	useEffect(() => {
		if (pagesController === null) {
			return
		}

		pagesController.setNavigator(index => {
			goToPage(index)
		})

		return () => {
			pagesController.setNavigator(null)
		}
	}, [pagesController])

	usePdfPageKeys(rootRef, surface)

	const overrides = useBindings()
	const pageInputRef = useRef<HTMLInputElement | null>(null)
	const surfaceRef = useRef<HTMLDivElement | null>(null)
	// The editor's tools take their keys on the page surface first (a tool letter, a key for the tool in effect).
	const onToolKey = (event: KeyboardEvent): boolean =>
		edit !== null && surfaceRef.current !== null && edit.onSurfaceKey(event, surfaceRef.current, state.page - 1)

	const runHostAction = (action: PdfHostAction): void => {
		switch (action) {
			case "preview.pdfGoToPage":
				pageInputRef.current?.focus()
				break
			case "preview.pdfFullScreen":
				if (fullscreenSupported()) {
					toggleViewerFullScreen().catch((error: unknown) => {
						log.warn("preview", "full screen refused", { error })
					})
				}

				break
			case "preview.pdfProperties":
				setProperties(true)
				break
			case "preview.pdfOutline":
				switch (
					outlineKeyTarget({ hasOutline: outline.length > 0, editing: edit !== null, paneShows: !phone, railShows: medium })
				) {
					case "pane":
						togglePdfOutlinePane()
						break
					case "rail":
						if (!railOpen) {
							togglePdfPagesRail()
						}

						setPdfRailTab("outline")
						break
					case "none":
						break
				}

				break
		}
	}

	// Zoom, fit, rotate and page keys for the layer the document is shown in, never a dialog over it. A key the viewer
	// takes is always kept from the browser, even at a zoom limit or the last page, so its page zoom never scales the
	// app instead.
	const onViewerKey = (event: KeyboardEvent, root: HTMLElement): boolean => {
		if (event.defaultPrevented || isImeKeydown(event) || isRecordingCombo() || !keyForEditor(root, event.target)) {
			return false
		}

		const action = pdfViewerKey(event, overrides)

		if (action === undefined) {
			return false
		}

		event.preventDefault()

		if (isPdfHostAction(action)) {
			if (!event.repeat) {
				runHostAction(action)
			}

			return true
		}

		const command = pdfViewerKeyCommand(action, state, scrollRoom)

		if (command !== null) {
			dispatch(command)
		}

		return true
	}

	// F6 and the viewer's keys pressed elsewhere in the viewer's layer (focus left on the preview overlay itself after a
	// click, as Safari and macOS Firefox do).
	useEditorLayerKeys(rootRef, (event, root) => {
		if (!onViewerKey(event, root)) {
			onCommandBarF6(event, root, focusPages)
		}
	})

	const reader = (
		<div
			ref={rootRef}
			className="flex size-full flex-col"
			onKeyDownCapture={event => {
				onRibbonEscape(event, event.currentTarget, focusPages, "capture")
			}}
			onKeyDown={event => {
				if (onToolKey(event.nativeEvent)) {
					event.preventDefault()

					return
				}

				if (onViewerKey(event.nativeEvent, event.currentTarget)) {
					return
				}

				if (!onRibbonEscape(event, event.currentTarget, focusPages, "bubble"))
					onCommandBarF6(event, event.currentTarget, focusPages)
			}}
			onKeyUp={event => {
				if (onToolKey(event.nativeEvent)) event.preventDefault()
			}}
		>
			{edit === null ? (
				<PdfCommandBar
					state={state}
					dispatch={dispatch}
					document={document}
					outline={outline}
					findFocus={findFocus}
					onFindClosed={() => {
						viewer.pages.scrollerRef.current?.focus()
					}}
					onDownload={download}
					onPrint={print.open}
					onProperties={() => {
						setProperties(true)
					}}
					pageInputRef={pageInputRef}
					scrollRoom={scrollRoom}
					outlinePane={{ open: paneOpen, toggle: togglePdfOutlinePane }}
					{...(commandGroups === undefined ? {} : { extraGroups: commandGroups })}
					{...(searchable === undefined ? {} : { searchable })}
				/>
			) : (
				<PdfRibbon
					state={state}
					dispatch={dispatch}
					document={document}
					outline={outline}
					findFocus={findFocus}
					onFindClosed={() => {
						viewer.pages.scrollerRef.current?.focus()
					}}
					onDownload={download}
					onPrint={print.open}
					onProperties={() => {
						setProperties(true)
					}}
					pageInputRef={pageInputRef}
					scrollRoom={scrollRoom}
					tools={PDF_TOOLS}
					policy={edit.policy}
					toolContext={edit.toolContext}
					activeTool={edit.activeTool}
					toolVariants={edit.toolVariants}
					onActivateTool={edit.setActiveTool}
					onPrefetch={() => {
						edit.swap.prefetch()
					}}
					history={edit.history}
				/>
			)}
			{edit?.banner}
			{surface === null ? null : <PdfPagesNotices />}
			{notice}
			{edit === null ? null : (
				<PdfFormNotices
					document={document}
					snapshot={edit.snapshot}
					scrollerRef={viewer.pages.scrollerRef}
				/>
			)}
			{signatures.kind === "current" ? (
				<PdfSignatureStatus
					document={edit?.signatureSource ?? viewerDocument}
					verify={signatures.verify}
					onViewSignedVersion={signatures.onViewSignedVersion}
				/>
			) : (
				<PdfSignedVersionStatus onBack={signatures.onBack} />
			)}
			{/* A preview surface: arrow keys in the pages scroll the document (sideways on a zoomed page) instead of
			paging to another file. External links open in a new tab once their domain is trusted. */}
			<div
				ref={surfaceRef}
				data-preview-surface=""
				className="relative flex min-h-0 flex-1 flex-col"
			>
				{pagesOverlay}
				{edit === null ? null : (
					<>
						<PdfLiveRegion owner={edit.swap} />
						<PdfToolPanels
							edit={edit}
							document={document}
							slot="top"
						/>
					</>
				)}
				<div className="flex min-h-0 flex-1 max-sm:flex-col">
					{surface === null ? null : <PdfPagesSide outline={outline.length === 0 ? null : outlinePane(undefined, undefined)} />}
					{edit === null && paneOpen && outline.length > 0
						? outlinePane(() => {
								closePdfOutlinePane()
								focusPages()
							}, "w-64 shrink-0 border-r border-border bg-background max-sm:hidden")
						: null}
					<PdfPages
						pdfjs={PDFJS}
						{...viewer.pages}
						className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none [overflow-anchor:none]"
						classNames={CLASS_NAMES}
						pageLabel={(page, total) => `${alt} — ${t("previewPdfPageIndicator", { current: page, total })}`}
						placeholder={
							<LoadingState
								size="sm"
								className="absolute inset-0 text-inherit"
							/>
						}
						allowLink={isSafeAbsoluteHref}
						sanitizeMathML={sanitizePdfMathML}
						maxCanvasBytes={pdfViewerSetup().limits.canvasMaxAreaInBytes}
						{...(edit === null
							? {}
							: {
									overlay: (page: number, viewport: PdfViewport) => (
										<>
											<PdfFieldOverlay
												document={document}
												page={page}
												viewport={viewport}
												swap={edit.swap}
												snapshot={edit.snapshot}
												starting={edit.phase.kind === "starting"}
												editable={edit.toolContext.editable}
											/>
											<PdfToolOverlay
												edit={edit}
												document={document}
												page={page}
												viewport={viewport}
											/>
										</>
									)
								})}
						tabIndex={-1}
						onClick={linkGate.onClick}
						onAuxClick={linkGate.onAuxClick}
					/>
					{edit === null ? null : (
						<PdfToolPanels
							edit={edit}
							document={document}
							slot="side"
						/>
					)}
				</div>
			</div>
			{linkGate.dialog}
			{edit?.dialogs}
			{print.dialog}
			{fullRead.dialog}
			{renderProperties === undefined ? (
				<PdfPropertiesDialog
					open={properties}
					onOpenChange={setProperties}
					document={document}
					size={size}
				/>
			) : (
				renderProperties(properties, setProperties)
			)}
		</div>
	)

	return surface === null ? reader : <PdfPagesSurfaceContext value={surface}>{reader}</PdfPagesSurfaceContext>
}
