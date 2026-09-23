import type { SocketEvent, NonRootItemTagged } from "@filen/sdk-rs"
import { removeByUuid } from "@filen/shared"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { log } from "@/lib/log"
import {
	driveListingQueryUpdate,
	driveListingQueryUpdateGlobal,
	findCachedListingItem,
	flatListingQueryUpdate,
	invalidateDriveListings,
	markListingsStale,
	normalizeParentUuid
} from "@/features/drive/queries/drive"
import { narrowItem, upsertDriveItem, type DriveItem } from "@/features/drive/lib/item"
import { currentRootUuid, insertIntoTrashListing, patchFavoritesListing, patchMovedItem } from "@/features/drive/lib/actions"
import { invalidatePhotosListing, markPhotosListingStale, type PhotosEventScope } from "@/features/photos/queries/photos"
import { markAccountStale } from "@/queries/account"
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

// Registers the drive handlers on the generic bridge; returns the unregister fn. Called once by the authed
// shell's socket host. Only "drive" events reach handleDriveEvent — the registry routes by type.
export function registerDriveSocketHandlers(): () => void {
	const unregisterDrive = registerSocketHandler("drive", handleDriveEvent)
	const unregisterMalformed = registerSocketHandler("driveMalformed", markDriveEventsMissed)
	const unregisterReconnecting = registerSocketHandler("reconnecting", handleDriveReconnecting)
	const unregisterAuthSuccess = registerSocketHandler("authSuccess", handleDriveAuthSuccess)

	return () => {
		unregisterDrive()
		unregisterMalformed()
		unregisterReconnecting()
		unregisterAuthSuccess()
	}
}

// Drive events are what keep the listings and the photos listing fresh, so one that can't be decoded, or
// a drop that loses them, leaves both stale: each re-reads on its next mount, focus or reconnect. The
// authSuccess that ends a drop also re-reads the mounted listings, since what changed meanwhile never
// arrived. The first authSuccess of a session re-reads nothing: a listing read before it doesn't count
// as current (drive.ts), so its next mount or focus reads it again.
let sawReconnecting = false

export function markDriveEventsMissed(): void {
	markListingsStale()

	markPhotosListingStale()
}

export function handleDriveReconnecting(): void {
	sawReconnecting = true

	markDriveEventsMissed()
}

export function handleDriveAuthSuccess(): void {
	if (!sawReconnecting) {
		return
	}

	sawReconnecting = false

	invalidateDriveListings()
}

// In-place attribute swap by uuid (a flag/color/meta changed; identity and membership did not) — never
// appends, so a global patch leaves an absent row absent instead of conjuring it into every listing.
function replaceIfPresent(items: DriveItem[], updated: DriveItem): DriveItem[] {
	return items.map(item => (item.data.uuid === updated.data.uuid ? updated : item))
}

// Only an OWNED row can enter this account's trash: a shared-in item its owner trashed leaves the
// shared listing without ever landing here (mobile gates the same insert on its owned-item cache).
function ownedRowOrUndefined(item: DriveItem | undefined): DriveItem | undefined {
	return item !== undefined && (item.type === "file" || item.type === "directory") ? item : undefined
}

// Recents is a flat, cross-directory aggregation with its own key. Dedups on uuid alone (recents
// aggregates across parents, so upsertDriveItem's name-collision rule doesn't apply here — same
// reasoning as the favorites listing). Appending is enough for ordering: resolveEffectiveSort forces
// uploadDateDesc for the recents variant (lib/preferences.ts), so the row sorts to the top at render.
function insertIntoRecents(item: DriveItem): void {
	flatListingQueryUpdate("recents", prev => [...removeByUuid(prev, item.data.uuid), item])
}

// A row the payload carries in full keeps its favorite, so one leaving the trash or replacing an
// edited or restored version rejoins Favorites alongside its parent listing.
function rejoinFavorites(item: DriveItem): void {
	if (item.data.favorited) {
		patchFavoritesListing(true, item)
	}
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

// Drive events that can add, remove or rename a photo; photosEventScope then narrows each to the part
// of the tree it touched, so a change outside the photos root skips the recursive refetch.
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

// null when the payload can't locate every end of the change, which always invalidates: a move names
// only its destination, a file rename carries no parent (and can turn a file into a photo), and a
// permanently deleted dir may already be gone from the dir cache. A restore's other end is the trash.
function photosEventScope(inner: DriveSocketEvent["inner"]): PhotosEventScope | null {
	switch (inner.type) {
		case "fileNew":
		case "fileRestore":
			return { dirs: [inner.file.parent], item: inner.file.uuid }

		// The superseded uuid is the one a listing may hold; the restored file replaces it in place.
		case "fileArchiveRestored":
			return { dirs: [inner.file.parent], item: inner.currentUuid }

		// A move's old parent isn't in the payload, but a file that left the root matters only if listed.
		case "fileMove":
			return { dirs: [inner.file.parent], item: inner.file.uuid }

		case "fileTrash":
		case "fileArchived":
		case "fileDeletedPermanent":
			return { dirs: [], item: inner.uuid }

		case "folderTrash":
			return { dirs: [inner.parent], item: inner.uuid }

		case "folderRestore":
			return { dirs: [inner.dir.parent], item: inner.dir.uuid }

		// A rename leaves the dir where it was, so its own cached chain locates it.
		case "folderMetadataChanged":
			return { dirs: [inner.uuid], item: inner.uuid }

		default:
			return null
	}
}

// Drive events that move the account's storage used or versioned storage. Trashing and restoring don't:
// trashed items keep counting until deleted. A new version arrives as fileNew, its predecessor as
// fileArchived.
const ACCOUNT_STORAGE_EVENT_TYPES: ReadonlySet<DriveSocketEvent["inner"]["type"]> = new Set([
	"fileNew",
	"fileArchived",
	"fileArchiveRestored",
	"fileDeletedPermanent",
	"folderDeletedPermanent",
	"trashEmpty",
	"deleteAll",
	"deleteVersioned"
])

export function handleDriveEvent(event: DriveSocketEvent): void {
	const inner = event.inner
	const rootUuid = currentRootUuid()

	if (PHOTOS_INVALIDATING_EVENT_TYPES.has(inner.type)) {
		invalidatePhotosListing(photosEventScope(inner))
	}

	// No event carries the new totals, so a change from any device marks the account for its next focus
	// or mount instead of waiting out its stale time (queries/account.ts).
	if (ACCOUNT_STORAGE_EVENT_TYPES.has(inner.type)) {
		markAccountStale()
	}

	switch (inner.type) {
		case "fileNew": {
			// A brand-new file — splice into its parent listing. upsertDriveItem drops any same-name/same-uuid
			// stale row so a re-delivered event never duplicates.
			const item = narrowItem(inner.file)

			driveListingQueryUpdate(normalizeParentUuid(inner.file.parent, rootUuid), prev => upsertDriveItem(prev, item))
			// A brand-new file is a recents entry by definition — mobile inserts unconditionally too.
			insertIntoRecents(item)
			rejoinFavorites(item)

			break
		}

		case "fileRestore": {
			const item = narrowItem(inner.file)

			// Global remove FIRST (it also strips the trash listing the item is leaving), then splice into the
			// destination parent — uuid is preserved across a restore, so removing after the upsert would strip
			// the just-restored row right back out.
			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, item.data.uuid))
			driveListingQueryUpdate(normalizeParentUuid(inner.file.parent, rootUuid), prev => upsertDriveItem(prev, item))
			rejoinFavorites(item)
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
			rejoinFavorites(item)
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
			rejoinFavorites(item)
			emitPreviewItemRemoved(item.data.uuid)

			break
		}

		case "fileMove": {
			const item = narrowItem(inner.file)

			// The File carries its NEW parent; web keeps no item cache to look up the OLD parent, so the patch
			// fans out to wherever the row was cached.
			patchMovedItem(item, rootUuid)
			// The item left this listing for another directory — a preview open on it advances or closes.
			emitPreviewItemRemoved(item.data.uuid)

			break
		}

		case "folderMove": {
			const item = narrowItem(inner.dir)

			patchMovedItem(item, rootUuid)
			emitPreviewItemRemoved(item.data.uuid)

			break
		}

		case "fileTrash":
		case "folderTrash": {
			// A fileTrash carrying `newUUID` is NOT a user trash: the SDK documents it as an edit on a
			// versioning-disabled account, the twin of fileArchived, whose successor arrives as its own
			// fileNew. It gets fileArchived's treatment — drop the superseded row and nothing else. Inserting
			// it into the trash listing would show a just-saved file as trashed, and removing it from the
			// preview would yank that file out from under the user mid-save.
			const supersededByEdit = inner.type === "fileTrash" && inner.newUUID !== undefined

			// The item left every normal listing and JOINED the trash's own listing (actions.ts's trashItems
			// patches both halves the same way). Purge it from the selection so the count / select-all toggle /
			// bulk ops never target a ghost. The payload carries no row, so the one for the trash insert is
			// read out of a cached listing BEFORE the removal fan-out strips it — with no cached copy
			// anywhere, only the removal applies and the trash listing refetches on its next mount or focus.
			useDriveStore.getState().removeFromSelection([inner.uuid])

			const trashed = supersededByEdit ? undefined : ownedRowOrUndefined(findCachedListingItem(inner.uuid))

			driveListingQueryUpdateGlobal(prev => removeByUuid(prev, inner.uuid))

			if (trashed !== undefined) {
				insertIntoTrashListing(trashed)
			}

			// A preview open on the trashed item advances to a neighbour or closes.
			if (!supersededByEdit) {
				emitPreviewItemRemoved(inner.uuid)
			}

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
			// A fileDeletedPermanent WITHOUT `stableUUID` deleted one archived VERSION, not the file — its
			// `uuid` names that version and the live file lives on, so nothing here may fire. Acting on it
			// would strip a still-existing file from any listing cached under a pre-rotation uuid, and yank
			// an open preview still holding that frozen slot (see fileArchived).
			if (inner.type === "fileDeletedPermanent" && inner.stableUUID === undefined) {
				break
			}

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
				// Attribute refresh wherever the row is already cached…
				driveListingQueryUpdateGlobal(prev => replaceIfPresent(prev, item))
				// …plus the Favorites root's own membership add/remove, which a replace-only fan-out can never
				// do (mobile does both arms too). The payload item carries its NEW favorited flag.
				patchFavoritesListing(item.data.favorited, item)
			}

			break
		}

		case "trashEmpty": {
			flatListingQueryUpdate("trash", () => [])

			break
		}

		case "deleteAll":
		case "deleteVersioned": {
			// Account-wide bulk operations with no per-item payload — a blanket cache wipe from an ambiguous
			// signal would be riskier than re-reading the listings (mobile leaves these unhandled).
			log.warn("socket", "drive event not cache-patched", inner.type)
			invalidateDriveListings()

			break
		}

		default: {
			// Exhaustive over the wasm DriveEvent union — a new variant fails to compile here until mapped.
			log.error("socket", "unhandled drive event", (inner as { type: string }).type)

			break
		}
	}
}
