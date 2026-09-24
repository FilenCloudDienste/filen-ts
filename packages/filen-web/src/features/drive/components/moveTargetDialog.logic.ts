import type { DriveItem } from "@/features/drive/lib/item"
import type { DirectoryTreeTarget } from "@/features/drive/components/directoryTreeSubmenu"

// A move destination is illegal for two independent reasons, checked separately so the picker can
// apply them at different points: entering a row (browsing) only ever needs the first, "Move here"
// needs both.

// Every directory arm: a directory shared out is still the user's own, listed under its real uuid.
function isDirectoryItem(item: DriveItem): boolean {
	return item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
}

// A directory shared with the user sits in its owner's tree, never the user's, so it can't be above a
// destination there. Its role names the other party, here the sharer; one without a role still counts.
function isSharedWithUser(item: DriveItem): boolean {
	const role = item.type === "sharedDirectory" || item.type === "sharedRootDirectory" ? item.data.sharingRole : undefined

	return role !== undefined && "Sharer" in role
}

// The directories among `items` that can lie on a chain in the user's own tree.
export function ownDirectoryUuids(items: readonly DriveItem[]): Set<string> {
	const uuids = new Set<string>()

	for (const item of items) {
		if (isDirectoryItem(item) && !isSharedWithUser(item)) {
			uuids.add(item.data.uuid)
		}
	}

	return uuids
}

// A directory being moved can never become its own destination, nor can any of its descendants — a
// descendant's ancestry chain always passes through the directory being moved, so testing the WHOLE
// chain for membership catches both cases without telling them apart (both are equally illegal).
// `targetAncestry` is the candidate target's own root-to-target uuid chain, inclusive of the
// candidate itself; an empty chain (root) is never illegal this way — no moved item can BE the root.
export function isMoveDestinationForbidden(targetAncestry: readonly string[], movedItems: readonly DriveItem[]): boolean {
	if (targetAncestry.length === 0) {
		return false
	}

	const movedDirUuids = ownDirectoryUuids(movedItems)

	return targetAncestry.some(uuid => movedDirUuids.has(uuid))
}

// Deep enough for any real tree; a longer chain is treated as unresolved.
const MAX_ANCESTRY_DEPTH = 64

// A directory's parent as far as the caller knows: its uuid, null once the walk has reached the top it
// needs, undefined when unknown.
export type ParentLookup = (uuid: string) => string | null | undefined

// Whether `uuid` is one of `dirUuids` or lies below one, walking `parentOf` upward. A chain that comes
// from a route only proves which directories hold its end, never which don't (a directory opened from
// search, Favorites or a pasted link starts a fresh one), so this is the absence check. "unresolved"
// when a link is missing, loops or runs too deep.
export function ancestryHits(uuid: string, dirUuids: ReadonlySet<string>, parentOf: ParentLookup): boolean | "unresolved" {
	let current = uuid

	for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
		if (dirUuids.has(current)) {
			return true
		}

		const parent = parentOf(current)

		if (parent === null) {
			return false
		}

		if (parent === undefined || parent === current) {
			return "unresolved"
		}

		current = parent
	}

	return "unresolved"
}

// Whether moving or copying `items` into `targetUuid` could put a directory inside itself: refused
// unless the walk proves no directory among them lies on the target's chain. A move into its own
// subtree can't be undone, so an unresolved chain counts as one. The parents are read only when a
// directory is among `items`: reading them scans every cached listing.
export function isChainForbidden(targetUuid: string, items: readonly DriveItem[], readParents: () => ParentLookup): boolean {
	const dirUuids = ownDirectoryUuids(items)

	return dirUuids.size > 0 && ancestryHits(targetUuid, dirUuids, readParents()) !== false
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

// A copy may land beside its source (the SDK keeps both names); only self/descendant is illegal.
export function isCopyConfirmDisabled(currentAncestry: readonly string[], copiedItems: readonly DriveItem[]): boolean {
	return isMoveDestinationForbidden(currentAncestry, copiedItems)
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

// The same two gates for the directory-tree submenus (move or copy), which know each directory only by
// its uuid chain. `readListing` supplies what the dialog would have on screen: a node's parent listing
// (to find the row itself) and a target's own listing (for the move no-op check). An unread target
// listing keeps the action disabled, as the dialog does until its listing loads.
export function createMoveTreeGates(
	movedItems: readonly DriveItem[],
	readListing: (uuid: string | null) => readonly DriveItem[] | undefined,
	mode: "move" | "copy" = "move"
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

			if (listing === undefined) {
				return true
			}

			return mode === "copy"
				? isCopyConfirmDisabled(target.ancestry, movedItems)
				: isMoveConfirmDisabled(target.ancestry, movedItems, listing)
		}
	}
}
