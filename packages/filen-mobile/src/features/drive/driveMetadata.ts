import auth from "@/lib/auth"
import { CreatedTime, DirColor, NonRootNormalItem, NonRootNormalItem_Tags } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { unwrapDirMeta, unwrapFileMeta, unwrapParentUuid, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { driveItemsQueryUpdateGlobal, driveItemsQueryUpdate } from "@/features/drive/queries/useDriveItems.query"
import cache from "@/lib/cache"
import { toSignalOpts } from "@/lib/signals"

/**
 * Optimistic updater for the root Favorites listing (`{ type: "favorites", uuid: null }`).
 * When `favorited` is true, insert/refresh the item; when false, remove it.
 * `driveItemsQueryUpdateGlobal` only `.map()`s existing rows, so it can never
 * ADD a newly-favorited item to the Favorites listing — this closes that gap.
 */
export function favoritesListingUpdater(prev: DriveItem[], item: DriveItem, favorited: boolean): DriveItem[] {
	const withoutItem = prev.filter(i => i.data.uuid !== item.data.uuid)

	return favorited ? [...withoutItem, item] : withoutItem
}

export async function favorite({ item, favorited, signal }: { item: DriveItem; favorited: boolean; signal?: AbortSignal }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	if (item.data.favorited === favorited) {
		return item
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const modifiedItem = await authedSdkClient.setFavorite(
		item.type === "directory" ? new NonRootNormalItem.Dir(item.data) : new NonRootNormalItem.File(item.data),
		favorited,
		toSignalOpts(signal)
	)

	if (modifiedItem.tag === NonRootNormalItem_Tags.Dir) {
		item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedItem.inner[0]))
	} else {
		item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedItem.inner[0]))
	}

	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	// Sync persistent caches — `favorited` flag changed on the raw Dir/File.
	if (item.type === "directory" && modifiedItem.tag === NonRootNormalItem_Tags.Dir) {
		cache.cacheNewNormalDir(modifiedItem.inner[0], item)
	} else if (item.type === "file" && modifiedItem.tag === NonRootNormalItem_Tags.File) {
		cache.cacheNewFile(modifiedItem.inner[0], item)
	}

	const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

	if (unwrappedParentUuid) {
		driveItemsQueryUpdateGlobal({
			parentUuid: unwrappedParentUuid,
			updater: prev => prev.map(i => (i.data.uuid === item.data.uuid ? item : i))
		})
	}

	driveItemsQueryUpdate({
		params: {
			path: {
				type: "favorites",
				uuid: null
			}
		},
		updater: prev => favoritesListingUpdater(prev, item, favorited)
	})

	return item
}

export async function rename({ item, newName, signal }: { item: DriveItem; newName: string; signal?: AbortSignal }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	if (item.data.decryptedMeta?.name === newName || newName.trim().length === 0) {
		return item
	}

	const { authedSdkClient } = await auth.getSdkClients()

	const modifiedItem =
		item.type === "directory"
			? await authedSdkClient.updateDirMetadata(
					item.data,
					{
						name: newName,
						created: undefined
					},
					toSignalOpts(signal)
				)
			: await authedSdkClient.updateFileMetadata(
					item.data,
					{
						name: newName,
						mime: undefined,
						lastModified: undefined,
						created: CreatedTime.Keep.new()
					},
					toSignalOpts(signal)
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

	// Sync persistent caches — name (decryptedMeta) changed on the raw Dir/File.
	if (item.type === "file" && "region" in modifiedItem) {
		cache.cacheNewFile(modifiedItem, item)
	} else if (item.type === "directory" && !("region" in modifiedItem)) {
		cache.cacheNewNormalDir(modifiedItem, item)
	}

	const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

	if (unwrappedParentUuid) {
		driveItemsQueryUpdateGlobal({
			parentUuid: unwrappedParentUuid,
			updater: prev => prev.map(i => (i.data.uuid === item.data.uuid ? item : i))
		})
	}

	return item
}

export async function setDirColor({ item, color, signal }: { item: DriveItem; color: DirColor; signal?: AbortSignal }) {
	if (item.type !== "directory") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const modifiedDir = await authedSdkClient.setDirColor(item.data, color, toSignalOpts(signal))

	item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedDir))

	if (item.type !== "directory") {
		throw new Error("Invalid item type")
	}

	// Sync persistent caches — `color` changed on the raw Dir.
	cache.cacheNewNormalDir(modifiedDir, item)

	const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

	if (unwrappedParentUuid) {
		driveItemsQueryUpdateGlobal({
			parentUuid: unwrappedParentUuid,
			updater: prev => prev.map(i => (i.data.uuid === item.data.uuid ? item : i))
		})
	}

	return item
}

export async function updateTimestamps({
	item,
	created,
	modified,
	signal
}: {
	item: DriveItem
	created?: number
	modified?: number
	signal?: AbortSignal
}) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	const modifiedItem =
		item.type === "directory"
			? await authedSdkClient.updateDirMetadata(
					item.data,
					{
						name: undefined,
						created: created !== undefined ? BigInt(created) : undefined
					},
					toSignalOpts(signal)
				)
			: await authedSdkClient.updateFileMetadata(
					item.data,
					{
						name: undefined,
						mime: undefined,
						lastModified: modified !== undefined ? BigInt(modified) : undefined,
						created: created !== undefined ? CreatedTime.Set.new(BigInt(created)) : CreatedTime.Keep.new()
					},
					toSignalOpts(signal)
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

	// Sync persistent caches — timestamps changed on the raw Dir/File.
	if (item.type === "file" && "region" in modifiedItem) {
		cache.cacheNewFile(modifiedItem, item)
	} else if (item.type === "directory" && !("region" in modifiedItem)) {
		cache.cacheNewNormalDir(modifiedItem, item)
	}

	const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

	if (unwrappedParentUuid) {
		driveItemsQueryUpdateGlobal({
			parentUuid: unwrappedParentUuid,
			updater: prev => prev.map(i => (i.data.uuid === item.data.uuid ? item : i))
		})
	}

	return item
}
