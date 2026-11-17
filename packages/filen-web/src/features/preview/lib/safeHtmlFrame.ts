import { linkHrefOf } from "@/lib/trustedLinks/useTrustedLinkGate"

// The frame SafeHtmlDocument shows sanitized HTML in: no scripts (its sandbox gives only allow-same-origin, so the page
// can fill and read its document) and a Content Security Policy of its own, intersected with the page's, so it loads
// nothing but inline images and the message's own parts (blob:) whatever the sanitizer let through. The frame's srcdoc
// is only the policy and the frame's own styles; the document is imported into it once loaded, so the sanitized
// string is never held by the frame.
export const SAFE_HTML_SANDBOX = "allow-same-origin"
export const SAFE_HTML_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"
// The largest document a frame is given (characters): a bigger one is not rendered.
export const SAFE_HTML_MAX_CHARS = 8 * 1024 * 1024

// Sanitized links carry their address in data-filen-href, never href: shown as links, opened by the host.
const LINK_STYLE = "[data-filen-href]{cursor:pointer;text-decoration:underline;color:LinkText}"
// White paper and dark text under the document's own styles (a mail written for a light background stays legible in
// a dark app); its own CSS may still set them.
const PAPER_STYLE = "html{background:#fff;color:#000;color-scheme:light}"
// An auto-height frame is measured by its content: a document sized by the viewport would grow with every resize.
const AUTO_HEIGHT_STYLE = "html,body{height:auto!important;min-height:0!important}"

// The frame's srcdoc: a standards-mode document whose first element is its policy, then its own styles. Nothing of the
// sanitized document is in it.
export function safeHtmlPrefix(options: { paper: boolean; autoHeight: boolean }): string {
	const styles = `${LINK_STYLE}${options.paper ? PAPER_STYLE : ""}${options.autoHeight ? AUTO_HEIGHT_STYLE : ""}`

	return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SAFE_HTML_CSP}"><style>${styles}</style>`
}

// Marks what a fill put into the frame's head, so the next fill replaces it and nothing else.
const CONTENT_MARK = "data-filen-content"

// Imports the sanitized document (DOMPurify's whole-document output) into the loaded frame, after its policy: parsed in
// an inert document first (nothing loads there), then its html element's attributes, its head's children and its body
// moved in, where the frame's policy governs every load. A later fill replaces the earlier one.
// `autoHeight`: html and body get height auto and no minimum inline, as important, which no stylesheet of the document
// outranks.
export function fillSafeHtml(frameDocument: Document, html: string, autoHeight: boolean): void {
	const parsed = new DOMParser().parseFromString(html, "text/html")
	const root = frameDocument.documentElement

	for (const name of root.getAttributeNames()) {
		root.removeAttribute(name)
	}

	for (const name of parsed.documentElement.getAttributeNames()) {
		root.setAttribute(name, parsed.documentElement.getAttribute(name) ?? "")
	}

	for (const node of frameDocument.head.querySelectorAll(`[${CONTENT_MARK}]`)) {
		node.remove()
	}

	for (const node of parsed.head.children) {
		const copy = frameDocument.importNode(node, true)

		copy.setAttribute(CONTENT_MARK, "")
		frameDocument.head.append(copy)
	}

	frameDocument.body.replaceWith(frameDocument.importNode(parsed.body, true))

	if (autoHeight) {
		for (const element of [root, frameDocument.body]) {
			element.style.setProperty("height", "auto", "important")
			element.style.setProperty("min-height", "0", "important")
		}
	}
}

// Clicks, middle clicks and Enter on a sanitized link (data-filen-href) open it through the host (its trust gate).
// Listeners run where the engine runs them in a script-less frame (Chromium, Firefox); WebKit runs none, so the host
// also lists the links beside it. A held Enter opens once. Returns the removal.
export function interceptFrameLinks(frameDocument: Document, open: (href: string) => void): () => void {
	const onActivate = (event: Event): void => {
		const href = linkHrefOf(event.target)

		if (href === null) {
			return
		}

		if (event.type === "keydown" && ((event as KeyboardEvent).key !== "Enter" || (event as KeyboardEvent).repeat)) {
			return
		}

		if (event.type === "auxclick" && (event as MouseEvent).button !== 1) {
			return
		}

		event.preventDefault()
		open(href)
	}
	const types = ["click", "auxclick", "keydown"] as const

	for (const type of types) {
		frameDocument.addEventListener(type, onActivate, true)
	}

	return () => {
		for (const type of types) {
			frameDocument.removeEventListener(type, onActivate, true)
		}
	}
}

const FORMAT_CHARACTERS = /\p{Cf}/gu

export interface LinkPlace {
	// The host for the web, the whole address for mail; format and bidi controls removed.
	readonly place: string
	// A mailto that also copies others in (cc, bcc), or carries anything else (a subject, a body).
	readonly extras: "copies" | "parameters" | null
}

// What a links list row shows for where a link goes.
export function linkPlace(href: string): LinkPlace {
	try {
		const url = new URL(href)

		if (url.protocol !== "mailto:") {
			return { place: url.host.replace(FORMAT_CHARACTERS, ""), extras: null }
		}

		const keys = [...url.searchParams.keys()].map(key => key.toLowerCase())

		return {
			place: decodeURIComponent(url.pathname).replace(FORMAT_CHARACTERS, ""),
			extras: keys.some(key => key === "cc" || key === "bcc") ? "copies" : keys.length > 0 ? "parameters" : null
		}
	} catch {
		return { place: href.replace(FORMAT_CHARACTERS, ""), extras: null }
	}
}

// How much taller a probe makes the frame: enough for any viewport-relative length to show.
const PROBE_PX = 64

// The content height of a loaded auto-height frame, and whether it follows the frame's own height (content sized in
// viewport units, which would climb to the cap one render at a time by a constant or a factor): measured at the
// frame's height and again at a taller probe, synchronously, so the probe is never painted.
// The root element's own box, not its scroll height (which is never below the viewport).
export function measureFrameContent(frame: HTMLIFrameElement, root: Element): { height: number; followsFrame: boolean } {
	const height = root.getBoundingClientRect().height
	const style = frame.style.height

	frame.style.height = `${String(frame.offsetHeight + PROBE_PX)}px`

	const probed = root.getBoundingClientRect().height

	frame.style.height = style

	return { height, followsFrame: probed > height }
}

// The next height of an auto-height frame: its content's, capped; held where the content follows the frame's height
// (it then scrolls inside).
export function nextAutoHeight(current: number, measured: { height: number; followsFrame: boolean }, cap: number): number {
	return measured.followsFrame ? current : Math.min(Math.ceil(measured.height), cap)
}
