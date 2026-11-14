import type { SmoothTransitionsUnavailable } from "@/features/audio/lib/smoothTransitions.types"
import { toggleSmoothTransitions, useSmoothTransitionsStore } from "@/features/audio/store/useSmoothTransitionsStore"

// Why smooth transitions are unavailable, in the words the player's toggle and the settings card share.
export const SMOOTH_TRANSITIONS_UNAVAILABLE_KEYS = {
	appleMobileGated: "smoothTransitionsUnavailableDevice",
	degraded: "smoothTransitionsUnavailableDegraded",
	sourceIneligible: "smoothTransitionsUnavailableSource"
} as const satisfies Record<SmoothTransitionsUnavailable, string>

// While unavailable the feature can still be turned off, never on.
export function smoothTransitionsLocked({
	enabled,
	unavailable
}: {
	enabled: boolean
	unavailable: SmoothTransitionsUnavailable | null
}): boolean {
	return !enabled && unavailable !== null
}

// What the toggle, its keys and the desktop menu run, inside the user's gesture.
export function toggleSmoothTransitionsByUser(): void {
	const { prefs, unavailable } = useSmoothTransitionsStore.getState()

	if (!smoothTransitionsLocked({ enabled: prefs.enabled, unavailable })) {
		toggleSmoothTransitions()
	}
}
