import { create } from "zustand"
import type { DriveItem } from "@/types"

// Drive's own clipboard: items marked to be copied or moved by a later paste. Memory only, never the
// system clipboard, so a kill or logout empties it.
export type DriveClipboardMode = "copy" | "cut"

export type DriveClipboardEntry = {
	mode: DriveClipboardMode
	items: DriveItem[]
}

export type DriveClipboardStore = {
	entry: DriveClipboardEntry | null
	set: (entry: DriveClipboardEntry) => void
	clear: () => void
}

export const useDriveClipboardStore = create<DriveClipboardStore>(set => ({
	entry: null,
	set(entry) {
		set({
			entry
		})
	},
	clear() {
		set({
			entry: null
		})
	}
}))

export default useDriveClipboardStore
