import { type DriveItemLike, driveItemName } from "./driveItem"

// The dot-prefix convention. Leading whitespace is trimmed first: a name created by another client
// can carry it, and " .env" is the same hidden file to a user.
export function isHiddenName(name: string): boolean {
	return name.trim().startsWith(".")
}

// Whether a search hit lives inside a hidden directory. `parentPath` is the "/"-joined chain of
// ancestor names relative to the search root (empty for a direct child) — search is recursive, so
// filtering on the hit's own name alone would hide `.thumb` from the browser while flooding the
// results with everything inside it.
export function isHiddenSearchPath(parentPath: string): boolean {
	return parentPath.split("/").some(isHiddenName)
}

// Display-only filter, applied where a listing renders rather than where it is fetched: the query
// cache stays complete, so flipping the toggle re-renders instead of refetching, and every consumer
// that reasons about what is really in a directory (transfers, offline sync, socket updaters) is
// untouched. Judges an item by driveItemName (decryptedMeta?.name ?? uuid), so an undecryptable item
// — whose display name is its uuid — always stays visible: hiding something the user cannot even
// identify would leave them no way to find it again. `searchParentPaths` is supplied for search
// results only, and extends the rule from a hit's own name to its ancestry.
export function filterHiddenItems<T extends DriveItemLike>({
	items,
	hide,
	searchParentPaths
}: {
	items: T[]
	hide: boolean
	searchParentPaths?: ReadonlyMap<string, string>
}): T[] {
	if (!hide) {
		return items
	}

	return items.filter(item => {
		if (isHiddenName(driveItemName(item))) {
			return false
		}

		const parentPath = searchParentPaths?.get(item.data.uuid)

		return parentPath === undefined || !isHiddenSearchPath(parentPath)
	})
}
