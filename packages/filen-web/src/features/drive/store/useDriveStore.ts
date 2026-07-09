import { create } from "zustand"
import { type DriveItem } from "@/features/drive/lib/item"

// Add if absent (by uuid), remove if present — the toggle boilerplate every selection action here
// builds on. Returns a new array; the input is never mutated.
function toggleInArray<T>(items: T[], item: T, getId: (item: T) => string): T[] {
	const id = getId(item)
	const index = items.findIndex(existing => getId(existing) === id)

	if (index >= 0) {
		return [...items.slice(0, index), ...items.slice(index + 1)]
	}

	return [...items, item]
}

const driveItemId = (item: DriveItem): string => item.data.uuid

interface DriveState {
	selectedItems: DriveItem[]
	setSelectedItems: (next: DriveItem[] | ((prev: DriveItem[]) => DriveItem[])) => void
	toggleSelectedItem: (item: DriveItem) => void
	removeFromSelection: (uuids: string[]) => void
	clearSelectedItems: () => void
}

export const useDriveStore = create<DriveState>(set => ({
	selectedItems: [],
	setSelectedItems: next => {
		set(state => ({
			selectedItems: typeof next === "function" ? next(state.selectedItems) : next
		}))
	},
	toggleSelectedItem: item => {
		set(state => ({
			selectedItems: toggleInArray(state.selectedItems, item, driveItemId)
		}))
	},
	removeFromSelection: uuids => {
		set(state => {
			const toRemove = new Set(uuids)
			const next = state.selectedItems.filter(item => !toRemove.has(driveItemId(item)))

			// Avoid a needless state update (and re-render) when nothing was actually selected.
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
