import auth from "@/lib/auth"
import type { AnyNormalDir } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { unwrapParentUuid } from "@/lib/sdkUnwrap"
import { itemFromModified } from "@/features/drive/driveModified"
import { driveItemsQueryUpdateForNormalParent, driveItemsQueryRemoveDirectoryFromPhotos } from "@/features/drive/queries/useDriveItems.query"
import socketCreateBatcher from "@/features/drive/socketCreateBatcher"
import { markDirectorySizesStale } from "@/features/drive/queries/useDirectorySize.query"
import { upsertItem } from "@filen/shared"
import events from "@/lib/events"
import { toSignalOpts } from "@/lib/signals"

export async function createDirectory({
	parent,
	signal,
	name
}: {
	parent: AnyNormalDir
	signal?: AbortSignal
	name: string
}) {
	const { authedSdkClient } = await auth.getSdkClients()
	const createdDir = await authedSdkClient.createDir(
		parent,
		name,
		toSignalOpts(signal)
	)

	const createdDriveItem = itemFromModified(createdDir)

	markDirectorySizesStale()

	driveItemsQueryUpdateForNormalParent({
		parentUuid: parent.inner[0].uuid,
		updater: prev => upsertItem(prev, createdDriveItem)
	})

	return createdDriveItem
}

export async function move({ item, newParent }: { item: DriveItem; newParent: AnyNormalDir }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)
	const oldItemUuid = `${item.data.uuid}`

	if (unwrappedParentUuidPrevious === newParent.inner[0].uuid) {
		return item
	}

	const { authedSdkClient } = await auth.getSdkClients()

	const modifiedItem =
		item.type === "directory"
			? await authedSdkClient.moveDir(item.data, newParent)
			: await authedSdkClient.moveFile(item.data, newParent)

	item = itemFromModified(modifiedItem)

	markDirectorySizesStale()
	// A queued create of this item must not land in its old parent after the removal below.
	socketCreateBatcher.flushNow()

	if (unwrappedParentUuidPrevious) {
		driveItemsQueryUpdateForNormalParent({
			parentUuid: unwrappedParentUuidPrevious,
			updater: prev => prev.filter(i => i.data.uuid !== oldItemUuid)
		})
	}

	const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

	if (unwrappedParentUuid) {
		driveItemsQueryUpdateForNormalParent({
			parentUuid: unwrappedParentUuid,
			updater: prev => upsertItem(prev, item)
		})

		if (item.type === "directory") {
			driveItemsQueryRemoveDirectoryFromPhotos({
				dirUuid: item.data.uuid,
				newParentUuid: unwrappedParentUuid,
				previousParentUuid: unwrappedParentUuidPrevious
			})
		}
	}

	// Re-point an open drive preview to the moved item. A move keeps the uuid but
	// changes the parent, so this refreshes the preview's item — its own save then
	// targets the new directory instead of the stale original one.
	events.emit("driveItemUpdated", {
		previousUuid: oldItemUuid,
		item
	})

	return item
}
