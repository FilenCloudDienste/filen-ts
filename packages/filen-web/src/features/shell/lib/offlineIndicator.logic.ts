// Pure connectivity-transition step for the global offline indicator, split out so the state
// machine is table-tested without mounting a component or faking `navigator.onLine`/window events.
export type OfflineIndicatorStatus = "hidden" | "offline" | "back-online"

// Internal status the component's timer drives; "hidden" is derived (see OfflineIndicator) rather
// than stored, so the transient "back-online" → "hidden" decay is the only timer this owns.
type TrackedStatus = "online" | "offline" | "back-online"

// Called only when `isOnline` actually changes (the caller's during-render guard fires this once
// per flip, mirroring filen-mobile's floating-bar offline slot): a drop always goes to "offline"; a
// return promotes a prior "offline" to the transient "back-online" confirmation banner, otherwise
// the status is unaffected. The back-online → online decay after a fixed delay is a timer at the
// call site, not part of this pure step.
export function nextOfflineStatus(prev: TrackedStatus, isOnline: boolean): TrackedStatus {
	if (!isOnline) {
		return "offline"
	}

	return prev === "offline" ? "back-online" : prev
}

export function toIndicatorStatus(status: TrackedStatus): OfflineIndicatorStatus {
	return status === "online" ? "hidden" : status
}
