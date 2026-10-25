import { type MouseEvent, type ReactNode } from "react"
import { cn } from "@filen/shared"
import { MarkdownView, type MarkdownComponents, type MarkdownUrlTransform } from "@filen/office/react/markdown"
import { markdownUrlTransform } from "@/features/preview/components/markdownViewer.logic"
import { useTrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"

// Shared rendered-markdown surface: file preview, the notes reader and editor preview, and the assistant's
// replies render through the package's MarkdownView with these element slots.

// Links open in a new tab, once their domain is trusted (the container's delegated handlers below); the
// URL itself already passed the link policy (markdownViewer.logic.ts).
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
const MARKDOWN_COMPONENTS: MarkdownComponents = {
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

interface MarkdownRendererProps {
	text: string
	alt: string
	className?: string | undefined
	overrides?: MarkdownComponents | undefined
	urlTransform?: MarkdownUrlTransform | undefined
	// -1: focusable from code (F6 from the preview's command bar).
	tabIndex?: number | undefined
}

function MarkdownBody({
	text,
	alt,
	className,
	overrides,
	urlTransform,
	tabIndex,
	onClick,
	onAuxClick
}: MarkdownRendererProps & {
	onClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined
	onAuxClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined
}) {
	const components = overrides === undefined ? MARKDOWN_COMPONENTS : { ...MARKDOWN_COMPONENTS, ...overrides }

	return (
		<div
			role="document"
			aria-label={alt}
			className={cn("size-full overflow-auto px-6 py-4 outline-none select-text", className)}
			tabIndex={tabIndex}
			onClick={onClick}
			onAuxClick={onAuxClick}
		>
			<MarkdownView
				text={text}
				components={components}
				urlTransform={urlTransform ?? markdownUrlTransform}
			/>
		</div>
	)
}

function GatedMarkdown(props: MarkdownRendererProps) {
	const linkGate = useTrustedLinkGate()

	return (
		<>
			<MarkdownBody
				{...props}
				onClick={linkGate.onClick}
				onAuxClick={linkGate.onAuxClick}
			/>
			{linkGate.dialog}
		</>
	)
}

// `className` replaces the full-pane geometry for an inline host (the assistant's reply bubbles).
// `overrides` replace single elements and `urlTransform` the link policy, for a host with a stricter one;
// pass module-scope values. A host that replaces the link slot owns its links, so only the default one
// goes through the trust confirmation.
export function MarkdownRenderer(props: MarkdownRendererProps) {
	return props.overrides?.a === undefined ? <GatedMarkdown {...props} /> : <MarkdownBody {...props} />
}
