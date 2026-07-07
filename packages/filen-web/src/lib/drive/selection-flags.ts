import { type DriveItem } from "@/lib/drive/item"

// Aggregated flags for a Drive multi-selection, computed in a single pass — the bulk-action bar's
// only source of gating truth (directory-listing.tsx computes this once per render from
// `selectedItems`, React Compiler memoizes). Mirrors filen-mobile's driveSelectors.ts
// DriveSelectionFlags/aggregateDriveSelectionFlags, simplified for web's narrower item shape: a web
// DriveItem is only ever "directory" | "file" (no shared*/offline variants), so `everyFile`/
// `everyDirectory` need no discriminant-set lookup, and there is no save-to-photos surface here, so
// mobile's `everyImageOrVideoFile` has no web counterpart.
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
}

// Returned by reference (not rebuilt) for an empty selection, mirroring mobile's EMPTY_DRIVE_FLAGS —
// lets a caller compare against this exact constant instead of re-deriving "nothing selected".
const EMPTY_DRIVE_SELECTION_FLAGS: DriveSelectionFlags = Object.freeze({
	count: 0,
	includesFavorited: false,
	everyFile: false,
	everyDirectory: false,
	includesUndecryptable: false
})

export function aggregateDriveSelectionFlags(items: readonly DriveItem[]): DriveSelectionFlags {
	if (items.length === 0) {
		return EMPTY_DRIVE_SELECTION_FLAGS
	}

	let includesFavorited = false
	let everyFile = true
	let everyDirectory = true
	let includesUndecryptable = false

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
	}

	return { count: items.length, includesFavorited, everyFile, everyDirectory, includesUndecryptable }
}
