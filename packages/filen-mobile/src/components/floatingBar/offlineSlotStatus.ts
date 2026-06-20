export type OfflineStatus = "online" | "offline" | "back-online"

/**
 * Pure connectivity-change transition for the floating-bar offline slot. Called only when
 * `isOnline` actually changes (the during-render guard in useOfflineSlotStatus fires it once per
 * flip): a drop always goes to "offline"; a return promotes a prior "offline" to the transient
 * "back-online" confirmation, otherwise keeps the current status. The 2s back-online → online
 * decay is a timer in the hook, not part of this pure step.
 */
export function nextOfflineStatus(prev: OfflineStatus, isOnline: boolean): OfflineStatus {
	if (!isOnline) {
		return "offline"
	}

	return prev === "offline" ? "back-online" : prev
}
