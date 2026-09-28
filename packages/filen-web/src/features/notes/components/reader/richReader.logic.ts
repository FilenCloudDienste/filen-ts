import { quillV2ToLegacyV1 } from "@filen/shared/dom"
import { sanitizeRichTextHtml } from "@/features/notes/lib/sanitizeRichText"

// Stored rich notes mix Quill 1 and Quill 2 markup. Normalizing to Quill 1's form means the reader
// styles one list shape (<ul>/<ol>/<ul data-checked>) and one code-block shape (<pre>) instead of
// both. Sanitize FIRST: the converter parses its input into a detached element of this document, which
// must never see markup that fetches or runs anything. Both steps short-circuit on plain content.
export function richReaderHtml(content: string): string {
	return quillV2ToLegacyV1(sanitizeRichTextHtml(content))
}
