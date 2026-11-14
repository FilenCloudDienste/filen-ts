export { OcrClient, OcrError, type OcrWorkerLike } from "./client"
export { applyOcrPage, fitOcrOverlay, ocrPageSummary, renderPageForOcr, type OcrGraft, type OcrPageEdit, type OcrRender } from "./page"
export { textStrip, rotateGray, type GrayImage } from "./pixels"
export { runOcrPages, type OcrPageOutcome, type OcrPipeline, type OcrRenderedPage, type OcrRunReport } from "./pipeline"
export {
	isFromOcr,
	isToOcr,
	OCR_ENGINE_VARIANTS,
	type FromOcr,
	type OcrArgs,
	type OcrAssets,
	type OcrEngineAssets,
	type OcrEngineVariant,
	type OcrFailure,
	type OcrHeapReport,
	type OcrModel,
	type OcrModelAsset,
	type OcrOp,
	type OcrOps,
	type OcrPageResult,
	type OcrRecogniseArgs,
	type OcrValue,
	type ToOcr
} from "./protocol"
export { serveOcr, type OcrHost, type OcrScope } from "./server"
export type { TesseractCore, TesseractFactory, TesseractInstance, TesseractModule } from "./tesseract"
