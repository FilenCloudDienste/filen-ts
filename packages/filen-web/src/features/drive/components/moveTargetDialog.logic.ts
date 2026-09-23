import type { DriveItem } from "@/features/drive/lib/item"
import type { DirectoryTreeTarget } from "@/features/drive/components/directoryTreeSubmenu"

// A move destination is illegal for two independent reasons, checked separately so the picker can
// apply them at different points: entering a row (browsing) only ever needs the first, "Move here"
// needs both.

// A directory being moved can never become its own destination, nor can any of its descendants — a
// descendant's ancestry chain always passes through the directory being moved, so testing the WHOLE
// chain for membership catches both cases without telling them apart (both are equally illegal).
// `targetAncestry` is the candidate target's own root-to-target uuid chain, inclusive of the
// candidate itself; an empty chain (root) is never illegal this way — no moved item can BE the root.
export function isMoveDestinationForbidden(targetAncestry: readonly string[], movedItems: readonly DriveItem[]): boolean {
	if (targetAncestry.length === 0) {
		return false
	}

	const movedDirUuids = new Set<string>(movedItems.filter(item => item.type === "directory").map(item => item.data.uuid))

	return targetAncestry.some(uuid => movedDirUuids.has(uuid))
}

// A move that would land every selected item exactly where it already sits — compared against the
// candidate target's OWN currently-listed children (the same rows the picker renders), so this needs
// no root-uuid normalization of its own the way actions.ts's cache patches do.
export function isMoveNoOp(movedItems: readonly DriveItem[], targetListing: readonly DriveItem[]): boolean {
	if (movedItems.length === 0) {
		return false
	}

	const targetUuids = new Set(targetListing.map(item => item.data.uuid))

	return movedItems.every(item => targetUuids.has(item.data.uuid))
}

// Row-level gate while browsing: entering a row is illegal for the same reason moving into it would
// be (self/descendant), evaluated one level deeper than the current target since the row is a
// candidate to descend INTO. An undecryptable row is excluded too — the client has no name to show
// for it and the backend can't resolve it as a destination either.
export function isMoveRowDisabled(row: DriveItem, currentAncestry: readonly string[], movedItems: readonly DriveItem[]): boolean {
	if (row.data.undecryptable) {
		return true
	}

	return isMoveDestinationForbidden([...currentAncestry, row.data.uuid], movedItems)
}

// "Move here" gate for the directory currently open in the picker.
export function isMoveConfirmDisabled(
	currentAncestry: readonly string[],
	movedItems: readonly DriveItem[],
	targetListing: readonly DriveItem[]
): boolean {
	return isMoveDestinationForbidden(currentAncestry, movedItems) || isMoveNoOp(movedItems, targetListing)
}

export interface MoveTreeGates {
	isBrowseDisabled: (target: DirectoryTreeTarget) => boolean
	isTargetDisabled: (target: DirectoryTreeTarget) => boolean
}

// The same two gates for the item menu's directory-tree submenu, which knows each directory only by its
// uuid chain. `readListing` supplies what the dialog would have on screen: a node's parent listing (to
// find the row itself) and a target's own listing (for the no-op check). An unread target listing
// keeps "Move here" disabled, as the dialog does until its listing loads.
export function createMoveTreeGates(
	movedItems: readonly DriveItem[],
	readListing: (uuid: string | null) => readonly DriveItem[] | undefined
): MoveTreeGates {
	// One uuid index per listing array, so a level of n directories isn't n linear scans.
	const rowIndexes = new WeakMap<readonly DriveItem[], Map<string, DriveItem>>()

	function findRow(listing: readonly DriveItem[], uuid: string): DriveItem | undefined {
		let index = rowIndexes.get(listing)

		if (index === undefined) {
			index = new Map(listing.map(item => [item.data.uuid, item]))
			rowIndexes.set(listing, index)
		}

		return index.get(uuid)
	}

	return {
		isBrowseDisabled: target => {
			const parentAncestry = target.ancestry.slice(0, -1)
			const listing = readListing(parentAncestry.at(-1) ?? null)
			const row = listing !== undefined && target.uuid !== null ? findRow(listing, target.uuid) : undefined

			return row === undefined
				? isMoveDestinationForbidden(target.ancestry, movedItems)
				: isMoveRowDisabled(row, parentAncestry, movedItems)
		},
		isTargetDisabled: target => {
			const listing = readListing(target.uuid)

			return listing === undefined || isMoveConfirmDisabled(target.ancestry, movedItems, listing)
		}
	}
}
