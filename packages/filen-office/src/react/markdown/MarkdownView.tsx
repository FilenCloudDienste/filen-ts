import Markdown, { type Components, type UrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { remarkGuardedMath } from "./remarkGuardedMath"
import { remarkMermaidFences } from "./remarkMermaidFences"
import { markdownUrlTransform } from "../../core/markdown/urls"

// The rendered markdown view: CommonMark plus GFM (tables, task lists, strikethrough, autolinks), no styles.
// Raw HTML in the source is never parsed into elements (no rehype-raw): a `<script>` or `<img onerror>`
// renders as inert text. URLs go through `urlTransform`, the shared link policy by default. `components`
// replaces single elements (the host's styling, link handling or a stricter rendering); pass a module-scope
// object so it is not rebuilt on every render.

export type MarkdownComponents = Components
export type MarkdownUrlTransform = UrlTransform

// Opt-in syntax beyond GFM. `math`: inline math between single dollar signs (GitHub's rule, remarkGuardedMath) and
// display math between double ones or in a ```math fence, emitted as `code.language-math` with `math-inline`, or `math-display` inside a
// `pre`, for the host's code slot to render. `mermaid`: each ```mermaid fence's `code` carries its place among the
// document's diagrams as `data-mermaid` (remarkMermaidFences), for the host's slots to draw it.
export interface MarkdownExtensions {
	readonly math?: true
	readonly mermaid?: true
}

export interface MarkdownViewProps {
	readonly text: string
	readonly components?: MarkdownComponents | undefined
	readonly urlTransform?: MarkdownUrlTransform | undefined
	readonly extensions?: MarkdownExtensions | undefined
}

// Every combination, built once: react-markdown rebuilds its processor when the list changes.
const PLUGINS = {
	none: [remarkGfm],
	math: [remarkGfm, remarkGuardedMath],
	mermaid: [remarkGfm, remarkMermaidFences],
	both: [remarkGfm, remarkGuardedMath, remarkMermaidFences]
}

function pluginsFor(extensions: MarkdownExtensions | undefined) {
	const math = extensions?.math === true
	const mermaid = extensions?.mermaid === true

	return math ? (mermaid ? PLUGINS.both : PLUGINS.math) : mermaid ? PLUGINS.mermaid : PLUGINS.none
}

export function MarkdownView({ text, components, urlTransform, extensions }: MarkdownViewProps) {
	return (
		<Markdown
			remarkPlugins={pluginsFor(extensions)}
			urlTransform={urlTransform ?? markdownUrlTransform}
			components={components}
		>
			{text}
		</Markdown>
	)
}
