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
	setSyncing: (fn: boolean | ((prev: boolean) => boolean)) => void
	setErrors: (fn: CameraUploadError[] | ((prev: CameraUploadError[]) => CameraUploadError[])) => void
}

export const useCameraUploadStore = create<CameraUploadStore>(set => ({
	syncing: false,
	errors: [],
	setErrors(fn) {
		set(state => ({
			errors: typeof fn === "function" ? fn(state.errors) : fn
		}))
	},
	setSyncing(fn) {
		set(state => ({
			syncing: typeof fn === "function" ? fn(state.syncing) : fn
		}))
	}
}))

export default useCameraUploadStore
