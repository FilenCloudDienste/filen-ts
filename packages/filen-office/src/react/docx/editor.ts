// Paged editing (a separate entry: the viewer does not load ProseMirror's view).
export {
	DocxEditor,
	type ClientPoint,
	type DocxEditorHandle,
	type DocxEditorInteractions,
	type DocxEditorProps,
	type DocxObjectPress,
	type DocxPageOverlay
} from "./DocxEditor"
export {
	DRAWING_HANDLES,
	CropDrag,
	DrawingDrag,
	EMU_PER_PAGE_PX,
	MIN_DRAWING_PX,
	cropSides,
	handleCursor,
	handlePoints,
	moveCommand,
	previewTransform,
	resizeCommand,
	resizedBox,
	type CropSide,
	type DrawingHandle,
	type PageBox
} from "./edit/objects"
export { EditSink, plainText, type EditSinkOptions } from "./edit/sink"
export { paintMath } from "./paint/math"
export { DOCX_MARK_LABELS, paintMarks, type DocxMarkLabels, type PageMarksContext } from "./paint/marks"
export { paintThumbnail, thumbnailHeight, type ThumbnailCanvas, type ThumbnailContext } from "./paint/thumbnail"
export { EditSurface, type DocxEditorMark } from "./edit/surface"
export { useDocxEditor, type DocxEditorControls, type DocxEditorState } from "./useDocxEditor"
export * from "./reflow/index"
