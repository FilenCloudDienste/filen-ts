import { create } from "zustand"

export type CameraUploadError = {
	id: string
	timestamp: number
	// Media-library asset id (a contentUri on Android) — plain data on purpose: holding the
	// live Asset shared object here retained its native peer for the store's lifetime.
	assetId?: string
	error?: unknown
}

// CU-09: a permanently-skipped asset surfaced to the user. `id` is the media-library asset id
// (the engine's `uploadFailures` key); `name` is the asset filename shown in the issues modal so
// the user can recognise + retry it. This is a UI-surfacing list only — the skip DECISION keys on
// `uploadFailures >= MAX_UPLOAD_FAILURES` in the engine, not on membership here.
export type CameraUploadSkippedAsset = {
	id: string
	name: string
}

export type CameraUploadStore = {
	syncing: boolean
	errors: CameraUploadError[]
	skippedAssets: CameraUploadSkippedAsset[]
	setSyncing: (fn: boolean | ((prev: boolean) => boolean)) => void
	setErrors: (fn: CameraUploadError[] | ((prev: CameraUploadError[]) => CameraUploadError[])) => void
	addSkippedAsset: (asset: CameraUploadSkippedAsset) => void
	removeSkippedAsset: (assetId: string) => void
	clearSkippedAssets: () => void
}

// CU-08: upper bound on the in-session error log. The engine appends one entry per sync pass and
// syncs fire frequently (mount, every foreground transition, a debounce, reconnect, settings
// focus-leave, the OS background task), so a durable failure would otherwise grow this array without
// limit — memory creep, an unusable error screen, and a permanent warning badge that "Clear errors"
// can't keep clear. setErrors keeps only the most recent N (oldest dropped from the front).
export const MAX_CAMERA_UPLOAD_ERRORS = 100

export const useCameraUploadStore = create<CameraUploadStore>(set => ({
	syncing: false,
	errors: [],
	skippedAssets: [],
	setErrors(fn) {
		set(state => {
			const next = typeof fn === "function" ? fn(state.errors) : fn

			// Bound the log (CU-08): keep only the most recent MAX_CAMERA_UPLOAD_ERRORS so a durable
			// per-pass failure can't grow it without limit. Slicing from the front drops the oldest.
			return {
				errors: next.length > MAX_CAMERA_UPLOAD_ERRORS ? next.slice(next.length - MAX_CAMERA_UPLOAD_ERRORS) : next
			}
		})
	},
	setSyncing(fn) {
		set(state => ({
			syncing: typeof fn === "function" ? fn(state.syncing) : fn
		}))
	},
	addSkippedAsset(asset) {
		set(state => {
			// Dedupe by id: the engine can re-report the same skipped asset on every pass (the skip
			// guard fires each sync while the failure count stays at the cap), so keep one entry per
			// asset instead of growing the list. Refresh the name in case it changed.
			const next = state.skippedAssets.filter(existing => existing.id !== asset.id)

			next.push(asset)

			return { skippedAssets: next }
		})
	},
	removeSkippedAsset(assetId) {
		set(state => {
			const next = state.skippedAssets.filter(existing => existing.id !== assetId)

			// Preserve referential identity when nothing was removed so selectors don't re-render.
			return next.length === state.skippedAssets.length ? state : { skippedAssets: next }
		})
	},
	clearSkippedAssets() {
		set({ skippedAssets: [] })
	}
}))

export default useCameraUploadStore
