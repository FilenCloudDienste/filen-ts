import type { SocketEvent, NonRootItemTagged } from "@filen/sdk-rs"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { queryClient } from "@/queries/client"
import { log } from "@/lib/log"
import {
	driveListingQueryKey,
	driveListingQueryUpdate,
	driveListingQueryUpdateGlobal,
	normalizeParentUuid
} from "@/features/drive/queries/drive"
import { narrowItem, upsertDriveItem, type DriveItem } from "@/features/drive/lib/item"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { invalidatePhotosListing } from "@/features/photos/queries/photos"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import {
	emitPreviewFileMetaChanged,
	emitPreviewFolderMetaChanged,
	emitPreviewItemRemoved,
	emitPreviewItemReplaced
} from "@/features/preview/lib/previewReconcile"

// The realtime DRIVE event handlers — a faithful port of filen-mobile's drive socketHandlers.ts
// SEMANTICS onto the wasm surface (flat discriminated `event.inner.type`), registered on the generic
// socket bridge. Web keeps no worker-side item cache like mobile's fileUuidToNormalFile map, so the two
// resolution strategies differ where a payload is sparse: an event that ships the full File/Dir splices
// it into its parent listing (the item's own `.parent`); an event that ships only a uuid patches every
// currently-instantiated listing at once via driveListingQueryUpdateGlobal (the same fan-out actions.ts
// uses), which reaches whichever listing holds the row without a parent lookup. No invalidate-storm — every
// path is a targeted setQueryData with the queries' own cancel-before-patch discipline.
//
// Alongside the listing-cache patch, an event that removes / rotates / renames an item also emits a
// previewReconcile signal so an OPEN preview pager (which steps a frozen snapshot the cache patch can't
// reach) advances/closes on removal, reseeds on a uuid rotation, and re-titles on a rename — the same
// same-client preview sync previewOverlay already runs after a local action, now driven by remote events.

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

// Registers the drive handler on the generic bridge; returns the unregister fn. Called once by the authed
// shell's socket host. Only "drive" events reach handleDriveEvent — the registry routes by type.
export function registerDriveSocketHandlers(): () => void {
	return registerSocketHandler("drive", handleDriveEvent)
}

// In-place attribute swap by uuid (a flag/color/meta changed; identity and membership did not) — never
// appends, so a global patch leaves an absent row absent instead of conjuring it into every listing.
function replaceIfPresent(items: DriveItem[], updated: DriveItem): DriveItem[] {
	return items.map(item => (item.data.uuid === updated.data.uuid ? updated : item))
}

function removeByUuid(items: DriveItem[], uuid: string): DriveItem[] {
	return items.filter(item => item.data.uuid !== uuid)
}

// ItemFavorite ships a NonRootItemTagged (the full item carrying its new favorited flag). Mobile's socket
// path handles only owned files/dirs here — shared/linked arms have no favorite toggle — so this narrows
// just those two and skips the rest. The base File/Dir shape is structurally assignable to narrowItem's
// input (the extra `type` tag is inert on the resulting item's `data`).
function narrowFavoriteItem(item: NonRootItemTagged): DriveItem | undefined {
	switch (item.type) {
		case "file":
			return narrowItem(item)
		case "normalDir":
			return narrowItem(item)
		default:
			return undefined
	}
}

// Coarse, cheap photos-query invalidation (see photos/queries/photos.ts's invalidatePhotosListing
// doc comment for why this is a whole-listing refetch rather than a splice-patch): every drive event
// that adds, removes, or renames a file or directory anywhere invalidates the entire photos recursive
// listing, since a single-item socket payload has no cheap way to prove whether its uuid even falls
// under the current photos root's subtree. A no-op when no photos query is mounted. Full recursive
// splice-patching (mirroring this file's own per-parent precision for drive listings) is a later
// optimization, not required for v1.
const PHOTOS_INVALIDATING_EVENT_TYPES: ReadonlySet<DriveSocketEvent["inner"]["type"]> = new Set([
	"fileNew",
	"fileMove",
	"folderMove",
	"fileTrash",
	"folderTrash",
	"fileRestore",
	"folderRestore",
	"fileArchived",
	"fileArchiveRestored",
	"fileDeletedPermanent",
	"folderDeletedPermanent",
	"fileMetadataChanged",
	"folderMetadataChanged"
])

export function handleDriveEvent(event: DriveSocketEvent): void {
	const inner = event.inner
	const rootUuid = currentRootUuid()

	if (PHOTOS_INVALIDATING_EVENT_TYPES.has(inner.type)) {
		invalidatePhotosListing()
	}

	switch (inner.type) {
		case "fileNew": {
			// A brand-new file — splice into its parent listing. upsertDriveItem drops any same-name/same-uuid
			// stale row so a re-delivered event never duplicates.
			driveListingQueryUpdate(normalizeParentUuid(inner.file.parent, rootUuid), prev => upsertDriveItem(prev, narrowItem(inner.file)))

			break
		}

		case "fileRestore": {
			const item = narrowItem(inner.file)

			// Global remove FIRST (it also strips the trash listing the item is leaving), then splice into the
			// destination parent — uuid is preserved across a restore, so removing after the upsert would strip
			// the just-restored row right back out.
			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, item.data.uuid))
			driveListingQueryUpdate(normalizeParentUuid(inner.file.parent, rootUuid), prev => upsertDriveItem(prev, item))
			// The item left the trash listing — a trash preview open on it advances to a neighbour or closes.
			emitPreviewItemRemoved(item.data.uuid)

			break
		}

		case "fileArchiveRestored": {
			const item = narrowItem(inner.file)

			// A version restore rotates the file's uuid: drop both the restored uuid (if a stale copy lingers)
			// and the superseded current uuid, then splice the fresh file into its parent.
			driveListingQueryUpdateGlobal(prev => removeByUuid(removeByUuid(prev, item.data.uuid), inner.currentUuid))
			driveListingQueryUpdate(normalizeParentUuid(inner.file.parent, rootUuid), prev => upsertDriveItem(prev, item))
			// A preview open on the superseded uuid reseeds with the restored file (same slot, fresh content).
			emitPreviewItemReplaced(inner.currentUuid, item)

			break
		}

		case "folderSubCreated": {
			driveListingQueryUpdate(normalizeParentUuid(inner.dir.parent, rootUuid), prev => upsertDriveItem(prev, narrowItem(inner.dir)))

			break
		}

		case "folderRestore": {
			const item = narrowItem(inner.dir)

			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, item.data.uuid))
			driveListingQueryUpdate(normalizeParentUuid(inner.dir.parent, rootUuid), prev => upsertDriveItem(prev, item))
			emitPreviewItemRemoved(item.data.uuid)

			break
		}

		case "fileMove": {
			const item = narrowItem(inner.file)

			// The File carries its NEW parent; web keeps no item cache to look up the OLD parent, so a global
			// remove clears the stale copy from wherever it was before splicing into the destination.
			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, item.data.uuid))
			driveListingQueryUpdate(normalizeParentUuid(inner.file.parent, rootUuid), prev => upsertDriveItem(prev, item))
			// The item left this listing for another directory — a preview open on it advances or closes.
			emitPreviewItemRemoved(item.data.uuid)

			break
		}

		case "folderMove": {
			const item = narrowItem(inner.dir)

			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, item.data.uuid))
			driveListingQueryUpdate(normalizeParentUuid(inner.dir.parent, rootUuid), prev => upsertDriveItem(prev, item))
			emitPreviewItemRemoved(item.data.uuid)

			break
		}

		case "fileTrash":
		case "folderTrash": {
			// The item left every normal listing (trash refetches on open — never optimistically populated,
			// mirroring actions.ts's trashItems). Purge it from the selection so the count / select-all toggle /
			// bulk ops never target a ghost.
			useDriveStore.getState().removeFromSelection([inner.uuid])
			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, inner.uuid))
			// A preview open on the trashed item advances to a neighbour or closes.
			emitPreviewItemRemoved(inner.uuid)

			break
		}

		case "fileArchived": {
			// A content save rotates the file's uuid: the OLD uuid is archived into version history and the
			// successor arrives as its own fileNew. The file itself lives on, so an open preview KEEPS its
			// frozen slot — a same-device save already resolves fresh bytes through the editor's saved-uuid
			// aliases (removing the slot here would yank the just-saved file out from under the user and
			// collapse the pager), and a cross-device edit merely leaves the frozen snapshot's
			// stale-but-still-downloadable version on screen (a preview is a static snapshot, never a live
			// mirror). Only the LISTING drops the superseded row; its fileNew replacement splices in beside it.
			useDriveStore.getState().removeFromSelection([inner.uuid])
			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, inner.uuid))

			break
		}

		case "fileDeletedPermanent":
		case "folderDeletedPermanent": {
			// The item is gone for good — purge selection, strip it from every listing, and drop it from an
			// open preview (advance to a neighbour, or close once it was the only slot).
			useDriveStore.getState().removeFromSelection([inner.uuid])
			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, inner.uuid))
			emitPreviewItemRemoved(inner.uuid)

			break
		}

		case "fileMetadataChanged": {
			// Only an owned file row can be rebuilt from its own cached shape + the new meta (web has no item
			// cache to reconstruct a share from). Re-narrow so name/undecryptable derive from the fresh meta.
			driveListingQueryUpdateGlobal(prev =>
				prev.map(row =>
					row.data.uuid === inner.uuid && row.type === "file" ? narrowItem({ ...row.data, meta: inner.metadata }) : row
				)
			)
			// A preview open on this file re-derives its header title from the fresh meta (rename).
			emitPreviewFileMetaChanged(inner.uuid, inner.metadata)

			break
		}

		case "folderMetadataChanged": {
			driveListingQueryUpdateGlobal(prev =>
				prev.map(row =>
					row.data.uuid === inner.uuid && row.type === "directory" ? narrowItem({ ...row.data, meta: inner.meta }) : row
				)
			)
			emitPreviewFolderMetaChanged(inner.uuid, inner.meta)

			break
		}

		case "folderColorChanged": {
			driveListingQueryUpdateGlobal(prev =>
				prev.map(row =>
					row.data.uuid === inner.uuid && row.type === "directory" ? { ...row, data: { ...row.data, color: inner.color } } : row
				)
			)

			break
		}

		case "itemFavorite": {
			const item = narrowFavoriteItem(inner.item)

			if (item !== undefined) {
				// Attribute-only refresh — replace the row in place wherever it's cached. No favorites-listing
				// membership add/remove: mobile's socket path doesn't touch it either (only the local
				// toggleFavorite action does), and the row's own favorited flag is now current everywhere.
				driveListingQueryUpdateGlobal(prev => replaceIfPresent(prev, item))
			}

			break
		}

		case "trashEmpty": {
			// Clear the trash listing directly (neither driveListingQueryUpdate — hardcoded to "drive" — nor the
			// global fan-out can single out one key). Only when it's cached: an unopened trash listing has
			// nothing to empty and setting [] would conjure a phantom slice.
			const key = driveListingQueryKey({ variant: "trash", uuid: null })

			if (queryClient.getQueryData(key) !== undefined) {
				queryClient.setQueryData<DriveItem[]>(key, [])
			}

			break
		}

		case "deleteAll":
		case "deleteVersioned": {
			// Account-wide bulk operations with no per-item payload — a blanket cache wipe from an ambiguous
			// signal would be riskier than letting the next mount refetch (mobile leaves these unhandled too).
			log.warn("socket", "drive event not cache-patched", inner.type)

			break
		}

		default: {
			// Exhaustive over the wasm DriveEvent union — a new variant fails to compile here until mapped.
			log.error("socket", "unhandled drive event", (inner as { type: string }).type)

			break
		}
	}
}
