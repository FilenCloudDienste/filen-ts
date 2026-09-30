import type { DriveItem } from "@/types"
import type { DrivePathType } from "@/hooks/useDrivePath"
import { itemSorter, type SortByType } from "@/lib/sort"
import { useDriveDirectorySizes } from "@/features/drive/hooks/useDriveDirectorySizes"

// A hook of its own so the compiler memoizes the sort on its inputs alone. Inlined into the screen, the sort
// joins the scope of whatever consumes it, and a search keystroke re-sorts the whole unchanged listing.
export function useSortedDriveItems({
	items,
	drivePathType,
	sort,
	keepOrder
}: {
	items: DriveItem[] | undefined
	drivePathType: DrivePathType | null
	sort: SortByType
	keepOrder: boolean
}): DriveItem[] {
	// Size sort needs the REAL directory sizes (items carry size: 0n for dirs — #49); the hook
	// prefetches + reads them from the same query cache the rows display from, and returns
	// undefined for every other sort mode (zero cost there).
	const directorySizes = useDriveDirectorySizes({
		items,
		drivePathType,
		enabled: sort === "sizeAsc" || sort === "sizeDesc"
	})

	const source = items ?? []

	return keepOrder ? source : itemSorter.sortItems(source, sort, { directorySizes })
}
