import { type StateCreator } from "zustand"

/**
 * Zustand slice for multi-select state. Each domain composes this into its
 * store via `...createSelectionSlice(getId)(...)`. The `getId` function
 * captures how an item is identified (e.g., `n => n.uuid` for notes,
 * `i => i.data.uuid` for drive items) so the slice handles toggle and
 * dedup without per-domain wrappers.
 *
 * New domains (PlaylistTracks, FileVersions, NoteParticipants,
 * ChatParticipants) use this slice directly. Existing domains keep their
 * named fields (`selectedNotes`, `selectedItems`, etc.) for compatibility
 * and use {@link toggleInArray} from this file for the toggle boilerplate.
 */
export type SelectionSlice<T> = {
	selected: T[]
	setSelected: (fn: T[] | ((prev: T[]) => T[])) => void
	clearSelected: () => void
	toggleSelected: (item: T) => void
	selectAll: (items: T[]) => void
}

export function createSelectionSlice<T>(getId: (item: T) => string): StateCreator<SelectionSlice<T>> {
	return set => ({
		selected: [],
		setSelected(fn) {
			set(state => ({
				selected: typeof fn === "function" ? fn(state.selected) : fn
			}))
		},
		clearSelected() {
			set({ selected: [] })
		},
		toggleSelected(item) {
			set(state => ({
				selected: toggleInArray(state.selected, item, getId)
			}))
		},
		selectAll(items) {
			set({ selected: items })
		}
	})
}

/**
 * Add `item` to `arr` if absent (by id), remove if present. Returns a new
 * array — input is not mutated. Used by stores that keep their existing
 * field names alongside the factory methods.
 */
export function toggleInArray<T>(arr: T[], item: T, getId: (i: T) => string): T[] {
	const id = getId(item)
	const idx = arr.findIndex(i => getId(i) === id)

	if (idx >= 0) {
		return [...arr.slice(0, idx), ...arr.slice(idx + 1)]
	}

	return [...arr, item]
}

/**
 * Membership check by id. Cheaper than callers writing `.some(i => getId(i) === getId(item))`
 * inline and keeps the id-equality semantics consistent across surfaces.
 */
export function isItemSelected<T>(arr: T[], item: T, getId: (i: T) => string): boolean {
	const id = getId(item)

	return arr.some(i => getId(i) === id)
}

export default createSelectionSlice
