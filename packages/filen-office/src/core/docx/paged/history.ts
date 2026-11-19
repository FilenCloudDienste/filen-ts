import { isHistoryTransaction, redoDepth, undoDepth } from "prosemirror-history"
import type { EditorState, Transaction } from "prosemirror-state"

// One undo order across the stories a document's editor edits. Each story's session keeps its own history;
// this records which story received each history event, in order, so undo takes back the most recent edit
// wherever it was (entering that story first, as Word moves to the header). O(1) per event.

// Events remembered at most (sessions keep 100 each by default).
const MAX_EVENTS = 10_000

export class DocumentHistory<S> {
	private readonly undos: S[] = []
	private readonly redos: S[] = []
	private readonly depths = new Map<S, { undo: number; redo: number }>()
	private versionValue = 0

	// Changes whenever what undo or redo would do changes.
	get version(): number {
		return this.versionValue
	}

	// A story whose session's history starts as `state` has it (events it already holds count as older than
	// everything recorded so far).
	track(story: S, state: EditorState): void {
		const undo = undoDepth(state)

		this.depths.set(story, { undo, redo: redoDepth(state) })

		for (let k = 0; k < undo; k++) this.undos.unshift(story)
	}

	// A story's session applied `transactions` and is now at `state`.
	record(story: S, transactions: readonly Transaction[], state: EditorState): void {
		const depth = this.depths.get(story) ?? { undo: 0, redo: 0 }
		const undo = undoDepth(state)
		const redo = redoDepth(state)

		this.depths.set(story, { undo, redo })

		if (undo === depth.undo && redo === depth.redo) return

		// The version changes only when what undo or redo would do may change (not with every keystroke).
		let changed = false

		if (transactions.some(tr => isHistoryTransaction(tr))) {
			// The session undid or redid itself (its own keys, a menu): the event moves between the stacks.
			if (undo < depth.undo) move(this.undos, this.redos, story)
			else if (undo > depth.undo) move(this.redos, this.undos, story)

			changed = true
		} else if (undo !== depth.undo) {
			// A new event (the depth also drops when the session's bounded history cut its oldest ones).
			changed = this.undos[this.undos.length - 1] !== story || this.redos.length > 0 || depth.undo === 0
			this.undos.push(story)
			this.redos.length = 0

			if (this.undos.length > MAX_EVENTS) this.undos.splice(0, this.undos.length - MAX_EVENTS)
		} else if (this.redos.length > 0) {
			// An edit joining the last event still drops the redo stack, as the session's own does.
			this.redos.length = 0
			changed = true
		}

		if (changed) this.versionValue++
	}

	// The story whose edit undo takes back next (skipping events a session no longer holds: its history is
	// bounded), or undefined.
	nextUndo(undoable: (story: S) => boolean): S | undefined {
		return next(this.undos, undoable)
	}

	nextRedo(redoable: (story: S) => boolean): S | undefined {
		return next(this.redos, redoable)
	}
}

function move<S>(from: S[], to: S[], story: S): void {
	const index = from.lastIndexOf(story)

	if (index >= 0) from.splice(index, 1)

	to.push(story)
}

// The top of `stack` that can still act, dropping those above it that cannot.
function next<S>(stack: S[], can: (story: S) => boolean): S | undefined {
	while (stack.length > 0) {
		const top = stack[stack.length - 1] as S

		if (can(top)) return top

		stack.pop()
	}

	return undefined
}
