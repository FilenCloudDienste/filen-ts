import { MERMAID_MAX_TEXT } from "@/mermaidFrame/config"

// What a diagram's source becomes before the frame sees it. The frame's own policy is what guarantees nothing a diagram
// names is fetched; this keeps diagrams that would try from rendering half-drawn (and from filling the console with
// refused loads), and keeps a diagram from reconfiguring the renderer.

export type MermaidSourceVerdict =
	| { readonly kind: "render"; readonly source: string }
	// It names images, icons, links or callbacks.
	| { readonly kind: "refused" }
	| { readonly kind: "tooComplex" }

// `%%{…}%%` directives. Mermaid reads one anywhere, across lines, and an unclosed one takes the rest of the text.
const DIRECTIVE = /%%\{[\s\S]*?\}%%/g
const UNCLOSED_DIRECTIVE = /%%\{[\s\S]*$/
// Front matter as mermaid finds it: `---` lines at the very start. Only a plain one-line title is kept.
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const FRONT_MATTER_TITLE = /^title:[ \t]*[^\r\n{}[\]]*$/m

// Shape and node attributes that load a picture (`@{ img: … }`, `icon: …`, a mindmap's `::icon(…)`), statements that
// make a node a link or a script call (`click`, a sequence's `link`/`links`, C4's `$link`, `href`, `callback`) and
// styles that load (`url(…)`, `@import`).
const REFUSED = [
	/\b(?:img|icon)\s*:/i,
	/::icon\s*\(/i,
	/^\s*(?:click|links?|callback)\b/im,
	/\$link\b/i,
	/\bhref\b/i,
	/\bcallback\b/i,
	/\burl\s*\(/i,
	/@import\b/i
] as const

function withoutFrontMatter(text: string): string {
	const start = text.trimStart()
	const match = FRONT_MATTER.exec(start)

	if (match === null) {
		return text
	}

	const title = FRONT_MATTER_TITLE.exec(match[1] ?? "")
	const rest = start.slice(match[0].length)

	return title === null ? rest : `---\n${title[0]}\n---\n${rest}`
}

export function mermaidSourceVerdict(text: string): MermaidSourceVerdict {
	if (text.length > MERMAID_MAX_TEXT) {
		return { kind: "tooComplex" }
	}

	const source = withoutFrontMatter(text.replace(DIRECTIVE, "").replace(UNCLOSED_DIRECTIVE, ""))

	if (REFUSED.some(pattern => pattern.test(source))) {
		return { kind: "refused" }
	}

	return { kind: "render", source }
}
