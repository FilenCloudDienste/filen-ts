import * as FileSystem from "expo-file-system"
import { xxHash32 } from "js-xxhash"
import { normalizeFilePathForSdk } from "@/lib/paths"

export type CollisionParams = {
	iteration: number
	path: string
	asset: {
		name: string
		creationTime: number
	}
}

/**
 * Generates a collision-resolved path for a camera upload asset.
 *
 * When multiple assets share the same filename, this function appends
 * a deterministic suffix based on the asset's metadata. The iteration
 * parameter controls which suffix strategy is used:
 *
 *   0 — append creationTime
 *   1 — append hash of name + creationTime
 *
 * Only creationTime is used because modificationTime can change when a
 * file is edited, which would produce different paths across syncs.
 *
 * Returns null when all iterations are exhausted or the path is invalid.
 */
export function modifyAssetPathOnCollision({ iteration, path, asset }: CollisionParams): string | null {
	const ext = FileSystem.Paths.extname(asset.name)
	const basename = FileSystem.Paths.basename(asset.name, ext)
	const parentDir = FileSystem.Paths.dirname(path)

	if (parentDir === "." || basename.length === 0 || parentDir.length === 0 || basename === ".") {
		return null
	}

	switch (iteration) {
		case 0: {
			return normalizeFilePathForSdk(FileSystem.Paths.join(parentDir, `${basename}_${asset.creationTime}${ext}`))
				.toLowerCase()
				.trim()
		}

		case 1: {
			return normalizeFilePathForSdk(
				FileSystem.Paths.join(parentDir, `${basename}_${xxHash32(`${asset.name}_${asset.creationTime}`).toString(16)}${ext}`)
			)
				.toLowerCase()
				.trim()
		}

		default: {
			return null
		}
	}
}

// Strip characters that would split a folder name into multiple path segments
// when joined with a filename. iOS `PHCollection.localIdentifier` (used as
// `Album.id`) has the format "<UUID>/L0/<NNN>" — passing it untreated into
// `FileSystem.Paths.join` would produce extra "/" segments and trip the
// strict `slashCount === 2` check inside `ensureParentDirectoryExists`.
export function sanitizePathSegment(s: string): string {
	return s.replace(/\//g, "_")
}
