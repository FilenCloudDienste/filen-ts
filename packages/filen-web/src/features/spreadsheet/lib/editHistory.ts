import type { DocState, EditOp } from "@/features/spreadsheet/lib/edits"

// Excel's own limit.
const HISTORY_LIMIT = 100

// `before` and `after` identify the document's states either side of the step: equal ids, equal content.
interface UndoEntry<S> {
	step: S
	op: EditOp
	before: number
	after: number
	weight: number
}

// A document's undo and redo history, S being what undoing one step needs. The oldest steps go once there
// are more than HISTORY_LIMIT or they snapshot more than `budget` cells in all, always keeping the latest.
// State ids are never reused, so a save point whose step falls out of history stays unreachable, and dirty
// stays true, without bookkeeping.
export class EditHistory<S> {
	private readonly undoSteps: UndoEntry<S>[] = []
	private redoSteps: { op: EditOp; after: number }[] = []
	private weight = 0
	// Identifies the current state; `saved` is the state last written to the file (0: as opened).
	private current = 0
	private nextState = 1
	private saved = 0
	private readonly weigh: (step: S) => number
	private readonly budget: number

	constructor(weigh: (step: S) => number, budget: number) {
		this.weigh = weigh
		this.budget = budget
	}

	// The current state's id.
	get version(): number {
		return this.current
	}

	state(): DocState {
		return { dirty: this.current !== this.saved, canUndo: this.undoSteps.length > 0, canRedo: this.redoSteps.length > 0 }
	}

	// A new edit's step: what could be redone is gone.
	record(step: S, op: EditOp): void {
		const after = this.nextState++

		this.push({ step, op, before: this.current, after, weight: this.weigh(step) })
		this.redoSteps = []
		this.current = after
	}

	peekUndo(): S | undefined {
		return this.undoSteps.at(-1)?.step
	}

	// The step peekUndo gave was reverted.
	popUndo(): void {
		const last = this.undoSteps.pop()

		if (last === undefined) {
			return
		}

		this.weight -= last.weight
		this.redoSteps.push({ op: last.op, after: last.after })
		this.current = last.before
	}

	peekRedo(): EditOp | undefined {
		return this.redoSteps.at(-1)?.op
	}

	// The op peekRedo gave was run again, as `step`.
	commitRedo(step: S): void {
		const redone = this.redoSteps.pop()

		if (redone === undefined) {
			return
		}

		this.push({ step, op: redone.op, before: this.current, after: redone.after, weight: this.weigh(step) })
		this.current = redone.after
	}

	markSaved(version: number): DocState {
		this.saved = version

		return this.state()
	}

	// As opened, with nothing to undo.
	untouched(): boolean {
		return this.current === 0 && this.undoSteps.length === 0
	}

	private push(entry: UndoEntry<S>): void {
		this.undoSteps.push(entry)
		this.weight += entry.weight

		while (this.undoSteps.length > 1 && (this.undoSteps.length > HISTORY_LIMIT || this.weight > this.budget)) {
			const dropped = this.undoSteps.shift()

			this.weight -= dropped?.weight ?? 0
		}
	}
}
