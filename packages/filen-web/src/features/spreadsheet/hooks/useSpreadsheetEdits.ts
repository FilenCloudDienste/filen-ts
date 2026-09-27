import { useRef, useState } from "react"
import { spreadsheetWorker } from "@/features/spreadsheet/lib/spreadsheetClient"
import { applyEditResult, type GridDoc } from "@/features/spreadsheet/lib/cellStore.logic"
import type { DocState, EditOp, EditResult } from "@/features/spreadsheet/lib/edits"

export interface SpreadsheetSnapshot {
	bytes: Uint8Array
	// Marks the snapshot saved: call once it is stored.
	commit: () => void
}

export interface SpreadsheetEdits {
	doc: GridDoc
	state: DocState
	// An edit is queued or in flight: the worker's `state` does not show it yet.
	pending: boolean
	apply: (op: EditOp) => Promise<EditResult>
	undo: () => Promise<EditResult>
	redo: () => Promise<EditResult>
	snapshot: () => Promise<SpreadsheetSnapshot>
}

// The grid's side of editing: every call to the worker goes through one queue (a later one never
// overtakes an earlier one, a save included), and each result folds into the view.
export function useSpreadsheetEdits(id: number, initial: GridDoc): SpreadsheetEdits {
	const [doc, setDoc] = useState(initial)
	const [state, setState] = useState<DocState>({ dirty: false, canUndo: false, canRedo: false })
	const [pending, setPending] = useState(0)
	const queue = useRef<Promise<unknown>>(Promise.resolve())

	function enqueue<T>(call: () => Promise<T>): Promise<T> {
		const next = queue.current.then(call)

		queue.current = next.catch(() => undefined)

		return next
	}

	function run(call: () => Promise<EditResult>): Promise<EditResult> {
		setPending(count => count + 1)

		return enqueue(call).then(
			result => {
				setDoc(prev => applyEditResult(prev, result))
				setState(result.state)
				setPending(count => count - 1)

				return result
			},
			(error: unknown) => {
				setPending(count => count - 1)

				throw error
			}
		)
	}

	async function snapshot(): Promise<SpreadsheetSnapshot> {
		const { bytes, version } = await enqueue(() => spreadsheetWorker().serialize(id))

		return {
			bytes,
			commit: () => {
				enqueue(() => spreadsheetWorker().markSaved(id, version)).then(setState, () => undefined)
			}
		}
	}

	// An undo or redo with nothing to undo or redo (none queued before it either) changes nothing: it is
	// not sent, so it never shows as a pending change.
	function step(possible: boolean, call: () => Promise<EditResult>): Promise<EditResult> {
		return possible || pending > 0 ? run(call) : Promise.resolve({ type: "none", state })
	}

	return {
		doc,
		state,
		pending: pending > 0,
		apply: op => run(() => spreadsheetWorker().apply(id, op)),
		undo: () => step(state.canUndo, () => spreadsheetWorker().undo(id)),
		redo: () => step(state.canRedo, () => spreadsheetWorker().redo(id)),
		snapshot
	}
}
