export {
	ARGUMENT_LABELS,
	MAX_FUNCTION_ARGUMENTS,
	sheetFunction,
	sheetFunctions,
	type ArgumentId,
	type FunctionArgument,
	type FunctionCategory,
	type FunctionPrefix,
	type FunctionSupport,
	type FunctionVolatility,
	type SheetFunction
} from "./functions/catalogue"
export * from "./protocol"
export {
	defineSheetFeature,
	sheetRegistry,
	type SheetCellDetailProducers,
	type SheetChangeSink,
	type SheetCommandContext,
	type SheetCommandHandler,
	type SheetCommandHandlers,
	type SheetCommandInfo,
	type SheetEditStep,
	type SheetFeature,
	type SheetHandled,
	type SheetLayoutProducers,
	type SheetQueryHandler,
	type SheetQueryHandlers,
	type SheetReadContext,
	type SheetRegistry,
	type SheetTarget,
	type SheetTileBuilder,
	type SheetTileProducer
} from "./registry"
export {
	DEFAULT_COL_WIDTH,
	DEFAULT_ROW_HEIGHT,
	MAX_COLUMNS,
	MAX_ROWS,
	cellKey,
	type CellRange,
	type CellView,
	type SpreadsheetKind
} from "./model/model"
export { MAX_SHEET_CELLS, type AxisEdit } from "./model/edits"
export {
	cellName,
	columnIndex,
	columnName,
	expandToMerges,
	rangeCols,
	rangeName,
	rangeRows,
	rangesIntersect,
	type CellPosition,
	type Selection
} from "./refs/cellRef"
export {
	engineCellFormula,
	engineFormula,
	formulaTranslator,
	renameSheetInFormula,
	rewriteFormula,
	sameSheet,
	shiftFormula,
	shiftSpan,
	shownFormula,
	storedFormula,
	wellFormedFormula,
	type FormulaRef,
	type RefArea
} from "./refs/formulaRefs"
export { malformedFormula, parseCellInput, type ParsedInput } from "./input/cellInput"
export {
	MAX_COL_WIDTH,
	MAX_RESIZE_TARGETS,
	MAX_ROW_HEIGHT,
	MIN_SIZE,
	PX_PER_POINT,
	clampSize,
	colWidthToPx,
	pxToColWidth,
	pxToRowHeight,
	resetTargets,
	resizeTargets,
	restoreSizes,
	rowHeightToPx,
	shiftIndex,
	shiftSizes,
	withSizes,
	type SizeAxis,
	type SizeEntry
} from "./sizes/sizes"
export { layerKeyFor } from "./sizes/sizeRouting"
export {
	EMPTY_LAYER,
	SIZE_LAYER_LIMIT,
	followShift,
	loadLayer,
	saveLayer,
	updateLayer,
	type LayerKey,
	type SheetSizes,
	type SizeLayer,
	type SizeLayerStorage,
	type StashedSizes
} from "./sizes/sizeLayer"
export { parseTsv, pastedCells, pastedInputs, type GridClip, type PastedBlock } from "./clipboard/tsv"
export { MAX_HTML_COPY_CELLS } from "./clipboard/html"
export type { FillMode, SeriesOptions, SeriesRequest } from "./fill/series"
export { gridMove, isTypedCharacter, type GridBounds } from "./grid/navigation"
export { newSheetName, type CellEntry } from "./grid/gridEdits"
export { canEncodeWindows1252, csvCellView, parseCsvFile, serializeCsv, type CsvFormat } from "./csv/csvView"
export { detectDelimiter, parseCsv, writeCsv } from "./csv/csvParse"
export type { CsvEncoding } from "./csv/encoding"
export {
	builtinFormatCode,
	changedDecimals,
	COMMA_STYLE,
	EXCEL_BUILTIN_FORMATS,
	formatGeneral,
	formatNumberInto,
	formatTextInto,
	formatValue,
	IMPLIED_BUILTINS,
	MAX_SERIAL_1900,
	MAX_SERIAL_1904,
	numFmt,
	numFmtCategory,
	numFmtProblem,
	NUMBER_FORMAT_PRESETS,
	NUMFMT_EN_US,
	NumFmtOutput,
	PERCENT_STYLE,
	type NumFmt,
	type NumFmtCategory,
	type NumFmtLocale,
	type NumFmtProblem,
	type NumFmtOptions,
	type NumFmtResult
} from "./numfmt"
export {
	applyTint,
	borderPresetEdges,
	DEFAULT_PALETTE,
	resolveColor,
	SHEET_BORDER_PRESETS,
	SheetStyles,
	themeTints,
	workbookPalette,
	type SheetBorderEdges,
	type SheetBorderLineInput,
	type SheetBorderPatch,
	type SheetBorderPreset,
	type SheetFormatChoices,
	type SheetStyleSource,
	type SheetStylesOptions
} from "./style"
export {
	DYNAMIC_FILTERS,
	MAX_FILTER_CONDITIONS,
	MAX_FILTER_TEXT,
	MAX_FILTER_VALUES,
	filterNumber,
	type SheetDynamicFilter,
	type SheetFilterCondition,
	type SheetFilterCriteria,
	type SheetFilterDate,
	type SheetFilterOperator
} from "./filter/criteria"
export { FilterButton, type SheetFilterItem, type SheetFilterLayout, type SheetFilterRange, type SheetFilterValues } from "./filter/types"
export { CfBarFlag, ICON_SETS, iconCount, iconSetIndex, type IconSetName } from "./cf/layers"
// The workbook-only CF and DV features register through commands.ts: their modules reach the workbook model, which a
// text document never loads.
export type { SheetValidationAlert, SheetValidationLayout, SheetValidationRule } from "./dv/xlsx"
export type { DvErrorStyle, DvOperator, DvType } from "./dv/rules"
export type { DvListItem } from "./dv/validate"
export {
	acceptSuggestion,
	argumentAt,
	formulaContext,
	functionSuggestions,
	highlightedReferences,
	insertReference,
	pointedReference,
	signatureParts,
	type FormulaCall,
	type FormulaContext,
	type FormulaWord,
	type HighlightedReference,
	type SignaturePart
} from "./functions/formulaEditing"
export { autoSum, type AutoSumCells, type SheetAutoSum } from "./functions/autoSum"
export {
	autoCompleteIndex,
	autoCompletion,
	columnEntries,
	type AutoCompleteCells,
	type AutoCompleteIndex
} from "./autoComplete/autoComplete"
export type { SheetSelectionStats } from "./stats/stats"
export {
	delocalizeFormula,
	EN_US_LOCALE,
	localizedDate,
	localizedInput,
	localizedNumber,
	localizeFormula,
	plainLocale,
	territoryCurrency,
	textNumber
} from "./input/locale"
