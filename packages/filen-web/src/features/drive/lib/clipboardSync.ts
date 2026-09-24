import type { SocketEvent } from "@filen/sdk-rs"
import { asDirectoryOrFile, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { stableUuidOf, useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"

// Keeps the clipboard on its items as they now are, the same way the selection is kept. Copies and cuts
// alike follow their items through renames, moves, color changes and content saves: a paste copies the
// current name and newest version, and a move re-encrypts the passed item's name for the destination's
// shares and links. Either drops an item once it is trashed or deleted. Matched by uuid or a file's
// stable id, never by name. Shared-in items carry no stable id and get no owner events, so they stay as
// they are.

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

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

		// With newUUID it's a content save on an account without versioning, not a trash: the successor's
		// fileNew is what the clipboard follows.
		case "fileTrash": {
			if (inner.newUUID === undefined) {
				dropGone(inner.uuid, inner.stableUUID)
			}

			break
		}

		// Without newUUID a moved file replaced it, and its lineage is gone.
		case "fileArchived": {
			if (inner.newUUID === undefined) {
				dropGone(inner.uuid, inner.stableUUID)
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
