import { type DriveItem } from "@/features/drive/lib/item"

// Aggregated flags for a Drive multi-selection, computed in a single pass — the bulk-action bar's
// only source of gating truth (directoryListing.tsx computes this once per render from
// `selectedItems`, React Compiler memoizes). Mirrors filen-mobile's driveSelectors.ts
// DriveSelectionFlags/aggregateDriveSelectionFlags; `everyFile`/`everyDirectory` match only the two
// BASE arms (a shared item's own type, e.g. sharedRootFile, counts as neither) — there is no
// save-to-photos surface here, so mobile's `everyImageOrVideoFile` has no web counterpart.
export interface DriveSelectionFlags {
	count: number
	// True iff any selected item is favorited. Drives the bulk Favorite/Unfavorite button's label and
	// the SET value it applies to the whole selection (see setFavoritedItems).
	includesFavorited: boolean
	everyFile: boolean
	everyDirectory: boolean
	// True iff any selected item is undecryptable. Gates bulk actions that need decrypted metadata
	// (favorite, move) — trash/restore/delete stay available, since those only need each item's uuid.
	includesUndecryptable: boolean
	// True iff every selected item is a shared-root arm (sharedRootDirectory/sharedRootFile) — the
	// only two arms removeSharedItem accepts, since only their shareSource is a SharedRootItem (see
	// item.ts's shareSource retention). Drives the bulk Unshare button's gate, mirroring the per-item
	// menu's own item.type check (item-menu.logic.ts).
	everySharedRoot: boolean
}

// Returned by reference (not rebuilt) for an empty selection, mirroring mobile's EMPTY_DRIVE_FLAGS —
// lets a caller compare against this exact constant instead of re-deriving "nothing selected".
const EMPTY_DRIVE_SELECTION_FLAGS: DriveSelectionFlags = Object.freeze({
	count: 0,
	includesFavorited: false,
	everyFile: false,
	everyDirectory: false,
	includesUndecryptable: false,
	everySharedRoot: false
})

export function aggregateDriveSelectionFlags(items: readonly DriveItem[]): DriveSelectionFlags {
	if (items.length === 0) {
		return EMPTY_DRIVE_SELECTION_FLAGS
	}

	let includesFavorited = false
	let everyFile = true
	let everyDirectory = true
	let includesUndecryptable = false
	let everySharedRoot = true

	for (const item of items) {
		if (item.data.favorited) {
			includesFavorited = true
		}

		if (item.data.undecryptable) {
			includesUndecryptable = true
		}

		if (item.type !== "file") {
			everyFile = false
		}

		if (item.type !== "directory") {
			everyDirectory = false
		}

		if (item.type !== "sharedRootDirectory" && item.type !== "sharedRootFile") {
			everySharedRoot = false
		}
	}

	return { count: items.length, includesFavorited, everyFile, everyDirectory, includesUndecryptable, everySharedRoot }
}
