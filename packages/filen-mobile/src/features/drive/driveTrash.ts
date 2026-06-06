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
import cache from "@/lib/cache"

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

	if (unwrappedParentUuidPrevious) {
		driveItemsQueryUpdateGlobal({
			parentUuid: unwrappedParentUuidPrevious,
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
		})
	}

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
}
