// Native HTML5 drag-and-drop for playlist track rows — the SAME idiom as features/drive/lib/dnd.ts
// (a module-level ref carries the live payload because dataTransfer only carries strings; the value on
// the transfer key is a marker, not the payload) applied to an in-list reorder instead of a cross-
// directory move. Deliberately its own tiny module rather than importing dnd.ts's internal-move
// machinery: that module's payload is a DriveItem[] destined for moveItems' worker round trip, while
// this one only ever carries a same-list array index and never leaves the client. No dnd-kit / no new
// dependency — package.json ships neither, and a single reorder list does not justify introducing one.
export const TRACK_DRAG_TYPE = "application/x-filen-track-reorder"

let draggedIndex: number | null = null

export function setDraggedTrackIndex(index: number): void {
	draggedIndex = index
}

export function getDraggedTrackIndex(): number | null {
	return draggedIndex
}

export function clearDraggedTrackIndex(): void {
	draggedIndex = null
}

export function isTrackReorderDrag(dataTransfer: DataTransfer | null): boolean {
	return dataTransfer?.types.includes(TRACK_DRAG_TYPE) ?? false
}
