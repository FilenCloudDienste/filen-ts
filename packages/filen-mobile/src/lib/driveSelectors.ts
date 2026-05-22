import type { DriveItem } from "@/types"
import { EXPO_IMAGE_SUPPORTED_EXTENSIONS, EXPO_VIDEO_SUPPORTED_EXTENSIONS } from "@/constants"

// Local extension check — kept inline (rather than calling getPreviewType
// from src/lib/utils) so this module doesn't pull in the SDK at test time.
function isImageOrVideoExtension(name: string): boolean {
	const trimmed = name.trim().toLowerCase()
	const dot = trimmed.lastIndexOf(".")
	const ext = dot >= 0 ? trimmed.slice(dot) : ""

	return EXPO_IMAGE_SUPPORTED_EXTENSIONS.has(ext) || EXPO_VIDEO_SUPPORTED_EXTENSIONS.has(ext)
}

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
	/**
	 * True iff every selected item is a file AND its decryptedMeta resolves
	 * to an image or video preview type. Gates the Save-to-photos bulk
	 * action (the OS photo library only accepts those two media types).
	 */
	everyImageOrVideoFile: boolean
}

export const EMPTY_DRIVE_FLAGS: DriveSelectionFlags = Object.freeze({
	count: 0,
	includesFavorited: false,
	everyFile: false,
	everyDirectory: false,
	everyImageOrVideoFile: false
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
	let everyImageOrVideoFile = true

	for (let i = 0; i < items.length; i++) {
		const it = items[i]!

		// SharedRoot* item types don't carry a `favorited` field — guard the access.
		if ("favorited" in it.data && it.data.favorited) {
			includesFavorited = true
		}

		const isFile = FILE_TYPES.has(it.type)

		if (!isFile) {
			everyFile = false
			everyImageOrVideoFile = false
		} else {
			const name = it.data.decryptedMeta?.name

			if (!name || !isImageOrVideoExtension(name)) {
				everyImageOrVideoFile = false
			}
		}

		if (!DIRECTORY_TYPES.has(it.type)) {
			everyDirectory = false
		}
	}

	return {
		count: items.length,
		includesFavorited,
		everyFile,
		everyDirectory,
		everyImageOrVideoFile
	}
}
