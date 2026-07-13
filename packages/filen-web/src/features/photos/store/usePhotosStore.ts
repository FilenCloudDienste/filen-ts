import { create } from "zustand"
import { type PhotoItem } from "@/features/photos/lib/captureSort"

// A separate store from drive's own useDriveStore — deliberately NOT the same singleton. The photos
// screen and a drive listing are different route trees that never mount together, but zustand state
// is a module-level singleton regardless: sharing useDriveStore would leak a drive selection into the
// photos grid (and vice versa) the instant a user navigates between the two, since neither route's
// mount/unmount resets the OTHER surface's own selection-reset effect. Same shape/behavior as
// useDriveStore otherwise — mirrors its own toggleInArray/removeFromSelection implementation exactly.

function toggleInArray<T>(items: T[], item: T, getId: (item: T) => string): T[] {
	const id = getId(item)
	const index = items.findIndex(existing => getId(existing) === id)

	if (index >= 0) {
		return [...items.slice(0, index), ...items.slice(index + 1)]
	}

	return [...items, item]
}

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
			const toRemove = new Set(uuids)
			const next = state.selectedItems.filter(item => !toRemove.has(photoItemId(item)))

			if (next.length === state.selectedItems.length) {
				return state
			}

			return { selectedItems: next }
		})
	},
	clearSelectedItems: () => {
		set({ selectedItems: [] })
	}
}))
