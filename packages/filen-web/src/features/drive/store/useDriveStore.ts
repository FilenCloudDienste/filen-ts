import { create } from "zustand"
import { toggleInArray, removeSelectedIds } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"

const driveItemId = (item: DriveItem): string => item.data.uuid

// Set by the "Open containing directory" action just before it navigates; consumed exactly once by
// the DESTINATION listing (hooks/useDriveListboxNav.ts), which selects, scrolls to and focuses the
// row. Carries the destination splat too, so it can only ever fire on the listing it was meant for —
// and so an unrelated navigation can drop it instead of hijacking a later listing's cursor.
export interface PendingReveal {
	uuid: string
	splat: string
}

interface DriveState {
	selectedItems: DriveItem[]
	setSelectedItems: (next: DriveItem[] | ((prev: DriveItem[]) => DriveItem[])) => void
	toggleSelectedItem: (item: DriveItem) => void
	removeFromSelection: (uuids: string[]) => void
	clearSelectedItems: () => void
	pendingReveal: PendingReveal | null
	requestReveal: (reveal: PendingReveal) => void
	clearPendingReveal: () => void
}

export const useDriveStore = create<DriveState>(set => ({
	selectedItems: [],
	pendingReveal: null,
	requestReveal: reveal => {
		set({ pendingReveal: reveal })
	},
	clearPendingReveal: () => {
		set({ pendingReveal: null })
	},
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
			const next = removeSelectedIds(state.selectedItems, uuids, driveItemId)

			// Avoid a needless state update (and re-render) when nothing was actually selected.
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
