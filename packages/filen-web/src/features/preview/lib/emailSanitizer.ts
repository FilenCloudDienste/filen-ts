import DOMPurify from "dompurify"
import { createEmailHtmlSanitizer } from "@filen/shared/dom"

export type { EmailLink, EmailSanitizeResult } from "@filen/shared/dom"

// HTML from untrusted files for SafeHtmlDocument (an email body, a notebook's HTML output), on a DOMPurify instance of
// its own: see the shared sanitizer.
export const sanitizeEmailHtml = createEmailHtmlSanitizer(() => DOMPurify(window))
