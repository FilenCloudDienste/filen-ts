import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { renderAsync } from "docx-preview"
import { collectBlobUrls, sanitizeDocxLinks } from "@/features/preview/lib/docxDom"
import { LoadingState } from "@/components/loadingState"
import { PreviewErrorState } from "@/features/preview/components/previewErrorState"
import { useTrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"

// docx-preview, kept for one release only as the automatic fallback for documents the own engine
// (docxViewer.tsx) fails on; removed with docxDom.ts after that.

function revokeAll(urls: readonly string[]): void {
	for (const url of urls) {
		URL.revokeObjectURL(url)
	}
}

// renderAsync feeds `bytes` straight into JSZip.loadAsync (verified against the installed 0.4.0
// source) — a Uint8Array is a directly-supported input, no Blob wrapping needed. `renderAltChunks:
// false` is the one deliberate option override: an altChunk part renders via `renderAltChunk`, which
// creates a real <iframe> and assigns raw HTML/MHT content to its `.srcdoc` (verified against the
// installed source) — a real XSS vector for a file this app can receive from anyone via a share.
// frame-src/default-src don't govern srcdoc (confirmed empirically against this exact CSP: the
// markup still renders); the actual backstop is that a srcdoc document inherits its parent's CSP, and
// script-src here has no unsafe-inline — the same mechanism the rest of this pipeline already relies
// on for its real DOM nodes. Disabling the option keeps the content out of the render entirely
// instead of depending on that inheritance alone. `experimental: true` governs exactly one thing in
// the installed build — tab-stop positioning: it makes renderTab register each tab span so
// refreshTabStops can measure and place it, and without it a document's tab stops collapse to a bare
// em space. Every other option keeps docx-preview's own default (the page-like white-on-gray wrapper
// it injects via its own <style> element into this same container needs no extra styling from this
// file).
//
// renderHyperlink (same source) copies a relationship's target straight into `href` with no scheme
// check of its own — sanitizeDocxLinks (lib/docxDom.ts) is the closing sweep for that, run once per
// render.
export function DocxPreviewFallback({ bytes, alt }: { bytes: Uint8Array; alt: string }) {
	const { t } = useTranslation("preview")
	const containerRef = useRef<HTMLDivElement | null>(null)
	const [status, setStatus] = useState<"pending" | "success" | "error">("pending")
	// Bumped by the error state's own Retry button — `bytes` never changes on a retry (already the
	// whole file, held by the caller's usePreviewBytes), so a dedicated counter re-runs this effect
	// against the SAME buffer, mirroring imageViewer.tsx's own TransformedImageBytes retry idiom.
	const [retryToken, setRetryToken] = useState(0)
	const linkGate = useTrustedLinkGate()

	useEffect(() => {
		let live = true
		const container = containerRef.current

		if (!container) {
			return
		}

		// Each run renders into its own host: a run still in flight when the next one starts (a retry, a
		// new buffer) can then only write into its own host, which the newer run has already detached.
		const host = document.createElement("div")

		// docx-preview copies a VML shape's style verbatim onto an <svg>: layout + paint containment makes
		// the host the containing block of a `position: fixed` shape and clips it, so a shared document
		// cannot draw over the app. Paint containment clips at the host box, so the host is fit-content
		// wide and never narrower than the scroller: a fixed-width page wider than the viewport widens it
		// and stays reachable by scrolling, while text in a section without a page size still wraps at
		// the scroller width.
		host.className = "w-fit min-w-full contain-layout contain-paint"
		// The object URLs this run's render minted; revoked on teardown, not right after renderAsync,
		// since @font-face rules and images keep reading them while the document is shown.
		let urls: string[] = []

		container.replaceChildren(host)

		async function render(): Promise<void> {
			try {
				await renderAsync(bytes, host, undefined, { renderAltChunks: false, experimental: true })
				sanitizeDocxLinks(host)

				if (live) {
					setStatus("success")
				}
			} catch {
				if (live) {
					setStatus("error")
				}
			} finally {
				urls = collectBlobUrls(host)

				// Torn down mid-render: the cleanup below has already run with nothing to revoke.
				if (!live) {
					revokeAll(urls)
				}
			}
		}

		void render()

		return () => {
			live = false
			revokeAll(urls)
		}
	}, [bytes, retryToken])

	return (
		<div className="relative size-full overflow-auto">
			{status === "pending" ? (
				<LoadingState
					size="lg"
					className="absolute inset-0 text-inherit"
				/>
			) : null}
			{status === "error" ? (
				<div className="absolute inset-0">
					<PreviewErrorState
						message={t("previewDocxLoadFailed")}
						onRetry={() => {
							setStatus("pending")
							setRetryToken(prev => prev + 1)
						}}
					/>
				</div>
			) : null}
			<div
				ref={containerRef}
				role="document"
				aria-label={alt}
				className={status === "success" ? "select-text" : "hidden"}
				// The links sanitizeDocxLinks kept open in a new tab, once their domain is trusted.
				onClick={linkGate.onClick}
				onAuxClick={linkGate.onAuxClick}
			/>
			{linkGate.dialog}
		</div>
	)
}
