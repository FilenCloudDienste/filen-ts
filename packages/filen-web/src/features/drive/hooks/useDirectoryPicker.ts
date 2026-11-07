import { useState } from "react"
import { filterHiddenItems } from "@filen/shared"
import { useDirectoryListingQuery, useDirectoryNamesQuery, useHiddenDotFilenRoot } from "@/features/drive/queries/drive"
import { sortDriveItems } from "@/features/drive/lib/sort"
import { rootDotFilenFilter } from "@/features/drive/lib/hiddenItems"
import { isRootDotFilenItem } from "@/features/drive/lib/dotFilenGuard"

// Navigation state of the in-dialog drive pickers: a local uuid stack from root, never the "/drive/$"
// route, so browsing a picker never touches app history. Always browses the "drive" variant. `items` is
// the listing in name order (directories first), whatever sort the drive itself is set to. `initialPath`
// (root first, the directory to open last) opens it there instead of at the root; read once, at mount. The root
// `.filen` is left out while its setting hides it, so no picker lands in it.
export function useDirectoryPicker(initialPath?: readonly string[]) {
	const [pathStack, setPathStack] = useState<string[]>(() => (initialPath === undefined ? [] : [...initialPath]))
	const targetUuid = pathStack.at(-1) ?? null
	const listingQuery = useDirectoryListingQuery("drive", targetUuid)
	const namesQuery = useDirectoryNamesQuery(pathStack)
	const dotFilenRoot = useHiddenDotFilenRoot()
	// Only the root level can hold it.
	const items = filterHiddenItems({
		// The root `.filen`, where shown, leads the directories as in the listing.
		items: sortDriveItems(
			listingQuery.data ?? [],
			"nameAsc",
			undefined,
			targetUuid === null && dotFilenRoot === null ? isRootDotFilenItem : undefined
		),
		hide: false,
		rootDotFilen:
			targetUuid === null ? rootDotFilenFilter({ rootUuid: dotFilenRoot, variant: "drive", searchAtDriveRoot: false }) : undefined
	})

	function descend(uuid: string): void {
		setPathStack(prev => [...prev, uuid])
	}

	function goRoot(): void {
		setPathStack([])
	}

	function goTo(index: number): void {
		setPathStack(prev => prev.slice(0, index + 1))
	}

	return { pathStack, targetUuid, listingQuery, items, namesQuery, descend, goRoot, goTo }
}

// A filter scoped to one directory must never carry over and hide everything in the next, so it resets
// on every path change. Reset in render (react.dev's "adjusting state when a prop changes"), not an effect.
export function useDirectoryPickerFilter(pathStack: string[]): [string, (value: string) => void] {
	const [filter, setFilter] = useState("")
	const pathKey = pathStack.join("/")
	const [filterPathKey, setFilterPathKey] = useState(pathKey)

	if (pathKey !== filterPathKey) {
		setFilterPathKey(pathKey)
		setFilter("")
	}

	return [filter, setFilter]
}
