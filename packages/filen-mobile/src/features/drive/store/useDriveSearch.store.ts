import { create } from "zustand"

// Reactive status for the cache-backed drive search. Written by the silent
// `driveSearch` singleton's cache status listener; read by `useDriveSearch` to
// drive the indicator state machine. `resyncing` is root-scoped (set only when a
// `ResyncProgress.Started` covers the active search root); `rootDeleted` flips when
// the active root is deleted server-side; `cacheUnavailable` flips if
// `configureCache` failed at init (search degrades to "unavailable").
export type DriveSearchStore = {
	resyncing: boolean
	rootDeleted: boolean
	cacheUnavailable: boolean
	setResyncing: (value: boolean) => void
	setRootDeleted: (value: boolean) => void
	setCacheUnavailable: (value: boolean) => void
}

export const useDriveSearchStore = create<DriveSearchStore>(set => ({
	resyncing: false,
	rootDeleted: false,
	cacheUnavailable: false,
	setResyncing(value) {
		set({ resyncing: value })
	},
	setRootDeleted(value) {
		set({ rootDeleted: value })
	},
	setCacheUnavailable(value) {
		set({ cacheUnavailable: value })
	}
}))

export default useDriveSearchStore
