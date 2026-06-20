import { create } from "zustand"
import type { Asset } from "expo-media-library/next"

export type CameraUploadError = {
	id: string
	timestamp: number
	asset?: Asset
	error?: unknown
}

export type CameraUploadStore = {
	syncing: boolean
	errors: CameraUploadError[]
	skippedAssets: Set<string>
	setSyncing: (fn: boolean | ((prev: boolean) => boolean)) => void
	setErrors: (fn: CameraUploadError[] | ((prev: CameraUploadError[]) => CameraUploadError[])) => void
	addSkippedAsset: (assetId: string) => void
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
	skippedAssets: new Set<string>(),
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
	addSkippedAsset(assetId) {
		set(state => {
			const next = new Set(state.skippedAssets)

			next.add(assetId)

			return { skippedAssets: next }
		})
	},
	clearSkippedAssets() {
		set({ skippedAssets: new Set<string>() })
	}
}))

export default useCameraUploadStore
