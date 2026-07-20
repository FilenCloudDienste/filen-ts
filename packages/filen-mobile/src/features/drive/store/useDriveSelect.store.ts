import { create } from "zustand"
import type { DriveItem } from "@/types"

export type DriveSelectStore = {
	selectedItems: DriveItem[]
	// SelectOptions.id of the picker session the selection was last seeded for. One session spans
	// EVERY /driveSelect screen it pushes (the same selectOptions ride each subfolder push), so
	// seeding is keyed here instead of per screen instance — a subfolder push must not wipe the
	// selection accumulated on parent screens.
	seededSelectId: string | null
	setSelectedItems: (fn: DriveItem[] | ((prev: DriveItem[]) => DriveItem[])) => void
	// Seed the selection once per session: the first screen of a session (new id) applies the
	// caller's initial selection; every later screen of the SAME session is a no-op.
	seedSelectSession: (sessionId: string, initiallySelected: DriveItem[]) => void
	// End the session (its root screen unmounted): drop the selection and the session marker.
	endSelectSession: () => void
}

export const useDriveSelectStore = create<DriveSelectStore>(set => ({
	selectedItems: [],
	seededSelectId: null,
	setSelectedItems(fn) {
		set(state => ({
			selectedItems: typeof fn === "function" ? fn(state.selectedItems) : fn
		}))
	},
	seedSelectSession(sessionId, initiallySelected) {
		set(state => {
			if (state.seededSelectId === sessionId) {
				return state
			}

			return {
				seededSelectId: sessionId,
				selectedItems: initiallySelected
			}
		})
	},
	endSelectSession() {
		set({
			seededSelectId: null,
			selectedItems: []
		})
	}
}))

export default useDriveSelectStore
