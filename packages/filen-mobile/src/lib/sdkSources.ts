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

export function driveItemToAnyDirWithContext(item: DriveItemDirectoryExtracted): AnyDirWithContext {
	switch (item.type) {
		case "directory": {
			return new AnyDirWithContext.Normal(new AnyNormalDir.Dir(item.data))
		}

		case "sharedDirectory": {
			const parentUuid = unwrapParentUuid(item.data.inner.parent)

			if (!parentUuid) {
				throw new Error("Shared directory is missing parent information.")
			}

			// TC-06: resolve the share context for THIS child directory. We need a SharingRole; the
			// listing path stamps the parent's role onto the child both as the cached parent's
			// shareInfo AND (when present) directly on item.data.sharingRole. Prefer the cached
			// parent, then fall back to the item's own sharingRole, so a cold start / restored route
			// param / evicted cache no longer hard-fails when the role is still recoverable from the
			// item — mirroring offlineHelpers, which resolves the same miss gracefully.
			const shareInfo = cache.directoryUuidToAnySharedDirWithContext.get(parentUuid)?.shareInfo ?? item.data.sharingRole

			if (!shareInfo) {
				// Neither the cached parent nor the item carries the share context. This is genuinely
				// recoverable — re-opening the shared parent in the drive repopulates the cache — but
				// resolving it here would require an extra SDK round-trip the silent transfer layer
				// deliberately avoids; a clearer retryable message is the sanctioned minimum.
				throw new Error("Shared directory is missing its share context. Open the shared directory once, then retry.")
			}

			// Target the shared directory ITSELF (item.data), borrowing only the shareInfo resolved
			// above — mirrors offline.ts findParentAnyDirWithContext. Wrapping the parent's
			// AnySharedDirWithContext directly would target the PARENT's (larger) tree instead of
			// this child directory.
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
