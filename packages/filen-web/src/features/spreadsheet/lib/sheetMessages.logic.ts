import type { SheetFileKind, SheetRefusal, SheetViewOnlyReason, SheetWritability } from "@filen/office/core/sheet"
import type { PreviewKey } from "@/lib/i18n"

// A view-only format's note names the format the file is in: an .xls, its template (an .xlt), or an OpenDocument
// spreadsheet (.ods, .ots).
function legacyKey(kind: SheetFileKind): PreviewKey {
	if (kind === "ods" || kind === "ots") return "previewSheetReadOnlyOds"

	return kind === "xlt" ? "previewSheetReadOnlyXlt" : "previewSpreadsheetReadOnlyXls"
}

// Why a session is view-only, in the words the viewer shows beside the cell contents.
export function viewOnlyKey(reason: SheetViewOnlyReason, kind: SheetFileKind): PreviewKey {
	switch (reason) {
		case "legacyFormat":
			return legacyKey(kind)
		case "lossy":
			return "previewSpreadsheetReadOnlyLossy"
		case "tooLarge":
			return "previewSpreadsheetReadOnlyTooLarge"
		// A text file that would not save back as it was; a workbook the gate could not prove is lossy.
		case "unsafe":
			return kind === "csv" || kind === "tsv" || kind === "tab"
				? "previewSpreadsheetReadOnlyUnsafe"
				: "previewSpreadsheetReadOnlyLossy"
		case "signed":
			return "previewSheetReadOnlySigned"
		case "readOnlyRecommended":
			return "previewSheetReadOnlyRecommended"
		case "modifyPassword":
			return "previewSheetReadOnlyModifyPassword"
		case "incomplete":
			return "previewSheetReadOnlyIncomplete"
	}
}

// The note beside the cell contents, by precedence: the app's own reasons first (no permission to write here, a
// name that does not say the format, a rename since), then the session's verdict. null: nothing to say.
export function readOnlyNoteKey({
	editable,
	readOnlyReason,
	unnamed,
	renamed,
	writability,
	kind
}: {
	editable: boolean
	readOnlyReason: "renamed" | undefined
	unnamed: boolean
	renamed: boolean
	writability: SheetWritability
	kind: SheetFileKind
}): PreviewKey | null {
	// A legacy workbook says so whoever may edit here.
	if (writability.state === "viewOnly" && writability.reason === "legacyFormat") {
		return legacyKey(kind)
	}

	if (!editable) {
		return readOnlyReason === "renamed" ? "previewSpreadsheetReadOnlyRenamed" : null
	}

	if (unnamed) {
		return "previewSpreadsheetReadOnlyUnnamed"
	}

	if (renamed) {
		return "previewSpreadsheetReadOnlyRenamed"
	}

	switch (writability.state) {
		case "checking":
			return "previewSpreadsheetCheckingWritable"
		case "viewOnly":
			return viewOnlyKey(writability.reason, kind)
		default:
			return null
	}
}

// A refused command's toast. A view-only refusal names the verdict when the session gave it.
export function refusalKey(refusal: SheetRefusal, kind: SheetFileKind): PreviewKey {
	switch (refusal.reason) {
		case "readOnly":
			return isViewOnlyReason(refusal.detail) ? viewOnlyKey(refusal.detail, kind) : "previewSpreadsheetReadOnlyLossy"
		case "tooLarge":
			return "previewSpreadsheetTooLarge"
		case "sheetName":
			return "previewSpreadsheetSheetNameInvalid"
		case "lastSheet":
			return "previewSheetLastSheet"
		case "formula":
			return "previewSpreadsheetFormulaInvalid"
		case "arrayFormula":
			return "previewSpreadsheetArrayFormula"
		case "tableHeader":
			return "previewSpreadsheetTableHeader"
		case "structureLocked":
			return "previewSpreadsheetStructureLocked"
		case "pivot":
			return "previewSheetPivot"
		case "merged":
			return refusal.detail === "mergeSize" ? "previewSheetSortMergeSize" : "previewSheetMerged"
		case "protectedSheet":
			return "previewSheetProtectedSheet"
		case "protectedWorkbook":
			return "previewSheetProtectedWorkbook"
		case "encoding":
			return "previewSpreadsheetEncodingUnsupported"
		case "styleLimit":
			return "previewSheetStyleLimit"
		case "unsupported":
			return "previewSheetUnsupported"
		case "multipleSelection":
			return refusal.detail === "mixed" ? "previewSheetMultipleSelections" : "previewSheetOverlappingSelections"
		case "mergeLosesValues":
			return "previewSheetMergeLosesValues"
		case "notesUnavailable":
			return "previewSheetNotesUnavailable"
		case "authorNeeded":
			return "previewSheetAuthorNeeded"
		case "notOwnComment":
			return "previewSheetNotOwnComment"
		case "linkTarget":
			return "previewSheetLinkTargetInvalid"
		case "filterCriteria":
			return "previewSheetFilterCriteria"
		case "drawingUnavailable":
			return "previewSheetDrawingUnavailable"
		case "objectLocked":
			return "previewSheetObjectLocked"
		case "chartUnsupported":
			return "previewSheetChartUnsupported"
		case "occupied":
			return "previewSheetMoveReplaceBody"
	}
}

// A refused Download as CSV's toast: too large to download, a text file read only in part, or that it failed.
export function csvRefusalKey(refusal: SheetRefusal): PreviewKey {
	if (refusal.reason !== "tooLarge") return "previewSheetDownloadCsvFailed"

	return refusal.detail === "incomplete" ? "previewSheetReadOnlyIncomplete" : "previewSheetDownloadCsvTooLarge"
}

const VIEW_ONLY_REASONS: ReadonlySet<string> = new Set<SheetViewOnlyReason>([
	"legacyFormat",
	"lossy",
	"tooLarge",
	"unsafe",
	"signed",
	"readOnlyRecommended",
	"modifyPassword",
	"incomplete"
])

function isViewOnlyReason(detail: string | undefined): detail is SheetViewOnlyReason {
	return detail !== undefined && VIEW_ONLY_REASONS.has(detail)
}
