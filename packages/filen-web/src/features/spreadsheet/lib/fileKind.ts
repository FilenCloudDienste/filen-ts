import type { SpreadsheetFileKind } from "@/features/spreadsheet/workers/spreadsheet.worker"

// The one list of spreadsheet extensions: the preview category, the editable gate and the worker's kind
// all read it. A Map, so a name like "constructor" is not found on a prototype.
const KINDS: ReadonlyMap<string, SpreadsheetFileKind> = new Map([
	["xlsx", "xlsx"],
	["xlsm", "xlsx"],
	["xls", "xls"],
	["csv", "csv"],
	["tsv", "tsv"]
])

export const SPREADSHEET_EXTENSIONS: readonly string[] = [...KINDS.keys()]

export function spreadsheetFileKind(extension: string): SpreadsheetFileKind | null {
	return KINDS.get(extension) ?? null
}

// A legacy .xls opens to be looked at only; every other kind saves in the format its extension names.
export function isEditableSpreadsheetExtension(extension: string): boolean {
	const kind = spreadsheetFileKind(extension)

	return kind !== null && kind !== "xls"
}

// The format a name promises, for telling whether a rename changed it: its kind, except that .xlsm
// (macros kept) and .xlsx (none allowed) open alike but are different files.
export function spreadsheetSaveFormat(extension: string): string | null {
	const kind = spreadsheetFileKind(extension)

	return kind === "xlsx" ? extension : kind
}
