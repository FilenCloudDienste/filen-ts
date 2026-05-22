import type { DriveItem } from "@/types"

/**
 * Aggregated flags for a Drive selection, computed in a single pass.
 *
 * Drive has 6 `DriveItem.type` discriminants (`file`, `directory`,
 * `sharedFile`, `sharedDirectory`, `sharedRootFile`, `sharedRootDirectory`)
 * across 8 variants (`drive`, `recents`, `favorites`, `offline`,
 * `sharedIn`, `sharedOut`, `links`, `trash`). Variant-specific gates that
 * depend on `drivePath` (e.g., "root only" for stop-sharing) stay inline
 * at the call site — only per-item aggregation lives here.
 */
export type DriveSelectionFlags = {
	count: number
	includesFavorited: boolean
	everyFile: boolean
	everyDirectory: boolean
}

export const EMPTY_DRIVE_FLAGS: DriveSelectionFlags = Object.freeze({
	count: 0,
	includesFavorited: false,
	everyFile: false,
	everyDirectory: false
}) as DriveSelectionFlags

const FILE_TYPES = new Set<DriveItem["type"]>(["file", "sharedFile", "sharedRootFile"])
const DIRECTORY_TYPES = new Set<DriveItem["type"]>(["directory", "sharedDirectory", "sharedRootDirectory"])

export function aggregateDriveSelectionFlags(items: readonly DriveItem[]): DriveSelectionFlags {
	if (items.length === 0) {
		return EMPTY_DRIVE_FLAGS
	}

	let includesFavorited = false
	let everyFile = true
	let everyDirectory = true

	for (let i = 0; i < items.length; i++) {
		const it = items[i]!

		// SharedRoot* item types don't carry a `favorited` field — guard the access.
		if ("favorited" in it.data && it.data.favorited) {
			includesFavorited = true
		}

		if (!FILE_TYPES.has(it.type)) {
			everyFile = false
		}

		if (!DIRECTORY_TYPES.has(it.type)) {
			everyDirectory = false
		}
	}

	return {
		count: items.length,
		includesFavorited,
		everyFile,
		everyDirectory
	}
}
