"use dom"

// Static side-effect import: sets globalThis.pdfjsWorker so PDFWorker resolves a main-thread ("fake")
// worker and returns before it would otherwise dynamic-import a worker script. GlobalWorkerOptions
// .workerSrc is deliberately never set — on this path it is never read. A real Worker cannot be used:
// in a release build the document origin is file://, where the origin is literally "null", so pdf.js
// wraps the worker in a module blob that the engine then refuses to load.
import "pdfjs-dist/legacy/build/pdf.worker.mjs"

import { useEffect, useRef, useState } from "react"
import { AnnotationLayer, AnnotationMode, getDocument, PDFDataRangeTransport, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs"
import { CMAPS, STANDARD_FONTS, WASM_BINARIES } from "@/components/pdfPreview/assets.generated"
import { buildPdfDocumentOptions } from "@/components/pdfPreview/options"
import { classifyPdfError } from "@/components/pdfPreview/errors"
import {
	PDF_EVENT_KEY,
	PDF_EXTERNAL_LINK_KEY,
	PDF_EXTERNAL_URL_ATTRIBUTE,
	type PdfPasswordResponse,
	type PdfSaveRequest,
	type PdfViewerEvent
} from "@/components/pdfPreview/protocol"
import { PDF_MAX_PAGE_CANVAS_BYTES, PDF_MAX_RANGE_LENGTH, PDF_MAX_ZOOM } from "@/components/pdfPreview/constants"
import { hardenFormWidgets } from "@/components/pdfPreview/formWidgets"
import { attachTextLayerSelection } from "@/components/pdfPreview/textSelection"
import { classifyUntrustedLinkHref } from "@/lib/untrustedLinks"
import { installDomConsoleProxy } from "@/hooks/useDomEvents/domConsoleProxy"
import useEffectOnce from "@/hooks/useEffectOnce"

installDomConsoleProxy()

/**
 * Resource CSP for the rendered document.
 *
 * Injected here rather than into the shared DOM shell, which every DOM component uses: each component
 * gets its own document at runtime, so a module-scope injection scopes the policy to this WebView
 * alone. It runs before React mounts and long before any document content exists.
 *
 * `connect-src 'none'` is production-only. Development needs the Metro channel, and development is a
 * developer's machine; production is what faces an attacker-authored document. Everything else is
 * identical in both.
 *
 * `script-src` and `style-src` stay omitted deliberately. `'self'` does not match a file:// origin, so
 * setting them would break rendering in release builds only — and there is nothing left for them to
 * defend: this version of pdf.js contains no eval path, the scripting sandbox is not bundled, and XFA
 * is off. `worker-src 'none'` is affordable precisely because of the fake-worker decision above.
 */
const contentSecurityPolicy = document.createElement("meta")

contentSecurityPolicy.setAttribute("http-equiv", "Content-Security-Policy")
contentSecurityPolicy.setAttribute(
	"content",
	[
		"img-src data: blob:",
		"font-src data: blob:",
		"media-src data: blob:",
		"object-src 'none'",
		"frame-src 'none'",
		"worker-src 'none'",
		"child-src 'none'",
		"form-action 'none'",
		"base-uri 'none'",
		...(process.env.NODE_ENV === "production" ? ["connect-src 'none'"] : [])
	].join("; ")
)

document.head.appendChild(contentSecurityPolicy)

// The shell ships user-scalable=no, which blocks pinch-zoom on both engines. A document viewer is
// expected to zoom, so relax it for THIS component only, to the same ceiling the native viewer had.
document
	.querySelector("meta[name=viewport]")
	?.setAttribute("content", `width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=${PDF_MAX_ZOOM}`)

// Authored rather than shipped: pdfjs-dist's stylesheet references ~80 image assets by relative URL,
// none of which are fetchable at a file:// origin.
//
// The custom properties are not decoration — they are a contract. TextLayer positions each span with
// a percentage left/top plus `font-size: calc(var(--text-scale-factor) * var(--font-height))` and a
// transform built from --scale-x / --rotate / --min-font-size-inv, and setLayerDimensions sizes the
// layer with `round(down, var(--total-scale-factor) * <pagePx>, var(--scale-round-x))`. Omit these and
// every span falls back to 16px, so the selection highlight sits somewhere other than the glyphs it
// claims to cover. --total-scale-factor is set per page, since it is the CSS scale of that page.
//
// `round()` needs a newer engine than the rest of this file does; `inset: 0` above is the deliberate
// fallback, so a WebView that cannot parse the width/height declaration still gets a correctly sized
// layer from the containing page div.
const styles = document.createElement("style")

styles.textContent = `
	/* The DOM shell sets -webkit-overflow-scrolling on html/body but never gives them a height, so a
	   height:100% child resolves against auto and never becomes a scroller: the document grows to fit
	   every page instead, which both defeats virtualization and makes the IntersectionObserver root
	   meaningless (everything intersects, so every page renders at once). */
	html, body { height: 100%; margin: 0; }
	#root { height: 100%; }
	.pdfPage { position: relative; margin: 0 auto 8px auto; background: #fff; overflow: hidden; }
	.pdfPage canvas { display: block; width: 100%; height: 100%; }
	.textLayer {
		position: absolute; inset: 0; overflow: clip; opacity: 1; line-height: 1;
		text-align: initial; forced-color-adjust: none; color-scheme: only light;
		transform-origin: 0 0; caret-color: CanvasText; z-index: 1;
		/* Metrics, not cosmetics: an inherited letter- or word-spacing would shift every run away from
		   the glyphs painted underneath it, and iOS honours the -webkit- prefixed size-adjust, so
		   omitting it lets the engine resize this text out of alignment on that platform alone. */
		letter-spacing: normal; word-spacing: normal;
		-webkit-text-size-adjust: none; text-size-adjust: none;
		/* The layer is NOT selectable; only the runs inside it are. Text runs are sparse boxes, so most
		   of a page is gap — and a touch is far less precise than a cursor, so a long press usually
		   lands on the layer rather than on a run. With the layer selectable the engine has nothing
		   finer to choose and selects the whole block, which is exactly "it selected the entire page".
		   Making the container unselectable removes that fallback while leaving the runs selectable. */
		user-select: none; -webkit-user-select: none;
		--scale-round-x: 1px;
		--scale-round-y: 1px;
		--min-font-size: 1;
		--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
		--min-font-size-inv: calc(1 / var(--min-font-size));
	}
	/* Split exactly as upstream does. Merging these into one selector also matched the selection
	   anchor, which is a direct child of the layer but not a text run, and handed it the selectable
	   properties it must never have. */
	.textLayer :is(span, br) {
		color: transparent; position: absolute; white-space: pre; cursor: text;
		transform-origin: 0% 0%; user-select: text; -webkit-user-select: text;
	}
	.textLayer > :not(.markedContent),
	.textLayer .markedContent span:not(.markedContent) {
		z-index: 1;
		--font-height: 0;
		font-size: calc(var(--text-scale-factor) * var(--font-height));
		--scale-x: 1;
		--rotate: 0deg;
		transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
	}
	.textLayer .markedContent { display: contents; }
	.textLayer.highlighting { touch-action: none; }
	/* The selection anchor. Absolutely positioned runs have no flow between them, so a drag that
	   leaves the last run has nothing to end on and the engine selects the whole block instead. This
	   normally sits below the layer and unselectable; while a selection is in progress the selecting
	   class pulls it up to cover the layer so there is something to anchor to. */
	.textLayer .endOfContent {
		display: block; position: absolute; inset: 100% 0 0; z-index: 0; cursor: default;
		user-select: none; -webkit-user-select: none;
		/* While a selection is in progress this element is stretched to cover the whole layer. It only
		   needs to exist in the DOM as somewhere for the selection to end — it must never become the
		   hit target, or every touch after the selection starts lands on an unselectable box and the
		   engine falls back to selecting the block that contains it. */
		pointer-events: none;
	}
	.textLayer.selecting .endOfContent { top: 0; }
	/* setLayerDimensions stamps data-main-rotation on both layers from the page's own /Rotate. Without
	   these the canvas is drawn rotated while the text and annotation layers are not, so on a rotated
	   page — which scans very often are — selection lands nowhere near the glyphs and links sit in the
	   wrong place. Copied from the upstream stylesheet. */
	[data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%); }
	[data-main-rotation="180"] { transform: rotate(180deg) translate(-100%, -100%); }
	[data-main-rotation="270"] { transform: rotate(270deg) translateX(-100%); }
	.textLayer ::selection { background: rgba(0, 100, 255, 0.28); }
	.annotationLayer { position: absolute; inset: 0; transform-origin: 0 0; pointer-events: none; z-index: 2; }
	.annotationLayer section { position: absolute; pointer-events: auto; box-sizing: border-box; }
	.annotationLayer .linkAnnotation a { display: block; width: 100%; height: 100%; }
	.annotationLayer input, .annotationLayer textarea, .annotationLayer select {
		position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box;
		font-size: 13px; background: rgba(0, 100, 255, 0.06); border: 1px solid rgba(0, 100, 255, 0.35);
	}
`

document.head.appendChild(styles)

function base64ToBytes(encoded: string): Uint8Array {
	const binary = atob(encoded)
	const bytes = new Uint8Array(binary.length)

	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index)
	}

	return bytes
}

/**
 * Hands pdf.js its font data directly instead of letting it fetch anything. pdf.js constructs this
 * with { cMapUrl, standardFontDataUrl, wasmUrl } and then calls fetch({ kind, filename }); those
 * constructor arguments are irrelevant here because nothing is resolved by URL.
 *
 * The wasm decoders are served from here too, and that is not optional: in this version ordinary
 * CCITTFax (G4 fax compression, which a great many scanned documents use) decodes through jbig2.wasm,
 * and without it those images are skipped silently — a scanned PDF would render as blank white pages
 * with no error at all.
 *
 * cMaps are served from here too, so a document referencing a CJK encoding without embedding the font
 * still renders its text.
 *
 * ICC colour management is off entirely, and not by choice: pdf.js disables it whenever
 * `useWorkerFetch` is false, which is pinned off here because leaving it to inference is what makes a
 * release build behave differently from development. Documents with ICC-based colour spaces fall back
 * to an unmanaged conversion — slightly different colours, never a failure to render.
 */
class InlineBinaryDataFactory {
	async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
		const encoded =
			kind === "standardFontDataUrl"
				? STANDARD_FONTS[filename]
				: kind === "wasmUrl"
					? WASM_BINARIES[filename]
					: kind === "cMapUrl"
						? CMAPS[filename]
						: undefined

		if (encoded === undefined) {
			throw new Error(`asset not bundled: ${kind}/${filename}`)
		}

		return base64ToBytes(encoded)
	}
}

/**
 * A short, safe label for a failure. Deliberately the error's NAME only: pdf.js embeds
 * document-controlled fragments in its messages, and this string reaches the persisted log.
 */
function describeError(error: unknown): string {
	if (typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string") {
		return (error as { name: string }).name
	}

	return "unknown"
}

function post(message: unknown): void {
	const rnWebView = (globalThis as unknown as { ReactNativeWebView?: { postMessage?: (message: string) => void } }).ReactNativeWebView

	if (!rnWebView || typeof rnWebView.postMessage !== "function") {
		return
	}

	try {
		rnWebView.postMessage(JSON.stringify(message))
	} catch {
		// Reporting must never throw out of the path that was reporting a failure.
	}
}

function postEvent(event: PdfViewerEvent): void {
	post({
		[PDF_EVENT_KEY]: event
	})
}

function postExternalLink(url: string): void {
	post({
		[PDF_EXTERNAL_LINK_KEY]: {
			url
		}
	})
}

/**
 * The link service the annotation layer calls into.
 *
 * pdf.js's own service assigns real hrefs and permits schemes we do not (ftp: among them). This one
 * never produces a navigable URL: an allowlisted external target is stashed on a data attribute for
 * the capture-phase handler to pick up, and everything else becomes an inert anchor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createLinkService(goToPage: (pageNumber: number) => void, getPdfDocument: () => any) {
	return {
		externalLinkTarget: null,
		externalLinkRel: null,
		eventBus: null,
		addLinkAttributes(link: HTMLAnchorElement, url: string): void {
			const classification = classifyUntrustedLinkHref(url)

			link.href = "#"

			if (classification.action === "external") {
				link.setAttribute(PDF_EXTERNAL_URL_ATTRIBUTE, classification.url)
			}
		},
		getAnchorUrl(): string {
			return "#"
		},
		getDestinationHash(): string {
			return "#"
		},
		async goToDestination(dest: unknown): Promise<void> {
			// In-document destinations never leave the viewer, so they are resolved here rather than being
			// handed to the host.
			//
			// pdf.js passes either a named destination (a string, needing a lookup) or an explicit
			// destination array whose first element is a page reference — never a page number. An earlier
			// version of this method only handled a number and returned early on the array, which made
			// every table-of-contents entry a silent no-op.
			const pdfDocument = getPdfDocument()

			if (!pdfDocument) {
				return
			}

			try {
				const explicit = typeof dest === "string" ? await pdfDocument.getDestination(dest) : dest

				if (!Array.isArray(explicit) || explicit.length === 0) {
					return
				}

				const pageIndex = await pdfDocument.getPageIndex(explicit[0])

				goToPage(pageIndex + 1)
			} catch {
				// A destination pointing at nothing is a broken document, not a viewer failure.
			}
		},
		goToPage(pageNumber: number): void {
			goToPage(pageNumber)
		},
		async getAttachmentContent(): Promise<null> {
			// Embedded attachments are not offered. Returning null rather than leaving the method missing
			// keeps a tap from producing an unhandled rejection inside the annotation layer.
			return null
		},
		executeNamedAction(): void {
			// Print, Download, SaveAs and friends. Nothing here is offered to a document.
		},
		executeSetOCGState(): void {
			// Optional-content state changes are ignored; they are a document-driven state machine we
			// have no use for.
		}
	}
}

type PageEntry = {
	container: HTMLDivElement
	rendered: boolean
	// Bumped on every release. Every await in renderPage re-checks it, so a continuation belonging to a
	// render that was already torn down cannot repopulate a container that has since been cleared —
	// which would otherwise leave a page permanently marked un-rendered, never released again, and
	// leaking its canvas for the life of the document.
	epoch: number
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	task: any | null
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	textLayer: any | null
	detachSelection: (() => void) | null
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	page: any | null
}

const Dom = ({
	readRange,
	writeChunk,
	fileSize,
	passwordResponse,
	saveRequest,
	readOnly,
	paddingTop,
	paddingBottom,
	paddingLeft,
	paddingRight
}: {
	dom?: import("expo/dom").DOMProps
	readRange: (offset: number, length: number) => Promise<string>
	writeChunk: (chunk: string) => Promise<void>
	fileSize: number
	passwordResponse: PdfPasswordResponse | null
	saveRequest: PdfSaveRequest | null
	readOnly: boolean
	paddingTop?: number
	paddingBottom?: number
	paddingLeft?: number
	paddingRight?: number
}) => {
	const scrollRef = useRef<HTMLDivElement>(null)
	const entriesRef = useRef<Map<number, PageEntry>>(new Map())
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const documentRef = useRef<any>(null)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const linkServiceRef = useRef<any>(null)
	const scaleRef = useRef<number>(1)
	// How far the user has pinched in. Pages re-rasterise at this multiple so zooming sharpens instead
	// of magnifying the pixels already on screen.
	const zoomRef = useRef<number>(1)
	const paintedRef = useRef<boolean>(false)
	const passwordResolverRef = useRef<((password: string) => void) | null>(null)
	const pendingRequestIdRef = useRef<string | null>(null)
	const [fatal, setFatal] = useState<boolean>(false)

	// A password can only arrive after mount, as a prop update. The requestId match is what stops a
	// stale answer from resolving a later prompt: pdf.js hands out a fresh resolver each time it asks,
	// and feeding it the previous attempt's password would loop.
	useEffect(() => {
		if (passwordResponse === null || passwordResponse.requestId !== pendingRequestIdRef.current) {
			return
		}

		const resolve = passwordResolverRef.current

		pendingRequestIdRef.current = null
		passwordResolverRef.current = null

		resolve?.(passwordResponse.password)
	}, [passwordResponse])

	useEffectOnce(() => {
		// Capability gate. Both are hard requirements: pdf.js's main-thread worker moves messages
		// through structuredClone, and there is nothing to render onto without a 2d context. Reporting
		// `unsupported` is what lets the host show "cannot preview here" instead of a permanent spinner.
		if (typeof structuredClone !== "function") {
			postEvent({
				event: "unsupported",
				reason: "structuredClone"
			})

			setFatal(true)

			return
		}

		if (!document.createElement("canvas").getContext("2d")) {
			postEvent({
				event: "unsupported",
				reason: "canvas"
			})

			setFatal(true)

			return
		}

		postEvent({
			event: "ready"
		})

		const scrollElement = scrollRef.current

		if (!scrollElement) {
			return
		}

		let destroyed = false
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let loadingTask: any = null
		let observer: IntersectionObserver | null = null
		let resizeObserver: ResizeObserver | null = null
		let zoomSettleTimer: ReturnType<typeof setTimeout> | null = null
		let cleanupZoom: (() => void) | null = null

		const goToPage = (pageNumber: number) => {
			entriesRef.current.get(pageNumber)?.container.scrollIntoView()
		}

		linkServiceRef.current = createLinkService(goToPage, () => documentRef.current)

		const renderPage = async (pageNumber: number) => {
			const entry = entriesRef.current.get(pageNumber)
			const pdfDocument = documentRef.current

			if (!entry || entry.rendered || !pdfDocument || destroyed) {
				return
			}

			entry.rendered = true

			const epoch = entry.epoch
			const current = () => !destroyed && entry.epoch === epoch

			try {
				const page = await pdfDocument.getPage(pageNumber)

				if (!current()) {
					return
				}

				entry.page = page

				const viewport = page.getViewport({
					scale: scaleRef.current
				})

				// Backing-store resolution. Full device pixel ratio — an earlier cap of 2 threw away a third
				// of the resolution on a 3x screen and made every page look soft — multiplied by how far the
				// user has pinched in, so zooming re-rasterises instead of stretching the bitmap it already
				// had. Bounded by total backing-store bytes, with no floor: on an extreme page the byte cap
				// has to be allowed to pull the ratio below device scale, or the cap it exists to enforce is
				// simply ignored.
				const maxRatio = Math.sqrt(PDF_MAX_PAGE_CANVAS_BYTES / 4 / Math.max(viewport.width * viewport.height, 1))
				const ratio = Math.min((globalThis.devicePixelRatio || 1) * zoomRef.current, maxRatio)
				const canvas = document.createElement("canvas")

				canvas.width = Math.floor(viewport.width * ratio)
				canvas.height = Math.floor(viewport.height * ratio)

				entry.container.style.height = `${Math.floor(viewport.height)}px`
				// The layers position themselves against this; it is the CSS scale of this page.
				entry.container.style.setProperty("--total-scale-factor", `${scaleRef.current}`)
				entry.container.replaceChildren(canvas)

				const renderViewport = page.getViewport({
					scale: scaleRef.current * ratio
				})

				const task = page.render({
					canvas,
					viewport: renderViewport,
					// Display-only when the file cannot be written back: offering an editable field for a
					// change that can never be saved is worse than not offering it.
					annotationMode: readOnly ? AnnotationMode.ENABLE : AnnotationMode.ENABLE_FORMS
				})

				entry.task = task

				await task.promise

				if (!current()) {
					return
				}

				entry.task = null

				// Reported as soon as there are pixels, not after the text and annotation layers. Those can
				// fail on their own, and holding the host's overlay until all three succeed turned any one
				// of them failing into a spinner that never goes away.
				if (!paintedRef.current) {
					paintedRef.current = true

					postEvent({
						event: "firstPagePainted"
					})
				}

				// Each layer is attempted on its own. Sharing one try meant a text layer that threw also
				// skipped the annotation layer, so a single failure cost both selection AND every link on
				// the page — and the two have nothing to do with each other.
				try {
					const textLayerDiv = document.createElement("div")

					textLayerDiv.className = "textLayer"
					entry.container.appendChild(textLayerDiv)

					const textLayer = new TextLayer({
						// streamTextContent, NOT getTextContent: the latter collects the stream with
						// `for await (… of readableStream)`, and WebKit has no asyncIterator on ReadableStream,
						// so it throws on every page and iOS gets no text layer at all. TextLayer takes the
						// stream directly and reads it with getReader(). Params match the upstream viewer.
						textContentSource: page.streamTextContent({
							includeMarkedContent: true,
							disableNormalization: true
						}),
						container: textLayerDiv,
						viewport
					})

					if (!current()) {
						textLayer.cancel()

						return
					}

					entry.textLayer = textLayer

					await textLayer.render()

					if (current()) {
						entry.detachSelection = attachTextLayerSelection(textLayerDiv)
					}
				} catch (error) {
					console.warn(`[pdfPreview] text layer failed on page ${pageNumber}: ${describeError(error)}`)
				}

				if (!current()) {
					return
				}

				const annotationDiv = document.createElement("div")

				annotationDiv.className = "annotationLayer"
				entry.container.appendChild(annotationDiv)

				const annotations = await page.getAnnotations({
					intent: "display"
				})

				if (!current()) {
					return
				}

				const annotationViewport = viewport.clone({
					dontFlip: true
				})

				const annotationLayer = new AnnotationLayer({
					div: annotationDiv,
					page,
					viewport: annotationViewport,
					linkService: linkServiceRef.current,
					annotationStorage: pdfDocument.annotationStorage,
					// Explicitly absent. The editor UI manager would bring annotation editing (and a
					// 16-argument surface we have no use for); the accessibility and struct-tree managers
					// belong to the full viewer we deliberately do not ship.
					accessibilityManager: null,
					annotationCanvasMap: null,
					annotationEditorUIManager: null,
					structTreeLayer: null,
					commentManager: null
				})

				await annotationLayer.render({
					annotations,
					div: annotationDiv,
					page,
					viewport: annotationViewport,
					linkService: linkServiceRef.current,
					// Forms render and are fillable. Scripting stays off: `enableScripting` is omitted, so
					// the annotation layer's own opt-in default (false) applies, and `hasJSActions` is
					// withheld so no JS-action path can be reached even if that changed. No downloadManager
					// is passed either — it is the only window.open in the distribution.
					renderForms: !readOnly
				})

				if (!current()) {
					return
				}

				hardenFormWidgets(annotationDiv)
			} catch (error) {
				const classification = classifyPdfError(error)

				if (classification.type === "aborted" || !current()) {
					return
				}

				// One page failing is not the document failing — leave the placeholder and carry on. But if
				// nothing has painted yet there is nothing to carry on to, and the host is still holding an
				// opaque overlay, so that case has to be reported rather than logged.
				entry.rendered = false

				// The error NAME (a pdf.js class) is safe to record; its message is not, because a document
				// controls parts of it and this reaches the persisted log.
				console.warn(`[pdfPreview] page ${pageNumber} failed to render: ${describeError(error)}`)

				if (!paintedRef.current) {
					postEvent({
						event: "error",
						kind: "renderFailed"
					})
				}
			}
		}

		const releasePage = (pageNumber: number) => {
			const entry = entriesRef.current.get(pageNumber)

			if (!entry) {
				return
			}

			// Not gated on `rendered`: a page whose render threw is marked un-rendered while its canvas is
			// still attached, and skipping it here would leave that canvas alive for the life of the
			// document.
			entry.epoch++
			entry.task?.cancel()
			entry.task = null
			entry.textLayer?.cancel()
			entry.textLayer = null
			entry.detachSelection?.()
			entry.detachSelection = null
			entry.rendered = false

			// Frees the decoded images and the operator list this page was holding.
			entry.page?.cleanup()
			entry.container.replaceChildren()
		}

		const load = async () => {
			const transport = new PDFDataRangeTransport(fileSize, new Uint8Array(0), false, undefined)

			// pdf.js requests an END offset; the bridge RPC takes a LENGTH. This is the one place that
			// knows both conventions.
			//
			// The request is split into reader-sized pieces before being reassembled. pdf.js merges
			// contiguous chunks with no upper bound before asking, so a single object spanning enough of
			// them — a multi-megabyte scanned image, a large embedded font — asks for more than the
			// reader's per-call cap allows. Failing that request is not recoverable: pdf.js does not
			// re-request a range that errored, so the document is dead for the rest of the session.
			// Splitting keeps the RPC's bound tight without letting it decide which documents can open.
			transport.requestDataRange = (begin: number, end: number) => {
				const fetchRange = async () => {
					const total = end - begin

					if (total <= 0) {
						return
					}

					const merged = new Uint8Array(total)
					let offset = begin

					while (offset < end) {
						const length = Math.min(PDF_MAX_RANGE_LENGTH, end - offset)
						const chunk = base64ToBytes(await readRange(offset, length))

						if (destroyed) {
							return
						}

						merged.set(chunk, offset - begin)

						offset += chunk.byteLength
					}

					// `begin` must be echoed exactly — pdf.js asserts on it — so the pieces are reassembled
					// and handed over as the single range that was asked for.
					transport.onDataRange(begin, merged)
				}

				fetchRange().catch(() => {
					if (!destroyed) {
						postEvent({
							event: "error",
							kind: "transportFailed"
						})
					}
				})
			}

			loadingTask = getDocument(
				buildPdfDocumentOptions({
					binaryDataFactory: InlineBinaryDataFactory,
					range: transport
				})
			)

			loadingTask.onPassword = (updatePassword: (password: string) => void, code: number) => {
				const requestId = `${Date.now()}-${entriesRef.current.size}`

				pendingRequestIdRef.current = requestId
				passwordResolverRef.current = updatePassword

				postEvent({
					event: "passwordRequired",
					requestId,
					reason: code === 2 ? "incorrect" : "required"
				})
			}

			const pdfDocument = await loadingTask.promise

			if (destroyed) {
				return
			}

			documentRef.current = pdfDocument

			if (pdfDocument.numPages < 1) {
				// Nothing will ever paint, so nothing would ever clear the host's overlay.
				postEvent({
					event: "error",
					kind: "invalidDocument"
				})

				return
			}

			postEvent({
				event: "documentOpened",
				pageCount: pdfDocument.numPages
			})

			const firstPage = await pdfDocument.getPage(1)
			const baseViewport = firstPage.getViewport({
				scale: 1
			})

			// clientWidth can be 0 if layout has not settled; a zero scale renders a zero-size canvas and
			// dismisses the spinner over a blank document, which looks like a corrupt file.
			const computeScale = () => {
				// clientWidth includes padding, but the page divs are laid out in the content box. Using the
				// padded width overstates the available space by the safe-area insets, which squashes every
				// page horizontally in landscape and drags the text layer out of alignment with it.
				const style = globalThis.getComputedStyle(scrollElement)
				const horizontalPadding = parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0")
				const width = scrollElement.clientWidth - horizontalPadding

				return width > 0 ? width / baseViewport.width : 1
			}

			scaleRef.current = computeScale()

			// Rotation and split-screen change the available width. Without this the pages keep the scale
			// they were first laid out at and stay stretched for the rest of the session.
			const onResize = () => {
				const next = computeScale()

				if (destroyed || Math.abs(next - scaleRef.current) < 0.01) {
					return
				}

				scaleRef.current = next

				for (const [pageNumber, entry] of entriesRef.current) {
					const wasRendered = entry.rendered

					releasePage(pageNumber)

					entry.container.style.height = `${Math.floor(baseViewport.height * next)}px`

					if (wasRendered) {
						renderPage(pageNumber)
					}
				}
			}

			resizeObserver = new ResizeObserver(onResize)

			resizeObserver.observe(scrollElement)

			// Re-rasterise the visible pages once a pinch settles. Debounced because the event fires
			// continuously through the gesture and each re-render is real work; the byte cap in renderPage
			// keeps a deep zoom from allocating without bound.
			const visualViewport = globalThis.visualViewport

			const onZoom = () => {
				if (zoomSettleTimer !== null) {
					clearTimeout(zoomSettleTimer)
				}

				zoomSettleTimer = setTimeout(() => {
					const next = Math.min(visualViewport?.scale ?? 1, PDF_MAX_ZOOM)

					if (destroyed || Math.abs(next - zoomRef.current) < 0.2) {
						return
					}

					zoomRef.current = next

					for (const [pageNumber, entry] of entriesRef.current) {
						if (!entry.rendered) {
							continue
						}

						releasePage(pageNumber)
						renderPage(pageNumber)
					}
				}, 220)
			}

			visualViewport?.addEventListener("resize", onZoom)

			cleanupZoom = () => {
				if (zoomSettleTimer !== null) {
					clearTimeout(zoomSettleTimer)
				}

				visualViewport?.removeEventListener("resize", onZoom)
			}

			const estimatedHeight = Math.floor(baseViewport.height * scaleRef.current)

			observer = new IntersectionObserver(
				entries => {
					for (const entry of entries) {
						const pageNumber = Number(entry.target.getAttribute("data-page"))

						if (!Number.isInteger(pageNumber)) {
							continue
						}

						if (entry.isIntersecting) {
							renderPage(pageNumber)
						} else {
							releasePage(pageNumber)
						}
					}
				},
				{
					root: scrollElement,
					// One viewport of lookahead in each direction, so a page is ready before it is reached
					// without holding the whole document.
					rootMargin: "100% 0px"
				}
			)

			for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
				const container = document.createElement("div")

				container.className = "pdfPage"
				container.setAttribute("data-page", String(pageNumber))
				container.style.width = "100%"
				container.style.height = `${estimatedHeight}px`

				scrollElement.appendChild(container)

				entriesRef.current.set(pageNumber, {
					container,
					rendered: false,
					epoch: 0,
					task: null,
					textLayer: null,
					detachSelection: null,
					page: null
				})

				observer.observe(container)
			}
		}

		load().catch(error => {
			const classification = classifyPdfError(error)

			if (classification.type === "aborted") {
				return
			}

			postEvent({
				event: "error",
				kind: classification.type === "error" ? classification.kind : "unknown"
			})

			setFatal(true)
		})

		return () => {
			destroyed = true

			observer?.disconnect()
			resizeObserver?.disconnect()
			cleanupZoom?.()

			for (const pageNumber of entriesRef.current.keys()) {
				releasePage(pageNumber)
			}

			entriesRef.current.clear()

			// destroy() is on the loading task; the document proxy only has cleanup().
			loadingTask?.destroy()
		}
	})

	// Serialise the document and stream it back when the host asks. saveDocument() returns the whole
	// file, so it is sliced to the same bound the reader uses rather than crossing the bridge whole.
	useEffect(() => {
		if (saveRequest === null) {
			return
		}

		let cancelled = false

		const run = async () => {
			const pdfDocument = documentRef.current

			if (!pdfDocument) {
				postEvent({
					event: "saveFailed",
					requestId: saveRequest.requestId
				})

				return
			}

			try {
				const bytes: Uint8Array = await pdfDocument.saveDocument()

				for (let offset = 0; offset < bytes.byteLength; offset += PDF_MAX_RANGE_LENGTH) {
					if (cancelled) {
						return
					}

					const slice = bytes.subarray(offset, Math.min(offset + PDF_MAX_RANGE_LENGTH, bytes.byteLength))
					let binary = ""

					for (let index = 0; index < slice.length; index++) {
						binary += String.fromCharCode(slice[index] ?? 0)
					}

					await writeChunk(btoa(binary))
				}

				if (cancelled) {
					return
				}

				// The stored edits are now on disk; anything after this is a fresh change.
				pdfDocument.annotationStorage.resetModified()

				postEvent({
					event: "saved",
					requestId: saveRequest.requestId,
					byteLength: bytes.byteLength
				})
			} catch (error) {
				console.warn(`[pdfPreview] save failed: ${describeError(error)}`)

				postEvent({
					event: "saveFailed",
					requestId: saveRequest.requestId
				})
			}
		}

		run()

		return () => {
			cancelled = true
		}
	}, [saveRequest, writeChunk])

	// Link activation, decided at tap time rather than at render time, so an anchor added or mutated
	// after the sweep is still checked. Capture phase on window, so it runs before any handler pdf.js
	// installed and before the engine performs the default action. Keyboard activation dispatches a
	// click too, so this covers every way an anchor can be followed.
	useEffectOnce(() => {
		const onActivate = (event: MouseEvent) => {
			if (!(event.target instanceof Element)) {
				return
			}

			const anchor = event.target.closest("a")

			if (!anchor) {
				return
			}

			const external = anchor.getAttribute(PDF_EXTERNAL_URL_ATTRIBUTE)

			event.preventDefault()

			if (external !== null) {
				postExternalLink(external)
			}
		}

		const onSubmit = (event: Event) => {
			// A document cannot be allowed to submit anything. form-action 'none' already blocks the
			// navigation; this stops the attempt earlier and keeps the page from appearing to act.
			event.preventDefault()
		}

		// Re-coerce on focus: autofill decides at focus time, and a field could have been recreated by
		// a re-render between the last sweep and the tap.
		const onFocusIn = (event: FocusEvent) => {
			if (event.target instanceof HTMLInputElement) {
				hardenFormWidgets(event.target.parentNode ?? document)
			}
		}

		window.addEventListener("click", onActivate, true)
		window.addEventListener("auxclick", onActivate, true)
		window.addEventListener("submit", onSubmit, true)
		window.addEventListener("focusin", onFocusIn, true)

		return () => {
			window.removeEventListener("click", onActivate, true)
			window.removeEventListener("auxclick", onActivate, true)
			window.removeEventListener("submit", onSubmit, true)
			window.removeEventListener("focusin", onFocusIn, true)
		}
	})

	return (
		<div
			ref={scrollRef}
			style={{
				width: "100%",
				height: "100%",
				overflow: "auto",
				background: "#1c1c1e",
				paddingTop: paddingTop ? `${paddingTop}px` : undefined,
				paddingBottom: paddingBottom ? `${paddingBottom}px` : undefined,
				paddingLeft: paddingLeft ? `${paddingLeft}px` : undefined,
				paddingRight: paddingRight ? `${paddingRight}px` : undefined,
				// Panning alone suppresses pinch-zoom at the element level, so it has to be re-allowed
				// explicitly alongside it.
				touchAction: "pan-x pan-y pinch-zoom",
				opacity: fatal ? 0 : 1
			}}
		/>
	)
}

export default Dom
