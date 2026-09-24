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
	// The cut items' uuids, so each row dims with one Set lookup; empty for a copy.
	cutUuids: ReadonlySet<string>
	set: (entry: DriveClipboardEntry) => void
	clear: () => void
	// A pasted cut leaves the clipboard as it starts moving, so a second paste can't move the same items
	// again; what failed to move comes back, unless something else was copied or cut meanwhile.
	restoreCut: (items: readonly DriveItem[]) => void
}

const NOTHING_CUT: ReadonlySet<string> = new Set()

function withEntry(entry: DriveClipboardEntry | null): Pick<DriveClipboardStore, "entry" | "cutUuids"> {
	return {
		entry,
		cutUuids: entry?.mode === "cut" ? new Set(entry.items.map(item => item.data.uuid)) : NOTHING_CUT
	}
}

export const useDriveClipboardStore = create<DriveClipboardStore>(set => ({
	entry: null,
	cutUuids: NOTHING_CUT,
	set(entry) {
		set(withEntry(entry))
	},
	clear() {
		set(withEntry(null))
	},
	restoreCut(items) {
		set(state => (state.entry !== null || items.length === 0 ? state : withEntry({ mode: "cut", items: items.slice() })))
	}
}))

// One Set lookup per row; a row re-renders only when its own cut state flips.
export function useIsDriveItemCut(uuid: string): boolean {
	return useDriveClipboardStore(state => state.cutUuids.has(uuid))
}

export default useDriveClipboardStore
