import { create } from "zustand"
import type { DriveItem } from "@/types"

export type DriveStore = {
	selectedItems: DriveItem[]
	setSelectedItems: (fn: DriveItem[] | ((prev: DriveItem[]) => DriveItem[])) => void
}

export const useDriveStore = create<DriveStore>(set => ({
	selectedItems: [],
	setSelectedItems(fn) {
		set(state => ({
			selectedItems: typeof fn === "function" ? fn(state.selectedItems) : fn
		}))
	}
}))

export default useDriveStore
