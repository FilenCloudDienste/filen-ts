// Toast geometry this app hands to sonner (see components/ui/sonner.tsx) — owned here so the overlap
// test below measures the column sonner actually draws. Values are sonner's own defaults.
export const TOAST_EDGE_OFFSET_PX = 24
export const TOAST_MOBILE_EDGE_OFFSET_PX = 16
export const TOAST_WIDTH_PX = 356
// Mirrors sonner's stylesheet `@media (max-width: 600px)`, below which toasts span the viewport and
// read the mobile offsets. Not configurable through its props.
export const TOAST_MOBILE_MAX_WIDTH_PX = 600

export interface ObstructionRect {
	top: number
	left: number
	right: number
	width: number
	height: number
}

export interface Viewport {
	width: number
	height: number
}

// How far above the viewport's bottom edge the toast stack must start to clear every obstruction that
// shares the toasts' column: the distance from the bottom edge up to the highest overlapping top edge.
// Measuring the top edge (not summing heights) is what makes stacked bars — a selection bar floating
// above the docked audio player — resolve to the taller combined clearance on their own.
export function computeToastClearance({
	obstructions,
	viewport
}: {
	obstructions: readonly ObstructionRect[]
	viewport: Viewport
}): number {
	const mobile = viewport.width <= TOAST_MOBILE_MAX_WIDTH_PX
	const columnRight = viewport.width - TOAST_EDGE_OFFSET_PX
	const columnLeft = columnRight - TOAST_WIDTH_PX
	let clearance = 0

	for (const rect of obstructions) {
		// Zero area = unmounted from layout (e.g. a bar inside the closed narrow-layout drawer).
		if (rect.width <= 0 || rect.height <= 0) {
			continue
		}

		// Mobile toasts span the whole width, so everything shares their column; skipping the test there
		// also keeps a bar mid-slide in the drawer from reading as off to the side.
		if (!mobile && (rect.right <= columnLeft || rect.left >= columnRight)) {
			continue
		}

		clearance = Math.max(clearance, viewport.height - rect.top)
	}

	return Math.max(0, Math.ceil(clearance))
}

// The stack rests one edge offset above whatever it clears, the same breathing room it has above the
// bare viewport edge. The safe-area term wins only when nothing is being cleared (a bar measured above
// the home indicator already sits clear of it).
export function toastBottomOffset({ clearance, edge }: { clearance: number; edge: number }): string {
	const flush = `calc(${String(edge)}px + env(safe-area-inset-bottom, 0px))`

	return clearance > 0 ? `max(${String(clearance + edge)}px, ${flush})` : flush
}
