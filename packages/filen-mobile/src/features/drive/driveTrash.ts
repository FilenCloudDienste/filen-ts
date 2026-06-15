import auth from "@/lib/auth"
import { type FileVersion } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { unwrapDirMeta, unwrapFileMeta, unwrapParentUuid, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import {
	driveItemsQueryUpdateGlobal,
	driveItemsQueryUpdate,
	driveItemsQueryUpdateForNormalParent,
	driveItemsQueryGet
} from "@/features/drive/queries/useDriveItems.query"
import { driveItemVersionsQueryUpdate } from "@/features/drive/queries/useDriveItemVersions.query"
import useFileVersionsStore from "@/features/drive/store/useFileVersions.store"
import cache from "@/lib/cache"
import events from "@/lib/events"

export async function deletePermanently({ item, signal }: { item: DriveItem; signal?: AbortSignal }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)

	if (item.type === "directory") {
		await authedSdkClient.deleteDirPermanently(
			item.data,
			signal
				? {
						signal
					}
				: undefined
		)
	} else {
		await authedSdkClient.deleteFilePermanently(
			item.data,
			signal
				? {
						signal
					}
				: undefined
		)
	}

	cache.forgetItem(item.data.uuid)

	// Always remove from the trash listing — trash items carry `parent = Trash`
	// sentinel, so unwrappedParentUuidPrevious is always null for them and the
	// global block below never fires for this function's only real callers.
	driveItemsQueryUpdate({
		params: {
			path: {
				type: "trash",
				uuid: null
			}
		},
		updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
	})

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

export async function trash({ item, signal }: { item: DriveItem; signal?: AbortSignal }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)

	const modifiedItem =
		item.type === "directory"
			? await authedSdkClient.trashDir(
					item.data,
					signal
						? {
								signal
							}
						: undefined
				)
			: await authedSdkClient.trashFile(
					item.data,
					signal
						? {
								signal
							}
						: undefined
				)

	// Ugly but works for now, until we have a better way
	if (!("region" in modifiedItem)) {
		item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedItem))
	} else {
		item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedItem))
	}

	// Sync persistent caches — `trash` flag flipped on the raw Dir/File. Item
	// still exists, just lives in the trash listing now.
	if (item.type === "file" && "region" in modifiedItem) {
		cache.cacheNewFile(modifiedItem, item)
	} else if (item.type === "directory" && !("region" in modifiedItem)) {
		cache.cacheNewNormalDir(modifiedItem, item)
	}

	if (unwrappedParentUuidPrevious) {
		driveItemsQueryUpdateGlobal({
			parentUuid: unwrappedParentUuidPrevious,
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
		})
	}

	// Recents is intentionally not re-added here: the global update above already
	// removed the item from every listing, and the recents query refetches on focus
	// (listRecents returns recent trashed items), so recents stays server-authoritative.
	driveItemsQueryUpdate({
		params: {
			path: {
				type: "trash",
				uuid: null
			}
		},
		updater: prev => [...prev.filter(i => i.data.uuid !== item.data.uuid), item]
	})

	// Drop the item from an open preview showing it (now lives in trash).
	events.emit("driveItemRemoved", {
		uuid: item.data.uuid
	})

	return item
}

export async function restore({ item, signal }: { item: DriveItem; signal?: AbortSignal }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const modifiedItem =
		item.type === "directory"
			? await authedSdkClient.restoreDir(
					item.data,
					signal
						? {
								signal
							}
						: undefined
				)
			: await authedSdkClient.restoreFile(
					item.data,
					signal
						? {
								signal
							}
						: undefined
				)

	// Ugly but works for now, until we have a better way
	if (!("region" in modifiedItem)) {
		item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedItem))
	} else {
		item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedItem))
	}

	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	// Refresh persistent caches with the restored item (its trash flag flipped).
	if (item.type === "file" && "region" in modifiedItem) {
		cache.cacheNewFile(modifiedItem, item)
	} else if (item.type === "directory" && !("region" in modifiedItem)) {
		cache.cacheNewNormalDir(modifiedItem, item)
	}

	const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

	if (unwrappedParentUuid) {
		driveItemsQueryUpdateForNormalParent({
			parentUuid: unwrappedParentUuid,
			updater: prev => [
				...prev.filter(
					i =>
						i.data.uuid !== item.data.uuid &&
						i.data.decryptedMeta?.name.toLowerCase().trim() !== item.data.decryptedMeta?.name.toLowerCase().trim()
				),
				item
			]
		})
	}

	driveItemsQueryUpdate({
		params: {
			path: {
				type: "trash",
				uuid: null
			}
		},
		updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
	})

	// Drop the item from an open preview showing it (restored out of trash).
	events.emit("driveItemRemoved", {
		uuid: item.data.uuid
	})
}

export async function emptyTrash({ signal }: { signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	await authedSdkClient.emptyTrash(
		signal
			? {
					signal
				}
			: undefined
	)

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

	driveItemsQueryUpdate({
		params: {
			path: {
				type: "trash",
				uuid: null
			}
		},
		updater: () => []
	})
}

export async function restoreFileVersion({ item, version, signal }: { item: DriveItem; version: FileVersion; signal?: AbortSignal }) {
	if (item.type !== "file") {
		throw new Error("Invalid item type")
	}

	// A version restore is a content change, so the file's uuid rotates. Capture
	// the pre-restore uuid to re-point any open preview keyed by the old uuid.
	const previousUuid = item.data.uuid

	const { authedSdkClient } = await auth.getSdkClients()
	const modifiedFile = await authedSdkClient.restoreFileVersion(
		item.data,
		version,
		signal
			? {
					signal
				}
			: undefined
	)

	item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedFile))

	if (item.type !== "file") {
		throw new Error("Invalid item type")
	}

	// Sync persistent caches — file size / chunks changed after version restore.
	cache.cacheNewFile(modifiedFile, item)

	const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

	if (unwrappedParentUuid) {
		driveItemsQueryUpdateForNormalParent({
			parentUuid: unwrappedParentUuid,
			updater: prev => [
				...prev.filter(
					i =>
						i.data.uuid !== item.data.uuid &&
						i.data.decryptedMeta?.name.toLowerCase().trim() !== item.data.decryptedMeta?.name.toLowerCase().trim()
				),
				item
			]
		})
	}

	// Drop the now-promoted version from the versions list so the screen
	// reflects the restore without a manual refetch (mirrors deleteVersion below).
	driveItemVersionsQueryUpdate({
		params: {
			uuid: item.data.uuid
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

export async function deleteVersion({ item, version, signal }: { item: DriveItem; version: FileVersion; signal?: AbortSignal }) {
	if (item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	await authedSdkClient.deleteFileVersion(
		version,
		signal
			? {
					signal
				}
			: undefined
	)

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
