export {
	type EmitPiece,
	type EmitRequest,
	type EmitResult,
	type FreshPptx,
	type PartsApi,
	type PptxEmitContext,
	type PptxEmitFamily,
	type PptxPartIndex,
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
export { IN_MEMORY_LIMIT, pptxSpliceWriter, savePptx, writeSnapshot } from "./write/save"
export { spliceSnapshot, type PptxSpliceSource, type SpliceSnapshot } from "./write/splice"
export { freshPptx } from "./write/fresh"
export { freshPptxSealed, savePptxSealed, type PptxSealer } from "./write/seal"
export type { SaveNotice } from "./write/parts"
