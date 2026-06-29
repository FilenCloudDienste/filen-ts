import { useCallback } from "react"
import { useSecureStore } from "@/lib/secureStore"
import { getPerDirectoryKey } from "@/features/drive/driveSortPreference"
import { type DrivePath } from "@/hooks/useDrivePath"

export const VIEW_MODE_PREFERENCES_SECURE_STORE_KEY = "drive.viewModePreferences"

export type DriveViewMode = "list" | "grid"

export type ViewModePreferences = {
	mode: "global" | "perDirectory"
	global: DriveViewMode
	perDirectory: Record<string, DriveViewMode>
}

export const DEFAULT_VIEW_MODE_PREFERENCES: ViewModePreferences = {
	mode: "global",
	global: "list",
	perDirectory: {}
}

export function useDriveViewModePreferences(): [
	ViewModePreferences,
	(next: ViewModePreferences | ((prev: ViewModePreferences) => ViewModePreferences)) => void
] {
	return useSecureStore<ViewModePreferences>(VIEW_MODE_PREFERENCES_SECURE_STORE_KEY, DEFAULT_VIEW_MODE_PREFERENCES)
}

// Per-directory override falls back to the user's global default (not a hardcoded value), so
// directories the user hasn't customized follow the global preference even in perDirectory mode.
export function resolveEffectiveViewMode(prefs: ViewModePreferences, drivePath: DrivePath): DriveViewMode {
	if (prefs.mode === "perDirectory") {
		return prefs.perDirectory[getPerDirectoryKey(drivePath)] ?? prefs.global
	}

	return prefs.global
}

export function useDriveViewMode(drivePath: DrivePath): {
	viewMode: DriveViewMode
	setViewMode: (next: DriveViewMode) => void
} {
	const [prefs, setPrefs] = useDriveViewModePreferences()
	const viewMode = resolveEffectiveViewMode(prefs, drivePath)

	const setViewMode = useCallback(
		(next: DriveViewMode) => {
			const key = getPerDirectoryKey(drivePath)

			setPrefs(prev => {
				if (prev.mode === "perDirectory") {
					return {
						...prev,
						perDirectory: { ...prev.perDirectory, [key]: next }
					}
				}

				return { ...prev, global: next }
			})
		},
		[drivePath, setPrefs]
	)

	return { viewMode, setViewMode }
}
