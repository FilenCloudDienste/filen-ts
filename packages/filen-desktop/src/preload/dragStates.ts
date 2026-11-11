import type { DesktopDragState } from "@filen/shared/desktop"

// The latest drag state per live id, replayed to a listener that joins after main sent it; an id goes with its end.
export function createDragStates(): {
	push(state: DesktopDragState): void
	latest(): DesktopDragState[]
	clear(): void
} {
	const states = new Map<string, DesktopDragState>()

	return {
		push: state => {
			if (state.state === "ended") {
				states.delete(state.id)
			} else {
				states.set(state.id, state)
			}
		},
		latest: () => [...states.values()],
		clear: () => {
			states.clear()
		}
	}
}
