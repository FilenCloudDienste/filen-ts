// "preview" namespace, text family — the rendered markdown preview (math, images). Spread into preview.ts; same
// catalog rules.
export const previewTextMarkdown = {
	/** Markdown preview — shown in place of an image, which previews never load; {{alt}} is the image's description (may be empty) */
	previewMarkdownImageNotLoaded: "[image: {{alt}}] (not loaded)",
	/** Markdown preview — tooltip of a formula that could not be shown */
	previewMarkdownMathUnreadable: "This formula can't be shown."
} as const
