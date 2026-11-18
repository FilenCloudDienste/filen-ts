import { createContext } from "react"

// What a document's highlighted code (a markdown file's fences, a notebook's cells) has taken so far, shared by all of
// it (highlightedFence.tsx): past either cap the rest stays plain.
export interface FenceBudget {
	lines: number
	chars: number
}

export const FENCE_MAX_LINES = 10_000
export const FENCE_MAX_CHARS = 1_048_576

export function newFenceBudget(): FenceBudget {
	return { lines: 0, chars: 0 }
}

export const FenceBudgetContext = createContext<FenceBudget | null>(null)
