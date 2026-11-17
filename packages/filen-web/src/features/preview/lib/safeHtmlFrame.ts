import { linkHrefOf } from "@/lib/trustedLinks/useTrustedLinkGate"

// The frame SafeHtmlDocument shows sanitized HTML in: no scripts (its sandbox gives only allow-same-origin, so the page
// can read its document) and a Content Security Policy of its own, intersected with the page's, so it loads nothing
// but inline images and the message's own parts (blob:) whatever the sanitizer let through.
export const SAFE_HTML_SANDBOX = "allow-same-origin"
export const SAFE_HTML_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"

// White paper and dark text under the document's own styles (a mail written for a light background stays legible in
// a dark app); its own CSS may still set them.
const PAPER_STYLE = "<style>html{background:#fff;color:#000;color-scheme:light}</style>"

// The srcdoc for a sanitized document (DOMPurify's whole-document output, `<html><head>…`): standards mode, the policy
// first in its head, then the paper.
export function safeHtmlSrcdoc(html: string, paper: boolean): string {
	const head = `<meta http-equiv="Content-Security-Policy" content="${SAFE_HTML_CSP}">${paper ? PAPER_STYLE : ""}`
	const at = html.indexOf("<head>")

	return at === -1
		? `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
		: `<!doctype html>${html.slice(0, at + 6)}${head}${html.slice(at + 6)}`
}

// Clicks, middle clicks and Enter on a link inside the frame never navigate it: the host opens the link (through its
// trust gate). Listeners run in the frame's document where its engine runs them for a script-less frame (Chromium,
// Firefox; WebKit runs none, so the host also lists the links beside it). Returns the removal.
export function interceptFrameLinks(frameDocument: Document, open: (href: string) => void): () => void {
	const onActivate = (event: Event): void => {
		const href = linkHrefOf(event.target)

		if (href === null) {
			return
		}

		if (event.type === "keydown" && (event as KeyboardEvent).key !== "Enter") {
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

// What a links list row shows for a link: the host for the web, the address for mail.
export function linkPlace(href: string): string {
	try {
		const url = new URL(href)

		return url.protocol === "mailto:" ? decodeURIComponent(url.pathname) : url.host
	} catch {
		return href
	}
}
