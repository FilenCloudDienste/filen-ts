// The sanitizer for HTML from untrusted files shown in a sandboxed, script-less frame (an email body, a notebook's HTML
// output). DOMPurify is passed in as a factory and the sanitizer makes one instance of its own, so its hooks never
// meet another sanitizer's (the rich-text one's, Mermaid's) and theirs never meet its.
//
// It keeps the document whole (an email's head carries its style element) and drops everything that runs, embeds,
// submits or redirects. Nothing remote may load: every URL attribute that does not point at the message's own parts
// (cid:, resolved to a local URL) or an inline image (data:image/), and every CSS rule, declaration or attribute value
// (SVG presentation attributes included) that could load anything else, is removed and counted. CSS is never
// rewritten: it is judged on its escapes decoded, and kept byte for byte or dropped whole. The frame's own Content
// Security Policy is the guarantee; this keeps the count honest and the console free of refused loads.
//
// Links never stay links: a kept one's address moves to data-filen-href (normalized, http(s) and mailto only), so the
// frame can never navigate, and the host opens it through its own gate. They are also returned, once each, labelled
// by their visible text, for the host to list beside the frame (a script-less frame runs no listener in WebKit).

import { cssValueLoads, keptCss } from "./cssLoads"

export interface EmailLink {
	readonly href: string
	// The link's visible text (format and bidi controls removed), or its address when it has none.
	readonly text: string
}

export interface EmailSanitizeResult {
	// Empty when the input is past EMAIL_MAX_HTML_CHARS (`tooLarge`).
	readonly html: string
	// URLs, CSS rules, declarations and attribute values removed because they pointed outside the message.
	readonly remoteBlocked: number
	readonly links: readonly EmailLink[]
	// The input, or the sanitized document, was past EMAIL_MAX_HTML_CHARS: nothing is returned.
	readonly tooLarge: boolean
}

// The part of DOMPurify this module uses.
export interface EmailPurifier {
	addHook(entryPoint: "afterSanitizeAttributes", hook: (node: Element) => void): void
	addHook(entryPoint: "uponSanitizeElement", hook: (node: Node) => void): void
	sanitize(
		dirty: string,
		config: {
			WHOLE_DOCUMENT: boolean
			FORBID_TAGS: string[]
			FORBID_ATTR: string[]
			ADD_TAGS: string[]
			RETURN_DOM: true
		}
	): Node
	// What the last run removed: it holds that run's parsed document until cleared.
	removed: unknown[]
}

// The largest HTML read (characters); a bigger document is refused before parsing.
export const EMAIL_MAX_HTML_CHARS = 8 * 1024 * 1024
// The attribute a kept link's address moves to.
export const EMAIL_LINK_ATTRIBUTE = "data-filen-href"
// The most links listed beside a body (a newsletter can carry hundreds; the frame keeps them all).
export const EMAIL_MAX_LINKS = 100
// A link's listed text beyond this many characters is cut.
const MAX_LINK_TEXT = 200

const FORBID_TAGS = [
	"script",
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"applet",
	"form",
	"input",
	"button",
	"select",
	"textarea",
	"link",
	"meta",
	"base",
	"foreignObject",
	"portal",
	"noscript"
]

// Attributes that run, submit or report, never kept whatever they hold; and the link attribute, which only the hook
// writes (on a real link it checked).
const FORBID_ATTR = ["srcdoc", "formaction", "action", "ping", "http-equiv", EMAIL_LINK_ATTRIBUTE]

// Attributes holding a URL the browser loads.
const LOADING_ATTRIBUTES = ["src", "srcset", "background", "poster", "lowsrc", "dynsrc", "data", "xlink:href", "longdesc"]
// SVG presentation attributes: CSS values the browser parses, a url() among them loading its target.
const PRESENTATION_ATTRIBUTES = ["fill", "stroke", "filter", "mask", "clip-path", "marker-start", "marker-mid", "marker-end", "cursor"]

const DATA_IMAGE = /^\s*data:image\//i
const CID = /^\s*cid:\s*<?([^>\s]+)>?\s*$/i
const LINK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"])

interface Run {
	resolveCid: (id: string) => string | null
	remoteBlocked: number
}

// A loading URL kept as is (an inline image), resolved (a part of the message), or null to remove.
function localUrl(value: string, run: Run): string | null {
	if (DATA_IMAGE.test(value)) {
		return value
	}

	const cid = CID.exec(value)?.[1]

	return cid === undefined ? null : run.resolveCid(cid)
}

// CSS with every chunk that could load from outside the message dropped whole and counted: a style element's rules (an
// @media block with one inside it too), or a style attribute's declarations.
function cleanCss(css: string, mode: "sheet" | "declarations", run: Run): string {
	const kept = keptCss(css, mode, run.resolveCid)

	run.remoteBlocked += kept.dropped

	return kept.css
}

// A cid: URL's id is percent-encoded (RFC 2392); the Content-ID it names is not.
function cidId(raw: string): string {
	try {
		return decodeURIComponent(raw)
	} catch {
		return raw
	}
}

function linkHref(value: string): string | null {
	try {
		const url = new URL(value)

		// A value the parser had to repair (`https:/x`, `https:\\x`) is not a link anyone wrote: refused.
		return LINK_SCHEMES.has(url.protocol) && (url.protocol === "mailto:" || /^https?:\/\//i.test(value)) ? url.href : null
	} catch {
		return null
	}
}

function cleanAttributes(node: Element, run: Run): void {
	const tag = node.tagName.toLowerCase()
	const anchor = tag === "a" || tag === "area"
	// An SVG link's target (xlink:href, or href) is a link like HTML's: never a resolved part, so a click can never
	// navigate the frame to one.
	const href = node.getAttribute("href") ?? (anchor ? node.getAttribute("xlink:href") : null)

	if (anchor) {
		node.removeAttribute("xlink:href")
	}

	for (const name of LOADING_ATTRIBUTES) {
		const value = node.getAttribute(name)

		if (value === null) {
			continue
		}

		const local = name === "srcset" ? null : localUrl(value, run)

		if (local === null) {
			node.removeAttribute(name)
			run.remoteBlocked++
		} else if (local !== value) {
			node.setAttribute(name, local)
		}
	}

	node.removeAttribute("href")
	node.removeAttribute("target")

	if (href !== null && (tag === "a" || tag === "area")) {
		const safe = linkHref(href)

		if (safe !== null) {
			node.setAttribute(EMAIL_LINK_ATTRIBUTE, safe)
			node.setAttribute("role", "link")
			node.setAttribute("tabindex", "0")
		}
	}

	const style = node.getAttribute("style")

	if (style !== null) {
		node.setAttribute("style", cleanCss(style, "declarations", run))
	}

	// Judged as one declaration each.
	for (const name of PRESENTATION_ATTRIBUTES) {
		const value = node.getAttribute(name)

		if (value !== null && cssValueLoads(value, run.resolveCid)) {
			node.removeAttribute(name)
			run.remoteBlocked++
		}
	}
}

// Text a reader sees: none from an element hidden by its attributes or its own style.
const HIDDEN_STYLE =
	/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?\s*(?:;|$)|font-size\s*:\s*0(?:px|em|rem|%)?\s*(?:;|$))/i
const FORMAT_CHARACTERS = /\p{Cf}/gu

function hidden(element: Element): boolean {
	return (
		element.hasAttribute("hidden") ||
		element.getAttribute("aria-hidden") === "true" ||
		HIDDEN_STYLE.test(element.getAttribute("style") ?? "")
	)
}

function visibleText(element: Element): string {
	let text = ""
	const pending: Node[] = [element]

	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (node.nodeType === 3) {
			text += node.nodeValue ?? ""
		} else if (node.nodeType === 1 && (node === element || !hidden(node as Element))) {
			for (let child = node.lastChild; child !== null; child = child.previousSibling) {
				pending.push(child)
			}
		}
	}

	return text
}

// The kept links in document order, each once, labelled after sanitizing by what a reader sees.
function keptLinks(root: Element): EmailLink[] {
	const links: EmailLink[] = []
	const seen = new Set<string>()

	for (const element of root.querySelectorAll(`[${EMAIL_LINK_ATTRIBUTE}]`)) {
		const href = element.getAttribute(EMAIL_LINK_ATTRIBUTE) ?? ""

		if (seen.has(href)) {
			continue
		}

		if (links.length >= EMAIL_MAX_LINKS) {
			break
		}

		const source = element.tagName.toLowerCase() === "area" ? (element.getAttribute("alt") ?? "") : visibleText(element)
		const label = source.replace(FORMAT_CHARACTERS, "").replace(/\s+/g, " ").trim()

		seen.add(href)
		links.push({ href, text: label.length === 0 ? href : label.slice(0, MAX_LINK_TEXT) })
	}

	return links
}

export function createEmailHtmlSanitizer(
	createPurifier: () => EmailPurifier
): (html: string, resolveCid: (id: string) => string | null) => EmailSanitizeResult {
	const purifier = createPurifier()
	// The run the hooks report to: sanitize is synchronous, so one at a time.
	let current: Run | null = null

	purifier.addHook("uponSanitizeElement", node => {
		if (current !== null && node.nodeName.toLowerCase() === "style" && node.textContent !== null) {
			node.textContent = cleanCss(node.textContent, "sheet", current)
		}
	})
	purifier.addHook("afterSanitizeAttributes", node => {
		if (current !== null) {
			cleanAttributes(node, current)
		}
	})

	return (html, resolveCid) => {
		if (html.length > EMAIL_MAX_HTML_CHARS) {
			return { html: "", remoteBlocked: 0, links: [], tooLarge: true }
		}

		const run: Run = { resolveCid: id => resolveCid(cidId(id)), remoteBlocked: 0 }

		current = run

		try {
			const root = purifier.sanitize(html, {
				WHOLE_DOCUMENT: true,
				FORBID_TAGS: [...FORBID_TAGS],
				FORBID_ATTR: [...FORBID_ATTR],
				ADD_TAGS: ["style"],
				RETURN_DOM: true
			})

			// WHOLE_DOCUMENT with RETURN_DOM: the document's html element.
			const element = root as Element

			const output = element.outerHTML

			// Resolved parts and escaping can grow a document past what its frame shows: one gate for both.
			if (output.length > EMAIL_MAX_HTML_CHARS) {
				return { html: "", remoteBlocked: run.remoteBlocked, links: [], tooLarge: true }
			}

			return { html: output, remoteBlocked: run.remoteBlocked, links: keptLinks(element), tooLarge: false }
		} finally {
			current = null
			purifier.removed.length = 0
		}
	}
}
