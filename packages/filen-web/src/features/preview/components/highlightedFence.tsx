import { useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { codeLanguageIdFor, highlightCodeRuns, mountCodeHighlightStyle, type CodeRun } from "@filen/office/dom/code"
import { scheduleIdle } from "@filen/shared/dom/scheduleIdle"
import { useNearViewport } from "@/lib/useNearViewport"
import { FENCE_MAX_CHARS, FENCE_MAX_LINES, FenceBudgetContext, type FenceBudget } from "@/features/preview/lib/fenceBudget"

// Code highlighted as the editor would (a markdown file's fences, a notebook's cells): a block is highlighted once it
// comes near its scroller, one block an idle task, and none past the document's budget (FENCE_MAX_LINES lines,
// FENCE_MAX_CHARS characters) or the highlighter's own size cap: those stay plain monospace.

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

// What a budget has charged for fences no longer mounted, by text: a fence mounted again with the same text takes one
// of these instead of charging again, while every mounted fence keeps its own (two equal fences are two charges).
const released = new WeakMap<FenceBudget, Map<string, number>>()

function releaseCharge(budget: FenceBudget, text: string): void {
	const pool = released.get(budget) ?? new Map<string, number>()

	pool.set(text, (pool.get(text) ?? 0) + 1)
	released.set(budget, pool)
}

function takeReleasedCharge(budget: FenceBudget, text: string): boolean {
	const pool = released.get(budget)
	const count = pool?.get(text) ?? 0

	if (pool === undefined || count === 0) return false

	if (count === 1) {
		pool.delete(text)
	} else {
		pool.set(text, count - 1)
	}

	return true
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

interface Highlight {
	text: string
	id: string
	runs: readonly CodeRun[]
}

// `language`: a language id or the fence's info word ("ts", "python"); `text` its content. Highlighted once a text:
// coming near again neither highlights nor charges the budget again.
export function HighlightedFence({ language, text, className }: { language: string; text: string; className: string }) {
	const budget = useContext(FenceBudgetContext)
	const [element, setElement] = useState<HTMLElement | null>(null)
	// A fence renders inside MarkdownRenderer's `role="document"` element: a markdown file's own scroller. In a notebook
	// cell that element does not scroll (the notebook's does), and the notebook provides its scroller through context.
	const near = useNearViewport(element, FENCE_MARGIN, element?.closest('[role="document"]') ?? undefined)
	const [highlight, setHighlight] = useState<Highlight | null>(null)
	// The text this fence has charged its budget for, held until it charges for another or unmounts.
	const charged = useRef<{ budget: FenceBudget; text: string } | null>(null)
	const id = codeLanguageIdFor(language)
	const current = highlight !== null && highlight.text === text && highlight.id === id ? highlight : null

	useEffect(() => {
		if (!near || id === null || budget === null || current !== null) {
			return undefined
		}

		return enqueue(() => {
			const held = charged.current
			const holds = held !== null && held.budget === budget && held.text === text
			const taken = !holds && takeReleasedCharge(budget, text)
			const lines = text.split("\n").length

			if (!holds && !taken && (budget.lines + lines > FENCE_MAX_LINES || budget.chars + text.length > FENCE_MAX_CHARS)) return

			const highlighted = highlightCodeRuns(text, id)

			if (highlighted === null) {
				if (taken) releaseCharge(budget, text)

				return
			}

			if (!holds) {
				if (!taken) {
					budget.lines += lines
					budget.chars += text.length
				}

				if (held !== null) releaseCharge(held.budget, held.text)

				charged.current = { budget, text }
			}

			mountCodeHighlightStyle(document)
			setHighlight({ text, id, runs: highlighted })
		})
	}, [near, id, text, budget, current])

	useEffect(
		() => () => {
			const held = charged.current

			if (held !== null) {
				releaseCharge(held.budget, held.text)
				charged.current = null
			}
		},
		[]
	)

	const content: ReactNode = current === null ? text : <Runs runs={current.runs} />

	return (
		<code
			ref={setElement}
			className={`fo-code-static ${className}`}
		>
			{content}
		</code>
	)
}
