import { DRAG_THRESHOLD_PX, exceedsDragThreshold } from "@/lib/windowDrag"

// Pure geometry and target picking for the pointer drag engine (pointerDrag.ts), framework-free so the
// unit tests exercise it directly.

export { DRAG_THRESHOLD_PX }

export interface Point {
	x: number
	y: number
}

// The press has travelled far enough to be a drag rather than a click.
export function passedThreshold(start: Point, now: Point): boolean {
	return exceedsDragThreshold(now.x - start.x, now.y - start.y)
}

// How far past an edge the pointer has to be before it counts as having left the window: a pointer
// resting on the window's last pixel row or column is still inside.
const OUTSIDE_MARGIN_PX = 2

export function outsideWindow(p: Point, size: { width: number; height: number }): boolean {
	return (
		p.x <= -OUTSIDE_MARGIN_PX ||
		p.y <= -OUTSIDE_MARGIN_PX ||
		p.x >= size.width + OUTSIDE_MARGIN_PX ||
		p.y >= size.height + OUTSIDE_MARGIN_PX
	)
}

// Walks the chain of drop targets from the hit element outward and returns the nearest one that takes
// the payload: a target that refuses it (a no-op move onto the payload's own parent row) lets the drop
// through to the one enclosing it (the listing's own space).
export function pickDropTarget<T extends Element>(chain: readonly T[], accepts: (target: T) => boolean): T | null {
	return chain.find(accepts) ?? null
}
