import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react"
import { cn } from "@filen/shared"
import type { EmailLink } from "@/features/preview/lib/emailSanitizer"
import {
	interceptFrameLinks,
	linkPlace,
	fillSafeHtml,
	nextAutoHeight,
	safeHtmlPrefix,
	SAFE_HTML_MAX_CHARS,
	SAFE_HTML_SANDBOX
} from "@/features/preview/lib/safeHtmlFrame"
import { useTrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"
import { useLatestRef } from "@/lib/useLatestRef"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

export interface SafeHtmlDocumentProps {
	// Already sanitized (sanitizeEmailHtml): the frame adds its own policy, never a second pass. Imported into the frame
	// once per value (the frame holds no copy of the string); past SAFE_HTML_MAX_CHARS it is not shown.
	html: string
	// The links the sanitizer kept, listed under the document.
	links: readonly EmailLink[]
	title: string
	// "fill": the frame takes its parent's size (an email body). "autoHeight": as tall as its content up to a cap, then
	// it scrolls inside (a notebook output).
	layout: "fill" | "autoHeight"
	// White paper whatever the app's theme.
	paper: boolean
}

// Past this height an auto-height document scrolls inside its frame.
const AUTO_HEIGHT_MAX = 4000

// Untrusted HTML in a sandboxed frame without scripts and with a policy that loads nothing remote (safeHtmlFrame.ts),
// imported into the frame once its policy is in place rather than held as a srcdoc string. Its links are no links (the
// sanitizer moved their addresses to data-filen-href), so the frame never navigates: where the engine runs listeners
// in it they open through the trusted-link gate, and every kept link is listed under it ("Links (n)") for every
// browser.
export function SafeHtmlDocument({ html, links, title, layout, paper }: SafeHtmlDocumentProps) {
	const { t } = useTranslation("preview")
	const gate = useTrustedLinkGate()
	const frameRef = useRef<HTMLIFrameElement>(null)
	const [height, setHeight] = useState<number | null>(null)
	// Each load of the frame (its srcdoc: the policy and styles) is a new document to fill.
	const [loaded, setLoaded] = useState(0)
	const requestOpen = gate.requestOpen
	// The frame's listeners stay for its document's life; they open through the gate as it stands.
	const openRef = useLatestRef(requestOpen)
	const tooLarge = html.length > SAFE_HTML_MAX_CHARS

	// The document is imported once the policy is loaded, its listeners attached in the same task, before anything can
	// be clicked.
	useEffect(() => {
		const frameDocument = frameRef.current?.contentDocument

		if (tooLarge || loaded === 0 || frameDocument === null || frameDocument === undefined) {
			return undefined
		}

		fillSafeHtml(frameDocument, html)

		const stopIntercepting = interceptFrameLinks(frameDocument, href => {
			openRef.current(href)
		})

		if (layout !== "autoHeight") {
			return stopIntercepting
		}

		const root = frameDocument.documentElement
		const given: number[] = []
		const observer = new ResizeObserver(() => {
			const next = nextAutoHeight(given, root.scrollHeight, AUTO_HEIGHT_MAX)

			if (next !== given.at(-1)) {
				given.push(next)
				setHeight(next)
			}
		})

		observer.observe(root)

		return () => {
			stopIntercepting()
			observer.disconnect()
		}
	}, [html, layout, tooLarge, loaded, openRef])

	if (tooLarge) {
		return <p className="m-auto p-6 text-center text-sm text-muted-foreground">{t("previewHtmlTooLarge")}</p>
	}

	return (
		<div className={cn("flex min-h-0 flex-col", layout === "fill" && "size-full")}>
			<iframe
				ref={frameRef}
				title={title}
				sandbox={SAFE_HTML_SANDBOX}
				srcDoc={safeHtmlPrefix({ paper, autoHeight: layout === "autoHeight" })}
				onLoad={() => {
					setLoaded(count => count + 1)
				}}
				className={cn("w-full border-0", layout === "fill" ? "min-h-0 flex-1" : undefined, paper && "bg-white")}
				style={layout === "autoHeight" && height !== null ? { height: `${String(height)}px` } : undefined}
			/>
			{links.length === 0 ? null : (
				<Collapsible className="shrink-0 border-t border-border/60">
					<CollapsibleTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="group m-1"
							/>
						}
					>
						{t("previewHtmlLinks", { count: links.length })}
						<ChevronDownIcon
							data-icon="inline-end"
							className="transition-transform group-data-[panel-open]:rotate-180"
						/>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<ul className="max-h-60 overflow-y-auto px-1 pb-1">
							{links.map(link => {
								const { place, extras } = linkPlace(link.href)
								const where =
									extras === null
										? place
										: t(extras === "copies" ? "previewHtmlLinkMailCopies" : "previewHtmlLinkMailParameters", { place })

								return (
									<li key={link.href}>
										<button
											type="button"
											className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
											aria-label={t("previewHtmlLinkOpen", { text: link.text, place: where })}
											onClick={() => {
												requestOpen(link.href)
											}}
										>
											<bdi className="min-w-0 flex-1 truncate">{link.text}</bdi>
											<bdi className="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground">{where}</bdi>
											<ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
										</button>
									</li>
								)
							})}
						</ul>
					</CollapsibleContent>
				</Collapsible>
			)}
			{gate.dialog}
		</div>
	)
}
