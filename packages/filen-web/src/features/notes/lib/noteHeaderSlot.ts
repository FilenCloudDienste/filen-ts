import { createContext } from "react"

// The note editor header's spot for an editor's own controls (the md editor's view switch), portalled there by the
// editor that holds their state; null until the header mounts, and outside a note editor pane.
export const NoteHeaderSlotContext = createContext<HTMLElement | null>(null)
