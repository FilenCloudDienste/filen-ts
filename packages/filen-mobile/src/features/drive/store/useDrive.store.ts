import { create } from "zustand"
import type { DriveItem } from "@/types"
import { toggleInArray } from "@/stores/createSelectionSlice"

export type DriveStore = {
	selectedItems: DriveItem[]
	setSelectedItems: (fn: DriveItem[] | ((prev: DriveItem[]) => DriveItem[])) => void
	toggleSelectedItem: (item: DriveItem) => void
	removeFromSelection: (uuids: string[]) => void
	clearSelectedItems: () => void
	selectAllItems: <T extends DriveItem>(items: T[]) => void
}

const driveItemId = (i: DriveItem) => i.data.uuid

export const useDriveStore = create<DriveStore>(set => ({
	selectedItems: [],
	setSelectedItems(fn) {
		set(state => ({
			selectedItems: typeof fn === "function" ? fn(state.selectedItems) : fn
		}))
	},
	toggleSelectedItem(item) {
		set(state => ({
			selectedItems: toggleInArray(state.selectedItems, item, driveItemId)
		}))
	},
	removeFromSelection(uuids) {
		set(state => {
			const toRemove = new Set(uuids)
			const next = state.selectedItems.filter(item => !toRemove.has(driveItemId(item)))

			// Avoid a needless state update (and re-render) when nothing was selected.
			if (next.length === state.selectedItems.length) {
				return state
			}

			return { selectedItems: next }
		})
	},
	clearSelectedItems() {
		set({ selectedItems: [] })
	},
	selectAllItems<T extends DriveItem>(items: T[]) {
		set({ selectedItems: items })
	}
}))

export default useDriveStore
