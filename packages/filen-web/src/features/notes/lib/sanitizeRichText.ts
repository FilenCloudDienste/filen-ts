import DOMPurify from "dompurify"
import { createRichTextSanitizer } from "@filen/shared/dom"

export { RICH_TEXT_ALLOWED_ATTR, RICH_TEXT_ALLOWED_TAGS } from "@filen/shared/dom"

// Read-only rich-note render and the live-edit path (Quill re-sanitizes every seed and paste with it), so the
// two can never drift. The allowlists are the cross-client contract (mobile:
// packages/filen-mobile/src/components/textEditor/richText/dom.tsx); the hardening for rendering into the
// app's own document lives in the shared sanitizer. On a DOMPurify instance of its own: hooks are per instance, so no
// other sanitizer's (another surface's on the default instance) ever runs on a note, and the note's never on theirs.
export const sanitizeRichTextHtml = createRichTextSanitizer(DOMPurify(window))
