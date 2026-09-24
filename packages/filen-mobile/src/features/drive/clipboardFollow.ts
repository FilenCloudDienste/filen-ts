import type { DriveItem } from "@/types"
import events from "@/lib/events"
import useDriveClipboardStore, { type DriveClipboardEntry } from "@/features/drive/store/useDriveClipboard.store"

// The clipboard holds item rows from Copy/Cut time. A cut follows its items as they change: its paste is a
// move, which addresses the item by uuid and re-encrypts the passed row's metadata for the destination's
// shares and links, so a stale row would move an old version or publish an old name. Any entry drops an
// item that was trashed or deleted. What a copy pastes after a rename or content edit stays as copied.
// Matched by uuid or, for a file's new version, by its stableUuid; never by name.

type EntryIndex = {
	uuids: ReadonlySet<string>
	stableUuids: ReadonlySet<string>
}

// Per entry (entries are replaced, never mutated): most drive events concern items that aren't on it.
const entryIndexes = new WeakMap<DriveClipboardEntry, EntryIndex>()

function stableUuidOf(item: DriveItem): string | undefined {
	return item.type === "file" ? item.data.stableUuid : undefined
}

function indexOf(entry: DriveClipboardEntry): EntryIndex {
	const cached = entryIndexes.get(entry)

	if (cached) {
		return cached
	}

	const uuids = new Set<string>()
	const stableUuids = new Set<string>()

	for (const item of entry.items) {
		uuids.add(item.data.uuid)

		const stableUuid = stableUuidOf(item)

		if (stableUuid) {
			stableUuids.add(stableUuid)
		}
	}

	const index = {
		uuids,
		stableUuids
	}

	entryIndexes.set(entry, index)

	return index
}

// A pasted cut while its items move, in paste order (null where one was trashed or deleted meanwhile), so what
// fails to move comes back as it is now. Not store state: nothing renders it, and a big paste changes it once
// per moved item.
type MovingCut = {
	items: (DriveItem | null)[]
	byUuid: Map<string, number>
	byStableUuid: Map<string, number>
}

let movingCut: MovingCut | null = null

function setMoving(moving: MovingCut, index: number, item: DriveItem | null): void {
	const previous = moving.items[index]

	if (previous) {
		moving.byUuid.delete(previous.data.uuid)

		const stableUuid = stableUuidOf(previous)

		if (stableUuid) {
			moving.byStableUuid.delete(stableUuid)
		}
	}

	moving.items[index] = item

	if (item) {
		moving.byUuid.set(item.data.uuid, index)

		const stableUuid = stableUuidOf(item)

		if (stableUuid) {
			moving.byStableUuid.set(stableUuid, index)
		}
	}
}

// Takes a cut off the clipboard as its paste starts, so a second paste can't move the same items again.
export function takeCutForPaste(entry: DriveClipboardEntry): void {
	useDriveClipboardStore.getState().clear()

	const moving: MovingCut = {
		items: [],
		byUuid: new Map(),
		byStableUuid: new Map()
	}

	entry.items.forEach((item, index) => {
		setMoving(moving, index, item)
	})

	movingCut = moving
}

// Ends the paste: the items at `failedIndexes` (in the pasted entry's order) go back on the clipboard as they
// are now, unless they were trashed or deleted meanwhile or something else was copied or cut.
export function restoreFailedCut(failedIndexes: readonly number[]): void {
	const moving = movingCut

	movingCut = null

	if (!moving) {
		return
	}

	const items: DriveItem[] = []

	for (const index of failedIndexes) {
		const item = moving.items[index]

		if (item) {
			items.push(item)
		}
	}

	useDriveClipboardStore.getState().restoreCut(items)
}

// A newer row of an item: a local rename, move, colour change, favourite, version restore or content save, or
// the socket echo of one. A cut follows it, to a row of the same type only (a shared variant can't be moved).
export function followDriveItem(previousUuid: string, item: DriveItem): void {
	if (movingCut) {
		const index = movingCut.byUuid.get(previousUuid)

		if (index !== undefined && movingCut.items[index]?.type === item.type) {
			setMoving(movingCut, index, item)
		}
	}

	const { entry } = useDriveClipboardStore.getState()

	if (entry === null || entry.mode !== "cut" || !indexOf(entry).uuids.has(previousUuid)) {
		return
	}

	useDriveClipboardStore.getState().mapItems(existing => (existing.data.uuid === previousUuid && existing.type === item.type ? item : existing))
}

// A file's new version (a content edit on any device arrives as a new file of the same lineage): a cut
// follows it.
export function followFileSuccessor(item: DriveItem): void {
	const stableUuid = stableUuidOf(item)

	if (!stableUuid) {
		return
	}

	if (movingCut) {
		const index = movingCut.byStableUuid.get(stableUuid)

		if (index !== undefined && movingCut.items[index]?.data.uuid !== item.data.uuid) {
			setMoving(movingCut, index, item)
		}
	}

	const { entry } = useDriveClipboardStore.getState()

	if (entry === null || entry.mode !== "cut" || !indexOf(entry).stableUuids.has(stableUuid)) {
		return
	}

	useDriveClipboardStore
		.getState()
		.mapItems(existing => (stableUuidOf(existing) === stableUuid && existing.data.uuid !== item.data.uuid ? item : existing))
}

function drop(uuid: string, cutOnly: boolean): void {
	if (movingCut) {
		const index = movingCut.byUuid.get(uuid)

		if (index !== undefined) {
			setMoving(movingCut, index, null)
		}
	}

	const { entry } = useDriveClipboardStore.getState()

	if (entry === null || (cutOnly && entry.mode !== "cut") || !indexOf(entry).uuids.has(uuid)) {
		return
	}

	useDriveClipboardStore.getState().mapItems(existing => (existing.data.uuid === uuid ? null : existing))
}

// A trashed or permanently deleted item can't be pasted any more, copied or cut.
export function dropDriveItem(uuid: string): void {
	drop(uuid, false)
}

// A file whose lineage ended (another file moved in over it) can't be moved any more; a copy keeps it.
export function dropCutItem(uuid: string): void {
	drop(uuid, true)
}

events.subscribe("driveItemUpdated", ({ previousUuid, item }) => {
	followDriveItem(previousUuid, item)
})

events.subscribe("driveItemRemoved", ({ uuid }) => {
	dropDriveItem(uuid)
})

// A paste still moving at logout must not put the ended account's items back on the clipboard.
events.subscribe("logout", () => {
	movingCut = null
})
