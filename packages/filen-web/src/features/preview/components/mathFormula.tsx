import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { assertMathTree, type MathElement } from "@filen/office/core/math"
import { latexPreview, type LatexError } from "@filen/office/core/docx/edit"
import { paintMath } from "@filen/office/react/docx/editor"
import { cn } from "@filen/shared"
import { latexErrorMessage } from "@/features/preview/lib/latexError"

// A markdown file's formula, read by the in-house LaTeX reader (the one Word equations are typed with) and painted
// as MathML. A formula it cannot read shows its source in code style, the reason in its tooltip.

type Formula = { readonly tree: MathElement } | { readonly error: LatexError | null }

// Outside the component: the React Compiler compiles no value blocks inside a try/catch.
function readFormula(latex: string, display: boolean): Formula {
	const preview = latexPreview(latex, display)

	if (preview.tree === null) {
		return { error: preview.error }
	}

	try {
		assertMathTree(preview.tree)

		return { tree: preview.tree }
	} catch {
		return { error: null }
	}
}

export function MathFormula({ latex, display }: { latex: string; display: boolean }) {
	const { t } = useTranslation("preview")
	const formula = readFormula(latex, display)
	const tree = "tree" in formula ? formula.tree : null
	const hostRef = useRef<HTMLSpanElement>(null)

	// Painted outside React: the MathML is built from the tree's allowlists (paintMath), never from markup.
	useEffect(() => {
		const host = hostRef.current

		if (host === null || tree === null) {
			return
		}

		const math = paintMath(tree, host.ownerDocument)

		if (display) {
			math.setAttribute("display", "block")
		}

		host.replaceChildren(math)
	}, [tree, display])

	if (tree === null) {
		const error = "error" in formula ? formula.error : null

		return (
			<code
				className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-destructive"
				title={error === null ? t("previewMarkdownMathUnreadable") : latexErrorMessage(t, error)}
			>
				{display ? `$$${latex}$$` : `$${latex}$`}
			</code>
		)
	}

	return (
		<span
			ref={hostRef}
			role="math"
			aria-label={latex}
			className={cn(display ? "my-3 block overflow-x-auto text-center" : "inline")}
		/>
	)
}
