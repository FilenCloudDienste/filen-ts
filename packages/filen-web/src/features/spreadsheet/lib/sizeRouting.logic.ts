import type { SpreadsheetKind } from "@/features/spreadsheet/lib/model"
import type { Writability } from "@/features/spreadsheet/hooks/useSpreadsheetEdits"
import type { LayerKey } from "@/features/spreadsheet/lib/sizeLayer"

// Where the sizes on show live: in the file only while it is a workbook this viewer can save; beside it
// (lib/sizeLayer.ts) for everything else, whose layer an editable workbook then ignores.
export function sizesInFile(kind: SpreadsheetKind, writability: Writability, canEdit: boolean): boolean {
	return kind === "xlsx" && writability === "writable" && canEdit
}

export function layerKeyFor(stable: string | undefined, documentKey: string): LayerKey {
	return stable === undefined ? { kind: "session", id: documentKey } : { kind: "stable", id: stable }
}

// Whether the rails can be resized now: not while a workbook that may become editable is still being
// proven, as its sizes may yet belong in the file (a size set meanwhile would snap back on the verdict).
export function resizable(kind: SpreadsheetKind, writability: Writability, mayEdit: boolean): boolean {
	return !(kind === "xlsx" && writability === "checking" && mayEdit)
}
