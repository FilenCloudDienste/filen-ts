import type { SlideRef } from "../../model"
import type { DeckOp, ZOrder } from "../ops"

// Bring Forward / Send Backward and their to-front, to-back forms: the shapes keep their order among themselves.

export type { ZOrder }

export const Z_ORDERS: readonly ZOrder[] = ["front", "forward", "backward", "back"]

// Whether the shapes (ids in z-order of the slide's top level, back to front) can move `to`: something not
// selected lies in that direction.
export function canZOrder(order: readonly number[], selected: ReadonlySet<number>, to: ZOrder): boolean {
	if (selected.size === 0) return false

	const up = to === "front" || to === "forward"
	let seenUnselected = false

	// From the far end in the direction of the move: an unselected shape before a selected one means it can pass.
	for (let k = 0; k < order.length; k++) {
		const id = order[up ? order.length - 1 - k : k] as number

		if (!selected.has(id)) seenUnselected = true
		else if (seenUnselected) return true
	}

	return false
}

export function zOrderOp(slide: SlideRef, ids: readonly number[], to: ZOrder): DeckOp | undefined {
	return ids.length === 0 ? undefined : { family: "shape", kind: "zOrder", slide, shapes: [...ids], to }
}
