import { borderPresetEdges, type SheetCommand, type SheetId, type SheetRange } from "@filen/office/core/sheet"
import type { SheetGridModel } from "@filen/office/react/sheet"
import { createModelStore } from "@/features/spreadsheet/lib/modelStore"

// Whether a grid's Format Cells dialog is open, shared by what opens it (Ctrl+1, the toolbar's menus) and the
// toolbar that holds it.

const store = createModelStore(false)

export function setFormatCellsOpen(model: SheetGridModel, open: boolean): void {
	store.set(model, open)
}

export function useFormatCellsOpen(model: SheetGridModel): boolean {
	return store.useValue(model)
}

// Excel's border shortcuts: Ctrl+Shift+& puts an outline round the selection, Ctrl+Shift+_ takes its borders off
// ("Keyboard shortcuts in Excel", support.microsoft.com).
export function borderShortcut(shortcut: "borderOutline" | "borderNone", sheet: SheetId, ranges: readonly SheetRange[]): SheetCommand {
	return { type: "format.borders", sheet, ranges, edges: borderPresetEdges(shortcut === "borderOutline" ? "outside" : "none") }
}
