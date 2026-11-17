// "preview" namespace, text family — sanitized HTML shown in a sandboxed frame (an email body, a notebook output): the
// list of its links under it. Spread into preview.ts; same catalog rules.
export const previewTextHtml = {
	/** Sandboxed HTML (email body, notebook output) — disclosure under the document listing its links; {{count}} is how many */
	previewHtmlLinks: "Links ({{count}})",
	/** Sandboxed HTML — accessible name of one listed link; {{text}} is the link's text, {{place}} its host or mail address */
	previewHtmlLinkOpen: "Open {{text}} ({{place}})",
	/** Sandboxed HTML — where a mail link writes to when it also copies others in; {{place}} is the address */
	previewHtmlLinkMailCopies: "{{place}}, with copies to others",
	/** Sandboxed HTML — where a mail link writes to when it also fills in a subject or text; {{place}} is the address */
	previewHtmlLinkMailParameters: "{{place}}, with a prepared message",
	/** Sandboxed HTML — shown instead of a formatted body too large to show */
	previewHtmlTooLarge: "This formatted content is too large to show."
} as const
