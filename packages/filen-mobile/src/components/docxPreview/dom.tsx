"use dom"

import { useRef, useState } from "react"
import { renderAsync } from "docx-preview"
import { readAllBytes, type RangeReader } from "@/lib/rangeTransfer"
import useEffectOnce from "@/hooks/useEffectOnce"
import { installDomConsoleProxy } from "@/hooks/useDomEvents/domConsoleProxy"
import { installDomViewportReset } from "@/lib/domViewport"
import {
	classifyDocxLinkHref,
	hardenDocxDom,
	DOCX_EXTERNAL_URL_ATTRIBUTE,
	DOCX_EXTERNAL_LINK_KEY
} from "@/components/docxPreview/linkSafety"

// Forward this WebView's console.* to the RN diagnostic logger (see domConsoleProxy).
installDomConsoleProxy()

// Reset the DOM shell's unstyled body and keep the page clear of the keyboard (#102).
installDomViewportReset()

/**
 * Hand an allowlisted URL to the native side, which opens it with the OS. Posts over the same
 * window.ReactNativeWebView channel the console proxy uses; the envelope key keeps the two apart.
 */
function postExternalLink(url: string): void {
	const rnWebView = (globalThis as unknown as { ReactNativeWebView?: { postMessage?: (message: string) => void } }).ReactNativeWebView

	if (!rnWebView || typeof rnWebView.postMessage !== "function") {
		return
	}

	try {
		rnWebView.postMessage(
			JSON.stringify({
				[DOCX_EXTERNAL_LINK_KEY]: {
					url
				}
			})
		)
	} catch {
		// Tapping a link must never throw out of the event handler.
	}
}

// The DOM-component shell ships `user-scalable=no` in its viewport meta, which blocks
// pinch-zoom on both engines. Relax it for THIS component only — a document preview is
// expected to zoom like the PDF viewer does. Both WebKit and Chromium honor the runtime
// change, and other DOM components (the note editors) keep the shell's no-zoom default.
document
	.querySelector("meta[name=viewport]")
	?.setAttribute("content", "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5")

/**
 * Resource CSP for the rendered document — the airtight half of the docx link/style hardening.
 *
 * linkSafety sanitises attacker-authored CSS as TEXT, which raises the cost of a beacon but cannot
 * be airtight: a `url()` hidden behind CSS ident escaping (`\75 rl(...)`) resolves to a url token in
 * the parser that the sanitiser never saw. A policy the engine itself enforces has no such gap. This
 * kills the whole class in one line: a document that gets ANY remote URL past the sanitiser — via
 * `background-image`, `border-image`, `cursor`, `list-style-image`, `content`, `@font-face`, or an
 * external image relationship — still cannot make the engine fetch it, so there is no beacon (IP,
 * user agent, open time) and no transport for CSS-attribute-selector exfiltration.
 *
 * Applied HERE rather than to the shared DOM shell, which is what previously blocked it: the shell
 * template is common to every DOM component (the note editors legitimately load remote images in
 * markdown), but each component gets its OWN document at runtime. Injecting from this module scope
 * therefore scopes the policy to the docx WebView alone, exactly like the viewport override above,
 * and runs before React mounts and long before renderAsync inserts any document content.
 *
 * Deliberately NOT a `default-src 'none'` lockdown. Only the directives that govern what CSS and
 * document markup can FETCH are set:
 *   - `script-src` / `connect-src` are left alone; constraining them would risk the bundle itself and
 *     Metro's dev channel, and neither is reachable from CSS (renderAltChunks, the one path to
 *     attacker script, is off — `frame-src` below is a second lock on it).
 *   - `style-src` is left alone on purpose: the production shell gains a `<link rel=stylesheet>` if
 *     the bundle ever emits a CSS artifact, and `'self'` does not match a file:// origin, so a
 *     style-src here could break rendering in production only. `@import` stays covered by the
 *     text-level strip in hardenDocxStyles.
 * Nothing legitimate is restricted: docx-preview routes every embedded image and font through
 * `blobToURL`, which with `useBase64URL: true` returns a `data:` URL (`blob:` otherwise), and the
 * only `targetMode === "External"` lookup in the library is for HYPERLINKS, which the tap-time
 * classifier below already governs.
 */
const contentSecurityPolicy = document.createElement("meta")

contentSecurityPolicy.setAttribute("http-equiv", "Content-Security-Policy")
contentSecurityPolicy.setAttribute(
	"content",
	"img-src data: blob:; font-src data: blob:; media-src data: blob:; object-src 'none'; frame-src 'none'"
)

document.head.appendChild(contentSecurityPolicy)

const Dom = ({
	readRange,
	fileSize,
	paddingTop,
	paddingBottom
}: {
	dom?: import("expo/dom").DOMProps
	/**
	 * Pulls the archive across the bridge in bounded pieces. A function rather than the bytes
	 * themselves: expo/dom re-serializes every prop into an injected JS source string on each render
	 * of the host, so a whole-document prop is re-encoded and re-parsed continuously, and a large one
	 * exhausts the renderer. Function props marshal as a name and are exempt.
	 */
	readRange: RangeReader
	fileSize: number
	paddingTop?: number
	paddingBottom?: number
}) => {
	const container = useRef<HTMLDivElement>(null)
	const didLoadRef = useRef<boolean>(false)
	const cancelledRef = useRef<boolean>(false)
	const [error, setError] = useState<string | null>(null)

	const load = async () => {
		const containerElement = container.current

		if (!containerElement || didLoadRef.current) {
			return
		}

		didLoadRef.current = true

		try {
			// docx-preview needs the whole archive: it is a zip, and the central directory is at the end.
			// Chunking bounds what crosses the bridge at once, not what the renderer ultimately holds —
			// the size gate on the native side is what protects the renderer.
			const bytes = await readAllBytes(readRange, fileSize, {
				isCancelled: () => cancelledRef.current
			})

			if (bytes === null || cancelledRef.current) {
				return
			}

			await renderAsync(bytes, containerElement, containerElement, {
				ignoreHeight: true,
				ignoreWidth: true,
				ignoreFonts: false,
				breakPages: true,
				debug: false,
				experimental: true,
				inWrapper: false,
				trimXmlDeclaration: true,
				ignoreLastRenderedPageBreak: true,
				renderHeaders: true,
				renderFooters: true,
				renderFootnotes: true,
				useBase64URL: true,
				renderEndnotes: true,
				// SECURITY-CRITICAL, do not flip. Alt-chunks embed foreign HTML/RTF sub-documents carried
				// inside the file itself, and docx-preview renders one by assigning the raw attacker HTML
				// to `iframe.srcdoc` with NO sandbox attribute — i.e. arbitrary script in this WebView's
				// own origin. The library's default for this option is `true`; it is off here, on web, and
				// (by composition, since it loads the web UI) on desktop.
				renderAltChunks: false,
				renderChanges: true,
				renderComments: true,
				hideWrapperOnPrint: false
			})

			// renderAsync has resolved, so everything the document produced is in the DOM: the library
			// awaits its image tasks and runs postRenderTasks before resolving, and the only work left
			// afterwards (tab-stop refresh, VML sizing) restyles existing nodes with fixed values and
			// creates no anchors. The capture-phase click handler below re-checks at tap time
			// regardless, so a node this sweep somehow misses still cannot navigate anywhere.
			hardenDocxDom(containerElement)
		} catch (e) {
			console.error(e)

			didLoadRef.current = false
			setError("Failed to render document")
		}
	}

	// Safe as a mount-only effect: the host renders this component only once its range source is open,
	// so `readRange` is present at mount and never changes for a given document.
	useEffectOnce(() => {
		load()

		return () => {
			cancelledRef.current = true
		}
	})

	// Link activation, enforced at tap time.
	//
	// This is the layer that actually decides what a tap does, and it is deliberately independent of
	// the render-time sweep: it re-classifies the live href on every activation, so an anchor added
	// after the sweep — or one whose href was changed afterwards — is still checked. Registered in
	// the CAPTURE phase on window so it runs before any handler the document or library installed,
	// and before the browser performs the default action.
	//
	// Keyboard activation (Enter on a focused link) dispatches a click too, so cancelling here covers
	// every way an anchor can be followed.
	useEffectOnce(() => {
		const onClickCapture = (event: MouseEvent) => {
			if (!(event.target instanceof Element)) {
				return
			}

			const anchor = event.target.closest("a")

			if (!anchor) {
				return
			}

			const external = anchor.getAttribute(DOCX_EXTERNAL_URL_ATTRIBUTE)

			if (external !== null) {
				// Cancel the "#" the sweep left behind so the document does not jump to the top, then
				// hand the real URL over. The native side re-validates before opening it.
				event.preventDefault()

				postExternalLink(external)

				return
			}

			const classification = classifyDocxLinkHref(anchor.getAttribute("href"))

			// In-document fragment: let the browser scroll to it as normal.
			if (classification.action === "internal") {
				return
			}

			event.preventDefault()

			if (classification.action === "external") {
				postExternalLink(classification.url)
			}
		}

		window.addEventListener("click", onClickCapture, true)

		return () => {
			window.removeEventListener("click", onClickCapture, true)
		}
	})

	// The browser consults touch-action for visual-viewport panning while pinch-zoomed too —
	// with an explicit pan list, a zoomed document can pan but not always fluidly diagonally.
	// Switch to fully unrestricted touch handling while zoomed (scale > 1) and restore the
	// declared pan/pinch set at 1x. Gesture claims latch at touch-start, so flipping between
	// gestures never glitches mid-pan.
	useEffectOnce(() => {
		const visualViewport = window.visualViewport

		if (!visualViewport) {
			return
		}

		const onResize = () => {
			if (!container.current) {
				return
			}

			container.current.style.touchAction = visualViewport.scale > 1.01 ? "auto" : "pan-y pan-x pinch-zoom"
		}

		visualViewport.addEventListener("resize", onResize)

		return () => {
			visualViewport.removeEventListener("resize", onResize)
		}
	})

	if (error !== null) {
		return (
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					paddingTop: paddingTop ? `${paddingTop}px` : undefined,
					paddingBottom: paddingBottom ? `${paddingBottom}px` : undefined
				}}
			>
				<span style={{ color: "#888", fontSize: "14px" }}>{error}</span>
			</div>
		)
	}

	return (
		<div
			ref={container}
			style={{
				width: "100%",
				height: "100%",
				overflow: "auto",
				paddingTop: paddingTop ? `${paddingTop}px` : undefined,
				paddingBottom: paddingBottom ? `${paddingBottom}px` : undefined,
				// With inWrapper: false the library's white-page rule (.docx-wrapper>section.docx)
				// never applies, and documents without an explicit <w:background> render as black
				// text on a transparent page — invisible over the app's dark background. Paint the
				// paper ourselves; a document's own background color still layers on top.
				backgroundColor: "#ffffff",
				// Panning alone (pan-x/pan-y) suppresses browser pinch-zoom at the element
				// level — pinch-zoom must be explicitly re-allowed alongside it.
				touchAction: "pan-y pinch-zoom pan-x"
			}}
		/>
	)
}

export default Dom
