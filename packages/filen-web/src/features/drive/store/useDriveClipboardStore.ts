import { create } from "zustand"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"

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

export interface ClipboardChange {
	// The uuids and file stable ids the change is about: without one of them held, nothing is looked at.
	keys: readonly string[]
	update: ClipboardItemUpdate
}

// When the held items were last known current: the socket epoch and the drive events missed so far.
// Events keep them current only while the socket stays up and delivers every drive event.
export interface ClipboardStamp {
	readonly epoch: number | null
	readonly missed: number
}

// A cut whose paste is moving. Changes keep reaching its items, so what failed to move comes back as it
// now is, and not at all once it's gone.
export interface CutPaste {
	readonly items: readonly DriveItem[]
	readonly current: (DriveItem | null)[]
	readonly checked: ClipboardStamp
}

interface DriveClipboardState {
	entry: DriveClipboardEntry | null
	// The cut items' uuids, for the rows that dim while cut; empty for a copy.
	cutUuids: ReadonlySet<string>
	// `current` false for items events may not have kept current though the socket is up: their paste looks
	// them up first.
	set: (entry: DriveClipboardEntry, current?: boolean) => void
	// Also forgets the cuts being pasted: what they fail to move stays off the clipboard.
	clear: () => void
	// Applies a change to the items held here: the entry's, and those of the cuts being pasted. The state
	// stays as it is when none of them changed.
	follow: (change: ClipboardChange) => void
	// Applies a lookup of the entry's items begun at `checked`, in generation `begunIn` (clipboardRecheck.ts):
	// each item it found becomes its current row, or leaves once gone. One a change replaced meanwhile keeps
	// that change. Returns how many left, or null, applying nothing, once the clipboard holds another entry.
	applyRecheck: (found: ReadonlyMap<DriveItem, DriveItem | null>, checked: ClipboardStamp, begunIn: number) => number | null
	// A pasted cut leaves the clipboard as it starts moving, so a second paste can't move the same items
	// again; what failed to move comes back, unless something else was copied or cut meanwhile.
	takeCut: () => CutPaste | null
	restoreCut: (paste: CutPaste, failed: readonly DriveItem[]) => void
}

const NOTHING_CUT: ReadonlySet<string> = new Set()

// Outside the state: nothing renders them.
const cutPastes = new Set<CutPaste>()

// No socket epoch matches it.
const UNCHECKED: ClipboardStamp = { epoch: null, missed: 0 }

let missedEvents = 0
let checkedAt = UNCHECKED
// Moves each time the clipboard takes another entry or gives one up: a copy, a cut, a clear, a cut's paste
// and its return. A followed change keeps it: the entry is still the one the user made.
let generation = 0

// Drive events went undelivered while the socket stayed up (one it couldn't decode), or it dropped.
export function markClipboardEventsMissed(): void {
	missedEvents++
}

export function clipboardStamp(): ClipboardStamp {
	return { epoch: currentSocketEpoch(), missed: missedEvents }
}

export function clipboardGeneration(): number {
	return generation
}

// Whether events have kept the held items current since they were last known to be.
export function isClipboardCurrent(): boolean {
	return socketLiveSince(checkedAt.epoch) && checkedAt.missed === missedEvents
}

export function stableUuidOf(item: DriveItem): string | undefined {
	const base = asDirectoryOrFile(item)

	return base.type === "file" ? base.data.stableUUID : undefined
}

// A Shared by me file: its owner's events reach this tab, but it carries no stable id, so its content
// saves are followed by uuid (clipboardSync.ts).
export function lacksStableId(item: DriveItem): boolean {
	return (
		(item.type === "sharedFile" || item.type === "sharedRootFile") &&
		item.data.stableUUID === undefined &&
		"Receiver" in item.data.sharingRole
	)
}

// Whether a file that lacks a stable id is held, as of when heldKeys was built; a followed item may only
// set it.
let fileLackingStableIdHeld = false

function addKeys(keys: Set<string>, item: DriveItem): void {
	keys.add(item.data.uuid)

	const stableUuid = stableUuidOf(item)

	if (stableUuid !== undefined) {
		keys.add(stableUuid)
	} else if (lacksStableId(item)) {
		fileLackingStableIdHeld = true
	}
}

// Every uuid and file stable id among the held items, so a change about none of them, as nearly every
// event in a burst is, costs a lookup instead of a pass over the clipboard. Built on the first change
// after the held items are replaced; a followed item adds its own. A key left over only costs a pass.
let heldKeys: Set<string> | null = null

function currentHeldKeys(entry: DriveClipboardEntry | null): Set<string> {
	if (heldKeys !== null) {
		return heldKeys
	}

	const keys = new Set<string>()

	fileLackingStableIdHeld = false

	for (const item of entry?.items ?? []) {
		addKeys(keys, item)
	}

	for (const paste of cutPastes) {
		for (const item of paste.current) {
			if (item !== null) {
				addKeys(keys, item)
			}
		}
	}

	heldKeys = keys

	return keys
}

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
	set: (entry, current = true) => {
		generation++
		heldKeys = null
		checkedAt = current ? clipboardStamp() : UNCHECKED
		set(withEntry(entry))
	},
	clear: () => {
		generation++
		cutPastes.clear()
		heldKeys = null
		set(withEntry(null))
	},
	follow: change => {
		const entry = get().entry
		const held = currentHeldKeys(entry)

		if (!change.keys.some(key => held.has(key))) {
			return
		}

		const update: ClipboardItemUpdate = item => {
			const next = change.update(item)

			if (next !== null && next !== item) {
				addKeys(held, next)
			}

			return next
		}

		for (const paste of cutPastes) {
			for (const [index, item] of paste.current.entries()) {
				if (item !== null) {
					paste.current[index] = update(item)
				}
			}
		}

		if (entry === null) {
			return
		}

		const items = followItems(entry.items, update)

		if (items !== entry.items) {
			set(withEntry(items.length === 0 ? null : { mode: entry.mode, items }))
		}
	},
	applyRecheck: (found, checked, begunIn) => {
		// The user made another entry while the lookup ran: it looked up none of it.
		if (begunIn !== generation) {
			return null
		}

		checkedAt = checked

		const entry = get().entry

		if (entry === null) {
			return 0
		}

		let left = 0
		const items = followItems(entry.items, item => {
			const now = found.get(item)

			if (now === null) {
				left++
			}

			return now === undefined ? item : now
		})

		if (items !== entry.items) {
			heldKeys = null
			set(withEntry(items.length === 0 ? null : { mode: entry.mode, items }))
		}

		return left
	},
	takeCut: () => {
		const entry = get().entry

		if (entry?.mode !== "cut") {
			return null
		}

		const paste: CutPaste = { items: entry.items, current: entry.items.slice(), checked: checkedAt }

		generation++
		cutPastes.add(paste)
		heldKeys = null
		set(withEntry(null))

		return paste
	},
	restoreCut: (paste, failed) => {
		if (!cutPastes.delete(paste)) {
			return
		}

		heldKeys = null

		const failedItems = new Set(failed)
		const items: DriveItem[] = []

		for (const [index, item] of paste.items.entries()) {
			const now = paste.current[index]

			if (failedItems.has(item) && now !== undefined && now !== null) {
				items.push(now)
			}
		}

		if (get().entry !== null || items.length === 0) {
			return
		}

		// Events kept them current only as far as they kept the pasted cut.
		generation++
		checkedAt = paste.checked
		set(withEntry({ mode: "cut", items }))
	}
}))

// Whether a held file lacks a stable id (see lacksStableId).
export function holdsFileLackingStableId(): boolean {
	currentHeldKeys(useDriveClipboardStore.getState().entry)

	return fileLackingStableIdHeld
}
