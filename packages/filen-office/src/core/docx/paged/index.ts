export { DocumentEdits, StoryEdits, type OverlayRecord, type StoryChange, type TopEntry } from "./edits"
export { MarkBoxes, PagedGeometry, type Affinity, type CaretBox, type HitResult, type PageRect, type PageSource } from "./geometry"
export { DocumentHistory } from "./history"
export { offsetMap, type OffsetMap, type SourceMap } from "./maps"
export { OBJECT_HIT_PROVIDERS, hitObject, type ObjectHit, type ObjectHitKind, type ObjectHitProvider } from "./objects"
export { PageIndex } from "./pages"
export {
	canMoveOutlineEntry,
	countRange,
	countSession,
	docxLineCount,
	docxOutline,
	docxRangeLayout,
	docxWordCount,
	goToOutlineEntry,
	moveOutlineEntry,
	outlineEntryAt,
	outlineSectionEnd,
	type DocxOutline,
	type DocxOutlineEntry,
	type DocxQuerySlicing,
	type DocxTextCount,
	type DocxWordCount,
	type DocxWordCountOptions
} from "./queries"
export {
	docxComments,
	type CommentHost,
	type DocxComment,
	type DocxCommentAnchor,
	type DocxComments,
	type DocxCommentThread
} from "../review/comments"
export {
	PagedEditor,
	type DocxFormatPainter,
	type EditedStory,
	type PagedEditorEvent,
	type PagedEditorOptions,
	type PagedSelection
} from "./editor"
export {
	DOCX_KEYS,
	besideNode,
	docxKeyBindings,
	docxKeyDefault,
	docxKeyFor,
	joinBackward,
	joinForward,
	lineBreak,
	selectAll,
	splitParagraph,
	type DocxAppKey,
	type DocxKey,
	type DocxKeyBindings,
	type DocxKeyRun,
	type KeyLike
} from "./keys"
export { tableBorderOf, type DocxTableBorder } from "../edit/tables/hits"
export * from "./annotations"
export * from "./uiQueries"
