import { lazy, Suspense, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { CodeIcon, EyeIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { decodeUtf8 } from "@/features/drive/lib/preview.logic"
import { markdownUrlTransform } from "@/features/preview/components/markdownViewer.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface MarkdownViewerProps {
	item: DriveItem
	alt: string
}

// "View source" mounts the SAME read-only CodeMirror surface every text/code file uses — a nested
// lazy() (not a plain import) so opening a markdown file never pulls CodeMirror's chunk in; it fetches
// only when the toggle is actually used, resolving to the SAME chunk previewOverlay.tsx's own
// TextViewer lazy() produces.
const TextViewer = lazy(() => import("@/features/preview/components/textViewer"))

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
// `code` spans don't. No fence-internal syntax highlighting here (unlike textViewer.tsx's CodeMirror
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

function MarkdownRender({ text, alt }: { text: string; alt: string }) {
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

function MarkdownToolbar({ mode, onToggle }: { mode: "rendered" | "source"; onToggle: () => void }) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex h-10 shrink-0 items-center justify-end px-2">
			<Button
				variant="ghost"
				size="sm"
				onClick={onToggle}
			>
				{mode === "rendered" ? (
					<>
						<CodeIcon />
						{t("previewMarkdownViewSourceAction")}
					</>
				) : (
					<>
						<EyeIcon />
						{t("previewMarkdownViewRenderedAction")}
					</>
				)}
			</Button>
		</div>
	)
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category) — decodes ONCE here for the rendered view; the source toggle mounts a fully separate
// TextViewer instance with its OWN usePreviewBytes call rather than threading these same bytes through,
// trading one extra re-download (only paid if the toggle is actually used) for keeping both viewers
// independently composable, matching every other viewer's own self-contained {item, alt} shape.
function MarkdownViewer({ item, alt }: MarkdownViewerProps) {
	const result = usePreviewBytes(item)
	const [mode, setMode] = useState<"rendered" | "source">("rendered")

	if (result.status === "pending") {
		return (
			<div className="flex size-full items-center justify-center">
				<Spinner className="size-6" />
			</div>
		)
	}

	if (result.status === "error") {
		return (
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
				{errorLabel(result.dto)}
			</div>
		)
	}

	const text = decodeUtf8(result.bytes)

	return (
		<div className="flex size-full flex-col">
			<MarkdownToolbar
				mode={mode}
				onToggle={() => {
					setMode(prev => (prev === "rendered" ? "source" : "rendered"))
				}}
			/>
			<div className="min-h-0 flex-1">
				{mode === "source" ? (
					<Suspense
						fallback={
							<div className="flex size-full items-center justify-center">
								<Spinner className="size-6" />
							</div>
						}
					>
						<TextViewer
							item={item}
							alt={alt}
						/>
					</Suspense>
				) : (
					<MarkdownRender
						text={text}
						alt={alt}
					/>
				)}
			</div>
		</div>
	)
}

export default MarkdownViewer
