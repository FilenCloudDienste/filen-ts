import type { SheetGridModel } from "@filen/office/react/sheet"
import { createModelStore } from "@/features/spreadsheet/lib/modelStore"

// Whether a grid's find bar is open, and how (Mod+F finds, Mod+H also replaces), shared by what opens it (the grid's
// shortcut, the toolbar's Find button) and the bar. `focus` grows each time it is asked to open, so an open bar
// takes focus again.
export interface SheetFindOpen {
	readonly mode: "find" | "replace"
	readonly focus: number
}

// Every open notifies, the same mode again too: `focus` grows, so the open bar takes focus again.
const store = createModelStore<SheetFindOpen | null>(null, () => false)
// The open bar's Find Next and Previous: false when it has no matches to step through. Read on demand, never shown.
const steps = new WeakMap<SheetGridModel, (direction: 1 | -1) => boolean>()

export function openSheetFind(model: SheetGridModel, mode: SheetFindOpen["mode"]): void {
	const current = store.get(model)

	store.set(model, { mode: current?.mode === "replace" ? "replace" : mode, focus: (current?.focus ?? 0) + 1 })
}

// Shift+F4 and Ctrl+Shift+F4 (Excel for the web's Find Next and Previous): steps the open bar's matches, or opens the
// bar when it has none.
export function stepSheetFind(model: SheetGridModel, direction: 1 | -1): void {
	if (steps.get(model)?.(direction) !== true) {
		openSheetFind(model, "find")
	}
}

// The open bar's stepping, while it is open; returns its removal.
export function setSheetFindStep(model: SheetGridModel, step: (direction: 1 | -1) => boolean): () => void {
	steps.set(model, step)

	return () => {
		if (steps.get(model) === step) {
			steps.delete(model)
		}
	}
}

export function closeSheetFind(model: SheetGridModel): void {
	if (store.get(model) !== null) {
		store.set(model, null)
	}
}

export function useSheetFindOpen(model: SheetGridModel): SheetFindOpen | null {
	return store.useValue(model)
}
