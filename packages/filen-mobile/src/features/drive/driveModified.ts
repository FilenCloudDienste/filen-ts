import type { Dir, File } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { unwrapDirMeta, unwrapFileMeta, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import cache from "@/lib/cache"

type DirectoryItem = Extract<DriveItem, { type: "directory" }>
type FileItem = Extract<DriveItem, { type: "file" }>

/**
 * Turn the own Dir/File an SDK mutation returned into its DriveItem and refresh the persistent
 * caches with the raw object.
 */
export function itemFromModified(modified: Dir): DirectoryItem
export function itemFromModified(modified: File): FileItem
export function itemFromModified(modified: Dir | File): DirectoryItem | FileItem
export function itemFromModified(modified: Dir | File): DirectoryItem | FileItem {
	if ("region" in modified) {
		const item = unwrappedFileIntoDriveItem(unwrapFileMeta(modified))

		if (item.type !== "file") {
			throw new Error("Invalid item type")
		}

		cache.cacheNewFile(modified, item)

		return item
	}

	const item = unwrappedDirIntoDriveItem(unwrapDirMeta(modified))

	if (item.type !== "directory") {
		throw new Error("Invalid item type")
	}

	cache.cacheNewNormalDir(modified, item)

	return item
}
