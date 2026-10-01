import { setFavoritedItems, trashItems, renameItem, type ActionOutcome } from "@/features/drive/lib/actions"
import { type BulkOutcome, type BulkProgress } from "@/lib/actions/bulk"
import type { DriveItem } from "@/features/drive/lib/item"
import { photosListingQueryUpdate } from "@/features/photos/queries/photos"
import type { PhotoItem } from "@/features/photos/lib/captureSort"

export type { ActionOutcome }

// Thin wrappers around drive's own shared action helpers (features/drive/lib/actions.ts) — the SAME
// network op + drive-cache patch runs unchanged; each wrapper only layers on the ONE extra patch the
// photos surface itself needs. driveListingQueryUpdateGlobal only ever sweeps ["drive","listing",…]
// keys (drive.ts's own doc comment), so a favorite/rename toggled from the photos grid would
// otherwise sit stale in ["photos","listing",rootUuid] until the whole recursive walk refetches.
//
// Mirroring driveListingQueryUpdate's own single-key patch shape here (rather than folding photos
// awareness into drive's shared updaters) keeps the dependency direction the same as everywhere
// else in the app: features/drive is the foundational surface many features build on, and teaching
// it about one downstream feature's key namespace would invert that — every other consumer
// (contacts/notes/audio/chats, see actions.ts's own grep-able usage) already reaches into drive's
// action helpers the same way this file does, never the other way around.

// Attribute-only refresh (a favorite flag or name changed) — replaces the row in place, never
// appends: the item may have left the listing meanwhile. Called with the favorite result of drive's
// own item menu (tile and preview) and after a rename, so the grid updates at once rather than on the
// socket echo.
export function patchPhoto(rootUuid: string, item: DriveItem): void {
	if (item.type === "file") {
		photosListingQueryUpdate(rootUuid, prev => prev.map(existing => (existing.data.uuid === item.data.uuid ? item : existing)))
	}
}

// Bulk favorite is a SET (mirrors setFavoritedItems' own doc comment: the bar computes one target
// from the whole selection) — patches every succeeded uuid's `favorited` flag directly rather than
// re-deriving from each item's own mutation result, since the only field this write can ever change
// is that one flag.
export async function setFavoritedPhotos(
	rootUuid: string,
	items: PhotoItem[],
	favorited: boolean,
	onSettled?: BulkProgress
): Promise<BulkOutcome<PhotoItem>> {
	const outcome = await setFavoritedItems(items, favorited, onSettled)

	if (outcome.succeeded.length > 0) {
		const succeededUuids = new Set(outcome.succeeded.map(succeeded => succeeded.data.uuid))

		photosListingQueryUpdate(rootUuid, prev =>
			prev.map(existing =>
				succeededUuids.has(existing.data.uuid) ? { ...existing, data: { ...existing.data, favorited } } : existing
			)
		)
	}

	return outcome
}

// A trashed item leaves the photos listing outright (it's no longer under the root at all) — no
// listing membership to re-add later, unlike a drive "favorites" toggle which can also ADD a row.
export async function trashPhotos(rootUuid: string, items: PhotoItem[], onSettled?: BulkProgress): Promise<BulkOutcome<PhotoItem>> {
	const outcome = await trashItems(items, onSettled)

	if (outcome.succeeded.length > 0) {
		const removedUuids = new Set(outcome.succeeded.map(succeeded => succeeded.data.uuid))

		photosListingQueryUpdate(rootUuid, prev => prev.filter(existing => !removedUuids.has(existing.data.uuid)))
	}

	return outcome
}

// `newName` is passed through unchanged (not pre-trimmed) — mirrors renameItem's own contract; the
// caller (the rename dialog) trims before calling in, same as useDriveDialogHost's handleRenameSubmit.
export async function renamePhotoItem(rootUuid: string, item: PhotoItem, newName: string): Promise<ActionOutcome> {
	const outcome = await renameItem(item, newName)

	if (outcome.status === "success") {
		patchPhoto(rootUuid, outcome.item)
	}

	return outcome
}
