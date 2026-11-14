import { isAppleMobile } from "@/lib/appleMobile"
import { SMOOTH_TRANSITIONS_APPLE_MOBILE } from "@/features/audio/lib/smoothTransitions.types"

export type SmoothTransitionsAvailability = "available" | "appleMobileGated"

export function smoothTransitionsAvailabilityFor(appleMobile: boolean, appleMobileAllowed: boolean): SmoothTransitionsAvailability {
	return appleMobile && !appleMobileAllowed ? "appleMobileGated" : "available"
}

// Whether this device may run smooth transitions at all. The one answer the store, the engine and the UI read.
export function smoothTransitionsAvailability(): SmoothTransitionsAvailability {
	return smoothTransitionsAvailabilityFor(typeof navigator !== "undefined" && isAppleMobile(), SMOOTH_TRANSITIONS_APPLE_MOBILE)
}
