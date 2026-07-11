import { type ReactNode } from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { markdownUrlTransform } from "@/features/preview/components/markdownViewer.logic"

// Shared rendered-markdown surface — extracted from markdownViewer.tsx so the notes reader's md split
// preview reuses the SAME remark/rehype config and link-hardening as file preview rather than a second
// copy. Preview's own markdownViewer.tsx is this module's regression net.

// react-markdown never parses raw HTML in the source into real elements (no rehype-raw plugin is used,
// deliberately) — a `<script>`/`<img onerror>` written into a .md file renders as an escaped, inert
// text string, never runs. urlTransform closes the remaining hole (a crafted `[link](javascript:...)`
// or `![x](javascript:...)`) via the SAME scheme allowlist docxViewer.tsx's own sanitizeLinks sweep
// uses — see markdownViewer.logic.ts.
function MarkdownLink({ href, children }: { href?: string | undefined; children?: ReactNode | undefined }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
		>
			{children}
		</a>
	)
}

// Fenced code blocks (```lang ... ```) carry a `language-xxx` className from remark/rehype; inline
// `code` spans don't. No fence-internal syntax highlighting here (unlike codeMirrorSource.tsx's
// grammars) — a monospace block is the whole scope for a nested code span inside rendered markdown.
function MarkdownCode({ className, children }: { className?: string | undefined; children?: ReactNode | undefined }) {
	if (typeof className === "string" && className.startsWith("language-")) {
		return <code className={className}>{children}</code>
	}

	return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
}

function MarkdownPre({ children }: { children?: ReactNode | undefined }) {
	return <pre className="mb-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-sm">{children}</pre>
}

// Module-scope (not re-created per render, no useMemo needed for a React-Compiler-managed component):
// none of these close over per-render props, so a stable object reference is the natural shape here.
const MARKDOWN_COMPONENTS: Components = {
	a: MarkdownLink,
	code: MarkdownCode,
	pre: MarkdownPre,
	h1: ({ children }) => <h1 className="mt-0 mb-3 text-2xl font-bold first:mt-0">{children}</h1>,
	h2: ({ children }) => <h2 className="mt-5 mb-2 text-xl font-bold first:mt-0">{children}</h2>,
	h3: ({ children }) => <h3 className="mt-4 mb-2 text-lg font-semibold first:mt-0">{children}</h3>,
	h4: ({ children }) => <h4 className="mt-3 mb-1.5 text-base font-semibold first:mt-0">{children}</h4>,
	h5: ({ children }) => <h5 className="mt-3 mb-1.5 text-base font-semibold first:mt-0">{children}</h5>,
	h6: ({ children }) => <h6 className="mt-3 mb-1.5 text-base font-semibold first:mt-0">{children}</h6>,
	p: ({ children }) => <p className="mb-3 text-sm leading-6">{children}</p>,
	ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 text-sm">{children}</ul>,
	ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm">{children}</ol>,
	li: ({ children }) => <li className="leading-6">{children}</li>,
	blockquote: ({ children }) => (
		<blockquote className="mb-3 border-l-2 border-border pl-3 text-muted-foreground italic">{children}</blockquote>
	),
	hr: () => <hr className="my-4 border-border" />,
	table: ({ children }) => <table className="mb-3 w-full border-collapse text-sm">{children}</table>,
	th: ({ children }) => <th className="border border-border bg-muted px-2 py-1 text-left font-medium">{children}</th>,
	td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
	img: ({ src, alt: imgAlt }) => (
		<img
			src={src}
			alt={imgAlt}
			className="max-w-full rounded"
		/>
	)
}

export function MarkdownRenderer({ text, alt }: { text: string; alt: string }) {
	return (
		<div
			role="document"
			aria-label={alt}
			className="size-full overflow-auto px-6 py-4 select-text"
		>
			<Markdown
				remarkPlugins={[remarkGfm]}
				urlTransform={markdownUrlTransform}
				components={MARKDOWN_COMPONENTS}
			>
				{text}
			</Markdown>
		</div>
	)
}
