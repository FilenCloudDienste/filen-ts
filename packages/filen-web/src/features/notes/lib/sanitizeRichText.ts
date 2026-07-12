import DOMPurify from "dompurify"

// Read-only rich-note render — sanitize config MUST match the new mobile app byte-for-byte
// (mobile reference: packages/filen-mobile/src/components/textEditor/richText/dom.tsx).
// The live-edit path (Quill) re-sanitizes with this SAME config before every seed
// paste; this module is shared between both paths so they can never drift.

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

function filterStyleDeclarations(style: string): string {
	return style
		.split(";")
		.map(declaration => declaration.trim())
		.filter(declaration => {
			if (declaration.length === 0) {
				return false
			}

			const separator = declaration.indexOf(":")

			if (separator === -1) {
				return false
			}

			const property = declaration.slice(0, separator).trim().toLowerCase()
			const value = declaration
				.slice(separator + 1)
				.trim()
				.toLowerCase()

			if (FORBIDDEN_STYLE_PROPERTIES.has(property)) {
				return false
			}

			if (VIEWPORT_UNIT.test(value)) {
				return false
			}

			return true
		})
		.join("; ")
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
})

export function sanitizeRichTextHtml(html: string): string {
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: [...RICH_TEXT_ALLOWED_TAGS],
		ALLOWED_ATTR: [...RICH_TEXT_ALLOWED_ATTR]
	})
}
