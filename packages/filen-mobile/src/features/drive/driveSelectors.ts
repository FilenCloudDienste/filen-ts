import type { DriveItem, DriveItemFileExtracted, DriveItemDirectoryExtracted } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import type { PreviewType } from "@/lib/previewType"
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

// Whether the drive screen renders on the BASE background (bg-background — the main drive tab) rather
// than the secondary background used by every other variant (favorites/shared/links/offline/recents +
// the driveSelect picker, which are modal-presented). Single source of truth for the screen bg AND for
// any raised surface on it: the grid card sits one elevation step above — secondary on the base-bg tab,
// tertiary on the secondary-bg screens — so it never blends into the screen.
export function driveScreenUsesBaseBackground(drivePath: DrivePath): boolean {
	return drivePath.type === "drive" && !drivePath.selectOptions
}

export function isDirectoryItem(item: DriveItem): item is DriveItemDirectoryExtracted {
	return DIRECTORY_TYPES.has(item.type)
}

/**
 * Predicate used when inserting an incoming item into a cached parent listing: keeps an
 * existing row unless it is the SAME item (uuid match) or a same-name duplicate that the
 * incoming item supersedes (case-insensitive, trimmed).
 *
 * The name half only fires when BOTH names are actually present. Undecryptable items carry
 * `decryptedMeta === null` (so their name is `undefined`); comparing `undefined !== undefined`
 * used to collapse to a name "match", evicting every undecryptable sibling whenever any
 * undecryptable item arrived. Guarding on presence keeps unrelated undecryptable rows.
 */
export function keepAgainstIncomingDriveItem(existing: DriveItem, incomingUuid: string, incomingName: string | undefined): boolean {
	if (existing.data.uuid === incomingUuid) {
		return false
	}

	const existingName = existing.data.decryptedMeta?.name.toLowerCase().trim()
	const normalizedIncomingName = incomingName?.toLowerCase().trim()

	if (existingName !== undefined && normalizedIncomingName !== undefined && existingName === normalizedIncomingName) {
		return false
	}

	return true
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
	previewType
}: {
	item: DriveItem
	drivePath: DrivePath
	previewType: PreviewType | null
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

			// Single-select no longer disables the other rows once something is picked —
			// ticking another row REPLACES the pick (nextDriveSelectSelection), which also
			// keeps a preseeded current value (initiallySelected) changeable in one tap.
			return false
		}
	}
}

// Pure reducer for a select-intention checkbox tap: untick clears the entry, ticking
// appends for multi-select and REPLACES the previous pick for single-select. Single
// source for the row checkbox handler so the semantics stay testable.
export function nextDriveSelectSelection({
	prev,
	item,
	type
}: {
	prev: DriveItem[]
	item: DriveItem
	type: "single" | "multiple"
}): DriveItem[] {
	const prevSelected = prev.some(i => i.data.uuid === item.data.uuid && i.type === item.type)

	if (prevSelected) {
		return prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
	}

	if (type === "single") {
		return [item]
	}

	return [...prev, item]
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
