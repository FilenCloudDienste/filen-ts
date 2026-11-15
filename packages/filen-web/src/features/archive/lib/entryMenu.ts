import { createContext } from "react"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { ExtractTarget } from "@/features/archive/lib/extractSelection"
import type { RowRef } from "@/features/archive/lib/sortedChildren"

export type EntryMenuAction =
	{ type: "open" } | { type: "download" } | { type: "extract"; target: ExtractTarget } | { type: "chooseDestination" }

export type SelectionMenuAction = { type: "extract"; target: ExtractTarget } | { type: "chooseDestination" }

export interface EntryOffers {
	open: boolean
	download: boolean
}

// What a row's context menu offers, the selection holding the row: a file the ⋯ menu's items; a directory
// Open, and Extract where it can be selected; any other selectable entry, or a row among several
// selected, the selection's Extract.
export type RowMenu = { type: "entry"; slot: number } | { type: "dir"; dir: number; extract: boolean } | { type: "selection" }

// What a row's ⋯ and context menus act through. Read only by an open menu, so the rows themselves stay
// on primitive props and a listing update re-renders none for it.
export interface EntryMenuHost {
	source: ArchiveSource
	// The new directory an extract next to the archive makes; null for a single compressed file.
	newFolderName: string | null
	extractDisabled: boolean
	// The selection's Extract is off (as the footer's Extract selected is).
	selectionExtractDisabled: boolean
	offers: (slot: number) => EntryOffers
	onAction: (slot: number, action: EntryMenuAction) => void
	// A right-click on the row at `index`: selects the row first where the selection doesn't hold it (the
	// drive listing's convention), and says what its menu offers; null for a row with none, which then
	// leaves the selection alone.
	openRowMenu: (index: number, ref: RowRef) => RowMenu | null
	onSelectionAction: (action: SelectionMenuAction) => void
	onOpenDir: (dir: number) => void
}

export const EntryMenuContext = createContext<EntryMenuHost | null>(null)
