import { useCallback } from "react"
import { useSecureStore } from "@/lib/secureStore"
import type { SortByType } from "@/lib/sort"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"

export const SORT_PREFERENCES_SECURE_STORE_KEY = "drive.sortPreferences"

export type SortPreferences = {
	mode: "global" | "perDirectory"
	global: SortByType
	perDirectory: Record<string, SortByType>
}

export const DEFAULT_SORT_PREFERENCES: SortPreferences = {
	mode: "global",
	global: "nameAsc",
	perDirectory: {}
}

// Drive views where sort is user-controllable. Recents is intentionally read-only
// (always uploadDateDesc — chronological is the whole point of the view).
export function isSortable(type: DrivePathType | null): type is DrivePathType {
	return type !== null && type !== "recents"
}

export function getPerDirectoryKey(drivePath: DrivePath): string {
	return `${drivePath.type ?? ""}:${drivePath.uuid ?? ""}`
}

export function resolveEffectiveSort(prefs: SortPreferences, drivePath: DrivePath): SortByType {
	if (drivePath.type === "recents") {
		return "uploadDateDesc"
	}

	if (!isSortable(drivePath.type)) {
		return "nameAsc"
	}

	if (prefs.mode === "perDirectory") {
		return prefs.perDirectory[getPerDirectoryKey(drivePath)] ?? "nameAsc"
	}

	return prefs.global
}

export function useDriveSortPreferences(): [
	SortPreferences,
	(next: SortPreferences | ((prev: SortPreferences) => SortPreferences)) => void
] {
	return useSecureStore<SortPreferences>(SORT_PREFERENCES_SECURE_STORE_KEY, DEFAULT_SORT_PREFERENCES)
}

export function useDriveSortPreference(drivePath: DrivePath): {
	sort: SortByType
	setSort: (next: SortByType) => void
	sortable: boolean
} {
	const [prefs, setPrefs] = useDriveSortPreferences()
	const sortable = isSortable(drivePath.type)
	const sort = resolveEffectiveSort(prefs, drivePath)

	const setSort = useCallback(
		(next: SortByType) => {
			if (!sortable) {
				return
			}

			const key = getPerDirectoryKey(drivePath)

			setPrefs(prev => {
				if (prev.mode === "perDirectory") {
					return {
						...prev,
						perDirectory: {
							...prev.perDirectory,
							[key]: next
						}
					}
				}

				return {
					...prev,
					global: next
				}
			})
		},
		[drivePath, sortable, setPrefs]
	)

	return {
		sort,
		setSort,
		sortable
	}
}
