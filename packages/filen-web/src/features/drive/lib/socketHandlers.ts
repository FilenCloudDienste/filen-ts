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
import { useDriveStore } from "@/features/drive/store/useDriveStore"

// The realtime DRIVE event handlers — a faithful port of filen-mobile's drive socketHandlers.ts
// SEMANTICS onto the wasm surface (flat discriminated `event.inner.type`), registered on the generic
// socket bridge. Web keeps no worker-side item cache like mobile's fileUuidToNormalFile map, so the two
// resolution strategies differ where a payload is sparse: an event that ships the full File/Dir splices
// it into its parent listing (the item's own `.parent`); an event that ships only a uuid patches every
// currently-instantiated listing at once via driveListingQueryUpdateGlobal (the same fan-out actions.ts
// uses), which reaches whichever listing holds the row without a parent lookup. No invalidate-storm — every
// path is a targeted setQueryData with the queries' own cancel-before-patch discipline.

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

export function handleDriveEvent(event: DriveSocketEvent): void {
	const inner = event.inner
	const rootUuid = currentRootUuid()

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

			break
		}

		case "fileArchiveRestored": {
			const item = narrowItem(inner.file)

			// A version restore rotates the file's uuid: drop both the restored uuid (if a stale copy lingers)
			// and the superseded current uuid, then splice the fresh file into its parent.
			driveListingQueryUpdateGlobal(prev => removeByUuid(removeByUuid(prev, item.data.uuid), inner.currentUuid))
			driveListingQueryUpdate(normalizeParentUuid(inner.file.parent, rootUuid), prev => upsertDriveItem(prev, item))

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

			break
		}

		case "fileMove": {
			const item = narrowItem(inner.file)

			// The File carries its NEW parent; web keeps no item cache to look up the OLD parent, so a global
			// remove clears the stale copy from wherever it was before splicing into the destination.
			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, item.data.uuid))
			driveListingQueryUpdate(normalizeParentUuid(inner.file.parent, rootUuid), prev => upsertDriveItem(prev, item))

			break
		}

		case "folderMove": {
			const item = narrowItem(inner.dir)

			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, item.data.uuid))
			driveListingQueryUpdate(normalizeParentUuid(inner.dir.parent, rootUuid), prev => upsertDriveItem(prev, item))

			break
		}

		case "fileTrash":
		case "folderTrash": {
			// The item left every normal listing (trash refetches on open — never optimistically populated,
			// mirroring actions.ts's trashItems). Purge it from the selection so the count / select-all toggle /
			// bulk ops never target a ghost.
			useDriveStore.getState().removeFromSelection([inner.uuid])
			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, inner.uuid))

			break
		}

		case "fileArchived":
		case "fileDeletedPermanent":
		case "folderDeletedPermanent": {
			// The item left the current listing — purge selection, then strip it from every listing. (fileArchived
			// moves the file into its version history; the listing removal is the same either way.)
			useDriveStore.getState().removeFromSelection([inner.uuid])
			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, inner.uuid))

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

			break
		}

		case "folderMetadataChanged": {
			driveListingQueryUpdateGlobal(prev =>
				prev.map(row =>
					row.data.uuid === inner.uuid && row.type === "directory" ? narrowItem({ ...row.data, meta: inner.meta }) : row
				)
			)

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
