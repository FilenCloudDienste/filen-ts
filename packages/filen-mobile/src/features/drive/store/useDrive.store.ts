import { create } from "zustand"
import { removeSelectedIds, toggleInArray } from "@filen/shared"
import type { DriveItem } from "@/types"

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

export const clearDriveSelection = () => useDriveStore.getState().clearSelectedItems()

type SelectionIndex = {
	typed: Set<string>
	uuids: Set<string>
}

// Every mounted row runs its selection selector on each store change (frozen screens included), so a linear scan
// costs rows × selected per toggle. The store always replaces selectedItems, never mutates it, so an index keyed
// by array identity cannot go stale.
const selectionIndexes = new WeakMap<readonly DriveItem[], SelectionIndex>()

function selectionIndex(selection: readonly DriveItem[]): SelectionIndex {
	let index = selectionIndexes.get(selection)

	if (!index) {
		index = {
			typed: new Set(),
			uuids: new Set()
		}

		for (const item of selection) {
			index.typed.add(`${item.type}\u0000${item.data.uuid}`)
			index.uuids.add(item.data.uuid)
		}

		selectionIndexes.set(selection, index)
	}

	return index
}

// Matches on uuid and type.
export function isDriveItemInSelection(selection: readonly DriveItem[], item: DriveItem): boolean {
	return selection.length > 0 && selectionIndex(selection).typed.has(`${item.type}\u0000${item.data.uuid}`)
}

// Matches on uuid alone.
export function isUuidSelected(selection: readonly DriveItem[], uuid: string): boolean {
	return selection.length > 0 && selectionIndex(selection).uuids.has(uuid)
}

export default useDriveStore
