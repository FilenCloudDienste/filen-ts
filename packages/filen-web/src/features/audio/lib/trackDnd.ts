// Native HTML5 drag-and-drop for playlist track rows. The payload is the dragged track's uuid, carried in
// dataTransfer under TRACK_DRAG_TYPE: a plain string, so unlike features/drive/lib/dnd.ts (whose
// DriveItem[] payload needs a module-level ref) no shared state is kept here. A uuid rather than an index
// because the reorder resolves both ends against the freshest playlist copy, which may already differ from
// the rendered one. No dnd-kit / no new dependency — a single reorder list does not justify one.
export const TRACK_DRAG_TYPE = "application/x-filen-track-reorder"

// dataTransfer.getData is empty until drop, but the type list is readable throughout the drag.
export function isTrackReorderDrag(dataTransfer: DataTransfer | null): boolean {
	return dataTransfer?.types.includes(TRACK_DRAG_TYPE) ?? false
}
