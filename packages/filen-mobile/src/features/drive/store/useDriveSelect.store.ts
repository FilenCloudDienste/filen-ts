import { create } from "zustand"
import type { DriveItem } from "@/types"

// The items a picker session acts on (moved, copied, or excluded from a pick) and its selection, kept
// here rather than in the route params: each screen the session pushes would otherwise re-serialize
// them, keys included. One session spans every /driveSelect screen it pushes, so the selection
// accumulated on parent screens survives subfolder pushes and is dropped with the session.
export type DriveSelectSession = {
	items: DriveItem[]
	itemUuids: ReadonlySet<string>
	selectedItems: DriveItem[]
}

export type DriveSelectStore = {
	sessions: Record<string, DriveSelectSession>
	// No-op once the session is closed.
	setSelectedItems: (sessionId: string, fn: DriveItem[] | ((prev: DriveItem[]) => DriveItem[])) => void
	openSession: (sessionId: string, items: DriveItem[], initiallySelected?: DriveItem[]) => void
	closeSession: (sessionId: string) => void
}

const NO_SELECTION: DriveItem[] = []

export const useDriveSelectStore = create<DriveSelectStore>(set => ({
	sessions: {},
	setSelectedItems(sessionId, fn) {
		set(state => {
			const session = state.sessions[sessionId]

			if (!session) {
				return state
			}

			return {
				sessions: {
					...state.sessions,
					[sessionId]: {
						...session,
						selectedItems: typeof fn === "function" ? fn(session.selectedItems) : fn
					}
				}
			}
		})
	},
	openSession(sessionId, items, initiallySelected) {
		set(state => ({
			sessions: {
				...state.sessions,
				[sessionId]: {
					items,
					itemUuids: new Set(items.map(item => item.data.uuid)),
					selectedItems: initiallySelected ?? NO_SELECTION
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

// A session's selection for store selectors; a missing session (closed, or a process-restored route)
// reads as one stable empty selection.
export function selectDriveSelectSelection(state: DriveSelectStore, sessionId: string | undefined): DriveItem[] {
	return (sessionId ? state.sessions[sessionId]?.selectedItems : undefined) ?? NO_SELECTION
}

// A plain read for render code: a session's items are set when it is opened, before its first screen is
// pushed, and never change, so nothing needs to subscribe. Not named use*, because the React Compiler
// skips a hook that references a hook as a value (useDriveSelectStore.getState).
export function getDriveSelectSession(sessionId: string): DriveSelectSession | undefined {
	return useDriveSelectStore.getState().sessions[sessionId]
}

export default useDriveSelectStore
