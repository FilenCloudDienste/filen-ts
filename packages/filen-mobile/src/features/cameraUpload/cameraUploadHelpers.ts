import * as FileSystem from "expo-file-system"
import { xxHash32 } from "js-xxhash"
import { normalizeFilePathForSdk } from "@/lib/paths"

export type CollisionParams = {
	iteration: number
	path: string
	asset: {
		name: string
		/**
		 * Seconds-normalized creation timestamp used as the stable collision-suffix
		 * identity for this asset.
		 *
		 * Callers supply `String(Math.floor((creationTime ?? 0) / 1000))` on the
		 * local side and `String(Math.floor(Number(meta?.created ?? 0) / 1000))` on
		 * the remote side.  Flooring to seconds absorbs sub-second drift introduced
		 * by the SDK's EXIF-override (which rewrites `meta.created` to
		 * DateTimeOriginal) and by network round-trips, so both trees produce the
		 * same suffix for the same physical asset.
		 *
		 * Null `creationTime` falls back to 0, mirroring the remote side's null-meta
		 * fallback — producing the string `"0"` on both sides symmetrically.
		 */
		contentHash: string
	}
}

/**
 * Generates a collision-resolved path for a camera upload asset.
 *
 * When multiple assets share the same filename, this function appends
 * a deterministic suffix based on the asset's seconds-normalized creation
 * timestamp.  The iteration parameter controls which suffix strategy is used:
 *
 *   0 — append contentHash (seconds-timestamp string) directly
 *   1 — append xxHash32 of name + contentHash
 *
 * Flooring to seconds absorbs sub-second drift from EXIF-override or network
 * round-trips, keeping local and remote trees symmetric across syncs without
 * any per-asset file read at listing time.
 *
 * There are exactly TWO iterations (0 and 1). If two assets genuinely share
 * both the same name AND the same creation second they are indistinguishable
 * and collapse to the same slot by design (deterministic dedup across syncs).
 * Callers should treat 2 as the hard cap, NOT extend the switch.
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
			return normalizeFilePathForSdk(FileSystem.Paths.join(parentDir, `${basename}_${asset.contentHash}${ext}`))
				.toLowerCase()
				.trim()
		}

		case 1: {
			return normalizeFilePathForSdk(
				FileSystem.Paths.join(parentDir, `${basename}_${xxHash32(`${asset.name}_${asset.contentHash}`).toString(16)}${ext}`)
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
