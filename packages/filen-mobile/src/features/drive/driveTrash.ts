import auth from "@/lib/auth"
import { type FileVersion } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { unwrapParentUuid } from "@/lib/sdkUnwrap"
import { itemFromModified } from "@/features/drive/driveModified"
import {
	driveItemsQueryUpdateGlobal,
	driveItemsQueryUpdateRoot,
	driveItemsQueryUpdateForNormalParent,
	driveItemsQueryGet,
	driveItemsQueryRemoveDirectoryFromPhotos
} from "@/features/drive/queries/useDriveItems.query"
import socketCreateBatcher from "@/features/drive/socketCreateBatcher"
import { driveItemVersionsQueryUpdate } from "@/features/drive/queries/useDriveItemVersions.query"
import { markDirectorySizesStale } from "@/features/drive/queries/useDirectorySize.query"
import { upsertItem } from "@filen/shared"
import useFileVersionsStore from "@/features/drive/store/useFileVersions.store"
import cache from "@/lib/cache"
import events from "@/lib/events"

export async function deletePermanently({ item }: { item: DriveItem }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)

	if (item.type === "directory") {
		await authedSdkClient.deleteDirPermanently(item.data)
	} else {
		await authedSdkClient.deleteFilePermanently(item.data)
	}

	cache.forgetItem(item.data.uuid)
	markDirectorySizesStale()

	// Always remove from the trash listing — trash items carry `parent = Trash`
	// sentinel, so unwrappedParentUuidPrevious is always null for them and the
	// global block below never fires for this function's only real callers.
	driveItemsQueryUpdateRoot("trash", prev => prev.filter(i => i.data.uuid !== item.data.uuid))

	if (unwrappedParentUuidPrevious) {
		driveItemsQueryUpdateGlobal({
			parentUuid: unwrappedParentUuidPrevious,
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
		})
	}

	// Drop the item from an open preview showing it (permanently gone).
	events.emit("driveItemRemoved", {
		uuid: item.data.uuid
	})

	return item
}

export async function trash({ item }: { item: DriveItem }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)

	const modifiedItem = item.type === "directory" ? await authedSdkClient.trashDir(item.data) : await authedSdkClient.trashFile(item.data)

	// The item still exists, it just lives in the trash listing now.
	item = itemFromModified(modifiedItem)

	markDirectorySizesStale()
	// A queued create of this item must not land after the removal below.
	socketCreateBatcher.flushNow()

	if (unwrappedParentUuidPrevious) {
		driveItemsQueryUpdateGlobal({
			parentUuid: unwrappedParentUuidPrevious,
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
		})
	}

	if (item.type === "directory") {
		driveItemsQueryRemoveDirectoryFromPhotos({
			dirUuid: item.data.uuid
		})
	}

	// Recents is intentionally not re-added here: the global update above already
	// removed the item from every listing, and the recents query refetches on focus
	// (listRecents returns recent trashed items), so recents stays server-authoritative.
	driveItemsQueryUpdateRoot("trash", prev => [...prev.filter(i => i.data.uuid !== item.data.uuid), item])

	// Drop the item from an open preview showing it (now lives in trash).
	events.emit("driveItemRemoved", {
		uuid: item.data.uuid
	})

	return item
}

export async function restore({ item }: { item: DriveItem }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	// Capture before reassignment — for the search self-heal emit below (Effect D keys its
	// tombstone on the pre-restore uuid).
	const previousUuid = item.data.uuid

	const { authedSdkClient } = await auth.getSdkClients()
	const modifiedItem =
		item.type === "directory" ? await authedSdkClient.restoreDir(item.data) : await authedSdkClient.restoreFile(item.data)

	item = itemFromModified(modifiedItem)

	markDirectorySizesStale()

	const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

	if (unwrappedParentUuid) {
		driveItemsQueryUpdateForNormalParent({
			parentUuid: unwrappedParentUuid,
			updater: prev => upsertItem(prev, item)
		})
	}

	driveItemsQueryUpdateRoot("trash", prev => prev.filter(i => i.data.uuid !== item.data.uuid))

	// Drop the item from an open preview showing it (restored out of trash).
	events.emit("driveItemRemoved", {
		uuid: item.data.uuid
	})

	// Un-suppress an active subtree cache-search: if this item was trashed while a /drive
	// search was open, Effect D tombstoned it; this clears that tombstone (keyed on the
	// pre-restore uuid + the restored uuid) so the next snapshot re-includes it. The gallery
	// + Effect D only REPLACE present rows on this event, so the just-emitted removal above
	// isn't undone (the item is absent → no-op there).
	events.emit("driveItemUpdated", {
		previousUuid,
		item
	})
}

export async function emptyTrash() {
	const { authedSdkClient } = await auth.getSdkClients()

	await authedSdkClient.emptyTrash()

	// Forget every previously-trashed item so cache.uuidToAnyDriveItem doesn't
	// retain zombies. Read the trash listing before clearing it.
	const trashed = driveItemsQueryGet({
		path: {
			type: "trash",
			uuid: null
		}
	})

	if (trashed) {
		for (const item of trashed) {
			cache.forgetItem(item.data.uuid)
		}
	}

	markDirectorySizesStale()

	driveItemsQueryUpdateRoot("trash", () => [])
}

export async function restoreFileVersion({ item, version }: { item: DriveItem; version: FileVersion }) {
	if (item.type !== "file") {
		throw new Error("Invalid item type")
	}

	// A version restore is a content change, so the file's uuid rotates. Capture
	// the pre-restore uuid to re-point any open preview keyed by the old uuid.
	const previousUuid = item.data.uuid

	const { authedSdkClient } = await auth.getSdkClients()
	const modifiedFile = await authedSdkClient.restoreFileVersion(item.data, version)

	item = itemFromModified(modifiedFile)
	markDirectorySizesStale()

	const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

	if (unwrappedParentUuid) {
		driveItemsQueryUpdateForNormalParent({
			parentUuid: unwrappedParentUuid,
			updater: prev => upsertItem(prev, item)
		})
	}

	// Drop the now-promoted version from the versions list so the screen
	// reflects the restore without a manual refetch. Keyed on `previousUuid`, NOT
	// item.data.uuid: a version restore ROTATES the file's uuid (the SDK sets
	// file.uuid = version.uuid), so item.data.uuid is now the NEW uuid, while the
	// file-versions screen queries by the PRE-rotation uuid it was opened with (route
	// param, never re-set). Writing to the new key would land on an unobserved cache
	// entry, leaving the restored version on screen until a manual refetch.
	// (deleteVersion below does NOT rotate the uuid, so its item.data.uuid key is correct.)
	driveItemVersionsQueryUpdate({
		params: {
			uuid: previousUuid
		},
		updater: prev => prev.filter(v => v.uuid !== version.uuid)
	})

	// Re-point an open drive preview from the old uuid to the restored file, so it
	// shows the restored content (and edits/saves build on it, not stale bytes).
	events.emit("driveItemUpdated", {
		previousUuid,
		item
	})

	return item
}

export async function deleteVersion({ item, version }: { item: DriveItem; version: FileVersion }) {
	if (item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	await authedSdkClient.deleteFileVersion(version)

	driveItemVersionsQueryUpdate({
		params: {
			uuid: item.data.uuid
		},
		updater: prev => prev.filter(v => v.uuid !== version.uuid)
	})

	// Purge the deleted version from any active selection so the header count and
	// a later bulk-delete can't reference a UUID that no longer exists.
	useFileVersionsStore.getState().setSelectedVersions(prev => prev.filter(v => v.uuid !== version.uuid))
}
