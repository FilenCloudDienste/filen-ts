import { create } from "zustand"
import type { DriveItem } from "@/types"
import { toggleInArray } from "@/stores/createSelectionSlice"

export type DriveStore = {
	selectedItems: DriveItem[]
	setSelectedItems: (fn: DriveItem[] | ((prev: DriveItem[]) => DriveItem[])) => void
	toggleSelectedItem: (item: DriveItem) => void
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
	clearSelectedItems() {
		set({ selectedItems: [] })
	},
	selectAllItems<T extends DriveItem>(items: T[]) {
		set({ selectedItems: items })
	}
}))

export default useDriveStore
