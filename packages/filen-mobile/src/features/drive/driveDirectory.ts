import auth from "@/lib/auth"
import { AnyNormalDir, NonRootItem_Tags } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { unwrapDirMeta, unwrapFileMeta, unwrapParentUuid, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { normalizeFilePathForSdk } from "@/lib/paths"
import { driveItemsQueryUpdateForNormalParent } from "@/features/drive/queries/useDriveItems.query"
import cache from "@/lib/cache"

export async function createDirectory({
	parent,
	signal,
	name
}: {
	parent: DriveItem | "root" | AnyNormalDir
	signal?: AbortSignal
	name: string
}) {
	if (!AnyNormalDir.instanceOf(parent) && parent !== "root" && parent.type !== "directory") {
		throw new Error("Invalid parent type")
	}

	const { authedSdkClient } = await auth.getSdkClients()
	let parentDir: AnyNormalDir | null = AnyNormalDir.instanceOf(parent) ? parent : null

	if (!parentDir && !AnyNormalDir.instanceOf(parent)) {
		if (parent === "root" || parent.data.uuid === authedSdkClient.root().uuid) {
			parentDir = new AnyNormalDir.Root(authedSdkClient.root())
		} else {
			const dir = cache.directoryUuidToAnyNormalDir.get(parent.data.uuid)

			if (!dir) {
				throw new Error("Parent not found in cache")
			}

			parentDir = dir
		}
	}

	if (!parentDir) {
		throw new Error("Parent directory not found")
	}

	const createdDir = await authedSdkClient.createDir(
		parentDir,
		name,
		signal
			? {
					signal
				}
			: undefined
	)

	const createdDriveItem = unwrappedDirIntoDriveItem(unwrapDirMeta(createdDir))

	if (createdDriveItem.type !== "directory") {
		throw new Error("Invalid item type")
	}

	cache.cacheNewNormalDir(createdDir, createdDriveItem)

	driveItemsQueryUpdateForNormalParent({
		parentUuid: parentDir.inner[0].uuid,
		updater: prev => [
			...prev.filter(
				i =>
					i.data.uuid !== createdDriveItem.data.uuid &&
					i.data.decryptedMeta?.name.toLowerCase().trim() !== createdDriveItem.data.decryptedMeta?.name.toLowerCase().trim()
			),
			createdDriveItem
		]
	})

	return createdDriveItem
}

export async function move({
	item,
	newParent,
	signal
}: {
	item: DriveItem
	newParent: DriveItem | "root" | AnyNormalDir
	signal?: AbortSignal
}) {
	if (!AnyNormalDir.instanceOf(newParent) && newParent !== "root" && newParent.type !== "directory") {
		throw new Error("Invalid parent type")
	}

	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)
	const oldItemUuid = `${item.data.uuid}`
	const { authedSdkClient } = await auth.getSdkClients()
	let newParentDir: AnyNormalDir | null = AnyNormalDir.instanceOf(newParent) ? newParent : null

	if (!newParentDir && !AnyNormalDir.instanceOf(newParent)) {
		if (newParent === "root" || newParent.data.uuid === authedSdkClient.root().uuid) {
			newParentDir = new AnyNormalDir.Root(authedSdkClient.root())
		} else {
			const dir = cache.directoryUuidToAnyNormalDir.get(newParent.data.uuid)

			if (!dir) {
				throw new Error("New parent not found in cache")
			}

			newParentDir = dir
		}
	}

	if (!newParentDir) {
		throw new Error("New parent directory not found")
	}

	if (unwrappedParentUuidPrevious === newParentDir.inner[0].uuid) {
		return item
	}

	const modifiedItem =
		item.type === "directory"
			? await authedSdkClient.moveDir(
					item.data,
					newParentDir,
					signal
						? {
								signal
							}
						: undefined
				)
			: await authedSdkClient.moveFile(
					item.data,
					newParentDir,
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

	// Refresh persistent caches with the moved item (its parent changed).
	if (item.type === "file" && "region" in modifiedItem) {
		cache.cacheNewFile(modifiedItem, item)
	} else if (item.type === "directory" && !("region" in modifiedItem)) {
		cache.cacheNewNormalDir(modifiedItem, item)
	}

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

export async function findItemMatchesForName({ name, signal }: { name: string; signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	const result = await authedSdkClient.findItemMatchesForName(
		name.trim().toLowerCase(),
		signal
			? {
					signal
				}
			: undefined
	)

	return result
		.map(({ item, path }) => {
			if (item.tag !== NonRootItem_Tags.NormalDir && item.tag !== NonRootItem_Tags.File) {
				return null
			}

			return {
				item:
					item.tag === NonRootItem_Tags.NormalDir
						? unwrappedDirIntoDriveItem(unwrapDirMeta(item.inner[0]))
						: unwrappedFileIntoDriveItem(unwrapFileMeta(item.inner[0])),
				path: normalizeFilePathForSdk(path)
			}
		})
		.filter(
			(
				i
			): i is {
				item: DriveItem
				path: string
			} => i !== null
		)
}
