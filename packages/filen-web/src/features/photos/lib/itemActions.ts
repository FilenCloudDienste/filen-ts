import { type ItemActionId } from "@/features/drive/components/itemMenu.logic"
import { type BulkActionDescriptor } from "@/features/drive/components/bulkActionBar.logic"
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

// The selection bar's counterpart (bulkActionBar.tsx), for the same reasons.
export const PHOTOS_HIDDEN_BULK_ACTION_IDS: ReadonlySet<BulkActionDescriptor["id"]> = new Set(["move", "extract"])

// A compress's directory names from what Photos already holds, read only when a default name or
// destination is made: the listing's path of each directory holding a photo (its last segment), then
// the drive listings, then the root's name the header asked for. Photos from different directories
// make an archive named after Photos itself (owner decision).
export function photosParentNaming(rootUuid: string, mixedFallback: string): ParentNaming {
	return {
		nameOf: uuid => {
			const path = queryClient.getQueryData<PhotosListing>(photosListingQueryKey(rootUuid))?.folders[uuid]
			const name = path?.slice(path.lastIndexOf("/") + 1)

			if (name !== undefined && name.length > 0) {
				return name
			}

			return cachedDirectoryName(uuid) ?? queryClient.getQueryData<string | null>(driveNamesQueryKey("drive", uuid)) ?? undefined
		},
		mixedFallback
	}
}
