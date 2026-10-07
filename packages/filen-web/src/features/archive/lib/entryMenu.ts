import { createContext } from "react"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { ExtractTarget } from "@/features/archive/lib/extractSelection"

export type EntryMenuAction =
	{ type: "open" } | { type: "download" } | { type: "extract"; target: ExtractTarget } | { type: "chooseDestination" }

export interface EntryOffers {
	open: boolean
	download: boolean
}

// What a file row's ⋯ menu acts through. Read only by an open menu, so the rows themselves stay on
// primitive props and a listing update re-renders none for it.
export interface EntryMenuHost {
	source: ArchiveSource
	// The new directory an extract next to the archive makes; null for a single compressed file.
	newFolderName: string | null
	extractDisabled: boolean
	offers: (slot: number) => EntryOffers
	onAction: (slot: number, action: EntryMenuAction) => void
}

export const EntryMenuContext = createContext<EntryMenuHost | null>(null)
