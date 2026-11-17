export { bundledFace, bundledFaces, type BundledFace, type LineMetricsEntry, type OriginalMetrics } from "./bundled"
export {
	declareDocxEmbeddedFonts,
	readDocxEmbeddedFont,
	readDocxFontTable,
	type DocxFontDeclaration,
	type EmbeddedFontRef,
	type EmbeddedStyle
} from "./docx"
export {
	DEFAULT_EOT_LIMITS,
	decodeEot,
	decodeMtx,
	embeddedFontData,
	isEot,
	isSfnt,
	readEotHeader,
	type EotHeader,
	type EotLimits
} from "./eot"
export { FontError, type FontErrorCode } from "./errors"
export type { FontAssets, FontFaceDescriptor, FontHost } from "./host"
export {
	DEFAULT_FONT_LIMITS,
	FontManager,
	cssFont,
	glyphWidthScale,
	type EmbeddedFontFailure,
	type EmbeddedFontReader,
	type FaceRegistration,
	type FontDeclaration,
	type FontLimits,
	type FontRequest,
	type FontSource,
	type MetricsBasis,
	type ResolvedFont
} from "./manager"
export { lineSpacingUnits, verticalMetrics, type LineSpacingRule, type VerticalMetrics } from "./metrics"
export { deobfuscateFont, obfuscateFont, parseFontKey } from "./obfuscation"
export { SfntFont, cmapCoverage, readNameValues, readSfnt, sfntDirectory, type SfntNames, type SfntTable } from "./sfnt"
export {
	DEFAULT_SLOT_CONTEXT,
	eastAsiaUsesAscii,
	fontSlot,
	forEachSlotRun,
	isChineseCharset,
	isChineseLanguage,
	type FontHint,
	type FontSlot,
	type SlotContext
} from "./slots"
export {
	ARIAL_NARROW_WIDTH_SCALE,
	NO_HINTS,
	SUBSTITUTIONS,
	UNCALIBRATED_APTOS_DISPLAY_SCALE,
	UNCALIBRATED_APTOS_NARROW_SCALE,
	UNCALIBRATED_APTOS_SCALE,
	fallbackFor,
	type BundledFamily,
	type Fallback,
	type FontClass,
	type FontHints,
	type FontPitch,
	type GenericFamily,
	type Substitution
} from "./substitutes"
export { symbolTable, symbolText, symbolToUnicode, type SymbolTable } from "./symbols"
export { BUNDLED_FACES, CLONE_METRICS, LINE_METRICS } from "./tables.generated"
export {
	FONT_INFO_NAME_IDS,
	FONT_INFO_TABLES,
	fontInfoTables,
	readFontInfo,
	sfntInfoTables,
	type FontAxis,
	type FontInfo,
	type FontName,
	type FontOutlines
} from "./info"
export {
	FONT_MAX_TABLE_BYTES,
	decompressBrotli,
	fontContainer,
	readWoff2Directory,
	readWoff2Tables,
	readWoffTables,
	woff2Tables,
	type FontContainer,
	type FontTableSet,
	type Woff2Directory
} from "./woff"
