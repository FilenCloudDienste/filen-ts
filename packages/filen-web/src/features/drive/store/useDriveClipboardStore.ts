import { create } from "zustand"
import { type DriveItem } from "@/features/drive/lib/item"

// Drive's own clipboard: items marked to be copied or moved by a later paste. In memory and per tab,
// never the system clipboard, which holds no drive items.
export type DriveClipboardMode = "copy" | "cut"

export interface DriveClipboardEntry {
	mode: DriveClipboardMode
	items: DriveItem[]
}

// What one change does to an item on the clipboard: the item as it now is (the same object when the
// change isn't about it), or null once it's gone.
export type ClipboardItemUpdate = (item: DriveItem) => DriveItem | null

// A cut whose paste is moving. Changes keep reaching its items, so what failed to move comes back as it
// now is, and not at all once it's gone.
export interface CutPaste {
	readonly items: readonly DriveItem[]
	readonly current: (DriveItem | null)[]
}

interface DriveClipboardState {
	entry: DriveClipboardEntry | null
	// The cut items' uuids, for the rows that dim while cut; empty for a copy.
	cutUuids: ReadonlySet<string>
	set: (entry: DriveClipboardEntry) => void
	// Also forgets the cuts being pasted: what they fail to move stays off the clipboard.
	clear: () => void
	// Applies a change to the items held here, or only to a cut's (the entry, and those being pasted)
	// when `cutOnly`. The state stays as it is when none of them changed.
	follow: (change: { update: ClipboardItemUpdate; cutOnly: boolean }) => void
	// A pasted cut leaves the clipboard as it starts moving, so a second paste can't move the same items
	// again; what failed to move comes back, unless something else was copied or cut meanwhile.
	takeCut: () => CutPaste | null
	restoreCut: (paste: CutPaste, failed: readonly DriveItem[]) => void
}

const NOTHING_CUT: ReadonlySet<string> = new Set()

// Outside the state: nothing renders them.
const cutPastes = new Set<CutPaste>()

function withEntry(entry: DriveClipboardEntry | null): Pick<DriveClipboardState, "entry" | "cutUuids"> {
	return {
		entry,
		cutUuids: entry?.mode === "cut" ? new Set(entry.items.map(item => item.data.uuid)) : NOTHING_CUT
	}
}

// The same array when nothing changed.
function followItems(items: DriveItem[], update: ClipboardItemUpdate): DriveItem[] {
	let next: DriveItem[] | null = null

	for (const [index, item] of items.entries()) {
		const updated = update(item)

		if (updated !== item && next === null) {
			next = items.slice(0, index)
		}

		if (next !== null && updated !== null) {
			next.push(updated)
		}
	}

	return next ?? items
}

export const useDriveClipboardStore = create<DriveClipboardState>((set, get) => ({
	entry: null,
	cutUuids: NOTHING_CUT,
	set: entry => {
		set(withEntry(entry))
	},
	clear: () => {
		cutPastes.clear()
		set(withEntry(null))
	},
	follow: ({ update, cutOnly }) => {
		for (const paste of cutPastes) {
			for (const [index, item] of paste.current.entries()) {
				if (item !== null) {
					paste.current[index] = update(item)
				}
			}
		}

		const entry = get().entry

		if (entry === null || (cutOnly && entry.mode !== "cut")) {
			return
		}

		const items = followItems(entry.items, update)

		if (items !== entry.items) {
			set(withEntry(items.length === 0 ? null : { mode: entry.mode, items }))
		}
	},
	takeCut: () => {
		const entry = get().entry

		if (entry?.mode !== "cut") {
			return null
		}

		const paste: CutPaste = { items: entry.items, current: entry.items.slice() }

		cutPastes.add(paste)
		set(withEntry(null))

		return paste
	},
	restoreCut: (paste, failed) => {
		if (!cutPastes.delete(paste)) {
			return
		}

		const failedItems = new Set(failed)
		const items: DriveItem[] = []

		for (const [index, item] of paste.items.entries()) {
			const now = paste.current[index]

			if (failedItems.has(item) && now !== undefined && now !== null) {
				items.push(now)
			}
		}

		set(state => (state.entry !== null || items.length === 0 ? state : withEntry({ mode: "cut", items })))
	}
}))
