import { createContext } from "react"

// The title page's scroller, which a series' episode lists window their rows over.
export const TitleScrollContext = createContext<HTMLElement | null>(null)
