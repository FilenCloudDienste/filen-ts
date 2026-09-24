import { create } from "zustand"
import type { DriveItem } from "@/types"

// The items a picker session acts on (moved, copied, or excluded from a pick) and its preselection, kept
// here rather than in the route params: each screen the session pushes would otherwise re-serialize
// them, keys included.
export type DriveSelectSession = {
	items: DriveItem[]
	itemUuids: ReadonlySet<string>
	initiallySelected: DriveItem[] | undefined
}

export type DriveSelectStore = {
	selectedItems: DriveItem[]
	sessions: Record<string, DriveSelectSession>
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
	openSession: (sessionId: string, items: DriveItem[], initiallySelected?: DriveItem[]) => void
	closeSession: (sessionId: string) => void
}

export const useDriveSelectStore = create<DriveSelectStore>(set => ({
	selectedItems: [],
	sessions: {},
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
	},
	openSession(sessionId, items, initiallySelected) {
		set(state => ({
			sessions: {
				...state.sessions,
				[sessionId]: {
					items,
					itemUuids: new Set(items.map(item => item.data.uuid)),
					initiallySelected
				}
			}
		}))
	},
	closeSession(sessionId) {
		set(state => {
			if (!state.sessions[sessionId]) {
				return state
			}

			const { [sessionId]: _closed, ...sessions } = state.sessions

			return {
				sessions
			}
		})
	}
}))

// A plain read for render code: a session is opened before its first screen is pushed and is fixed for its
// lifetime, so nothing needs to subscribe. Not named use*, because the React Compiler skips a hook that
// references a hook as a value (useDriveSelectStore.getState).
export function getDriveSelectSession(sessionId: string): DriveSelectSession | undefined {
	return useDriveSelectStore.getState().sessions[sessionId]
}

export default useDriveSelectStore
