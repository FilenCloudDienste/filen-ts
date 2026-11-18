import { createContext } from "react"

// The lines a markdown document's fences have highlighted so far, shared by its fences (highlightedFence.tsx).
export interface FenceBudget {
	lines: number
}

export const FenceBudgetContext = createContext<FenceBudget | null>(null)
