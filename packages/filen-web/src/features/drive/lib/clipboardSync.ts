import type { SocketEvent } from "@filen/sdk-rs"
import { asDirectoryOrFile, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"

// Keeps the clipboard on its items as they now are, the same way the selection is kept. A cut is a move
// still to come, so it follows its items through renames, moves, color changes and content saves: a
// move re-encrypts the passed item's name for the destination's shares and links, and a superseded
// version isn't the file anymore. A copy keeps what was copied. Either drops an item once it is trashed
// or deleted. Matched by uuid or a file's stable id, never by name. Shared-in items carry no stable id
// and get no owner events, so they stay as they are.

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

function stableUuidOf(item: DriveItem): string | undefined {
	const base = asDirectoryOrFile(item)

	return base.type === "file" ? base.data.stableUUID : undefined
}

// Cut only: each matching item as `rebuild` makes it.
function followCut(matches: (item: DriveItem) => boolean, rebuild: (item: DriveItem) => DriveItem): void {
	useDriveClipboardStore.getState().follow({
		update: item => (matches(item) ? rebuild(item) : item),
		cutOnly: true
	})
}

// A local write's result for the item that was `previousUuid` (a content save or version restore
// rotates the uuid).
export function followClipboardItem(next: DriveItem, previousUuid: string = next.data.uuid): void {
	followCut(
		item => item.data.uuid === previousUuid,
		() => next
	)
}

// Gone, and for a file its whole lineage, older versions a copy holds included.
function dropGone(uuid: string, stableUuid: string | undefined): void {
	useDriveClipboardStore.getState().follow({
		update: item => (item.data.uuid === uuid || (stableUuid !== undefined && stableUuidOf(item) === stableUuid) ? null : item),
		cutOnly: false
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
				followCut(
					item => stableUuidOf(item) === stableUuid,
					() => narrowItem(file)
				)
			}

			break
		}

		case "fileArchiveRestored": {
			const { currentUuid, file } = inner

			followCut(
				item => item.data.uuid === currentUuid,
				() => narrowItem(file)
			)

			break
		}

		case "fileMove": {
			const file = inner.file

			followCut(
				item => item.data.uuid === file.uuid,
				() => narrowItem(file)
			)

			break
		}

		// The SDK builds the payload with the default colour, and a paste sends the item on to the move, so
		// the directory keeps its own.
		case "folderMove": {
			const dir = inner.dir

			followCut(
				item => item.data.uuid === dir.uuid,
				item => {
					const base = asDirectoryOrFile(item)

					return base.type === "directory" ? narrowItem({ ...dir, color: base.data.color }) : item
				}
			)

			break
		}

		case "fileMetadataChanged": {
			const { uuid, metadata } = inner

			followCut(
				item => item.data.uuid === uuid,
				item => {
					const base = asDirectoryOrFile(item)

					return base.type === "file" ? narrowItem({ ...base.data, meta: metadata }) : item
				}
			)

			break
		}

		case "folderMetadataChanged": {
			const { uuid, meta } = inner

			followCut(
				item => item.data.uuid === uuid,
				item => {
					const base = asDirectoryOrFile(item)

					return base.type === "directory" ? narrowItem({ ...base.data, meta }) : item
				}
			)

			break
		}

		case "folderColorChanged": {
			const { uuid, color } = inner

			followCut(
				item => item.data.uuid === uuid,
				item => {
					const base = asDirectoryOrFile(item)

					return base.type === "directory" ? narrowItem({ ...base.data, color }) : item
				}
			)

			break
		}

		case "itemFavorite": {
			const favorite = inner.item

			if (favorite.type === "file" || favorite.type === "normalDir") {
				followCut(
					item => item.data.uuid === favorite.uuid,
					() => narrowItem(favorite)
				)
			}

			break
		}

		// With newUUID it's a content save on an account without versioning, not a trash: the successor's
		// fileNew is what a cut follows.
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
