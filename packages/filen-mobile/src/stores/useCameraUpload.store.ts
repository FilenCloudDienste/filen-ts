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

export const useCameraUploadStore = create<CameraUploadStore>(set => ({
	syncing: false,
	errors: [],
	skippedAssets: new Set<string>(),
	setErrors(fn) {
		set(state => ({
			errors: typeof fn === "function" ? fn(state.errors) : fn
		}))
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
