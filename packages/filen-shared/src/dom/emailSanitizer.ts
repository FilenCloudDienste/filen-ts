// The sanitizer for HTML from untrusted files shown in a sandboxed, script-less frame (an email body, a notebook's HTML
// output). DOMPurify is passed in as a factory and the sanitizer makes one instance of its own, so its hooks never
// meet another sanitizer's (the rich-text one's, Mermaid's) and theirs never meet its.
//
// It keeps the document whole (an email's head carries its style element) and drops everything that runs, embeds,
// submits or redirects. Nothing remote may load: every URL attribute and every CSS url(), @import, @font-face and
// image-set() that does not point at the message's own parts (cid:, resolved to a local URL) or an inline image
// (data:image/) is removed and counted. The frame's own Content Security Policy is the guarantee; this keeps the
// count honest and the console free of refused loads.
//
// Links are kept, and returned too: a frame without scripts runs no listener in some engines (WebKit), so the host
// lists them beside the frame, where they open through its own gate. Only http(s) and mailto links, each once.

export interface EmailLink {
	readonly href: string
	// The link's text, or its address when it has none.
	readonly text: string
}

export interface EmailSanitizeResult {
	readonly html: string
	// URLs and CSS loads removed because they pointed outside the message.
	readonly remoteBlocked: number
	readonly links: readonly EmailLink[]
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
		}
	): string
}

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

// Attributes that run, submit or report: never kept, whatever they hold.
const FORBID_ATTR = ["srcdoc", "formaction", "action", "ping", "http-equiv"]

// Attributes holding a URL the browser loads.
const LOADING_ATTRIBUTES = ["src", "srcset", "background", "poster", "lowsrc", "dynsrc", "data", "xlink:href", "longdesc"]

const DATA_IMAGE = /^\s*data:image\//i
const CID = /^\s*cid:\s*<?([^>\s]+)>?\s*$/i
const LINK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"])

// CSS escapes (`\75 rl(`, `\@import`) decoded, so the checks below see what the browser's parser will.
function decodeCssEscapes(css: string): string {
	return css.replace(/\\(?:([0-9a-f]{1,6})\s?|([^\n0-9a-f]))/gi, (_whole, hex: string | undefined, char: string | undefined) => {
		if (hex === undefined) {
			return char ?? ""
		}

		const point = Number.parseInt(hex, 16)

		return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? "�" : String.fromCodePoint(point)
	})
}

interface Run {
	resolveCid: (id: string) => string | null
	remoteBlocked: number
	links: EmailLink[]
	seen: Set<string>
}

// A loading URL kept as is (an inline image), resolved (a part of the message), or null to remove.
function localUrl(value: string, run: Run): string | null {
	if (DATA_IMAGE.test(value)) {
		return value
	}

	const cid = CID.exec(value)?.[1]

	return cid === undefined ? null : run.resolveCid(cid)
}

// CSS with everything that would load from outside the message made inert.
function cleanCss(css: string, run: Run): string {
	return decodeCssEscapes(css)
		.replace(/@import\b[^;]*;?/gi, () => {
			run.remoteBlocked++

			return ""
		})
		.replace(/@font-face\s*\{[^}]*\}/gi, () => {
			run.remoteBlocked++

			return ""
		})
		.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, _quote: string, url: string) => {
			const local = localUrl(url, run)

			if (local === url) {
				return whole
			}

			if (local === null) {
				run.remoteBlocked++

				return "url()"
			}

			return `url('${local}')`
		})
		.replace(/((?:-webkit-)?image-set)\s*\(/gi, () => {
			// An unknown function: the browser drops the declaration.
			run.remoteBlocked++

			return "blocked-image-set("
		})
}

function linkHref(value: string): string | null {
	try {
		const url = new URL(value.trim())

		return LINK_SCHEMES.has(url.protocol) ? url.href : null
	} catch {
		return null
	}
}

function keepLink(href: string, text: string, run: Run): void {
	if (run.seen.has(href) || run.links.length >= EMAIL_MAX_LINKS) {
		return
	}

	const label = text.replace(/\s+/g, " ").trim()

	run.seen.add(href)
	run.links.push({ href, text: label.length === 0 ? href : label.slice(0, MAX_LINK_TEXT) })
}

function cleanAttributes(node: Element, run: Run): void {
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

	const href = node.getAttribute("href")

	if (href !== null) {
		const tag = node.tagName.toLowerCase()
		const safe = tag === "a" || tag === "area" ? linkHref(href) : null

		if (safe === null) {
			node.removeAttribute("href")
		} else {
			keepLink(safe, tag === "a" ? (node.textContent ?? "") : (node.getAttribute("alt") ?? ""), run)
		}
	}

	// The frame opens nothing itself: the host opens links.
	node.removeAttribute("target")

	const style = node.getAttribute("style")

	if (style !== null) {
		node.setAttribute("style", cleanCss(style, run))
	}
}

export function createEmailHtmlSanitizer(
	createPurifier: () => EmailPurifier
): (html: string, resolveCid: (id: string) => string | null) => EmailSanitizeResult {
	const purifier = createPurifier()
	// The run the hooks report to: sanitize is synchronous, so one at a time.
	let current: Run | null = null

	purifier.addHook("uponSanitizeElement", node => {
		if (current !== null && node.nodeName.toLowerCase() === "style" && node.textContent !== null) {
			node.textContent = cleanCss(node.textContent, current)
		}
	})
	purifier.addHook("afterSanitizeAttributes", node => {
		if (current !== null) {
			cleanAttributes(node, current)
		}
	})

	return (html, resolveCid) => {
		const run: Run = { resolveCid, remoteBlocked: 0, links: [], seen: new Set() }

		current = run

		try {
			const clean = purifier.sanitize(html, {
				WHOLE_DOCUMENT: true,
				FORBID_TAGS: [...FORBID_TAGS],
				FORBID_ATTR: [...FORBID_ATTR],
				ADD_TAGS: ["style"]
			})

			return { html: clean, remoteBlocked: run.remoteBlocked, links: run.links }
		} finally {
			current = null
		}
	}
}
