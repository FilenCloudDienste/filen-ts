import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { renderAsync } from "docx-preview"
import { type DriveItem } from "@/features/drive/lib/item"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { isSafeLinkHref } from "@/features/preview/components/docxViewer.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Spinner } from "@/components/ui/spinner"

export interface DocxViewerProps {
	item: DriveItem
	alt: string
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
// instead of depending on that inheritance alone. Every other option keeps docx-preview's own default
// (the page-like white-on-gray wrapper it injects via its own <style> element into this same
// container needs no extra styling from this file).
//
// renderHyperlink (same source) copies a relationship's target straight into `href` with no scheme
// check of its own — sanitizeLinks below is the closing sweep for that, run once per render.
function sanitizeLinks(container: HTMLElement): void {
	for (const anchor of container.querySelectorAll("a[href]")) {
		if (!(anchor instanceof HTMLAnchorElement)) {
			continue
		}

		if (!isSafeLinkHref(anchor.href)) {
			anchor.removeAttribute("href")

			continue
		}

		// docx-preview emits no target/rel at all, so a click would otherwise navigate this app's own
		// tab away to whatever the document links to. target="_blank" + rel="noreferrer" (this app's
		// external-link convention, registerForm.tsx) keeps the preview in place and drops the new
		// tab's window.opener access.
		anchor.target = "_blank"
		anchor.rel = "noreferrer"
	}
}

function DocxRender({ bytes, alt }: { bytes: Uint8Array; alt: string }) {
	const { t } = useTranslation("preview")
	const containerRef = useRef<HTMLDivElement | null>(null)
	const [status, setStatus] = useState<"pending" | "success" | "error">("pending")

	useEffect(() => {
		let live = true
		const container = containerRef.current

		if (!container) {
			return
		}

		async function render(target: HTMLDivElement): Promise<void> {
			try {
				await renderAsync(bytes, target, undefined, { renderAltChunks: false })
				sanitizeLinks(target)

				if (live) {
					setStatus("success")
				}
			} catch {
				if (live) {
					setStatus("error")
				}
			}
		}

		void render(container)

		return () => {
			live = false
		}
	}, [bytes])

	return (
		<div className="relative size-full overflow-auto">
			{status === "pending" ? (
				<div className="absolute inset-0 flex items-center justify-center">
					<Spinner className="size-6" />
				</div>
			) : null}
			{status === "error" ? (
				<div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-destructive">
					{t("previewDocxLoadFailed")}
				</div>
			) : null}
			<div
				ref={containerRef}
				role="document"
				aria-label={alt}
				className={status === "success" ? "select-text" : "hidden"}
			/>
		</div>
	)
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category) — DocxRender above owns everything docx-preview-specific once bytes are in hand.
function DocxViewer({ item, alt }: DocxViewerProps) {
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
		<DocxRender
			bytes={result.bytes}
			alt={alt}
		/>
	)
}

export default DocxViewer
