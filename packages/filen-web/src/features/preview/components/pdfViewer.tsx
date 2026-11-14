import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer } from "pdfjs-dist"
import {
	loadPdfOutline,
	type PdfErrorKind,
	type PdfOutlineItem,
	type PdfSource,
	type PdfViewerCommand,
	type PdfViewport
} from "@filen/office/dom/pdf"
import {
	PdfPages,
	usePdfDocument,
	usePdfViewer,
	type PdfDocumentOptions,
	type PdfDomDocument,
	type PdfJsDom
} from "@filen/office/react/pdf"
import { type DriveItem } from "@/features/drive/lib/item"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewRangeSource } from "@/features/preview/hooks/usePreviewRangeSource"
import { usePdfFullReadGuard } from "@/features/preview/hooks/usePdfFullReadGuard"
import { PDF_FULL_READ_WARN_BYTES, pdfViewerLimits, type PdfViewerLimits } from "@/features/preview/lib/pdfLimits"
import { PdfCommandBar, PdfPropertiesDialog } from "@/features/preview/components/pdfCommandBar"
import { toggleViewerFullScreen, useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { onCommandBarF6, onRibbonEscape } from "@/features/office/components/ribbon/ribbonFocus"
import { usePreviewByteSource, usePreviewDownload } from "@/features/preview/lib/accessMode"
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
import { Button } from "@/components/ui/button"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { PreviewErrorState, PreviewGate, PreviewLoading } from "@/features/preview/components/previewErrorState"
import "@filen/office/css/pdf.css"
import "@/features/preview/components/pdfTheme.css"
import { recoverIfNewerBuild } from "@/lib/appUpdate"
import { usePasswordDraft } from "@/features/preview/lib/passwordDraft"
import { usePdfPrint } from "@/features/pdf/print/usePdfPrint"
import { PDFJS_ASSETS } from "virtual:pdfjs-assets"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { PdfSignatureStatus, PdfSignedVersionStatus } from "@/features/pdf/signatures/pdfSignatureStatus"
import { useSignatureVerifier, type PdfSignatureVerify } from "@/features/pdf/signatures/useSignatureVerifier"
import { usePdfEdit, type PdfEditHost, type PdfEditView } from "@/features/pdf/session/usePdfEdit"
import { PdfFieldOverlay } from "@/features/pdf/session/fieldOverlay"
import { PdfFormNotices } from "@/features/pdf/forms/formNotices"
import { PdfRibbon } from "@/features/pdf/ribbon/pdfRibbon"
import { PDF_TOOLS } from "@/features/pdf/tools"
import { PdfToolOverlay, PdfToolPanels } from "@/features/pdf/tools/toolHost"
import { PdfPagesNotices, PdfPagesSide } from "@/features/pdf/pages/pagesSurface"
import { PdfPagesSurfaceContext, type PdfPagesSurfaceValue } from "@/features/pdf/pages/pagesSurfaceContext"
import { usePdfPageKeys } from "@/features/pdf/pages/pagesKeys"
import { pageShown } from "@/features/pdf/pages/pagesSurface.logic"
import { usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { pdfTooLargeToEdit, type PresentationSaveSource } from "@/features/drive/lib/previewSave.logic"
import { pdfEngineMemory } from "@/features/pdf/session/engineWorker"
import { formatBytes } from "@filen/shared"

export interface PdfViewerProps {
	item: DriveItem
	alt: string
	variant?: DriveVariant
	canSaveCopy?: boolean
	onOpenFile?: (item: DriveItem) => void
	// Present where the slot's file may be edited and saved (the preview overlay's save path).
	editing?: PdfEditHost
}

// Only what the viewer uses, so the rest of pdf.js's exports stay out of the bundle.
const PDFJS: PdfJsDom = { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer }

// Vite rewrites `new URL(specifier, import.meta.url)` to a same-origin, content-hashed asset URL, which
// worker-src 'self' covers. A worker script (not one shared Worker) gives every document its own worker,
// destroyed with it: pdf.js tears down the worker of the task it destroys. pdf.js has no eval path, so the CSP
// needs nothing more. Its data files (character maps, standard fonts, image decoders, ICC profile) come from this
// origin too (vite/pdfjs-assets-plugin.ts), and decoded images and pdf.js's own canvases are capped for the device.
const WORKER_SRC = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href

let built: { readonly options: PdfDocumentOptions; readonly limits: PdfViewerLimits } | null = null

// Built once: the device's limits do not change while the page lives.
function viewerSetup(): { readonly options: PdfDocumentOptions; readonly limits: PdfViewerLimits } {
	if (built === null) {
		const limits = pdfViewerLimits()

		built = { limits, options: { worker: { kind: "script", src: WORKER_SRC }, assets: { kind: "urls", ...PDFJS_ASSETS }, ...limits } }
	}

	return built
}

// The column grows to its widest page (w-max) and at least fills the view (min-w-full), so narrower pages stay
// centred while a page zoomed wider than the view overflows to the right only, keeping its left side scrollable.
const CLASS_NAMES = {
	column: "flex w-max min-w-full flex-col items-center gap-4 py-4",
	page: "flex shrink-0 items-center justify-center bg-white shadow-sm",
	canvas: (rendered: boolean) => (rendered ? "block max-w-full" : "invisible"),
	link: "rounded-xs focus-ring-row"
}

type PasswordAttempt = "initial" | "retry"

// The password prompt: the shared single-field dialog, nested in the preview overlay's own. Dismissing it leaves
// pdf.js waiting (it does not fail the task), so a button stands in to open it again. In a preview overlay, a
// newer version of the file shown meanwhile asks again as this one was left: dismissed, or with what was typed
// (PasswordDraft).
export function PdfPasswordPrompt({ attempt, onSubmit }: { attempt: PasswordAttempt; onSubmit: (password: string) => void }) {
	const { t } = useTranslation("preview")
	const draft = usePasswordDraft()
	const [dismissed, setDismissed] = useState(() => draft?.dismissed ?? false)
	// What the field starts from when it opens: the carried draft at first, blank once dismissed.
	const [seed, setSeed] = useState(() => draft?.password ?? "")

	return (
		<div className="flex size-full items-center justify-center px-6">
			{dismissed ? (
				<Button
					variant="outline"
					onClick={() => {
						setDismissed(false)
						draft?.dismiss(false)
					}}
				>
					{t("previewPdfPasswordReopen")}
				</Button>
			) : null}
			<InputDialog
				open={!dismissed}
				pending={false}
				title={t("previewPdfPasswordTitle")}
				body={attempt === "retry" ? t("previewPdfPasswordRetryBody") : t("previewPdfPasswordBody")}
				label={t("previewPdfPasswordLabel")}
				secret
				submitLabel={t("previewPdfPasswordSubmit")}
				initialValue={seed}
				validate={value => value.length > 0}
				onOpenChange={open => {
					setDismissed(!open)
					draft?.dismiss(!open)

					if (!open) {
						setSeed("")
					}
				}}
				onValueChange={value => {
					draft?.keep(value, false)
				}}
				onSubmit={value => {
					draft?.keep("", false)
					onSubmit(value)
				}}
			/>
		</div>
	)
}

interface PdfReaderProps {
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
	// pdf.js holds every byte of the file (it read them all); a reopen of the document drops them.
	fullyRead: boolean
	onReopen: () => void
	signatures: PdfSignatures
}

// The signature status of the document shown: its verifier (null: none), and either the way to open the byte prefix a
// signature signed, or, while that signed version is shown, the way back.
type PdfSignatures =
	| { readonly kind: "current"; readonly verify: PdfSignatureVerify | null; readonly onViewSignedVersion: (byteLength: number) => void }
	| { readonly kind: "signedVersion"; readonly onBack: () => void }

function PdfReader({ item, notice, document, viewerDocument, edit, alt, size, fullyRead, onReopen, signatures }: PdfReaderProps) {
	const { t } = useTranslation("preview")
	const viewer = usePdfViewer(document)
	const { state } = viewer
	const rootRef = useRef<HTMLDivElement | null>(null)
	const [findFocus, setFindFocus] = useState(0)
	const fullRead = usePdfFullReadGuard(size)
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
	const [outline, setOutline] = useState<readonly PdfOutlineItem[]>([])
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

			if (root === null) {
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
		[state.find.open, dispatch]
	)

	// The next and previous match, from anywhere in the layer but the find field (which steps on its own, DocxFindField);
	// with nothing searched yet they open the find field.
	const onFindStepKey = (keyboardEvent: KeyboardEvent, direction: 1 | -1): void => {
		const root = rootRef.current

		if (root === null || keyboardEvent.defaultPrevented || !keyForEditor(root, keyboardEvent.target)) {
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
		[state.find, dispatch]
	)
	useAction(
		"editor.findPrevious",
		keyboardEvent => {
			onFindStepKey(keyboardEvent, -1)
		},
		IN_EDITORS,
		[state.find, dispatch]
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
					online: edit.policy.online
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

		const command = pdfViewerKeyCommand(action, state)

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
				{edit === null ? null : (
					<PdfToolPanels
						edit={edit}
						document={document}
						slot="top"
					/>
				)}
				<div className="flex min-h-0 flex-1 max-sm:flex-col-reverse">
					{surface === null ? null : <PdfPagesSide />}
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
						maxCanvasBytes={viewerSetup().limits.canvasMaxAreaInBytes}
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
												editable={edit.policy.editable && edit.policy.online}
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
			<PdfPropertiesDialog
				open={properties}
				onOpenChange={setProperties}
				document={document}
				size={size}
			/>
		</div>
	)

	return surface === null ? reader : <PdfPagesSurfaceContext value={surface}>{reader}</PdfPagesSurfaceContext>
}

interface PdfDocumentProps {
	item: DriveItem
	notice: ReactNode
	edit: PdfEditView | null
	source: PdfSource
	alt: string
	// The file's size (a ranged source reads less up front).
	size: number
	// Opens the source again: a ranged source's own retry gets a new port.
	onRetry?: () => void
	signatures: PdfSignatures
}

function loadFailedKey(kind: PdfErrorKind): "previewPdfReadFailed" | "previewPdfLoadFailed" {
	return kind === "transportFailed" ? "previewPdfReadFailed" : "previewPdfLoadFailed"
}

function PdfDocument({ item, notice, edit, source, alt, size, onRetry, signatures }: PdfDocumentProps) {
	const { t } = useTranslation("preview")
	const { state, password, retry, fullyRead, reopen, acceptedPassword, release } = usePdfDocument(PDFJS, source, viewerSetup().options)
	const failed = state.status === "error"
	const ready = state.status === "ready" ? state.document : null
	const swap = edit?.swap ?? null
	const editing = edit?.phase.kind === "editing"

	// The editor takes the view from this document (and the password pdf.js accepted for it, memory only).
	useEffect(() => {
		if (swap === null || ready === null) {
			return
		}

		swap.setViewer(ready, acceptedPassword())

		return () => {
			swap.setViewer(null, null)
		}
	}, [swap, ready, acceptedPassword])

	// Once the editor has the document, pdf.js closes: its file buffer goes, its painted pages stay on screen.
	useEffect(() => {
		if (editing) {
			release()
		}
	}, [editing, release])

	// A form or signatures: the editor is likely wanted, so it is fetched while the reader is idle.
	useEffect(() => {
		if (swap === null || ready === null) {
			return
		}

		return prefetchWhenIdle(ready, swap)
	}, [swap, ready])

	useEffect(() => {
		if (failed) {
			// pdf.worker is its own file: a deploy that changed it fails documents in older tabs.
			recoverIfNewerBuild()
		}
	}, [failed])

	if (state.status === "loading") {
		return <PreviewLoading />
	}

	if (state.status === "password") {
		return (
			<PdfPasswordPrompt
				attempt={state.reason === "incorrect" ? "retry" : "initial"}
				onSubmit={password}
			/>
		)
	}

	if (state.status === "error") {
		return (
			<PreviewErrorState
				message={t(loadFailedKey(state.kind))}
				onRetry={onRetry ?? retry}
			/>
		)
	}

	return (
		<PdfReader
			item={item}
			notice={notice}
			document={edit?.snapshot?.document ?? state.document}
			viewerDocument={state.document}
			edit={edit}
			alt={alt}
			size={size}
			fullyRead={fullyRead}
			onReopen={reopen}
			signatures={signatures}
		/>
	)
}

interface PdfSourceProps {
	item: DriveItem
	alt: string
	// Bytes [0, limit) only: the version a signature signed.
	limit: number | undefined
	signatures: PdfSignatures
	edit: PdfEditView | null
	notice: ReactNode
}

function BufferedPdf({ item, alt, limit, signatures, edit, notice }: PdfSourceProps) {
	return (
		<PreviewGate result={usePreviewBytes(item)}>
			{ready => (
				<PdfDocument
					item={item}
					notice={notice}
					edit={edit}
					source={{ kind: "bytes", bytes: limit === undefined ? ready.bytes : ready.bytes.subarray(0, limit) }}
					alt={alt}
					size={limit ?? ready.bytes.byteLength}
					signatures={signatures}
				/>
			)}
		</PreviewGate>
	)
}

function RangedPdf({ item, alt, limit, signatures, edit, notice }: PdfSourceProps) {
	return (
		<PreviewGate result={usePreviewRangeSource(item, limit === undefined ? undefined : { limit })}>
			{ready => (
				<PdfDocument
					item={item}
					notice={notice}
					edit={edit}
					source={ready.source}
					alt={alt}
					size={limit ?? Number(item.data.size)}
					onRetry={ready.refetch}
					signatures={signatures}
				/>
			)}
		</PreviewGate>
	)
}

// pdf.js reads the file on demand through a range port to the SDK worker, aligned to its blocks, so a large file opens
// after reading its first pages. A file of one block or less is read whole and kept in the session's preview cache,
// as is an archive's entry (bytes from the archive, not the drive).
export function PdfViewer({ item, alt, variant, editing }: PdfViewerProps) {
	useLeaveViewerFullScreen()

	const { t } = useTranslation("preview")

	const entry = usePreviewByteSource()
	const access = usePreviewAccessMode()
	// An archive's entry is not a drive file the editor could read or save.
	const edit = usePdfEdit(item, access, entry === null ? editing : undefined)
	const editView = entry === null && editing !== undefined ? edit : null
	const holding = edit.phase.kind === "starting" || edit.phase.kind === "editing"
	// The file pdf.js opened: kept while the editor holds the document (its saves make new versions under it).
	const [shownItem, setShownItem] = useState(item)

	if (!holding && shownItem.data.uuid !== item.data.uuid) {
		setShownItem(item)
	}

	// pdf.js closed its document when the editor took over: one the editor let go of (Discard, a poisoned engine) opens
	// pdf.js anew on the file.
	const [view, setView] = useState({ held: false, generation: 0 })

	if (edit.phase.kind === "editing" && !view.held) {
		setView({ held: true, generation: view.generation })
	} else if (!holding && view.held) {
		setView({ held: false, generation: view.generation + 1 })
	}

	const verify = useSignatureVerifier(item, edit.swap)
	// The byte length of the signed version shown instead of the file, or null for the file itself.
	const [signedVersion, setSignedVersion] = useState<number | null>(null)
	const signatures: PdfSignatures =
		signedVersion === null
			? { kind: "current", verify, onViewSignedVersion: setSignedVersion }
			: {
					kind: "signedVersion",
					onBack: () => {
						setSignedVersion(null)
					}
				}
	const limit = signedVersion ?? undefined
	// A new key per version shown: the document, its viewer state and its reads start over.
	const key = signedVersion === null ? `file-${String(view.generation)}` : `signed-${String(signedVersion)}`
	const editMaxBytes = pdfEngineMemory().editMaxBytes
	// A file the tools would edit but for its size: said once, under the ribbon.
	const notice =
		variant !== undefined && entry === null && signedVersion === null && pdfTooLargeToEdit(item, variant, editMaxBytes) ? (
			<div
				role="status"
				className="flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
			>
				<p className="min-w-0 flex-1">{t("previewPdfTooLarge", { size: formatBytes(editMaxBytes) })}</p>
			</div>
		) : null
	// The signed version is a read-only view of bytes, never the editor's.
	const sourceEdit = signedVersion === null ? editView : null

	// The signed version of the file as it now is (the editor's saves may have signed it since pdf.js opened it).
	const sourceItem = signedVersion === null ? shownItem : item
	const ranged = entry === null && Number(sourceItem.data.size) > BLOCK_BYTES
	const source = ranged ? (
		<RangedPdf
			key={key}
			item={sourceItem}
			alt={alt}
			limit={limit}
			signatures={signatures}
			edit={sourceEdit}
			notice={notice}
		/>
	) : (
		<BufferedPdf
			key={key}
			item={sourceItem}
			alt={alt}
			limit={limit}
			signatures={signatures}
			edit={sourceEdit}
			notice={notice}
		/>
	)

	return (
		<>
			{editing !== undefined && editView !== null ? (
				<PdfSaveBinding
					saveRef={editing.saveRef}
					saveSource={editView.saveSource}
				/>
			) : null}
			{source}
		</>
	)
}

// The overlay's Save streams through the editor while it has the document.
function PdfSaveBinding({ saveRef, saveSource }: { saveRef: PdfEditHost["saveRef"]; saveSource: PresentationSaveSource | null }) {
	useEffect(() => {
		if (saveSource === null) {
			return
		}

		saveRef.current = saveSource

		return () => {
			if (saveRef.current === saveSource) {
				saveRef.current = null
			}
		}
	}, [saveRef, saveSource])

	return null
}

// Fetches the editor while the reader is idle when the document has a form or signatures (pdf.js's information says,
// with no page read). Returns the cancel.
function prefetchWhenIdle(document: PdfDomDocument, swap: { prefetch(): void }): () => void {
	let live = true
	let idle = 0

	void document.getMetadata().then(
		({ info }) => {
			const record = typeof info === "object" && info !== null ? info : {}
			const wanted = Reflect.get(record, "IsAcroFormPresent") === true || Reflect.get(record, "IsSignaturesPresent") === true

			if (!live || !wanted) {
				return
			}

			const prefetch = (): void => {
				swap.prefetch()
			}

			idle = typeof requestIdleCallback === "function" ? requestIdleCallback(prefetch) : window.setTimeout(prefetch, 2000)
		},
		() => undefined
	)

	return () => {
		live = false

		if (typeof cancelIdleCallback === "function") {
			cancelIdleCallback(idle)
		} else {
			window.clearTimeout(idle)
		}
	}
}
