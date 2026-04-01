import { create } from "zustand"
import type { DriveItemFileExtracted } from "@/types"

export type DrivePreviewStore = {
	headerHeight: number | null
	setHeaderHeight: (fn: number | null | ((prev: number | null) => number | null)) => void
	currentIndex: number | null
	setCurrentIndex: (fn: number | null | ((prev: number | null) => number | null)) => void
	reset: () => void
	currentItem: DriveItemFileExtracted | null
	setCurrentItem: (fn: DriveItemFileExtracted | null | ((prev: DriveItemFileExtracted | null) => DriveItemFileExtracted | null)) => void
	currentItemEdited: DriveItemFileExtracted | null
	setCurrentItemEdited: (
		fn: DriveItemFileExtracted | null | ((prev: DriveItemFileExtracted | null) => DriveItemFileExtracted | null)
	) => void
}

export const useDrivePreviewStore = create<DrivePreviewStore>(set => ({
	headerHeight: null,
	setHeaderHeight(fn) {
		set(state => ({
			headerHeight: typeof fn === "function" ? fn(state.headerHeight) : fn
		}))
	},
	currentIndex: null,
	setCurrentIndex(fn) {
		set(state => ({
			currentIndex: typeof fn === "function" ? fn(state.currentIndex) : fn
		}))
	},
	reset() {
		set({
			// headerHeight: null,
			currentIndex: null,
			currentItem: null,
			currentItemEdited: null
		})
	},
	currentItem: null,
	setCurrentItem(fn) {
		set(state => ({
			currentItem: typeof fn === "function" ? fn(state.currentItem) : fn
		}))
	},
	currentItemEdited: null,
	setCurrentItemEdited(fn) {
		set(state => ({
			currentItemEdited: typeof fn === "function" ? fn(state.currentItemEdited) : fn
		}))
	}
}))

export default useDrivePreviewStore
