// The actions whose handlers are mounted right now, for the command palette: every useAction registers here while it
// is mounted and enabled, so the palette offers what the keys would run on this screen and runs the same handler.

export interface LiveAction {
	readonly id: string
	// Whether the key would reach the handler with focus on `focus`: enabled, and focus inside the element the action
	// is scoped to, when it is.
	available: (focus: Element | null) => boolean
	// The handler behind the action's own guard; a no-op when the guard stands it down.
	run: (event: KeyboardEvent) => void
}

// Per id, in mount order: the last mounted one that is available wins, as the innermost surface does.
const live = new Map<string, LiveAction[]>()

export function registerLiveAction(action: LiveAction): () => void {
	const stack = live.get(action.id)

	if (stack === undefined) {
		live.set(action.id, [action])
	} else {
		stack.push(action)
	}

	return () => {
		const current = live.get(action.id)

		if (current === undefined) {
			return
		}

		const left = current.filter(entry => entry !== action)

		if (left.length === 0) {
			live.delete(action.id)
		} else {
			live.set(action.id, left)
		}
	}
}

function availableEntry(id: string, focus: Element | null): LiveAction | undefined {
	return live.get(id)?.findLast(entry => entry.available(focus))
}

// The ids that would run with focus on `focus`.
export function liveActionIds(focus: Element | null): string[] {
	return [...live.keys()].filter(id => availableEntry(id, focus) !== undefined)
}

// The event a palette run hands the handler: not a keydown, so no key listener matches it, and dispatched on the
// element focus was on, so a handler reading its target sees where the user was.
export const PALETTE_RUN_EVENT = "filenpaletterun"

// Runs the action as its key would with focus on `focus`. False when no handler for it is mounted there now.
export function runLiveAction(id: string, focus: Element | null): boolean {
	const entry = availableEntry(id, focus)

	if (entry === undefined) {
		return false
	}

	const event = new KeyboardEvent(PALETTE_RUN_EVENT, { cancelable: true })

	if (focus?.isConnected === true) {
		focus.addEventListener(
			PALETTE_RUN_EVENT,
			() => {
				entry.run(event)
			},
			{ once: true }
		)
		focus.dispatchEvent(event)
	} else {
		entry.run(event)
	}

	return true
}
