import type { MermaidConfig } from "mermaid"

// What the diagram frame renders with, shared by the frame (entry.ts) and the page that drives it (mermaidFrame.ts).
// Types only from mermaid: importing this never brings mermaid itself into the page.

// The largest source the frame is given (characters), and the most edges a flowchart may have.
export const MERMAID_MAX_TEXT = 50_000
export const MERMAID_MAX_EDGES = 500

export type MermaidTheme = "default" | "dark"

// A job, page to frame.
export interface MermaidJob {
	readonly id: number
	readonly source: string
	readonly theme: MermaidTheme
}

// Its answer, frame to page: the SVG, or why there is none.
export type MermaidReply = { readonly id: number; readonly svg: string } | { readonly id: number; readonly error: "failed" | "tooComplex" }

// Every top-level key of mermaid's configuration, its type's and its defaults' (treemap has a default but no type). All
// of them are `secure`: a diagram's own directives and front matter can set none (the page strips both as well).
export const MERMAID_CONFIG_KEYS = [
	"theme",
	"themeVariables",
	"themeCSS",
	"look",
	"handDrawnSeed",
	"layout",
	"maxTextSize",
	"maxEdges",
	"elk",
	"darkMode",
	"htmlLabels",
	"fontFamily",
	"altFontFamily",
	"logLevel",
	"securityLevel",
	"startOnLoad",
	"arrowMarkerAbsolute",
	"secure",
	"legacyMathML",
	"forceLegacyMathML",
	"deterministicIds",
	"deterministicIDSeed",
	"flowchart",
	"swimlane",
	"agentflow",
	"sequence",
	"gantt",
	"journey",
	"timeline",
	"class",
	"state",
	"er",
	"pie",
	"quadrantChart",
	"xyChart",
	"requirement",
	"architecture",
	"mindmap",
	"ishikawa",
	"kanban",
	"gitGraph",
	"c4",
	"sankey",
	"packet",
	"block",
	"eventmodeling",
	"treeView",
	"radar",
	"usecase",
	"venn",
	"wardley-beta",
	"cynefin",
	"railroad",
	"dompurifyConfig",
	"wrap",
	"fontSize",
	"markdownAutoWrap",
	"suppressErrorRendering",
	"treemap"
] as const satisfies readonly (keyof MermaidConfig | "treemap")[]

type UnlistedKey = Exclude<keyof MermaidConfig, (typeof MERMAID_CONFIG_KEYS)[number]>

// Does not compile once a mermaid update adds a key the list above lacks (the error names it).
export const MERMAID_CONFIG_KEYS_COMPLETE: [UnlistedKey] extends [never] ? true : UnlistedKey = true

// The frame's whole configuration: strict security, SVG text labels (no HTML in the drawing), ids that depend only on
// the source, the dagre layout, and the size caps.
export function mermaidFrameConfig(theme: MermaidTheme): MermaidConfig {
	return {
		startOnLoad: false,
		securityLevel: "strict",
		htmlLabels: false,
		deterministicIds: true,
		layout: "dagre",
		maxTextSize: MERMAID_MAX_TEXT,
		maxEdges: MERMAID_MAX_EDGES,
		suppressErrorRendering: true,
		theme,
		secure: [...MERMAID_CONFIG_KEYS]
	}
}
