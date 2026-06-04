import type { DriveItem, DriveItemFileExtracted, DriveItemDirectoryExtracted } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import type { PreviewType } from "@/lib/utils"
import { EXPO_IMAGE_SUPPORTED_EXTENSIONS, EXPO_VIDEO_SUPPORTED_EXTENSIONS } from "@/constants"
import { serialize } from "@/lib/serializer"

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
	/**
	 * True iff any selected item is undecryptable. Gates bulk actions that
	 * require decrypted metadata (download, share, rename, move, favorite,
	 * etc.) so the toolbar can downgrade to a minimal Trash-only mode.
	 */
	includesUndecryptable: boolean
}

export const EMPTY_DRIVE_FLAGS: DriveSelectionFlags = Object.freeze({
	count: 0,
	includesFavorited: false,
	everyFile: false,
	everyDirectory: false,
	everyImageOrVideoFile: false,
	includesUndecryptable: false
}) as DriveSelectionFlags

export const FILE_TYPES = new Set<DriveItem["type"]>(["file", "sharedFile", "sharedRootFile"])
export const DIRECTORY_TYPES = new Set<DriveItem["type"]>(["directory", "sharedDirectory", "sharedRootDirectory"])

// Narrowing type guards backed by the discriminant sets above. `Set.has()` alone
// returns a plain boolean (no narrowing), so call sites that subsequently touch
// file-only meta (mime/size/modified) use these instead of the bare `.has()`.
export function isFileItem(item: DriveItem): item is DriveItemFileExtracted {
	return FILE_TYPES.has(item.type)
}

export function isDirectoryItem(item: DriveItem): item is DriveItemDirectoryExtracted {
	return DIRECTORY_TYPES.has(item.type)
}

export function aggregateDriveSelectionFlags(items: readonly DriveItem[]): DriveSelectionFlags {
	if (items.length === 0) {
		return EMPTY_DRIVE_FLAGS
	}

	let includesFavorited = false
	let everyFile = true
	let everyDirectory = true
	let everyImageOrVideoFile = true
	let includesUndecryptable = false

	for (let i = 0; i < items.length; i++) {
		const it = items[i]!

		// SharedRoot* item types don't carry a `favorited` field — guard the access.
		if ("favorited" in it.data && it.data.favorited) {
			includesFavorited = true
		}

		if (it.data.undecryptable === true) {
			includesUndecryptable = true
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
		everyImageOrVideoFile,
		includesUndecryptable
	}
}

/**
 * Whether a Drive row is non-interactive for the active picker (`selectOptions`).
 * Returns false outside picker mode (normal browsing never disables rows here).
 *
 * Mirrors the per-row gating in the picker:
 *   - move : undecryptable items + the very items being moved are invalid targets.
 *   - select: undecryptable items, type/previewType mismatches, already-selected
 *             source items, and (single-select) any row once another is picked.
 *
 * `previewType` is supplied by the caller (computed via getPreviewType over the
 * decrypted name) so this module stays SDK-free for testing.
 */
export function isDriveItemDisabled({
	item,
	drivePath,
	previewType,
	selectedFromDriveSelectCount,
	isSelectedFromDriveSelect
}: {
	item: DriveItem
	drivePath: DrivePath
	previewType: PreviewType | null
	selectedFromDriveSelectCount: number
	isSelectedFromDriveSelect: boolean
}): boolean {
	if (!drivePath.selectOptions) {
		return false
	}

	switch (drivePath.selectOptions.intention) {
		case "move": {
			// Undecryptable items can't be valid move/copy destinations — we
			// don't know what they are, and the SDK can't act on them either.
			if (item.data.undecryptable) {
				return true
			}

			return drivePath.selectOptions.items.some(i => i.data.uuid === item.data.uuid)
		}

		case "select": {
			// Undecryptable items aren't valid picks for any select intent —
			// we can't know whether they'd satisfy file/directory or previewType filters.
			if (item.data.undecryptable) {
				return true
			}

			const allowedItemTypes: ("file" | "directory")[] = []

			if (drivePath.selectOptions.files) {
				allowedItemTypes.push("file")
			}

			if (drivePath.selectOptions.directories) {
				allowedItemTypes.push("directory")
			}

			const normalizeItemType = DIRECTORY_TYPES.has(item.type) ? "directory" : "file"

			if (
				!allowedItemTypes.includes(normalizeItemType) ||
				(drivePath.selectOptions.previewType && drivePath.selectOptions.previewType !== previewType) ||
				drivePath.selectOptions.items.some(i => i.data.uuid === item.data.uuid)
			) {
				return true
			}

			switch (drivePath.selectOptions.type) {
				case "single": {
					return selectedFromDriveSelectCount > 0 && !isSelectedFromDriveSelect
				}

				case "multiple": {
					return false
				}
			}
		}
	}
}

/**
 * True when the row is "disabled" only because the caller's selectOptions exclude
 * directories (e.g. files-only picker), but the item itself is a directory the user
 * must still be able to navigate into. Selection stays blocked; row-tap navigates.
 */
export function isDriveItemNavigateOnly({
	item,
	drivePath,
	disabled
}: {
	item: DriveItem
	drivePath: DrivePath
	disabled: boolean
}): boolean {
	if (!disabled || !drivePath.selectOptions) {
		return false
	}

	if (drivePath.selectOptions.intention !== "select") {
		return false
	}

	if (drivePath.selectOptions.directories) {
		return false
	}

	return DIRECTORY_TYPES.has(item.type)
}

/**
 * Resolves the router target for navigating INTO a directory row, keyed off the
 * current drive variant. Returns null when the item isn't a navigable directory
 * (files, trash view, or a linked view missing its `linked` payload).
 *
 * The returned object is a valid expo-router `Href` for `router.push`.
 */
export function resolveDriveNavigationTarget({ item, drivePath }: { item: DriveItem; drivePath: DrivePath }) {
	if (!DIRECTORY_TYPES.has(item.type) || drivePath.type === "trash") {
		return null
	}

	if (drivePath.type === "offline") {
		return {
			pathname: "/offline/[uuid]" as const,
			params: {
				uuid: item.data.uuid
			}
		}
	}

	if (drivePath.type === "sharedIn") {
		return {
			pathname: "/sharedIn/[uuid]" as const,
			params: {
				uuid: item.data.uuid
			}
		}
	}

	if (drivePath.type === "sharedOut") {
		return {
			pathname: "/sharedOut/[uuid]" as const,
			params: {
				uuid: item.data.uuid
			}
		}
	}

	if (drivePath.type === "favorites") {
		return {
			pathname: "/favorites/[uuid]" as const,
			params: {
				uuid: item.data.uuid
			}
		}
	}

	if (drivePath.type === "links") {
		return {
			pathname: "/links/[uuid]" as const,
			params: {
				uuid: item.data.uuid
			}
		}
	}

	if (drivePath.selectOptions) {
		return {
			pathname: "/driveSelect/[uuid]" as const,
			params: {
				uuid: item.data.uuid,
				selectOptions: serialize(drivePath.selectOptions)
			}
		}
	}

	if (drivePath.type === "linked") {
		if (!drivePath.linked) {
			return null
		}

		return {
			pathname: "/linkedDir/[uuid]" as const,
			params: {
				uuid: item.data.uuid,
				linked: serialize(drivePath.linked)
			}
		}
	}

	return {
		pathname: "/tabs/drive/[uuid]" as const,
		params: {
			uuid: item.data.uuid
		}
	}
}
