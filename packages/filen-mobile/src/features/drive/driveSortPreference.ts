import { useCallback } from "react"
import { useSecureStore } from "@/lib/secureStore"
import type { SortByType } from "@/lib/sort"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"
import { type ScopedPreferences, getPerDirectoryKey, applyScopedPreference } from "@/features/drive/driveScopedPreference"

export const SORT_PREFERENCES_SECURE_STORE_KEY = "drive.sortPreferences"

export type SortPreferences = ScopedPreferences<SortByType>

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

			setPrefs(prev => applyScopedPreference(prev, key, next))
		},
		[drivePath, sortable, setPrefs]
	)

	return {
		sort,
		setSort,
		sortable
	}
}
