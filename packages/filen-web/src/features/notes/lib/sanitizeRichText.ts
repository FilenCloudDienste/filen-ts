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

// Registered once at module load (DOMPurify hooks are global to the imported instance, same as
// mobile's dom.tsx registering it once when the WebView loads): every `<a href>` that survives
// sanitization is forced to open externally with a locked-down rel, closing the reverse-tabnabbing
// hole a raw `target="_blank"` in untrusted content would otherwise open.
DOMPurify.addHook("afterSanitizeAttributes", node => {
	if (node.tagName === "A" && node.getAttribute("href")) {
		node.setAttribute("target", "_blank")
		node.setAttribute("rel", "noopener noreferrer")
	}
})

export function sanitizeRichTextHtml(html: string): string {
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: [...RICH_TEXT_ALLOWED_TAGS],
		ALLOWED_ATTR: [...RICH_TEXT_ALLOWED_ATTR]
	})
}
