import { create } from "zustand"
import { toggleInArray, removeSelectedIds } from "@filen/shared"
import { type PhotoItem } from "@/features/photos/lib/captureSort"

// A separate store from drive's own useDriveStore — deliberately NOT the same singleton. The photos
// screen and a drive listing are different route trees that never mount together, but zustand state
// is a module-level singleton regardless: sharing useDriveStore would leak a drive selection into the
// photos grid (and vice versa) the instant a user navigates between the two, since neither route's
// mount/unmount resets the OTHER surface's own selection-reset effect. Same shape/behavior as
// useDriveStore otherwise.

const photoItemId = (item: PhotoItem): string => item.data.uuid

interface PhotosState {
	selectedItems: PhotoItem[]
	setSelectedItems: (next: PhotoItem[] | ((prev: PhotoItem[]) => PhotoItem[])) => void
	toggleSelectedItem: (item: PhotoItem) => void
	removeFromSelection: (uuids: string[]) => void
	clearSelectedItems: () => void
}

export const usePhotosStore = create<PhotosState>(set => ({
	selectedItems: [],
	setSelectedItems: next => {
		set(state => ({
			selectedItems: typeof next === "function" ? next(state.selectedItems) : next
		}))
	},
	toggleSelectedItem: item => {
		set(state => ({
			selectedItems: toggleInArray(state.selectedItems, item, photoItemId)
		}))
	},
	removeFromSelection: uuids => {
		set(state => {
			const next = removeSelectedIds(state.selectedItems, uuids, photoItemId)

			if (next === state.selectedItems) {
				return state
			}

			return { selectedItems: next }
		})
	},
	clearSelectedItems: () => {
		set({ selectedItems: [] })
	}
}))
