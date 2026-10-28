import { type DriveItemLike, driveItemName } from "./driveItem"
import { isDotFilenSearchPath, isRootDotFilen } from "./dotFilen"

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

// Hides the root `.filen` (dotFilen.ts) on its own setting, which the dot-prefix toggle never touches.
export interface RootDotFilenFilter<T> {
	rootUuid: string
	// An own directory's parent uuid; null for anything else (a file, a shared item).
	directoryParentOf: (item: T) => string | null
	// Search hits under a search rooted at the drive root, whose ancestry then names `.filen` first.
	searchAtDriveRoot: boolean
	// Flat listings (recents, favorites): whether an item sits directly in `.filen` or one of its subdirectories,
	// as far as the platform's resolver knows them. An unknown one is a miss, never a lookup.
	insideDotFilen?: ((item: T) => boolean) | undefined
}

// Display-only filter, applied where a listing renders rather than where it is fetched: the query
// cache stays complete, so flipping the toggle re-renders instead of refetching, and every consumer
// that reasons about what is really in a directory (transfers, offline sync, socket updaters) is
// untouched. Judges an item by driveItemName (decryptedMeta?.name ?? uuid), so an undecryptable item
// — whose display name is its uuid — always stays visible: hiding something the user cannot even
// identify would leave them no way to find it again. `searchParentPaths` is supplied for search
// results only, and extends the rule from a hit's own name to its ancestry. `rootDotFilen` also
// removes the root `.filen` and every search hit inside it. Returns `items` itself when nothing was removed, so a
// caller can tell by identity and a memo downstream keeps its input.
export function filterHiddenItems<T extends DriveItemLike>({
	items,
	hide,
	searchParentPaths,
	rootDotFilen
}: {
	items: T[]
	hide: boolean
	searchParentPaths?: ReadonlyMap<string, string>
	rootDotFilen?: RootDotFilenFilter<T> | undefined
}): T[] {
	if (!hide && rootDotFilen === undefined) {
		return items
	}

	const shown = items.filter(item => {
		const name = driveItemName(item)
		const parentPath = searchParentPaths?.get(item.data.uuid)

		if (rootDotFilen !== undefined) {
			if (isRootDotFilen({ name, parentUuid: rootDotFilen.directoryParentOf(item), rootUuid: rootDotFilen.rootUuid })) {
				return false
			}

			if (rootDotFilen.searchAtDriveRoot && parentPath !== undefined && isDotFilenSearchPath(parentPath)) {
				return false
			}

			if (rootDotFilen.insideDotFilen?.(item) === true) {
				return false
			}
		}

		if (!hide) {
			return true
		}

		if (isHiddenName(name)) {
			return false
		}

		return parentPath === undefined || !isHiddenSearchPath(parentPath)
	})

	return shown.length === items.length ? items : shown
}
