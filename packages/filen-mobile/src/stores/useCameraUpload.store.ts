import { create } from "zustand"

export type CameraUploadStore = {
	syncing: boolean
	errors: unknown[]
	setSyncing: (fn: boolean | ((prev: boolean) => boolean)) => void
	setErrors: (fn: unknown[] | ((prev: unknown[]) => unknown[])) => void
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
