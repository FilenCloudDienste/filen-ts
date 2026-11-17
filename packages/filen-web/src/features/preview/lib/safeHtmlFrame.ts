import { EMAIL_MAX_HTML_CHARS } from "@filen/shared/dom"
import { linkHrefOf } from "@/lib/trustedLinks/useTrustedLinkGate"

// The frame SafeHtmlDocument shows sanitized HTML in: no scripts (its sandbox gives only allow-same-origin, so the page
// can fill and read its document) and a Content Security Policy of its own, intersected with the page's, so it loads
// nothing but inline images and the message's own parts (blob:) whatever the sanitizer let through. The frame's srcdoc
// is only the policy and the frame's own styles; the document is imported into it once loaded, so the sanitized
// string is never held by the frame.
export const SAFE_HTML_SANDBOX = "allow-same-origin"
export const SAFE_HTML_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"
// The largest document a frame is given (characters), the sanitizer's own input cap: a bigger one is not rendered.
export const SAFE_HTML_MAX_CHARS = EMAIL_MAX_HTML_CHARS

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

// Direction changes (grow, shrink, grow…) a document's height may take before it is held, whatever the heights.
const AUTO_HEIGHT_REVERSALS = 6
// A change after this long without one is the reader's (a <details> opened or closed), not the frame's own layout
// answering its last height: the height settles afresh. A script-less frame runs no listener in WebKit, so the toggle
// itself cannot be heard.
const AUTO_HEIGHT_QUIET_MS = 400

// A width change this small is a scrollbar appearing or going (the host's, as the frame's height crosses the viewport):
// the frame's own doing, not a new width to settle at.
const AUTO_HEIGHT_SCROLLBAR_PX = 24
// Fresh settles a document gets in all (its first included): past them, a held height is held for good, so content that
// cycles slowly, or toggles the host's scrollbar, cannot keep resizing the frame.
const AUTO_HEIGHT_SETTLES = 10

export interface AutoHeightSteps {
	// The frame's next height, from its current one, the measured content, the frame's width and the time (ms).
	step(current: number, measured: { height: number; followsFrame: boolean }, width: number, now: number): number
}

// nextAutoHeight over one document's life, held once it would go back to any height it was given while settling
// (content that cycles with the frame's height across media queries, however many steps the cycle has), or after a few
// direction changes: the frame keeps its height and the document scrolls inside. A new width, or a change after a quiet
// spell, settles afresh, so content the reader opens and closes is followed both ways.
export function autoHeightSteps(cap: number): AutoHeightSteps {
	const given = new Set<number>()
	let held: number | null = null
	let reversals = 0
	let lastChange = 0
	let lastWidth: number | null = null
	let lastStep = Number.NEGATIVE_INFINITY
	let settles = 0

	const reset = (): void => {
		given.clear()
		held = null
		reversals = 0
		lastChange = 0
	}

	return {
		step: (current, measured, width, now) => {
			const widthChanged = lastWidth === null || Math.abs(width - lastWidth) > AUTO_HEIGHT_SCROLLBAR_PX

			if ((widthChanged || now - lastStep > AUTO_HEIGHT_QUIET_MS) && settles < AUTO_HEIGHT_SETTLES) {
				settles++
				lastWidth = width
				reset()
			}

			lastStep = now

			if (held !== null) {
				return held
			}

			const next = nextAutoHeight(current, measured, cap)
			const change = Math.sign(next - current)

			if (change !== 0 && lastChange !== 0 && change !== lastChange) reversals++

			if (change !== 0) lastChange = change

			if (next !== current && (given.has(next) || reversals >= AUTO_HEIGHT_REVERSALS)) {
				held = current

				return current
			}

			given.add(next)

			return next
		}
	}
}
