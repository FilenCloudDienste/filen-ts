import type { File, SocketEvent } from "@filen/sdk-rs"
import { asDirectoryOrFile, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	holdsFileLackingStableId,
	lacksStableId,
	stableUuidOf,
	useDriveClipboardStore
} from "@/features/drive/store/useDriveClipboardStore"

// Keeps the clipboard on its items as they now are, the same way the selection is kept. Copies and cuts
// alike follow their items through renames, moves, color changes and content saves: a paste copies the
// current name and newest version, and a move re-encrypts the passed item's name for the destination's
// shares and links. Either drops an item once it is trashed or deleted. Matched by uuid or a file's
// stable id, never by name. Shared by me files carry no stable id but get owner events, so their content
// saves are matched by uuid. Shared-in items get no owner events, so they stay as they are.

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

// A content save retires a file's uuid in a fileArchived (or, without versioning, a fileTrash) naming its
// successor, whose fileNew may land first or second. For a held file lacking a stable id the two are
// paired here: whichever comes first waits for the other, a few at most, and only while such a file is
// held.
const MAX_WAITING = 8
// Successor uuid → the held uuid it replaces.
const retiredBy = new Map<string, string>()
// Successor uuid → its file, until the uuid it replaces is named.
const successors = new Map<string, File>()

function wait<T>(waiting: Map<string, T>, successorUuid: string, value: T): void {
	waiting.delete(successorUuid)
	waiting.set(successorUuid, value)

	if (waiting.size > MAX_WAITING) {
		const oldest = waiting.keys().next()

		if (oldest.done !== true) {
			waiting.delete(oldest.value)
		}
	}
}

// Whether a held file lacks a stable id; drops what waits once none does.
function pairingByUuid(): boolean {
	if (holdsFileLackingStableId()) {
		return true
	}

	retiredBy.clear()
	successors.clear()

	return false
}

// The item that is `uuid`, as `rebuild` makes it.
function followUuid(uuid: string, rebuild: (item: DriveItem) => DriveItem): void {
	useDriveClipboardStore.getState().follow({
		keys: [uuid],
		update: item => (item.data.uuid === uuid ? rebuild(item) : item)
	})
}

// A local write's result for the item that was `previousUuid` (a content save or version restore
// rotates the uuid).
export function followClipboardItem(next: DriveItem, previousUuid: string = next.data.uuid): void {
	followUuid(previousUuid, () => next)
}

// Gone, and for a file its whole lineage, older versions a copy holds included.
function dropGone(uuid: string, stableUuid: string | undefined): void {
	useDriveClipboardStore.getState().follow({
		keys: stableUuid === undefined ? [uuid] : [uuid, stableUuid],
		update: item => (item.data.uuid === uuid || (stableUuid !== undefined && stableUuidOf(item) === stableUuid) ? null : item)
	})
}

// Trashed or deleted here.
export function dropFromClipboard(gone: DriveItem): void {
	dropGone(gone.data.uuid, stableUuidOf(gone))
}

// A content save retired `uuid` for `successorUuid`. A held file with a stable id follows the successor's
// fileNew by that id instead.
function followRetired(uuid: string, successorUuid: string): void {
	if (!pairingByUuid()) {
		return
	}

	const successor = successors.get(successorUuid)
	const next = successor === undefined ? undefined : narrowItem(successor)
	// Held files it retires whose successor hasn't arrived yet.
	const waiting: DriveItem[] = []

	useDriveClipboardStore.getState().follow({
		keys: [uuid],
		update: item => {
			if (item.data.uuid !== uuid || !lacksStableId(item)) {
				return item
			}

			if (next === undefined) {
				waiting.push(item)

				return item
			}

			return next
		}
	})

	successors.delete(successorUuid)

	if (waiting.length > 0) {
		wait(retiredBy, successorUuid, uuid)
	}
}

export function followDriveEventOnClipboard(event: DriveSocketEvent): void {
	const inner = event.inner

	switch (inner.type) {
		// A content save's successor carries the lineage's stable id; the uuid it supersedes arrives as a
		// fileArchived (or, without versioning, a fileTrash) carrying newUUID, in either order.
		case "fileNew": {
			const file = inner.file
			const stableUuid = file.stableUUID

			if (stableUuid !== undefined) {
				useDriveClipboardStore.getState().follow({
					keys: [stableUuid],
					update: item => (stableUuidOf(item) === stableUuid ? narrowItem(file) : item)
				})
			}

			if (pairingByUuid()) {
				const retired = retiredBy.get(file.uuid)

				if (retired === undefined) {
					wait(successors, file.uuid, file)
				} else {
					retiredBy.delete(file.uuid)
					followUuid(retired, () => narrowItem(file))
				}
			}

			break
		}

		case "fileArchiveRestored": {
			const { currentUuid, file } = inner

			followUuid(currentUuid, () => narrowItem(file))

			break
		}

		case "fileMove": {
			const file = inner.file

			followUuid(file.uuid, () => narrowItem(file))

			break
		}

		// The SDK builds the payload with the default colour, and a paste sends the item on to the move, so
		// the directory keeps its own.
		case "folderMove": {
			const dir = inner.dir

			followUuid(dir.uuid, item => {
				const base = asDirectoryOrFile(item)

				return base.type === "directory" ? narrowItem({ ...dir, color: base.data.color }) : item
			})

			break
		}

		case "fileMetadataChanged": {
			const { uuid, metadata } = inner

			followUuid(uuid, item => {
				const base = asDirectoryOrFile(item)

				return base.type === "file" ? narrowItem({ ...base.data, meta: metadata }) : item
			})

			break
		}

		case "folderMetadataChanged": {
			const { uuid, meta } = inner

			followUuid(uuid, item => {
				const base = asDirectoryOrFile(item)

				return base.type === "directory" ? narrowItem({ ...base.data, meta }) : item
			})

			break
		}

		case "folderColorChanged": {
			const { uuid, color } = inner

			followUuid(uuid, item => {
				const base = asDirectoryOrFile(item)

				return base.type === "directory" ? narrowItem({ ...base.data, color }) : item
			})

			break
		}

		case "itemFavorite": {
			const favorite = inner.item

			if (favorite.type === "file" || favorite.type === "normalDir") {
				followUuid(favorite.uuid, () => narrowItem(favorite))
			}

			break
		}

		// With newUUID it's a content save on an account without versioning, not a trash: the clipboard follows
		// the successor. The stable id this carries is then freshly minted, so it pairs by uuid alone.
		case "fileTrash": {
			if (inner.newUUID === undefined) {
				dropGone(inner.uuid, inner.stableUUID)
			} else {
				followRetired(inner.uuid, inner.newUUID)
			}

			break
		}

		// Without newUUID a moved file replaced it, and its lineage is gone.
		case "fileArchived": {
			if (inner.newUUID === undefined) {
				dropGone(inner.uuid, inner.stableUUID)
			} else {
				followRetired(inner.uuid, inner.newUUID)
			}

			break
		}

		// Without a stable id it deleted one archived version, and the file lives on.
		case "fileDeletedPermanent": {
			if (inner.stableUUID !== undefined) {
				dropGone(inner.uuid, inner.stableUUID)
			}

			break
		}

		case "folderTrash":
		case "folderDeletedPermanent": {
			dropGone(inner.uuid, undefined)

			break
		}

		// Everything the user owns is gone.
		case "deleteAll": {
			useDriveClipboardStore.getState().clear()

			break
		}

		default:
			break
	}
}
