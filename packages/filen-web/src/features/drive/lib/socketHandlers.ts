import type { SocketEvent, NonRootItemTagged } from "@filen/sdk-rs"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { log } from "@/lib/log"
import {
	driveListingQueryUpdate,
	driveListingQueryUpdateGlobal,
	findOwnedListingItem,
	flatListingQueryUpdate,
	flushListingCreates,
	invalidateDriveListings,
	invalidateFlatListing,
	markListingsStale,
	normalizeParentUuid,
	queueListingCreate
} from "@/features/drive/queries/drive"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	currentRootUuid,
	insertIntoTrashListing,
	patchFavoritesListing,
	patchMovedItem,
	patchRestoredItem
} from "@/features/drive/lib/actions"
import { followDriveEventOnClipboard } from "@/features/drive/lib/clipboardSync"
import {
	invalidatePhotosListing,
	markPhotosListingStale,
	patchPhotosFavorite,
	type PhotosEventScope
} from "@/features/photos/queries/photos"
import { markAccountStale } from "@/queries/account"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { markClipboardEventsMissed } from "@/features/drive/store/useDriveClipboardStore"
import { hasActiveCopies, useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import {
	emitPreviewFileMetaChanged,
	emitPreviewFolderMetaChanged,
	emitPreviewItemRemoved,
	emitPreviewItemReplaced
} from "@/features/preview/lib/previewReconcile"
import { emitBranchChange } from "@/features/drive/lib/branchChanges"

// The realtime DRIVE event handlers — a faithful port of filen-mobile's drive socketHandlers.ts
// SEMANTICS onto the wasm surface (flat discriminated `event.inner.type`), registered on the generic
// socket bridge. Web keeps no worker-side item cache like mobile's fileUuidToNormalFile map, so the two
// resolution strategies differ where a payload is sparse: an event that ships the full File/Dir splices
// it into its parent listing (the item's own `.parent`) if that listing has been read — a copy or an
// upload elsewhere creates items by the thousand under directories nobody has opened, and a listing made
// from them would sit in memory for the session and show as that directory's whole content until read; an event that ships only a uuid patches every
// currently-instantiated listing at once via driveListingQueryUpdateGlobal (the same fan-out actions.ts
// uses), which reaches whichever listing holds the row without a parent lookup. No invalidate-storm — every
// path is a targeted setQueryData, which a listing read under way also applies to what it returns.
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

// Drive events are what keep the listings, the photos listing and the clipboard fresh, so one that can't be
// decoded, or a drop that loses them, leaves them stale: each listing re-reads on its next mount, focus or
// reconnect, and the clipboard's items are looked up again before their next paste. The authSuccess that
// ends a drop also re-reads the mounted listings, since what changed meanwhile never arrived. The first
// authSuccess of a session re-reads nothing: a listing read before it doesn't count as current (drive.ts),
// so its next mount or focus reads it again.
let sawReconnecting = false

export function markDriveEventsMissed(): void {
	markListingsStale()

	markPhotosListingStale()
	markClipboardEventsMissed()
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

// Recents is a flat, cross-directory aggregation with its own key, which a new file joins with the batch
// its parent listing gets (queueListingCreate). Appending is enough for ordering: resolveEffectiveSort
// forces uploadDateDesc for the recents variant (lib/preferences.ts), so the row sorts to the top at
// render. A copy lands its files as fileNew events by the thousand; while one runs, recents is read once
// after the last copy instead.
let recentsDeferred = false

function newFileJoinsRecents(): boolean {
	if (hasActiveCopies(useTransfersStore.getState().transfers)) {
		recentsDeferred = true

		return false
	}

	return true
}

// Called as each copy settles; only the last one standing reads.
export function flushDeferredRecents(): void {
	if (!recentsDeferred || hasActiveCopies(useTransfersStore.getState().transfers)) {
		return
	}

	recentsDeferred = false

	invalidateFlatListing("recents")
}

// A row keeps its favorite, so one leaving the trash or replacing an edited or restored version rejoins
// Favorites alongside its parent listing. Only a restored directory's colour can be unknown.
function rejoinFavorites(item: DriveItem, colorKnown: boolean): void {
	if (item.data.favorited) {
		patchFavoritesListing(true, item, colorKnown)
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

// Batched per parent listing (queueListingCreate). Every other event applies the queue first, so none
// lands before a create it follows.
const BATCHED_CREATE_EVENT_TYPES: ReadonlySet<DriveSocketEvent["inner"]["type"]> = new Set(["fileNew", "folderSubCreated"])

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
	"folderMetadataChanged",
	"deleteAll"
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

	if (!BATCHED_CREATE_EVENT_TYPES.has(inner.type)) {
		flushListingCreates()
	}

	if (PHOTOS_INVALIDATING_EVENT_TYPES.has(inner.type)) {
		invalidatePhotosListing(photosEventScope(inner))
	}

	// No event carries the new totals, so a change from any device marks the account for its next focus
	// or mount instead of waiting out its stale time (queries/account.ts).
	if (ACCOUNT_STORAGE_EVENT_TYPES.has(inner.type)) {
		markAccountStale()
	}

	// The clipboard follows its items, and a trashed or deleted item leaves it.
	followDriveEventOnClipboard(event)

	switch (inner.type) {
		case "fileNew": {
			// A brand-new file — spliced into its parent listing, where a same-name/same-uuid stale row makes
			// way so a re-delivered event never duplicates, and into Recents, which it joins by definition
			// (mobile inserts unconditionally too).
			const item = narrowItem(inner.file)

			queueListingCreate(normalizeParentUuid(inner.file.parent, rootUuid), item, { recent: newFileJoinsRecents() })
			rejoinFavorites(item, true)

			break
		}

		case "fileRestore": {
			const { item } = patchRestoredItem(narrowItem(inner.file), rootUuid)

			rejoinFavorites(item, true)
			// The item left the trash listing — a trash preview open on it advances to a neighbour or closes.
			emitPreviewItemRemoved(item.data.uuid)

			break
		}

		case "fileArchiveRestored": {
			const item = narrowItem(inner.file)

			// A version restore rotates the file's uuid: drop both the restored uuid (if a stale copy lingers)
			// and the superseded current uuid, then splice the fresh file into its parent.
			driveListingQueryUpdateGlobal({ type: "remove", uuid: item.data.uuid })
			driveListingQueryUpdateGlobal({ type: "remove", uuid: inner.currentUuid })
			driveListingQueryUpdate(normalizeParentUuid(inner.file.parent, rootUuid), { type: "upsert", items: [item] })
			rejoinFavorites(item, true)
			// A preview open on the superseded uuid reseeds with the restored file (same slot, fresh content).
			emitPreviewItemReplaced(inner.currentUuid, item)

			break
		}

		case "folderSubCreated": {
			queueListingCreate(normalizeParentUuid(inner.dir.parent, rootUuid), narrowItem(inner.dir))

			break
		}

		// The SDK builds a directory's restore and move payloads with the default colour; the shared patches
		// keep the colour a current listing holds.
		case "folderRestore": {
			const { item, colorKnown } = patchRestoredItem(narrowItem(inner.dir), rootUuid)

			rejoinFavorites(item, colorKnown)
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
			// A shared-in item its owner trashed leaves the shared listing without ever landing here.
			useDriveStore.getState().removeFromSelection([inner.uuid])

			const trashed = supersededByEdit ? undefined : findOwnedListingItem(inner.uuid)

			driveListingQueryUpdateGlobal({ type: "remove", uuid: inner.uuid })

			if (trashed !== undefined) {
				// A file row carries no colour an outdated listing could have missed.
				insertIntoTrashListing(trashed.item, trashed.current || trashed.item.type === "file")
			}

			// A preview open on the trashed item advances to a neighbour or closes.
			if (!supersededByEdit) {
				emitPreviewItemRemoved(inner.uuid)
			}

			// A route through the trashed directory leaves it (branchChanges.ts).
			if (inner.type === "folderTrash") {
				emitBranchChange({ type: "trashed", uuid: inner.uuid })
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
			driveListingQueryUpdateGlobal({ type: "remove", uuid: inner.uuid })

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
			driveListingQueryUpdateGlobal({ type: "remove", uuid: inner.uuid })
			emitPreviewItemRemoved(inner.uuid)

			break
		}

		case "fileMetadataChanged": {
			// Only an owned file row can be rebuilt from its own cached shape + the new meta (web has no item
			// cache to reconstruct a share from). Re-narrow so name/undecryptable derive from the fresh meta.
			driveListingQueryUpdateGlobal({
				type: "replace",
				uuid: inner.uuid,
				replace: row => (row.type === "file" ? narrowItem({ ...row.data, meta: inner.metadata }) : row)
			})
			// A preview open on this file re-derives its header title from the fresh meta (rename).
			emitPreviewFileMetaChanged(inner.uuid, inner.metadata)

			break
		}

		case "folderMetadataChanged": {
			driveListingQueryUpdateGlobal({
				type: "replace",
				uuid: inner.uuid,
				replace: row => (row.type === "directory" ? narrowItem({ ...row.data, meta: inner.meta }) : row)
			})
			emitPreviewFolderMetaChanged(inner.uuid, inner.meta)

			break
		}

		case "folderColorChanged": {
			driveListingQueryUpdateGlobal({
				type: "replace",
				uuid: inner.uuid,
				replace: row => (row.type === "directory" ? { ...row, data: { ...row.data, color: inner.color } } : row)
			})

			break
		}

		case "itemFavorite": {
			const item = narrowFavoriteItem(inner.item)

			if (item !== undefined) {
				// Attribute refresh wherever the row is already cached…
				driveListingQueryUpdateGlobal({ type: "replace", uuid: item.data.uuid, replace: () => item })
				// …plus the Favorites root's own membership add/remove, which a replace-only fan-out can never
				// do (mobile does both arms too). The payload item carries its NEW favorited flag and the
				// server's colour.
				patchFavoritesListing(item.data.favorited, item, true)

				// How a favorite set anywhere else reaches the photos grid.
				patchPhotosFavorite(item)
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
