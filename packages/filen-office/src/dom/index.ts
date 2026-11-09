export { fontFaceHost, localSource, type FontFaceScope } from "./fontFaceHost"
export { canMeasureOffscreen, canvasMeasurer, offscreenMeasurer, type CanvasContextLike, type OffscreenCanvasScope } from "./canvasMeasurer"
export {
	NEW_PROTECTION_SPIN_COUNT,
	hashDocumentProtectionPassword,
	hashProtectionPassword,
	verifyProtectionPassword,
	type NewProtectionHash,
	type ProtectionVerdict
} from "./protection"
