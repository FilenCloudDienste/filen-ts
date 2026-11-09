export {
	DEFAULT_MARKUP_MODE,
	DOCX_MARKUP_MODES,
	DOCX_REVISION_COLORS,
	EMPTY_ANNOTATIONS,
	RECT_FLOATS,
	markupInfo,
	parseDocxMarkupMode,
	revisionColor,
	type DocxAnnotations,
	type DocxComment,
	type DocxCommentRun,
	type DocxMarkupInfo,
	type DocxMarkupMode,
	type DocxRevision,
	type DocxRevisionKind,
	type DocxRevisionTarget
} from "./annotations"
export {
	heldSource,
	type DocxAbortSignal,
	type DocxDocumentUnlock,
	type DocxEncryptionRefusal,
	type DocxLockedDocument,
	type DocxProtectedOpen,
	type DocxProtection,
	type DocxProtectionOptions,
	type DocxTakenPackage,
	type DocxUnlockedDocument
} from "./protection"
export { inThreadDocxProtection } from "./protectionWorker"
export { DocxEngine, type DocxEmit, type DocxEngineOptions, type DocxEngineServices } from "./engine"
export { findMatches, lineOf, type FindablePage } from "./find"
export {
	docxWorkerPool,
	inThreadDocxHost,
	macrotaskYield,
	serveDocxWorker,
	type DocxHost,
	type DocxListener,
	type DocxWorkerLike,
	type DocxWorkerPool,
	type DocxWorkerScope
} from "./host"
export {
	inThreadDocxLegacy,
	type DocNotConverted,
	type DocNotConvertedKind,
	type DocxConvertedDocument,
	type DocxLegacy,
	type DocxLegacyOpen,
	type DocxLegacyRefusal
} from "./legacy"
export { parseHyperlinkField } from "./links"
export * from "./protocol"
export {
	DocxClosedError,
	DocxZipWorkerError,
	docxZipWorker,
	inThreadDocxZipper,
	serveDocxZipWorker,
	type DocxZipped,
	type DocxZipper,
	type DocxZipperFactory
} from "./save"
export { fetchFontAssets, hyphenationLibrary, windowServices, workerServices, type FontLocation } from "./services"
export {
	DOCX_MAX_ZOOM,
	DOCX_MIN_ZOOM,
	DOCX_VIEWER_CAPABILITIES,
	DOCX_VIEWER_COMMANDS,
	DOCX_ZOOM_STEPS,
	canZoomIn,
	canZoomOut,
	clampZoom,
	fitWidthZoom,
	isDocxCommandEnabled,
	parseDocxViewerCommand,
	stepZoom,
	type DocxCapabilities,
	type DocxCommandGroup,
	type DocxCommandInfo,
	type DocxViewerCommand,
	type DocxViewerCommandType,
	type DocxViewerState
} from "./viewer"
