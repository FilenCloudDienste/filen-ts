import { applyOfflineGate, driveItemActions, type ItemActionId, type ItemMenuShortcuts } from "@/features/drive/components/itemMenu.logic"
import { driveBulkActions, type BulkActionDescriptor } from "@/features/drive/components/bulkActionBar.logic"
import { type DriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { type ParentNaming } from "@/features/drive/lib/archiveTargets"
import { cachedDirectoryName, driveNamesQueryKey } from "@/features/drive/queries/drive"
import { photosListingQueryKey, type PhotosListing } from "@/features/photos/queries/photos"
import { queryClient } from "@/queries/client"

// Photos items are always owned, decryptable files, so drive's own item menu applies as is (tile and
// preview alike) minus Move: mobile hides it from its photos context too, and a flat cross-tree
// projection has no directory context for a move destination to restart from. Copy and Compress stay:
// both only read the photos, and what they make lands in the Cloud Drive tree. Extract never applies: a
// photos listing holds only images and videos.
export const PHOTOS_HIDDEN_ACTION_IDS: ReadonlySet<ItemActionId> = new Set(["move", "extract"])

// The grid's keys (photos/lib/keymap.ts), as a photo's menus show them: drive's entries under the photos grid's own
// actions.
export const PHOTOS_ITEM_SHORTCUTS: ItemMenuShortcuts = {
	entries: {
		rename: "photos.rename",
		favorite: "photos.toggleFavorite",
		info: "photos.info",
		download: "photos.download",
		share: "photos.share",
		trash: "photos.trash"
	},
	copyToClipboard: "photos.copy"
}

// The selection bar's counterpart (bulkActionBar.tsx), for the same reasons.
export const PHOTOS_HIDDEN_BULK_ACTION_IDS: ReadonlySet<BulkActionDescriptor["id"]> = new Set(["move", "extract"])

// What the selection bar offers for a photos selection, and so what the grid's keys may run on it. A photos selection
// is always owned, decryptable, non-shared-root files, so the drive variant yields exactly the photos set once the
// hidden ids are dropped.
export function photosBulkActions(flags: DriveSelectionFlags): BulkActionDescriptor[] {
	return driveBulkActions("drive", flags).filter(descriptor => !PHOTOS_HIDDEN_BULK_ACTION_IDS.has(descriptor.id))
}

// Whether a photo's own menu offers `id`, enabled while `isOnline` says so: a key never opens what the menu would not.
export function photoItemOffers(item: PhotoItem, id: ItemActionId, isOnline: boolean): boolean {
	return (
		!PHOTOS_HIDDEN_ACTION_IDS.has(id) &&
		applyOfflineGate(driveItemActions(item, "drive"), isOnline).some(descriptor => descriptor.id === id && descriptor.enabled !== false)
	)
}

// A compress's directory names from what Photos already holds, read only when a default name or
// destination is made: the listing's path of each directory holding a photo (its last segment), then
// the drive listings, then the root's name the header asked for. Photos from different directories
// make an archive named after Photos itself (owner decision).
export function photosParentNaming(rootUuids: readonly string[], mixedFallback: string): ParentNaming {
	return {
		nameOf: uuid => {
			for (const rootUuid of rootUuids) {
				const path = queryClient.getQueryData<PhotosListing>(photosListingQueryKey(rootUuid))?.folders[uuid]
				const name = path?.slice(path.lastIndexOf("/") + 1)

				if (name !== undefined && name.length > 0) {
					return name
				}
			}

			return cachedDirectoryName(uuid) ?? queryClient.getQueryData<string | null>(driveNamesQueryKey("drive", uuid)) ?? undefined
		},
		mixedFallback
	}
}
