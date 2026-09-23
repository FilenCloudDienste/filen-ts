import { create } from "zustand"
import { type DriveItem } from "@/features/drive/lib/item"

// Drive's own clipboard: items marked to be copied or moved by a later paste. In memory and per tab,
// never the system clipboard, which holds no drive items.
export type DriveClipboardMode = "copy" | "cut"

export interface DriveClipboardEntry {
	mode: DriveClipboardMode
	items: DriveItem[]
}

interface DriveClipboardState {
	entry: DriveClipboardEntry | null
	set: (entry: DriveClipboardEntry) => void
	clear: () => void
	// A pasted cut leaves the clipboard as it starts moving, so a second paste can't move the same items
	// again; what failed to move comes back, unless something else was copied or cut meanwhile.
	restoreCut: (items: readonly DriveItem[]) => void
}

export const useDriveClipboardStore = create<DriveClipboardState>(set => ({
	entry: null,
	set: entry => {
		set({ entry })
	},
	clear: () => {
		set({ entry: null })
	},
	restoreCut: items => {
		set(state => (state.entry !== null || items.length === 0 ? state : { entry: { mode: "cut", items: items.slice() } }))
	}
}))
