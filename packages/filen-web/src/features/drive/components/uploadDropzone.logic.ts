// Depth counter for the drag-over highlight (uploadDropzone.tsx): dragenter/dragleave bubble up
// from every descendant element the cursor crosses, not just the zone's own edges — a naive
// dragover-sets-true / dragleave-sets-false boolean would flicker the highlight off each time the
// cursor passes over a row inside the zone. Incrementing on enter and decrementing on leave (floored
// at zero) keeps the zone "active" for the whole time the cursor is anywhere inside it, no matter how
// many descendants it crosses along the way.
export function enterDragDepth(depth: number): number {
	return depth + 1
}

export function leaveDragDepth(depth: number): number {
	return Math.max(0, depth - 1)
}
