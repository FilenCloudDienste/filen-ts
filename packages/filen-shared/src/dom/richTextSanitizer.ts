// The rich-text (Quill note) sanitizer, shared by every client that renders note HTML into its own document.
// DOMPurify is passed in, so this package takes no dependency on it: the host's own DOMPurify module (its
// default export) satisfies RichTextPurifier.
//
// The tag and attribute allowlists are the cross-client contract: every client must keep the exact same
// lists. The hook adds hardening for a host that renders into its own document (with its own CSS) rather
// than an isolated WebView.

export const RICH_TEXT_ALLOWED_TAGS = [
	"p",
	"strong",
	"em",
	"u",
	"a",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"code",
	"ol",
	"ul",
	"li",
	"blockquote",
	"pre",
	"br",
	"span",
	"div"
] as const

export const RICH_TEXT_ALLOWED_ATTR = ["href", "target", "rel", "src", "alt", "class", "style"] as const

// The Quill formats an editor registers (its `formats` option), matching the tag allowlist above: a format the
// sanitizer drops (image, video, strike, script) would render and save, then vanish on the next load.
// Registered Quill format names only; `list` and `code-block` bring their containers.
export const RICH_TEXT_QUILL_FORMATS = [
	"bold",
	"italic",
	"underline",
	"link",
	"header",
	"blockquote",
	"code-block",
	"code",
	"list",
	"indent",
	"align",
	"color",
	"background",
	"size",
	"font",
	"direction"
] as const

// The part of DOMPurify this module uses.
export interface RichTextPurifier {
	addHook(entryPoint: "afterSanitizeAttributes", hook: (node: Element) => void): void
	sanitize(dirty: string, config: { ALLOWED_TAGS: string[]; ALLOWED_ATTR: string[] }): string
	// What the last run removed: it holds that run's parsed document until cleared.
	removed: unknown[]
}

// `style` stays on the allowlist (rich formatting emits inline styles like text-align/color), but DOMPurify
// does not filter CSS, so a note could otherwise carry `position:fixed;width:100vw;height:100vh;z-index:…`
// that escapes the content's overflow container and paints a full-viewport click-sink over the app.
// Declarations that let content break out of flow or cover the viewport are stripped: positioning
// (`position`/`z-index`, plus the offsets that only bite with positioning) and viewport-relative sizing.
const FORBIDDEN_STYLE_PROPERTIES = new Set(["position", "z-index", "top", "right", "bottom", "left", "inset"])
const VIEWPORT_UNIT = /\d*\.?\d+(vw|vh|vmin|vmax)\b/

// `class` stays on the allowlist for the same reason (Quill emits alignment, indentation, sizing and code
// blocks as classes), and it is the louder hole: a class resolves against whatever CSS the host document
// ships, so `class="fixed inset-0 z-50 bg-background"` reproduces the full-viewport overlay the style filter
// strips, with none of the declarations it can see. Only Quill's content formatting classes survive,
// excluding its chrome (`ql-tooltip` is absolutely positioned, `ql-container` establishes a containing block).
const ALLOWED_CLASS = /^ql-(?:align|bg|color|direction|font|indent|size)-[a-z0-9]+$|^ql-(?:code-block|code-block-container|syntax|ui)$/

function filterClassTokens(value: string): string {
	return value
		.split(/\s+/)
		.filter(token => ALLOWED_CLASS.test(token))
		.join(" ")
}

// Judged on CSS-parser-canonical names and values, never the raw attribute: browsers decode CSS escapes, so
// `\070osition:fixed` is honoured as `position: fixed` and `100\76w` as `100vw` while a literal comparison
// sees only the escaped bytes. Routing the attribute through the CSSOM (`cssText`) decodes those escapes and
// drops invalid declarations first.
function filterStyleDeclarations(style: string): string {
	const parsed = document.createElement("span").style

	parsed.cssText = style

	for (const forbidden of FORBIDDEN_STYLE_PROPERTIES) {
		parsed.removeProperty(forbidden)
	}

	// Backwards: removeProperty shifts the live index list.
	for (let index = parsed.length - 1; index >= 0; index--) {
		const property = parsed.item(index)

		if (VIEWPORT_UNIT.test(parsed.getPropertyValue(property))) {
			parsed.removeProperty(property)
		}
	}

	return parsed.cssText.replace(/\s*;\s*$/, "")
}

// Every `<a href>` that survives opens externally with a locked-down rel (no reverse tabnabbing through a
// raw target="_blank"), and style and class pass the filters above.
function hardenAttributes(node: Element): void {
	if (node.tagName === "A" && node.getAttribute("href")) {
		node.setAttribute("target", "_blank")
		node.setAttribute("rel", "noopener noreferrer")
	}

	const style = node.getAttribute("style")

	if (style) {
		const filtered = filterStyleDeclarations(style)

		if (filtered.length > 0) {
			node.setAttribute("style", filtered)
		} else {
			node.removeAttribute("style")
		}
	}

	const className = node.getAttribute("class")

	if (className) {
		const filtered = filterClassTokens(className)

		if (filtered.length > 0) {
			node.setAttribute("class", filtered)
		} else {
			node.removeAttribute("class")
		}
	}
}

// DOMPurify hooks are global to the instance, so the hook is added once per instance however often this runs.
const hooked = new WeakSet<RichTextPurifier>()

export function createRichTextSanitizer(purifier: RichTextPurifier): (html: string) => string {
	if (!hooked.has(purifier)) {
		purifier.addHook("afterSanitizeAttributes", hardenAttributes)
		hooked.add(purifier)
	}

	return html => {
		try {
			return purifier.sanitize(html, {
				ALLOWED_TAGS: [...RICH_TEXT_ALLOWED_TAGS],
				ALLOWED_ATTR: [...RICH_TEXT_ALLOWED_ATTR]
			})
		} finally {
			purifier.removed.length = 0
		}
	}
}
