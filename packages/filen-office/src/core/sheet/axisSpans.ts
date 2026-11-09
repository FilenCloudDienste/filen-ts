import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetAxisMove, type SheetAxisSpan, type SheetRefusal } from "./protocol"
import type { SheetChangeSink, SheetEditStep, SheetHandled } from "./registry"

// axis.insert and axis.delete over several spans: each span moved on its own, the last first, so the spans before it
// are where the command named them; the moves are one step. A span refused after others moved takes those back.

// The spans a command names, as given.
export function axisMoveSpans(command: SheetAxisMove): readonly SheetAxisSpan[] {
	return "spans" in command ? command.spans : [{ at: command.at, count: command.count }]
}

// The spans in the order they are moved (the last first), or why they cannot be: past `limit` or empty (tooLarge),
// or overlapping another (as Excel refuses overlapping selections).
export function orderedAxisSpans(spans: readonly SheetAxisSpan[], limit: number): readonly SheetAxisSpan[] | SheetRefusal {
	if (spans.length === 0) return { reason: "tooLarge" }

	for (const { at, count } of spans)
		if (!Number.isInteger(at) || !Number.isInteger(count) || at < 0 || count <= 0 || at + count > limit) return { reason: "tooLarge" }

	if (spans.length === 1) return spans

	const ordered = [...spans].sort((a, b) => b.at - a.at)

	for (let k = 1; k < ordered.length; k++) {
		const later = ordered[k - 1] as SheetAxisSpan
		const earlier = ordered[k] as SheetAxisSpan

		if (earlier.at + earlier.count > later.at) return { reason: "multipleSelection", detail: "overlapping" }
	}

	return ordered
}

// A command's spans in the order they are moved, or why they cannot be.
export function axisMoveOrder(command: SheetAxisMove): readonly SheetAxisSpan[] | SheetRefusal {
	return orderedAxisSpans(axisMoveSpans(command), command.axis === "rows" ? SHEET_MAX_ROWS : SHEET_MAX_COLS)
}

// Runs `move` on each span in order, as one step: null when none changed anything.
export async function moveAxisSpans(
	spans: readonly SheetAxisSpan[] | SheetRefusal,
	changes: SheetChangeSink,
	move: (span: SheetAxisSpan) => SheetHandled | Promise<SheetHandled>
): Promise<SheetHandled> {
	if ("reason" in spans) return { refused: spans }

	const only = spans.length === 1 ? spans[0] : undefined

	if (only !== undefined) return move(only)

	const steps: SheetEditStep[] = []

	for (const span of spans) {
		const handled = await move(span)

		if (handled === null) continue

		if ("refused" in handled) {
			// What the earlier spans changed goes back; the session reports nothing of a refused command.
			for (let k = steps.length - 1; k >= 0; k--) await steps[k]?.undo(changes)

			return handled
		}

		steps.push(handled)
	}

	if (steps.length === 0) return null

	return {
		bytes: steps.reduce((sum, step) => sum + step.bytes, 0),
		undo: async sink => {
			for (let k = steps.length - 1; k >= 0; k--) await steps[k]?.undo(sink)
		},
		redo: async sink => {
			for (const step of steps) await step.redo(sink)
		}
	}
}
