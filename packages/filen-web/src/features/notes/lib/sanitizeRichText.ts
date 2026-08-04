import DOMPurify from "dompurify"

// Read-only rich-note render — the tag/attribute allow-lists MUST match the new mobile app
// byte-for-byte (mobile reference: packages/filen-mobile/src/components/textEditor/richText/dom.tsx).
// The live-edit path (Quill) re-sanitizes with this SAME config before every seed
// paste; this module is shared between both paths so they can never drift.
// The afterSanitizeAttributes hook below is where web-only hardening lives: mobile renders note HTML
// inside an isolated WebView with no app CSS, we render it into the app's own document.

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

// `style` stays on the allow-list (rich formatting emits inline styles like text-align/color), but
// DOMPurify does not filter CSS, so an attacker-authored note could otherwise carry
// `position:fixed;width:100vw;height:100vh;z-index:…` that escapes this read-only content's overflow
// container and paints a full-viewport click-sink on the app's own origin. This module renders via
// dangerouslySetInnerHTML directly into the page, so declarations that let content break out of flow
// or cover the viewport are stripped here: positioning (`position`/`z-index`, plus the offsets that
// only bite with positioning) and viewport-relative sizing. Everything else in `style` survives.
const FORBIDDEN_STYLE_PROPERTIES = new Set(["position", "z-index", "top", "right", "bottom", "left", "inset"])
const VIEWPORT_UNIT = /\d*\.?\d+(vw|vh|vmin|vmax)\b/

// `class` stays on the allow-list for the same reason (Quill emits alignment, indentation, sizing and
// code blocks as classes), and it is the LOUDER hole: a class resolves against whatever CSS the
// embedding document already ships, so on the web `class="fixed inset-0 z-50 bg-background"` reproduces
// the exact full-viewport overlay the style filter above strips — with none of the declarations the
// filter can see. Nothing in `style` can substitute for it, so the answer is a positive allow-list:
// only Quill's CONTENT formatting classes survive. Everything else goes, including Quill's own chrome
// classes (`ql-tooltip` is absolutely positioned, `ql-container` establishes a containing block).
const ALLOWED_CLASS = /^ql-(?:align|bg|color|direction|font|indent|size)-[a-z0-9]+$|^ql-(?:code-block|code-block-container|syntax|ui)$/

function filterClassTokens(value: string): string {
	return value
		.split(/\s+/)
		.filter(token => ALLOWED_CLASS.test(token))
		.join(" ")
}

// The denylist MUST be applied to CSS-parser-canonical property names and values, never to the raw
// attribute string. A raw string/regex match is bypassable: browsers decode CSS escape sequences, so
// `\070osition:fixed` is honoured as `position: fixed` and `100\76w` as `100vw` while a literal
// comparison sees only the escaped bytes. Routing the raw attribute through the CSSOM (`cssText`)
// decodes those escapes and drops invalid declarations before the denylist runs, so a forbidden
// declaration cannot be smuggled past this filter in any form the viewer's browser would render.
function filterStyleDeclarations(style: string): string {
	const parsed = document.createElement("span").style

	parsed.cssText = style

	for (const forbidden of FORBIDDEN_STYLE_PROPERTIES) {
		parsed.removeProperty(forbidden)
	}

	// Iterate backwards: removeProperty shifts the live index list.
	for (let index = parsed.length - 1; index >= 0; index--) {
		const property = parsed.item(index)

		if (VIEWPORT_UNIT.test(parsed.getPropertyValue(property))) {
			parsed.removeProperty(property)
		}
	}

	return parsed.cssText.replace(/\s*;\s*$/, "")
}

// Registered once at module load (DOMPurify hooks are global to the imported instance, same as
// mobile's dom.tsx registering it once when the WebView loads): every `<a href>` that survives
// sanitization is forced to open externally with a locked-down rel, closing the reverse-tabnabbing
// hole a raw `target="_blank"` in untrusted content would otherwise open.
DOMPurify.addHook("afterSanitizeAttributes", node => {
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
})

export function sanitizeRichTextHtml(html: string): string {
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: [...RICH_TEXT_ALLOWED_TAGS],
		ALLOWED_ATTR: [...RICH_TEXT_ALLOWED_ATTR]
	})
}
