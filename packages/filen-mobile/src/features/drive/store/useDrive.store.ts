import { create } from "zustand"
import { removeSelectedIds } from "@filen/shared"
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
			const next = removeSelectedIds(state.selectedItems, uuids, driveItemId)

			// Avoid a needless state update (and re-render) when nothing was selected.
			if (next === state.selectedItems) {
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
