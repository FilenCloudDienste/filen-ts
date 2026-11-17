// "preview" namespace, text family — sanitized HTML shown in a sandboxed frame (an email body, a notebook output): the
// list of its links under it. Spread into preview.ts; same catalog rules.
export const previewTextHtml = {
	/** Sandboxed HTML (email body, notebook output) — disclosure under the document listing its links; {{count}} is how many */
	previewHtmlLinks: "Links ({{count}})",
	/** Sandboxed HTML — accessible name of one listed link; {{text}} is the link's text, {{place}} its host or mail address */
	previewHtmlLinkOpen: "Open {{text}} ({{place}})"
} as const
