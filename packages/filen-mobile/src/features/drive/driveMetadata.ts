import auth from "@/lib/auth"
import { CreatedTime, DirColor, NonRootNormalItem, NonRootNormalItem_Tags } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { unwrapDirMeta, unwrapFileMeta, unwrapParentUuid, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { driveItemsQueryUpdateGlobal, driveItemsQueryUpdate } from "@/features/drive/queries/useDriveItems.query"
import cache from "@/lib/cache"
import events from "@/lib/events"
import { applyMembershipPatch } from "@filen/shared"

/**
 * Optimistic updater for the root Favorites listing (`{ type: "favorites", uuid: null }`).
 * When `favorited` is true, insert/refresh the item; when false, remove it.
 * `driveItemsQueryUpdateGlobal` only `.map()`s existing rows, so it can never
 * ADD a newly-favorited item to the Favorites listing — this closes that gap.
 */
export function favoritesListingUpdater(prev: DriveItem[], item: DriveItem, favorited: boolean): DriveItem[] {
	return applyMembershipPatch(prev, item, favorited)
}

export async function favorite({ item, favorited }: { item: DriveItem; favorited: boolean }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	if (item.data.favorited === favorited) {
		return item
	}

	// Capture before the SDK reassigns `item`: an open preview matches by the uuid
	// it currently holds. (favorite keeps the uuid, but capturing first stays
	// correct and consistent with move/restoreFileVersion regardless.)
	const previousUuid = item.data.uuid

	const { authedSdkClient } = await auth.getSdkClients()
	const modifiedItem = await authedSdkClient.setFavorite(
		item.type === "directory" ? new NonRootNormalItem.Dir(item.data) : new NonRootNormalItem.File(item.data),
		favorited
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

	// Refresh an open preview showing this file (favorite badge in the header).
	events.emit("driveItemUpdated", {
		previousUuid,
		item
	})

	return item
}

export async function rename({ item, newName }: { item: DriveItem; newName: string }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	if (item.data.decryptedMeta?.name === newName || newName.trim().length === 0) {
		return item
	}

	// Capture before the SDK reassigns `item` (see favorite above).
	const previousUuid = item.data.uuid

	const { authedSdkClient } = await auth.getSdkClients()

	const modifiedItem =
		item.type === "directory"
			? await authedSdkClient.updateDirMetadata(item.data, {
					name: newName,
					created: CreatedTime.Keep.new()
				})
			: await authedSdkClient.updateFileMetadata(item.data, {
					name: newName,
					mime: undefined,
					lastModified: undefined,
					created: CreatedTime.Keep.new()
				})

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

	// Refresh an open preview showing this file (new name in the header).
	events.emit("driveItemUpdated", {
		previousUuid,
		item
	})

	return item
}

export async function setDirColor({ item, color }: { item: DriveItem; color: DirColor }) {
	if (item.type !== "directory") {
		throw new Error("Invalid item type")
	}

	// Capture before reassignment — the uuid may rotate on a metadata write.
	const previousUuid = item.data.uuid

	const { authedSdkClient } = await auth.getSdkClients()
	const modifiedDir = await authedSdkClient.setDirColor(item.data, color)

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

	// Self-heal an open preview + an active subtree cache-search (Effect D replaces the
	// row by previousUuid and clears any tombstone) — color changed in place.
	events.emit("driveItemUpdated", {
		previousUuid,
		item
	})

	return item
}
