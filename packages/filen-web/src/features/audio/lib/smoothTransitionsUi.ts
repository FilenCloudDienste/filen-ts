import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import type { SmoothTransitionsUnavailable } from "@/features/audio/lib/smoothTransitions.types"
import { toggleSmoothTransitions, useSmoothTransitionsStore } from "@/features/audio/store/useSmoothTransitionsStore"

// Why smooth transitions are unavailable, in the words the player's toggle and the settings card share.
export const SMOOTH_TRANSITIONS_UNAVAILABLE_KEYS = {
	appleMobileGated: "smoothTransitionsUnavailableDevice",
	degraded: "smoothTransitionsUnavailableDegraded",
	sourceIneligible: "smoothTransitionsUnavailableSource"
} as const satisfies Record<SmoothTransitionsUnavailable, string>

interface SmoothTransitionsUiState {
	enabled: boolean
	unavailable: SmoothTransitionsUnavailable | null
}

// Whether tracks blend now: what every on/off control shows. The stored pref stays as set, so a reload restores it.
export function smoothTransitionsActive({ enabled, unavailable }: SmoothTransitionsUiState): boolean {
	return enabled && unavailable === null
}

// While unavailable the feature can still be turned off, never on.
export function smoothTransitionsLocked({ enabled, unavailable }: SmoothTransitionsUiState): boolean {
	return !enabled && unavailable !== null
}

const UNAVAILABLE_TOAST_ID = "smooth-transitions-unavailable"

// What the toggle, its keys and the desktop menu run, inside the user's gesture. A refusal says why: a key or a menu
// click has no tooltip to show it.
export function toggleSmoothTransitionsByUser(): void {
	const { prefs, unavailable } = useSmoothTransitionsStore.getState()

	if (unavailable !== null && smoothTransitionsLocked({ enabled: prefs.enabled, unavailable })) {
		toast.info(i18n.t(`audio:${SMOOTH_TRANSITIONS_UNAVAILABLE_KEYS[unavailable]}`), { id: UNAVAILABLE_TOAST_ID })

		return
	}

	toggleSmoothTransitions()
}
