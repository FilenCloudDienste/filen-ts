import { create } from "zustand"

export type OfflineStore = {
	syncing: boolean
	setSyncing: (fn: boolean | ((prev: boolean) => boolean)) => void
}

export const useOfflineStore = create<OfflineStore>(set => ({
	syncing: false,
	setSyncing(fn) {
		set(state => ({
			syncing: typeof fn === "function" ? fn(state.syncing) : fn
		}))
	}
}))

export default useOfflineStore
