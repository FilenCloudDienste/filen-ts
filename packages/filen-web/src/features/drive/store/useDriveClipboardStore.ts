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
	// The cut items' uuids, for the rows that dim while cut; empty for a copy.
	cutUuids: ReadonlySet<string>
	set: (entry: DriveClipboardEntry) => void
	clear: () => void
	// A pasted cut leaves the clipboard as it starts moving, so a second paste can't move the same items
	// again; what failed to move comes back, unless something else was copied or cut meanwhile.
	restoreCut: (items: readonly DriveItem[]) => void
}

const NOTHING_CUT: ReadonlySet<string> = new Set()

function withEntry(entry: DriveClipboardEntry | null): Pick<DriveClipboardState, "entry" | "cutUuids"> {
	return {
		entry,
		cutUuids: entry?.mode === "cut" ? new Set(entry.items.map(item => item.data.uuid)) : NOTHING_CUT
	}
}

export const useDriveClipboardStore = create<DriveClipboardState>(set => ({
	entry: null,
	cutUuids: NOTHING_CUT,
	set: entry => {
		set(withEntry(entry))
	},
	clear: () => {
		set(withEntry(null))
	},
	restoreCut: items => {
		set(state => (state.entry !== null || items.length === 0 ? state : withEntry({ mode: "cut", items: items.slice() })))
	}
}))
