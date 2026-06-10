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

export default useOfflineStore
