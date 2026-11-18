// "preview" namespace, text family — Mermaid diagrams (markdown fences and .mmd files). Spread into preview.ts; same
// catalog rules.
export const previewTextMermaid = {
	/** Mermaid diagram — the picture's description for screen readers */
	previewMermaidAlt: "Mermaid diagram",
	/** Mermaid diagram — status while it is drawn */
	previewMermaidRendering: "Rendering diagram",
	/** Mermaid diagram — button on a diagram past the first 50 of a document, which waits until asked */
	previewMermaidRender: "Render diagram",
	/** Mermaid diagram — shown instead of a diagram that names images, icons or links */
	previewMermaidRefused: "This diagram uses images or links, which previews don't load.",
	/** Mermaid diagram — button below the refused message that reveals the diagram's source */
	previewMermaidShowSource: "Show source",
	/** Mermaid diagram — shown instead of a diagram too large or slow to draw */
	previewMermaidTooComplex: "Diagram too complex to preview",
	/** Mermaid diagram — tooltip of a diagram's source shown because it could not be drawn */
	previewMermaidUnreadable: "This diagram can't be shown.",
	/** .mmd/.mermaid file — the command bar's view switch label */
	previewMermaidView: "Diagram view"
} as const
