import type { DriveItem } from "@/types"
import events from "@/lib/events"
import useDriveClipboardStore, { type DriveClipboardEntry } from "@/features/drive/store/useDriveClipboard.store"

// The clipboard holds item rows from Copy/Cut time and follows its items as they change, so a paste acts on
// each item as it is now: a copy copies the current name and newest version, and a cut's move (which
// addresses the item by uuid and re-encrypts the passed row's metadata for the destination's shares and
// links) neither moves an old version nor publishes an old name. An item that was trashed or deleted, or
// whose lineage ended, leaves the clipboard. Matched by uuid or, for a file's new version, by its
// stableUuid; never by name.

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
// the socket echo of one. The clipboard follows it, to a row of the same type only (a shared variant can't be
// moved).
export function followDriveItem(previousUuid: string, item: DriveItem): void {
	if (movingCut) {
		const index = movingCut.byUuid.get(previousUuid)

		if (index !== undefined && movingCut.items[index]?.type === item.type) {
			setMoving(movingCut, index, item)
		}
	}

	const { entry } = useDriveClipboardStore.getState()

	if (entry === null || !indexOf(entry).uuids.has(previousUuid)) {
		return
	}

	useDriveClipboardStore.getState().mapItems(existing => (existing.data.uuid === previousUuid && existing.type === item.type ? item : existing))
}

// A file's new version (a content edit on any device arrives as a new file of the same lineage): the
// clipboard follows it.
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

	if (entry === null || !indexOf(entry).stableUuids.has(stableUuid)) {
		return
	}

	useDriveClipboardStore
		.getState()
		.mapItems(existing => (stableUuidOf(existing) === stableUuid && existing.data.uuid !== item.data.uuid ? item : existing))
}

// A trashed or permanently deleted item, or a file whose lineage ended (another file moved in over it),
// can't be pasted any more.
export function dropDriveItem(uuid: string): void {
	if (movingCut) {
		const index = movingCut.byUuid.get(uuid)

		if (index !== undefined) {
			setMoving(movingCut, index, null)
		}
	}

	const { entry } = useDriveClipboardStore.getState()

	if (entry === null || !indexOf(entry).uuids.has(uuid)) {
		return
	}

	useDriveClipboardStore.getState().mapItems(existing => (existing.data.uuid === uuid ? null : existing))
}

// The clipboard's row of an item, or a moving cut's: a rename or colour change arrives as a delta, applied to this row
// when the session caches hold none for the item.
export function heldDriveItem(uuid: string): DriveItem | null {
	const { entry } = useDriveClipboardStore.getState()

	if (entry !== null && indexOf(entry).uuids.has(uuid)) {
		return entry.items.find(item => item.data.uuid === uuid) ?? null
	}

	const index = movingCut?.byUuid.get(uuid)

	return index === undefined ? null : (movingCut?.items[index] ?? null)
}

// A delete-all removed every own item. Shared-in rows go too, as a row can't reliably tell shared in from shared
// out, and a cut still moving puts nothing back.
export function clearClipboardAfterDeleteAll(): void {
	movingCut = null

	useDriveClipboardStore.getState().clear()
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
