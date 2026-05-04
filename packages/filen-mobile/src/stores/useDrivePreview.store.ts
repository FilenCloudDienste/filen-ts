import { create } from "zustand"
import type { GalleryItemTagged } from "@/components/drivePreview/gallery"

export type DrivePreviewStore = {
	headerHeight: number | null
	setHeaderHeight: (fn: number | null | ((prev: number | null) => number | null)) => void
	currentIndex: number | null
	setCurrentIndex: (fn: number | null | ((prev: number | null) => number | null)) => void
	reset: () => void
	currentItem: GalleryItemTagged | null
	setCurrentItem: (fn: GalleryItemTagged | null | ((prev: GalleryItemTagged | null) => GalleryItemTagged | null)) => void
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
			currentIndex: null,
			currentItem: null
		})
	},
	currentItem: null,
	setCurrentItem(fn) {
		set(state => ({
			currentItem: typeof fn === "function" ? fn(state.currentItem) : fn
		}))
	},
	currentItemEdited: null
}))

export default useDrivePreviewStore
