import {
	toggleFavorite,
	setFavoritedItems,
	trashItems,
	renameItem,
	replaceIfPresent,
	type ActionOutcome
} from "@/features/drive/lib/actions"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import type { DriveItem } from "@/features/drive/lib/item"
import { photosListingQueryUpdate } from "@/features/photos/queries/photos"
import type { PhotoItem } from "@/features/photos/lib/captureSort"

export type { ActionOutcome }

// Narrows a mutation's returned DriveItem back down to the photos listing's own PhotoItem arm —
// every mutation below (rename/favorite) preserves the input's type ("file" in, "file" out; the
// backend never turns a file into a directory), so this always succeeds for an item this module was
// ever handed in the first place. Written as a real type guard (not a cast) so the narrowed array
// below is honestly typed.
function asPhotoItem(item: DriveItem): PhotoItem | null {
	return item.type === "file" ? item : null
}

function asPhotoItems(items: DriveItem[]): PhotoItem[] {
	return items.filter((item): item is PhotoItem => item.type === "file")
}

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

// The preview overlay's own header menu runs drive's raw toggleFavorite (it is the shared,
// un-forked PreviewOverlay component — see previewOverlay.tsx's own itemMenu.tsx-sourced descriptor),
// never this file's toggleFavoritePhoto wrapper. This is the patch that extension point calls instead
// (PreviewOverlayProps.onFavoriteToggled, wired from usePhotosDialogHost) — the ONE local patch that
// keeps the grid's heart badge in sync without a reload, since the realtime itemFavorite socket event
// is deliberately excluded from socketHandlers.ts's photos-invalidating set (an attribute flip, not a
// membership change, so it never triggers invalidatePhotosListing the way trash/rename do).
export function patchPhotoFavoriteFromPreview(rootUuid: string, item: DriveItem): void {
	const photoItem = asPhotoItem(item)

	if (photoItem !== null) {
		photosListingQueryUpdate(rootUuid, prev => asPhotoItems(replaceIfPresent(prev, photoItem)))
	}
}

export async function toggleFavoritePhoto(rootUuid: string, item: PhotoItem): Promise<ActionOutcome> {
	const outcome = await toggleFavorite(item)

	if (outcome.status === "success") {
		const photoItem = asPhotoItem(outcome.item)

		if (photoItem !== null) {
			photosListingQueryUpdate(rootUuid, prev => asPhotoItems(replaceIfPresent(prev, photoItem)))
		}
	}

	return outcome
}

// Bulk favorite is a SET (mirrors setFavoritedItems' own doc comment: the bar computes one target
// from the whole selection) — patches every succeeded uuid's `favorited` flag directly rather than
// re-deriving from each item's own mutation result, since the only field this write can ever change
// is that one flag.
export async function setFavoritedPhotos(rootUuid: string, items: PhotoItem[], favorited: boolean): Promise<BulkOutcome<DriveItem>> {
	const outcome = await setFavoritedItems(items, favorited)

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
export async function trashPhotos(rootUuid: string, items: PhotoItem[]): Promise<BulkOutcome<DriveItem>> {
	const outcome = await trashItems(items)

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
		const photoItem = asPhotoItem(outcome.item)

		if (photoItem !== null) {
			photosListingQueryUpdate(rootUuid, prev => asPhotoItems(replaceIfPresent(prev, photoItem)))
		}
	}

	return outcome
}
