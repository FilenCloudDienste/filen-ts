import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { renderAsync } from "docx-preview"
import { type DriveItem } from "@/lib/drive/item"
import { usePreviewBytes } from "@/components/preview/use-preview-bytes"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Spinner } from "@/components/ui/spinner"

export interface DocxViewerProps {
	item: DriveItem
	alt: string
}

// renderAsync feeds `bytes` straight into JSZip.loadAsync (verified against the installed 0.4.0
// source) — a Uint8Array is a directly-supported input, no Blob wrapping needed. `renderAltChunks:
// false` is the one deliberate option override: altChunk parts embed raw HTML/MHT content that
// docx-preview injects via appendChild rather than escaping (unlike the rest of its DOM-node
// pipeline), a real XSS vector for a file this app can receive from anyone via a share — CSP's
// script-src (no unsafe-inline) already blocks any resulting inline <script>/event-handler
// execution too, but disabling the parse entirely keeps the attack surface out of the render in the
// first place rather than relying on CSP as the only backstop. Every other option keeps
// docx-preview's own default (the page-like white-on-gray wrapper it injects via its own <style>
// element into this same container needs no extra styling from this file).
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
				className={status === "success" ? "" : "hidden"}
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
