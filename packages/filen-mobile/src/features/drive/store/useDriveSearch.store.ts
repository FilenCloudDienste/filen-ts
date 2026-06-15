import { create } from "zustand"

// Reactive status for the cache-backed drive search. Written by the silent
// `driveSearch` singleton's cache status listener; read by `useDriveSearch` to
// drive the indicator state machine. `resyncing` is root-scoped (set only when a
// `ResyncProgress.Started` covers the active search root); `rootDeleted` flips when
// the active root is deleted server-side; `cacheUnavailable` flips if
// `configureCache` failed at init (search degrades to "unavailable").
//
// `resyncProgress` is a monotonic LIVENESS heartbeat — bumped on every
// `ResyncProgress.Listing`/`Applying` tick (Listing arrives ~every 200ms during the
// network-bound listing phase). The hook's watchdog + stall timers re-arm on it so they
// measure SILENCE since the last sign of life, not total elapsed time — a legitimately
// long search (huge tree / slow network / slow device) never false-fails while the worker
// is visibly progressing. (Status-message delivery is best-effort and can drop under load,
// so a frequent heartbeat that tolerates occasional drops beats trusting any single signal.)
export type DriveSearchStore = {
	resyncing: boolean
	rootDeleted: boolean
	cacheUnavailable: boolean
	resyncProgress: number
	setResyncing: (value: boolean) => void
	setRootDeleted: (value: boolean) => void
	setCacheUnavailable: (value: boolean) => void
	bumpResyncProgress: () => void
}

export const useDriveSearchStore = create<DriveSearchStore>(set => ({
	resyncing: false,
	rootDeleted: false,
	cacheUnavailable: false,
	resyncProgress: 0,
	setResyncing(value) {
		set({ resyncing: value })
	},
	setRootDeleted(value) {
		set({ rootDeleted: value })
	},
	setCacheUnavailable(value) {
		set({ cacheUnavailable: value })
	},
	bumpResyncProgress() {
		set(state => ({ resyncProgress: state.resyncProgress + 1 }))
	}
}))

export default useDriveSearchStore
