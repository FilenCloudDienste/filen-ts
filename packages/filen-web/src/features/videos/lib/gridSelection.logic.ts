import { isSelectionGesture, type ClickModifiers } from "@/features/drive/lib/listbox"

// A library grid's selection: title ids (the grid pages its cards in, so an index alone would not say which titles),
// and the index a Shift range extends from.
export interface GridSelection {
	ids: ReadonlySet<string>
	anchor: number | null
}

export const NO_SELECTION: GridSelection = { ids: new Set(), anchor: null }

// What a click on a card does to the selection, as in the drive: Shift extends a range, Ctrl/Cmd toggles. While
// anything is selected a plain click (or tap) toggles too; otherwise it opens the title (null).
export function cardClickIntent(modifiers: ClickModifiers, selecting: boolean): "range" | "toggle" | null {
	if (isSelectionGesture(modifiers)) {
		return modifiers.shiftKey ? "range" : "toggle"
	}

	return selecting ? "toggle" : null
}

export function toggleSelection(selection: GridSelection, id: string, index: number): GridSelection {
	const ids = new Set(selection.ids)

	if (!ids.delete(id)) {
		ids.add(id)
	}

	return { ids, anchor: index }
}

// The indices a Shift click on `index` selects, [start, end): from the anchor, or the card itself without one.
export function rangeBounds(selection: GridSelection, index: number): { start: number; end: number } {
	const anchor = selection.anchor ?? index

	return { start: Math.min(anchor, index), end: Math.max(anchor, index) + 1 }
}

// The range replaces the selection, as in the drive; the anchor stays where it was.
export function withRange(selection: GridSelection, ids: readonly string[], index: number): GridSelection {
	return { ids: new Set(ids), anchor: selection.anchor ?? index }
}

export function selectAll(ids: readonly string[]): GridSelection {
	return { ids: new Set(ids), anchor: null }
}
