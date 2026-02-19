import { create } from "zustand"
import type { DriveItem } from "@/types"

export type DriveSelectStore = {
	selectedItems: DriveItem[]
	setSelectedItems: (fn: DriveItem[] | ((prev: DriveItem[]) => DriveItem[])) => void
}

export const useDriveSelectStore = create<DriveSelectStore>(set => ({
	selectedItems: [],
	setSelectedItems(fn) {
		set(state => ({
			selectedItems: typeof fn === "function" ? fn(state.selectedItems) : fn
		}))
	}
}))

export default useDriveSelectStore
