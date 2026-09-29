import { create } from "zustand"
import { toggleInArray, removeSelectedIds, pruneSelection } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"
import { driveRowKey } from "@/features/drive/lib/rowKey"

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
	pruneSelection: (keep: (item: DriveItem) => boolean) => void
	removeRowsFromSelection: (rows: DriveItem[]) => void
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
	// By row: toggling one Shared by me receiver's row leaves the item's other receiver rows alone.
	toggleSelectedItem: item => {
		set(state => ({
			selectedItems: toggleInArray(state.selectedItems, item, driveRowKey)
		}))
	},
	// By uuid: used where the item itself left the listing or the action applies to the whole item, so
	// every receiver row of it goes too. Unshare, which removes only one receiver's row, prunes by row.
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
	// Drops every selected row failing `keep`; same no-op-without-update rule as removeFromSelection.
	pruneSelection: keep => {
		set(state => {
			const next = pruneSelection(state.selectedItems, keep)

			return next === state.selectedItems ? state : { selectedItems: next }
		})
	},
	removeRowsFromSelection: rows => {
		set(state => {
			if (rows.length === 0) {
				return state
			}

			const keys = new Set(rows.map(driveRowKey))
			const next = state.selectedItems.filter(item => !keys.has(driveRowKey(item)))

			return next.length === state.selectedItems.length ? state : { selectedItems: next }
		})
	},
	clearSelectedItems: () => {
		set({ selectedItems: [] })
	}
}))
