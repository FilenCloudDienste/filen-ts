import { useContext, useEffect, useState, type ReactNode } from "react"
import { codeLanguageIdFor, highlightCodeRuns, mountCodeHighlightStyle, type CodeRun } from "@filen/office/dom/code"
import { scheduleIdle } from "@filen/shared/dom/scheduleIdle"
import { useNearViewport } from "@/lib/useNearViewport"
import { FenceBudgetContext } from "@/features/preview/lib/fenceBudget"

// A markdown file's fenced code highlighted as the editor would: a fence is highlighted once it comes near the viewport,
// one fence an idle task, and none past FENCE_MAX_LINES lines a document (or past the highlighter's own size cap): those
// stay plain monospace.

const FENCE_MAX_LINES = 10_000
const FENCE_MARGIN = 800

// One fence an idle task, across documents.
const queue: (() => void)[] = []
let draining = false

function drain(): void {
	queue.shift()?.()

	if (queue.length > 0) {
		scheduleIdle(drain, { timeout: 500, fallbackMs: 16 })
	} else {
		draining = false
	}
}

function enqueue(job: () => void): () => void {
	let cancelled = false

	queue.push(() => {
		if (!cancelled) job()
	})

	if (!draining) {
		draining = true
		scheduleIdle(drain, { timeout: 500, fallbackMs: 16 })
	}

	return () => {
		cancelled = true
	}
}

function Runs({ runs }: { runs: readonly CodeRun[] }) {
	return runs.map((run, index) =>
		run.classes === "" ? (
			run.text
		) : (
			<span
				key={index}
				className={run.classes}
			>
				{run.text}
			</span>
		)
	)
}

// `language`: the fence's info word ("ts", "python"); `text` its content.
export function HighlightedFence({ language, text, className }: { language: string; text: string; className: string }) {
	const budget = useContext(FenceBudgetContext)
	const [element, setElement] = useState<HTMLElement | null>(null)
	const near = useNearViewport(element, FENCE_MARGIN)
	const [runs, setRuns] = useState<readonly CodeRun[] | null>(null)
	const id = codeLanguageIdFor(language)

	useEffect(() => {
		if (!near || id === null || budget === null) {
			return undefined
		}

		return enqueue(() => {
			const lines = text.split("\n").length

			if (budget.lines + lines > FENCE_MAX_LINES) return

			const highlighted = highlightCodeRuns(text, id)

			if (highlighted === null) return

			budget.lines += lines
			mountCodeHighlightStyle(document)
			setRuns(highlighted)
		})
	}, [near, id, text, budget])

	const content: ReactNode = runs === null ? text : <Runs runs={runs} />

	return (
		<code
			ref={setElement}
			className={`fo-code-static ${className}`}
		>
			{content}
		</code>
	)
}
