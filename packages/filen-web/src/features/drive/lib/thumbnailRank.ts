import { createContext } from "react"

// A listing's answer to "how soon is the cell at this index worth a thumbnail generation" (see rowRank),
// read only when a generation slot frees. Null outside a virtualized listing: a lone cell ranks first.
// The provider's value must keep its identity while scrolling, or every thumbnail re-renders each frame.
export const ThumbnailRankContext = createContext<((index: number) => number) | null>(null)
