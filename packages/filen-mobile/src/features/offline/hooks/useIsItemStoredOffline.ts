import type { DriveItem } from "@/types"
import offline from "@/features/offline/offline"
import useOfflineStore from "@/features/offline/store/useOffline.store"

// Reads the in-memory offline index; the storedVersion bump re-runs the selector whenever the
// index is swapped, and the row re-renders only when its own answer flips.
export default function useIsItemStoredOffline(item: DriveItem | null): boolean {
	return useOfflineStore(state => state.storedVersion >= 0 && item !== null && offline.isItemStoredSync(item) === true)
}
