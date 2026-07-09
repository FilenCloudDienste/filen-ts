import { useEffect, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { getDocument, GlobalWorkerOptions, PasswordResponses, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { type DriveItem } from "@/lib/drive/item"
import { clampListboxIndex } from "@/lib/drive/listbox"
import { usePreviewBytes } from "@/components/preview/use-preview-bytes"
import {
	mostVisiblePage,
	canvasDimsForViewport,
	canvasRenderTransform,
	pdfPageAction,
	PDF_PAGE_RENDER_MARGIN_PX,
	PDF_PAGE_EVICT_MARGIN_PX,
	type PageVisibility
} from "@/components/preview/pdf-viewer.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { InputDialog } from "@/components/dialogs/input-dialog"

export interface PdfViewerProps {
	item: DriveItem
	alt: string
}

// Vite statically recognizes `new URL(specifier, import.meta.url)` and rewrites it to a same-origin,
// content-hashed asset URL — worker-src 'self' covers it (no blob: wrapper ever needed, since the
// resolved URL always shares this page's origin). Confirmed against the installed 6.1.200 bundle:
// neither pdf.mjs nor pdf.worker.mjs calls eval/Function, so 'wasm-unsafe-eval' — already present in
// the CSP for the SDK's own wasm — is the only script-src concession pdf.js benefits from, and even
// that's only for its own optional wasm codecs; nothing here needed a CSP change.
//
// A STRING workerSrc (not a shared, manually-constructed Worker assigned to workerPort) is
// deliberate: pdf.js caches ONE PDFWorker wrapper per port object, and PDFDocumentLoadingTask.destroy
// always tears down that wrapper's underlying Worker — sharing one physical worker across documents
// would mean closing the FIRST preview kills every other one still open. workerSrc instead gives
// every getDocument() call its own dedicated worker, safely destroyed on that one item's own unmount.
GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href

// Fixed render resolution (independent of container width) — the canvas is then constrained to
// max-width:100% so narrower viewports shrink it, while devicePixelRatio (applied separately, see
// canvasRenderTransform) keeps the underlying bitmap crisp on HiDPI screens either way.
const BASE_SCALE = 1.5

type PasswordAttempt = "initial" | "retry"

type DocumentState =
	| { status: "loading" }
	| { status: "password"; attempt: PasswordAttempt }
	| { status: "success"; doc: PDFDocumentProxy }
	| { status: "error" }

// Owns one pdf.js loading task's whole lifecycle: worker-backed parsing, the onPassword retry loop,
// and teardown. onPassword (not a caught rejection) is the only viable retry path here — getDocument
// transfers `bytes`' backing ArrayBuffer to the worker on the FIRST call (detaching it), so a second,
// independent getDocument() call for a retry would hand the worker an already-empty buffer; onPassword
// instead resumes the SAME task/transport, which already holds the full file worker-side.
function usePdfDocument(bytes: Uint8Array): { state: DocumentState; submitPassword: (password: string) => void } {
	const [state, setState] = useState<DocumentState>({ status: "loading" })
	const updatePasswordRef = useRef<((password: string) => void) | null>(null)

	useEffect(() => {
		let live = true
		// bytes.slice(): getDocument transfers `data`'s backing ArrayBuffer to the worker (postMessage
		// with a transfer list — verified against the installed 6.1.200 source), detaching it. StrictMode
		// double-invokes this effect in dev with the SAME `bytes` reference, so the first call would
		// detach the SDK-owned buffer out from under the second, racing loser. A copy gives every call —
		// StrictMode's extra one included — its own buffer to transfer; `bytes` itself is never touched.
		const task = getDocument({ data: bytes.slice() })

		task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
			updatePasswordRef.current = updatePassword

			if (live) {
				setState({ status: "password", attempt: reason === PasswordResponses.INCORRECT_PASSWORD ? "retry" : "initial" })
			}
		}

		task.promise
			.then(doc => {
				if (live) {
					setState({ status: "success", doc })
				}
			})
			.catch(() => {
				if (live) {
					setState({ status: "error" })
				}
			})

		return () => {
			live = false
			updatePasswordRef.current = null
			void task.destroy()
		}
	}, [bytes])

	function submitPassword(password: string): void {
		const updatePassword = updatePasswordRef.current

		if (!updatePassword) {
			return
		}

		setState({ status: "loading" })
		updatePassword(password)
	}

	return { state, submitPassword }
}

// The password prompt: an InputDialog (the shared single-field-prompt primitive, nested inside the
// preview overlay's own dialog exactly like versions-dialog.tsx nests a ConfirmDialog) that can be
// dismissed without resolving it — pdf.js just leaves the task waiting rather than failing, so a
// small reopen button stands in for the dialog once dismissed rather than stranding the user with no
// way back in.
function PdfPasswordPrompt({ attempt, onSubmit }: { attempt: PasswordAttempt; onSubmit: (password: string) => void }) {
	const { t } = useTranslation("preview")
	const [dismissed, setDismissed] = useState(false)

	return (
		<div className="flex size-full items-center justify-center px-6">
			{dismissed ? (
				<Button
					variant="outline"
					onClick={() => {
						setDismissed(false)
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
				type="password"
				autoComplete="current-password"
				submitLabel={t("previewPdfPasswordSubmit")}
				validate={value => value.length > 0}
				onOpenChange={open => {
					setDismissed(!open)
				}}
				onSubmit={onSubmit}
			/>
		</div>
	)
}

// One page's canvas — resolves its own PDFPageProxy on mount (cheap: already-parsed doc structure,
// not rasterization), then renders once metadata is ready AND the parent's lazy gate opens. The gate
// keeps a many-page document from rasterizing every page up front (each canvas allocates
// width*height*4 bytes — the same tab-crashing-allocation concern PREVIEW_MAX_BYTES already guards at
// the whole-file level, just at per-page granularity here). A page's canvas is also released once it
// scrolls past the wider PDF_PAGE_EVICT_MARGIN_PX zone (pdfPageAction below) — without that, a long,
// low-byte-size document could still accumulate hundreds of full-res canvases over one scroll-through
// and exhaust the tab despite never approaching the whole-file byte cap. Re-entering the render
// margin re-renders from scratch; the wrapper div's own size (from the already-resolved `page`, never
// reset by eviction) keeps scroll position stable across an evict/re-render cycle.
function PdfPage({
	doc,
	pageNumber,
	label,
	root,
	shouldRender,
	onIntersect,
	wrapperRef
}: {
	doc: PDFDocumentProxy
	pageNumber: number
	label: string
	root: RefObject<HTMLDivElement | null>
	shouldRender: boolean
	onIntersect: (pageNumber: number, ratio: number, isIntersecting: boolean) => void
	wrapperRef: (el: HTMLDivElement | null) => void
}) {
	const divRef = useRef<HTMLDivElement | null>(null)
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const [page, setPage] = useState<PDFPageProxy | null>(null)
	const [rendered, setRendered] = useState(false)
	// Live (non-monotonic, unlike the parent's renderSet) membership in the wider eviction margin —
	// gates the render effect below (see pdfPageAction) and is itself set from the eviction observer.
	const [withinExtendedView, setWithinExtendedView] = useState(false)

	// Latest onIntersect, read (never as a dependency) from the observer callback below — keeps that
	// effect from tearing down and recreating its IntersectionObserver on every ancestor re-render
	// (currentPage/renderSet change on nearly every scroll frame), which a raw `onIntersect` dependency
	// would otherwise force on every one of those renders.
	const onIntersectRef = useRef(onIntersect)

	useEffect(() => {
		onIntersectRef.current = onIntersect
	})

	useEffect(() => {
		let live = true

		void doc.getPage(pageNumber).then(resolved => {
			if (live) {
				setPage(resolved)
			}
		})

		return () => {
			live = false
		}
	}, [doc, pageNumber])

	useEffect(() => {
		const container = root.current
		const el = divRef.current

		if (!container || !el) {
			return
		}

		const observer = new IntersectionObserver(
			entries => {
				const entry = entries[0]

				if (entry) {
					onIntersectRef.current(pageNumber, entry.intersectionRatio, entry.isIntersecting)
				}
			},
			{ root: container, rootMargin: `${String(PDF_PAGE_RENDER_MARGIN_PX)}px 0px`, threshold: [0, 0.25, 0.5, 0.75, 1] }
		)

		observer.observe(el)

		return () => {
			observer.disconnect()
		}
	}, [root, pageNumber])

	// A second, wider-margin observer purely for eviction — deliberately separate from the one above
	// (which needs fine-grained ratios for the current-page indicator, not a 1200px-wide root). Boolean
	// isIntersecting only, so threshold stays at the default single crossing. Eviction itself (canvas
	// release + un-rendering) runs right here in the callback rather than in a state-driven effect body
	// below — a subscription callback is where React wants an external-system reaction to live
	// (react-hooks/set-state-in-effect), and it also sidesteps ever reading a stale `rendered`: the
	// action is the same (release, unconditionally) whether or not this page had finished rendering.
	useEffect(() => {
		const container = root.current
		const el = divRef.current

		if (!container || !el) {
			return
		}

		const observer = new IntersectionObserver(
			entries => {
				const entry = entries[0]

				if (!entry) {
					return
				}

				setWithinExtendedView(entry.isIntersecting)

				if (!entry.isIntersecting) {
					// Releases a fully-rendered canvas, or one an in-flight render had already sized before
					// the render effect's own cleanup (triggered by the withinExtendedView update above)
					// cancels that task — safe either way; a resized canvas just stops accepting meaningful
					// draws. setRendered(false) when already false is a no-op React bails out on.
					const canvas = canvasRef.current

					if (canvas) {
						canvas.width = 0
						canvas.height = 0
					}

					setRendered(false)
				}
			},
			{ root: container, rootMargin: `${String(PDF_PAGE_EVICT_MARGIN_PX)}px 0px` }
		)

		observer.observe(el)

		return () => {
			observer.disconnect()
		}
	}, [root])

	useEffect(() => {
		if (!page || !shouldRender) {
			return
		}

		const canvas = canvasRef.current

		if (!canvas) {
			return
		}

		if (pdfPageAction(withinExtendedView, rendered) !== "render") {
			return
		}

		let cancelled = false
		const viewport = page.getViewport({ scale: BASE_SCALE })
		const ratio = window.devicePixelRatio
		const dims = canvasDimsForViewport(viewport.width, viewport.height, ratio)

		canvas.width = dims.bufferWidth
		canvas.height = dims.bufferHeight
		canvas.style.width = `${String(dims.cssWidth)}px`
		canvas.style.height = `${String(dims.cssHeight)}px`

		const task: RenderTask = page.render({ canvas, viewport, transform: canvasRenderTransform(ratio) })

		task.promise
			.then(() => {
				if (!cancelled) {
					setRendered(true)
				}
			})
			.catch(() => {
				// A cancelled task rejects too, with a RenderingCancelledException (RenderTask.cancel's own
				// documented contract, confirmed against the installed d.ts) — the `cancelled` guard above
				// already keeps that path from reaching here, and eviction (same cancel path) hits it just
				// as harmlessly. Nothing else surfaces a page-level render error; the document-level error
				// branch already covers a genuinely broken PDF, and a single bad page is rare enough not to
				// warrant its own labeled state yet.
			})

		return () => {
			cancelled = true
			task.cancel()
		}
	}, [page, shouldRender, withinExtendedView, rendered])

	const viewport = page?.getViewport({ scale: BASE_SCALE })

	return (
		<div
			ref={el => {
				divRef.current = el
				wrapperRef(el)
			}}
			className="relative flex shrink-0 items-center justify-center bg-white shadow-sm"
			style={viewport ? { width: viewport.width, height: viewport.height } : { width: 300, height: 400 }}
		>
			{!rendered ? (
				<div className="absolute inset-0 flex items-center justify-center">
					<Spinner className="size-5" />
				</div>
			) : null}
			<canvas
				ref={canvasRef}
				aria-label={label}
				className={rendered ? "block max-w-full" : "invisible"}
			/>
		</div>
	)
}

// The scrollable page list plus its own local toolbar (page indicator + Prev/Next-PAGE buttons) —
// deliberately NOT the overlay's ArrowLeft/ArrowRight (those are sibling-FILE nav, trapped by the
// dialog's own focus scope before they could ever reach this component; reusing them here would also
// just be ambiguous with that outer meaning). Natural scroll plus these buttons are the only page-nav
// surfaces.
function PdfPageList({ doc, alt }: { doc: PDFDocumentProxy; alt: string }) {
	const { t } = useTranslation("preview")
	const numPages = doc.numPages
	const pageNumbers = Array.from({ length: numPages }, (_, i) => i + 1)

	const containerRef = useRef<HTMLDivElement | null>(null)
	const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
	const ratiosRef = useRef<Map<number, number>>(new Map())
	const [renderSet, setRenderSet] = useState<ReadonlySet<number>>(() => new Set([1]))
	const [currentPage, setCurrentPage] = useState(1)

	function handleIntersect(pageNumber: number, ratio: number, isIntersecting: boolean): void {
		ratiosRef.current.set(pageNumber, ratio)

		if (isIntersecting) {
			setRenderSet(prev => (prev.has(pageNumber) ? prev : new Set(prev).add(pageNumber)))
		}

		const entries: PageVisibility[] = Array.from(ratiosRef.current, ([page, r]) => ({ page, ratio: r }))

		setCurrentPage(prev => mostVisiblePage(entries, prev))
	}

	function goToPage(target: number): void {
		const clamped = clampListboxIndex(target - 1, numPages) + 1
		const el = pageRefs.current.get(clamped)

		el?.scrollIntoView({ behavior: "smooth", block: "start" })
	}

	return (
		<div className="flex size-full flex-col">
			<div className="flex h-10 shrink-0 items-center justify-center gap-2 border-b border-border">
				<Button
					variant="ghost"
					size="icon-sm"
					disabled={currentPage <= 1}
					aria-label={t("previewPdfPreviousPageAction")}
					onClick={() => {
						goToPage(currentPage - 1)
					}}
				>
					<ChevronLeftIcon />
				</Button>
				<span className="text-xs text-muted-foreground tabular-nums">
					{t("previewPdfPageIndicator", { current: currentPage, total: numPages })}
				</span>
				<Button
					variant="ghost"
					size="icon-sm"
					disabled={currentPage >= numPages}
					aria-label={t("previewPdfNextPageAction")}
					onClick={() => {
						goToPage(currentPage + 1)
					}}
				>
					<ChevronRightIcon />
				</Button>
			</div>
			<div
				ref={containerRef}
				className="min-h-0 flex-1 overflow-y-auto"
			>
				<div className="flex flex-col items-center gap-4 py-4">
					{pageNumbers.map(pageNumber => (
						<PdfPage
							key={pageNumber}
							doc={doc}
							pageNumber={pageNumber}
							label={`${alt} — ${t("previewPdfPageIndicator", { current: pageNumber, total: numPages })}`}
							root={containerRef}
							shouldRender={renderSet.has(pageNumber)}
							onIntersect={handleIntersect}
							wrapperRef={el => {
								if (el) {
									pageRefs.current.set(pageNumber, el)
								} else {
									pageRefs.current.delete(pageNumber)
								}
							}}
						/>
					))}
				</div>
			</div>
		</div>
	)
}

function PdfDocument({ bytes, alt }: { bytes: Uint8Array; alt: string }) {
	const { t } = useTranslation("preview")
	const { state, submitPassword } = usePdfDocument(bytes)

	if (state.status === "loading") {
		return (
			<div className="flex size-full items-center justify-center">
				<Spinner className="size-6" />
			</div>
		)
	}

	if (state.status === "password") {
		return (
			<PdfPasswordPrompt
				attempt={state.attempt}
				onSubmit={submitPassword}
			/>
		)
	}

	if (state.status === "error") {
		return (
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
				{t("previewPdfLoadFailed")}
			</div>
		)
	}

	return (
		<PdfPageList
			doc={state.doc}
			alt={alt}
		/>
	)
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category) — PdfDocument above owns everything pdf.js-specific once bytes are in hand.
function PdfViewer({ item, alt }: PdfViewerProps) {
	const result = usePreviewBytes(item)

	if (result.status === "pending") {
		return (
			<div className="flex size-full items-center justify-center">
				<Spinner className="size-6" />
			</div>
		)
	}

	if (result.status === "error") {
		return (
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
				{errorLabel(result.dto)}
			</div>
		)
	}

	return (
		<PdfDocument
			bytes={result.bytes}
			alt={alt}
		/>
	)
}

export default PdfViewer
