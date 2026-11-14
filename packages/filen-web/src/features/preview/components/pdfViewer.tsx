import { useEffect, useEffectEvent, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer } from "pdfjs-dist"
import { loadPdfOutline, type PdfErrorKind, type PdfOutlineItem, type PdfSource, type PdfViewerCommand } from "@filen/office/dom/pdf"
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
import { PdfSignatureStatus } from "@/features/pdf/signatures/pdfSignatureStatus"

export interface PdfViewerProps {
	item: DriveItem
	alt: string
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
	document: PdfDomDocument
	alt: string
	size: number
	// pdf.js holds every byte of the file (it read them all); a reopen of the document drops them.
	fullyRead: boolean
	onReopen: () => void
}

function PdfReader({ document, alt, size, fullyRead, onReopen }: PdfReaderProps) {
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
		fullRead: {
			confirm: () => fullRead.confirm("print"),
			hold: fullRead.hold
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

	const focusPages = (): void => {
		viewer.pages.scrollerRef.current?.focus()
	}

	const overrides = useBindings()
	const pageInputRef = useRef<HTMLInputElement | null>(null)

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

	return (
		<div
			ref={rootRef}
			className="flex size-full flex-col"
			onKeyDownCapture={event => {
				onRibbonEscape(event, event.currentTarget, focusPages, "capture")
			}}
			onKeyDown={event => {
				if (onViewerKey(event.nativeEvent, event.currentTarget)) {
					return
				}

				if (!onRibbonEscape(event, event.currentTarget, focusPages, "bubble"))
					onCommandBarF6(event, event.currentTarget, focusPages)
			}}
		>
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
			<PdfSignatureStatus document={document} />
			{/* A preview surface: arrow keys in the pages scroll the document (sideways on a zoomed page) instead of
			paging to another file. External links open in a new tab once their domain is trusted. */}
			<div
				data-preview-surface=""
				className="flex min-h-0 flex-1 flex-col"
			>
				<PdfPages
					pdfjs={PDFJS}
					{...viewer.pages}
					className="min-h-0 flex-1 overflow-y-auto outline-none [overflow-anchor:none]"
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
					tabIndex={-1}
					onClick={linkGate.onClick}
					onAuxClick={linkGate.onAuxClick}
				/>
			</div>
			{linkGate.dialog}
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
}

interface PdfDocumentProps {
	source: PdfSource
	alt: string
	// The file's size (a ranged source reads less up front).
	size: number
	// Opens the source again: a ranged source's own retry gets a new port.
	onRetry?: () => void
}

function loadFailedKey(kind: PdfErrorKind): "previewPdfReadFailed" | "previewPdfLoadFailed" {
	return kind === "transportFailed" ? "previewPdfReadFailed" : "previewPdfLoadFailed"
}

function PdfDocument({ source, alt, size, onRetry }: PdfDocumentProps) {
	const { t } = useTranslation("preview")
	const { state, password, retry, fullyRead, reopen } = usePdfDocument(PDFJS, source, viewerSetup().options)
	const failed = state.status === "error"

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
			document={state.document}
			alt={alt}
			size={size}
			fullyRead={fullyRead}
			onReopen={reopen}
		/>
	)
}

function BufferedPdf({ item, alt }: PdfViewerProps) {
	return (
		<PreviewGate result={usePreviewBytes(item)}>
			{ready => (
				<PdfDocument
					source={{ kind: "bytes", bytes: ready.bytes }}
					alt={alt}
					size={ready.bytes.byteLength}
				/>
			)}
		</PreviewGate>
	)
}

function RangedPdf({ item, alt }: PdfViewerProps) {
	return (
		<PreviewGate result={usePreviewRangeSource(item)}>
			{ready => (
				<PdfDocument
					source={ready.source}
					alt={alt}
					size={Number(item.data.size)}
					onRetry={ready.refetch}
				/>
			)}
		</PreviewGate>
	)
}

// pdf.js reads the file on demand through a range port to the SDK worker, aligned to its blocks, so a large file opens
// after reading its first pages. A file of one block or less is read whole and kept in the session's preview cache,
// as is an archive's entry (bytes from the archive, not the drive).
export function PdfViewer({ item, alt }: PdfViewerProps) {
	useLeaveViewerFullScreen()

	const ranged = usePreviewByteSource() === null && Number(item.data.size) > BLOCK_BYTES

	return ranged ? (
		<RangedPdf
			item={item}
			alt={alt}
		/>
	) : (
		<BufferedPdf
			item={item}
			alt={alt}
		/>
	)
}
