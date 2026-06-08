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
 * There are exactly TWO iterations (0 and 1), and that is the maximum
 * possible here: the only deterministic inputs available are the asset's
 * name and creationTime, so iteration 0 (creationTime) and iteration 1
 * (hash of name+creationTime) exhaust the distinct suffixes derivable
 * from that fixed input. A third strategy would have to reuse the same
 * data and could not produce a new path — so callers should treat 2 as
 * the hard cap, NOT extend the switch. If two assets genuinely share the
 * same name AND creationTime they are indistinguishable and collapse to
 * the same slot by design (deterministic dedup across syncs).
 *
 * Returns null for iteration >= 2 (exhausted) or when the path is invalid.
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

// Toggle the "after activation" camera-upload setting while keeping
// `activationTimestamp` consistent. Enabling stamps `now` so `listLocal`'s
// `gte(CREATION_TIME, activationTimestamp)` filter only matches assets created
// from this moment on; disabling resets it to 0 so the filter is inert.
// `now` is injected (rather than calling Date.now() here) so the transform
// stays pure and deterministically testable.
export function applyAfterActivationToggle<T extends { afterActivation: boolean; activationTimestamp: number }>({
	config,
	enabled,
	now
}: {
	config: T
	enabled: boolean
	now: number
}): T {
	return {
		...config,
		afterActivation: enabled,
		activationTimestamp: enabled ? now : 0
	}
}
