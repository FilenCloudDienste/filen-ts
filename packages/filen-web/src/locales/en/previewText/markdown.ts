// "preview" namespace, text family — the rendered markdown preview (math, images). Spread into preview.ts; same
// catalog rules.
export const previewTextMarkdown = {
	/** Markdown preview — shown in place of an image, which previews never load; {{alt}} is the image's description (may be empty) */
	previewMarkdownImageNotLoaded: "[image: {{alt}}] (not loaded)",
	/** Markdown preview — tooltip of a formula that could not be shown */
	previewMarkdownMathUnreadable: "This formula can't be shown.",
	/** Markdown editor — view switch: the rendered page, read only (a toggle) */
	previewMarkdownRead: "Read",
	/** Markdown editor — view switch: the editing view's menu; {{mode}} is the current one ("Live preview" or "Source") */
	previewMarkdownEditingView: "Editing view: {{mode}}",
	/** Markdown editor — editing view: the source styled in place, its syntax shown only where the cursor is */
	previewMarkdownLivePreview: "Live preview",
	/** Markdown editor — the editing view's menu button in a note's header, short for "Live preview" */
	previewMarkdownLiveShort: "Live",
	/** Markdown editor — editing view: the plain markdown source */
	previewMarkdownSource: "Source",
	/** Markdown editor — why Live preview is unavailable for a very large document */
	previewMarkdownLiveTooLarge: "This document is too large for live preview.",
	/** Markdown live preview — accessible name of a task list item's checkbox */
	previewMarkdownTaskToggle: "Toggle task",
	/** Markdown live preview — tooltip on a link (Windows, Linux) */
	previewMarkdownOpenLink: "Ctrl+click to open",
	/** Markdown live preview — tooltip on a link (macOS) */
	previewMarkdownOpenLinkMac: "Cmd+click to open"
} as const
