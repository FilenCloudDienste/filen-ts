export {
	changeBarX,
	indexAnnotations,
	placeBalloons,
	useDocxAnnotations,
	type BalloonLayout,
	type BalloonPlacement,
	type DocxAnnotationAnchor,
	type DocxAnnotationIndex,
	type DocxPageAnnotations,
	type DocxThread
} from "./annotations/index"
export { DocxPages, type DocxPageFrame, type DocxPagesFind, type DocxPagesHandle, type DocxPagesProps } from "./DocxPages"
export { findInDocument, findMatchList, lineOf, matchTop, type DocxFindMatch, type DocxFindOptions } from "./find"
export { linkActivator, type DocxLinkPolicy } from "./links"
export { DEFAULT_MEDIA_LIMITS, DocxMediaCache, type MediaCacheLimits, type UrlFactory } from "./media"
export { DOCX_OBJECT_LABELS, paintObjects, type DocxObjectLabels, type ObjectPaintOptions } from "./paint/objects"
export { paintPage, type PagePaintContext, type PaintedObject, type PaintedPage, type PaintedText } from "./paint/page"
export { DocxDocumentStore, IDLE_DOCUMENT, type DocxDocument, type DocxSource, type DocxStatus, type DocxTables } from "./store"
export { useDocxDocument } from "./useDocxDocument"
export { useDocxViewer, type DocxViewer, type DocxViewerOptions } from "./useDocxViewer"
export { patchPage, type PaintedLine } from "./paint/page"
