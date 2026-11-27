import { useContext, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { MarkdownComponents, MarkdownExtensions } from "@filen/office/react/markdown"
import { MarkdownCode, MarkdownPre, MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { MathFormula } from "@/features/preview/components/mathFormula"
import { HighlightedFence } from "@/features/preview/components/highlightedFence"
import { FenceBudgetContext, newFenceBudget, type FenceBudget } from "@/features/preview/lib/fenceBudget"
import { previewImageSource, previewMarkdownUrlTransform } from "@/features/preview/components/markdownViewer.logic"
import { MermaidFence } from "@/features/preview/components/mermaidDiagram"
import { useMermaidScope } from "@/features/preview/hooks/useMermaidDiagram"
import { MermaidScopeContext } from "@/features/preview/lib/mermaidScope"

// A markdown file as the preview renders it: the shared surface plus math, fences highlighted, Mermaid diagrams (drawn in
// a frame that loads nothing, mermaidFrame.ts), and images that are never fetched (an image embedded as a data: URL
// shows; any other is named in its place). Notes and assistant replies keep the plain surface.

const EXTENSIONS: MarkdownExtensions = { math: true, mermaid: true }

function classNames(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : []
}

function PreviewCode({ className, children }: { className?: string | undefined; children?: ReactNode | undefined }) {
	const classes = className?.split(" ") ?? []

	// Math only as remark-math marks it ($…$, $$…$$ and ```math fences).
	if (classes.includes("math-inline") || classes.includes("math-display")) {
		return (
			<MathFormula
				latex={typeof children === "string" ? children : ""}
				display={classes.includes("math-display")}
			/>
		)
	}

	// A fence with a language: highlighted near the viewport.
	const language = classes.find(name => name.startsWith("language-"))?.slice("language-".length)

	if (language !== undefined && typeof children === "string") {
		return (
			<HighlightedFence
				language={language}
				text={children}
				className={className ?? ""}
			/>
		)
	}

	return <MarkdownCode className={className}>{children}</MarkdownCode>
}

// Display math arrives as `pre > code.math-display`: the formula is its own block, not a code block. A ```mermaid
// fence arrives as `pre > code[data-mermaid]`, its place among the document's diagrams.
const PreviewPre: MarkdownComponents["pre"] = ({ node, children }) => {
	const first = node?.children[0]

	if (first?.type === "element" && first.tagName === "code" && classNames(first.properties.className).includes("math-display")) {
		return <>{children}</>
	}

	const ordinal = first?.type === "element" && first.tagName === "code" ? first.properties["dataMermaid"] : undefined

	if (first?.type === "element" && typeof ordinal === "string") {
		return (
			<MermaidFence
				source={first.children.map(child => (child.type === "text" ? child.value : "")).join("")}
				ordinal={Number(ordinal)}
			/>
		)
	}

	return <MarkdownPre>{children}</MarkdownPre>
}

function PreviewImage({ src, alt }: { src?: string | Blob | undefined; alt?: string | undefined }) {
	const { t } = useTranslation("preview")

	const source = typeof src === "string" ? previewImageSource(src) : null

	if (source !== null) {
		return (
			<img
				src={source}
				alt={alt}
				className="max-w-full rounded"
			/>
		)
	}

	return <span className="text-muted-foreground italic">{t("previewMarkdownImageNotLoaded", { alt: alt ?? "" })}</span>
}

const OVERRIDES: MarkdownComponents = { code: PreviewCode, pre: PreviewPre, img: PreviewImage }

export function PreviewMarkdown({ text, alt }: { text: string; alt: string }) {
	// The document's fence highlighting budget and diagram scope, kept for its life; a notebook's cells share their
	// notebook's (one budget, one frame and one count of diagrams a document).
	const outerBudget = useContext(FenceBudgetContext)
	const outerScope = useContext(MermaidScopeContext)
	const [ownBudget] = useState<FenceBudget>(newFenceBudget)
	const ownScope = useMermaidScope()
	const budget = outerBudget ?? ownBudget
	const scope = outerScope ?? ownScope

	return (
		<MermaidScopeContext value={scope}>
			<FenceBudgetContext value={budget}>
				<MarkdownRenderer
					text={text}
					alt={alt}
					tabIndex={-1}
					extensions={EXTENSIONS}
					overrides={OVERRIDES}
					urlTransform={previewMarkdownUrlTransform}
				/>
			</FenceBudgetContext>
		</MermaidScopeContext>
	)
}
