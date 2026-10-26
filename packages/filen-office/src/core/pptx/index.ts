export {
	type EmitPiece,
	type EmitRequest,
	type EmitResult,
	type FreshPptx,
	type PartsApi,
	type PptxEmitContext,
	type PptxEmitFamily,
	type PptxPartKind,
	type PptxSaveInput,
	type PptxSaveOptions,
	type PptxSaveOutcome,
	type PptxSnapshot,
	type PptxSource,
	type SavePptx,
	type SpliceWriter
} from "./write/types"
export { emitFamilyOf, emitPptx, PPTX_EMIT_FAMILIES } from "./write/emit"
export { openPptx, openPptxPackage, PptxParts, type PptxOpen, type PptxOpenOptions } from "./package"
