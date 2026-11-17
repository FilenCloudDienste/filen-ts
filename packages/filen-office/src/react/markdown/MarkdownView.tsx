import Markdown, { type Components, type UrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { remarkGuardedMath } from "./remarkGuardedMath"
import { markdownUrlTransform } from "../../core/markdown/urls"

// The rendered markdown view: CommonMark plus GFM (tables, task lists, strikethrough, autolinks), no styles.
// Raw HTML in the source is never parsed into elements (no rehype-raw): a `<script>` or `<img onerror>`
// renders as inert text. URLs go through `urlTransform`, the shared link policy by default. `components`
// replaces single elements (the host's styling, link handling or a stricter rendering); pass a module-scope
// object so it is not rebuilt on every render.

export type MarkdownComponents = Components
export type MarkdownUrlTransform = UrlTransform

// Opt-in syntax beyond GFM. `math`: inline math between single dollar signs (GitHub's rule, remarkGuardedMath) and
// display math between double ones, emitted as `code.language-math` with `math-inline`, or `math-display` inside a
// `pre`, for the host's code slot to render.
export interface MarkdownExtensions {
	readonly math?: true
}

export interface MarkdownViewProps {
	readonly text: string
	readonly components?: MarkdownComponents | undefined
	readonly urlTransform?: MarkdownUrlTransform | undefined
	readonly extensions?: MarkdownExtensions | undefined
}

const REMARK_PLUGINS = [remarkGfm]
const MATH_PLUGINS = [remarkGfm, remarkGuardedMath]

export function MarkdownView({ text, components, urlTransform, extensions }: MarkdownViewProps) {
	return (
		<Markdown
			remarkPlugins={extensions?.math === true ? MATH_PLUGINS : REMARK_PLUGINS}
			urlTransform={urlTransform ?? markdownUrlTransform}
			components={components}
		>
			{text}
		</Markdown>
	)
}
