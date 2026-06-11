import { create } from "zustand"
import { type OfflineSyncError } from "@/features/offline/offlineHelpers"

export type OfflineStore = {
	syncing: boolean
	setSyncing: (fn: boolean | ((prev: boolean) => boolean)) => void
	syncErrors: OfflineSyncError[]
	setSyncErrors: (syncErrors: OfflineSyncError[]) => void
}

export const useOfflineStore = create<OfflineStore>(set => ({
	syncing: false,
	setSyncing(fn) {
		set(state => ({
			syncing: typeof fn === "function" ? fn(state.syncing) : fn
		}))
	},
	syncErrors: [],
	setSyncErrors(syncErrors) {
		set({ syncErrors })
	}
}))

// Appends a user-initiated store action's errors to the error surface immediately — sync passes
// replace the list wholesale at their end, but an initial store's degraded warnings (e.g. a
// remote file whose content is shorter than its metadata claims) would otherwise never be seen:
// the warning only fires on FRESH observations, and by the next sync pass the delivered size is
// already recorded. Dedup by id so repeated actions don't stack identical entries.
export function appendOfflineSyncErrors(errors: OfflineSyncError[]): void {
	if (errors.length === 0) {
		return
	}

	const existing = useOfflineStore.getState().syncErrors
	const known = new Set(existing.map(error => error.id))
	const fresh = errors.filter(error => !known.has(error.id))

	if (fresh.length === 0) {
		return
	}

	useOfflineStore.getState().setSyncErrors([...existing, ...fresh])
}

export default useOfflineStore
