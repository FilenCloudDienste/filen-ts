import { AnyDirWithContext, AnyFile, AnyNormalDir, AnySharedDir, AnySharedDirWithContext } from "@filen/sdk-rs"
import type { DriveItem, DriveItemDirectoryExtracted } from "@/types"
import cache from "@/lib/cache"
import { unwrapParentUuid } from "@/lib/sdkUnwrap"

// DriveItem → the SDK's own source values, one definition for downloads, thumbnails and copies.

export function driveItemToAnyFile(item: DriveItem): AnyFile | null {
	switch (item.type) {
		case "file": {
			return new AnyFile.File(item.data)
		}

		case "sharedFile":
		case "sharedRootFile": {
			return new AnyFile.Shared(item.data)
		}

		default: {
			return null
		}
	}
}

// Null when a shared directory's role is unrecoverable; see driveItemToAnyDirWithContext for the throwing variant.
export function tryDriveItemToAnyDirWithContext(item: DriveItemDirectoryExtracted): AnyDirWithContext | null {
	switch (item.type) {
		case "directory": {
			return new AnyDirWithContext.Normal(new AnyNormalDir.Dir(item.data))
		}

		case "sharedDirectory": {
			const parentUuid = unwrapParentUuid(item.data.inner.parent)

			if (!parentUuid) {
				return null
			}

			// The listing stamps the parent's role onto the child both as the cached parent's shareInfo and
			// on item.data.sharingRole; the latter survives a cold start, restored route param or evicted cache.
			const shareInfo = cache.directoryUuidToAnySharedDirWithContext.get(parentUuid)?.shareInfo ?? item.data.sharingRole

			if (!shareInfo) {
				return null
			}

			// Target the child itself, borrowing only the role; wrapping the parent's context would target the parent's tree.
			return new AnyDirWithContext.Shared(
				AnySharedDirWithContext.new({
					dir: new AnySharedDir.Dir(item.data),
					shareInfo
				})
			)
		}

		case "sharedRootDirectory": {
			return new AnyDirWithContext.Shared(
				AnySharedDirWithContext.new({
					dir: new AnySharedDir.Root(item.data),
					shareInfo: item.data.sharingRole
				})
			)
		}
	}
}

export function driveItemToAnyDirWithContext(item: DriveItemDirectoryExtracted): AnyDirWithContext {
	const context = tryDriveItemToAnyDirWithContext(item)

	if (!context) {
		// Recoverable by re-opening the shared parent (repopulates the cache); resolving it here would cost an SDK round-trip.
		throw new Error("Shared directory is missing its share context. Open the shared directory once, then retry.")
	}

	return context
}
