import { useEffect, useRef, useState } from "react"
import { useLatestRef } from "@/lib/useLatestRef"
import { withOpenSpreadsheet } from "@/features/spreadsheet/lib/spreadsheetClient"
import { applyEditResult, type GridDoc } from "@/features/spreadsheet/lib/cellStore.logic"
import type { AxisEdit, DocState, EditOp, EditResult } from "@/features/spreadsheet/lib/edits"

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
// overtakes an earlier one, a save included), and each result folds into the view. `onShift` hears where a
// CSV's rows or columns moved (edit, undo or redo), for the sizes kept beside it.
export function useSpreadsheetEdits(
	id: number,
	initial: GridDoc,
	onShift?: (sheet: number, shift: AxisEdit & { revert: boolean }) => void
): SpreadsheetEdits {
	const [doc, setDoc] = useState(initial)
	const [state, setState] = useState<DocState>({ dirty: false, canUndo: false, canRedo: false })
	const [pending, setPending] = useState(0)
	const queue = useRef<Promise<unknown>>(Promise.resolve())
	// The latest, for results that land after the render that asked for them.
	const onShiftRef = useLatestRef(onShift)

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

				if (result.type === "shifted") {
					onShiftRef.current?.(result.sheet, result.shift)
				}

				return result
			},
			(error: unknown) => {
				setPending(count => count - 1)

				throw error
			}
		)
	}

	async function snapshot(): Promise<SpreadsheetSnapshot> {
		const { bytes, version } = await enqueue(() => withOpenSpreadsheet(id, (remote, workerId) => remote.serialize(workerId)))

		return {
			bytes,
			commit: () => {
				enqueue(() => withOpenSpreadsheet(id, (remote, workerId) => remote.markSaved(workerId, version))).then(
					setState,
					() => undefined
				)
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
		apply: op => run(() => withOpenSpreadsheet<EditResult>(id, (remote, workerId) => remote.apply(workerId, op))),
		undo: () => step(state.canUndo, () => withOpenSpreadsheet<EditResult>(id, (remote, workerId) => remote.undo(workerId))),
		redo: () => step(state.canRedo, () => withOpenSpreadsheet<EditResult>(id, (remote, workerId) => remote.redo(workerId))),
		snapshot
	}
}

export type Writability = "checking" | "writable" | "readOnly"

// Whether the open document may be edited and saved. A workbook opens unproven: the worker proves that
// saving it loses nothing, and until that answers nothing may be sent to it (an edit before the verdict
// would make it view-only). Asked once editing could follow (`wanted`, which may turn true later); a file
// that will never be edited here (`neverEditable`) tells the worker to skip the proof instead. An answer
// arriving after the viewer has gone is ignored, as the document is closed by then.
export function useSpreadsheetWritability(
	id: number,
	doc: Pick<GridDoc, "kind" | "writable">,
	wanted: boolean,
	neverEditable: boolean
): Writability {
	const proven = doc.kind === "xlsx"
	const [verdict, setVerdict] = useState<boolean | null>(null)

	useEffect(() => {
		if (!proven || !neverEditable) {
			return
		}

		void withOpenSpreadsheet(id, (remote, workerId) => remote.viewOnly(workerId)).catch(() => undefined)
	}, [id, proven, neverEditable])

	useEffect(() => {
		if (!proven || neverEditable || !wanted || verdict !== null) {
			return undefined
		}

		let live = true

		withOpenSpreadsheet(id, (remote, workerId) => remote.writability(workerId)).then(
			writable => {
				if (live) {
					setVerdict(writable)
				}
			},
			() => {
				if (live) {
					setVerdict(false)
				}
			}
		)

		return () => {
			live = false
		}
	}, [id, proven, neverEditable, wanted, verdict])

	if (!proven) {
		return doc.writable ? "writable" : "readOnly"
	}

	return verdict === null ? "checking" : verdict ? "writable" : "readOnly"
}
