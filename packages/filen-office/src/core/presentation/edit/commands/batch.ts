import type { DeckOp } from "../ops"

// A command that takes several ops (Duplicate of several slides, Ungroup of several groups) sends them as one: a
// batch, applied all or nothing and undone in one step, as PowerPoint undoes the command. Returned as a list of at
// most one op, so a caller that runs a list runs it unchanged.
export function oneStep(ops: readonly DeckOp[]): DeckOp[] {
	if (ops.length < 2) return [...ops]

	return [{ family: "batch", kind: "batch", ops }]
}
