import type { DriveItem } from "@/features/drive/lib/item"

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
