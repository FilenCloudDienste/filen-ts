import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer } from "pdfjs-dist"
import { loadPdfOutline, type PdfOutlineItem, type PdfSource } from "@filen/office/dom/pdf"
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
import { PdfCommandBar, PdfPropertiesDialog } from "@/features/preview/components/pdfCommandBar"
import { toggleViewerFullScreen, useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
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
import { Button } from "@/components/ui/button"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { PreviewErrorState, PreviewGate, PreviewLoading } from "@/features/preview/components/previewErrorState"
import "@filen/office/css/pdf.css"
import "@/features/preview/components/pdfTheme.css"
import { recoverIfNewerBuild } from "@/lib/appUpdate"
import { usePasswordDraft } from "@/features/preview/lib/passwordDraft"

export interface PdfViewerProps {
	item: DriveItem
	alt: string
}

// Only what the viewer uses, so the rest of pdf.js's exports stay out of the bundle.
const PDFJS: PdfJsDom = { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer }

// Vite rewrites `new URL(specifier, import.meta.url)` to a same-origin, content-hashed asset URL, which
// worker-src 'self' covers. A worker script (not one shared Worker) gives every document its own worker,
// destroyed with it: pdf.js tears down the worker of the task it destroys. pdf.js has no eval path, so the CSP
// needs nothing more.
const OPTIONS: PdfDocumentOptions = { worker: { kind: "script", src: new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href } }

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

function PdfReader({ document, alt, size }: { document: PdfDomDocument; alt: string; size: number }) {
	const { t } = useTranslation("preview")
	const viewer = usePdfViewer(document)
	const { state, dispatch } = viewer
	const rootRef = useRef<HTMLDivElement | null>(null)
	const [findFocus, setFindFocus] = useState(0)
	const [outline, setOutline] = useState<readonly PdfOutlineItem[]>([])
	const [properties, setProperties] = useState(false)
	const linkGate = useTrustedLinkGate()
	const download = usePreviewDownload()

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
				onProperties={() => {
					setProperties(true)
				}}
				pageInputRef={pageInputRef}
			/>
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
					tabIndex={-1}
					onClick={linkGate.onClick}
					onAuxClick={linkGate.onAuxClick}
				/>
			</div>
			{linkGate.dialog}
			<PdfPropertiesDialog
				open={properties}
				onOpenChange={setProperties}
				document={document}
				size={size}
			/>
		</div>
	)
}

function PdfDocument({ bytes, alt }: { bytes: Uint8Array; alt: string }) {
	const { t } = useTranslation("preview")
	const source: PdfSource = { kind: "bytes", bytes }
	const { state, password, retry } = usePdfDocument(PDFJS, source, OPTIONS)
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
				message={t("previewPdfLoadFailed")}
				onRetry={retry}
			/>
		)
	}

	return (
		<PdfReader
			document={state.document}
			alt={alt}
			size={bytes.byteLength}
		/>
	)
}

// Gated on the whole-buffer download every buffered preview shares; PdfDocument owns the rest.
export function PdfViewer({ item, alt }: PdfViewerProps) {
	useLeaveViewerFullScreen()

	return (
		<PreviewGate result={usePreviewBytes(item)}>
			{ready => (
				<PdfDocument
					bytes={ready.bytes}
					alt={alt}
				/>
			)}
		</PreviewGate>
	)
}
