import type { DvListItem } from "../dv/validate"

// AutoComplete of cell entries (support.microsoft.com, "Turn automatic completion of cell entries on or off"): the
// text already in the column completes what is typed, and Option+Down (Alt+Down here) lists it. The entries are the
// text cells of the run of filled cells above and below the edited one (numbers, dates, booleans and formulas are not
// completed), each once regardless of case, nearest first.

declare module "../protocol" {
	interface SheetQueryMap {
		// The column's entries for a cell, each as shown and as typed in the session's locale.
		"autoComplete.entries": { request: SheetCell; result: { readonly entries: readonly DvListItem[] } }
	}
}

// One sheet's column as AutoComplete reads it.
export interface AutoCompleteCells {
	// The cell holds anything at all.
	filled(row: number, col: number): boolean
	// The cell's text entry, or null when it holds something else (or nothing).
	text(row: number, col: number): string | null
}

// The distinct text entries of the run of filled cells round (row, col) in its column (the cell itself left out),
// with the row each was first found at: up from the cell, then down. `rows`: the sheet's row extent.
export function columnEntries(
	cells: AutoCompleteCells,
	row: number,
	col: number,
	rows: number
): { readonly row: number; readonly text: string }[] {
	const seen = new Set<string>()
	const out: { row: number; text: string }[] = []
	const visit = (at: number): void => {
		const text = cells.text(at, col)

		if (text === null || text === "") return

		const key = text.toLowerCase()

		if (seen.has(key)) return

		seen.add(key)
		out.push({ row: at, text })
	}

	for (let at = row - 1; at >= 0 && cells.filled(at, col); at--) visit(at)
	for (let at = row + 1; at < rows && cells.filled(at, col); at++) visit(at)

	return out
}

// Entries prepared once per entry typed, for the match on every key.
export interface AutoCompleteIndex {
	readonly texts: readonly string[]
	readonly keys: readonly string[]
}

export function autoCompleteIndex(texts: readonly string[]): AutoCompleteIndex {
	return { texts, keys: texts.map(text => text.toLowerCase()) }
}

// The entry `typed` completes to: the one entry starting with it (case-insensitively) and longer than it, or null
// when none does, more than one does, or it already is one.
export function autoCompletion(index: AutoCompleteIndex, typed: string): string | null {
	if (typed === "") return null

	const wanted = typed.toLowerCase()
	let found = -1

	for (let i = 0; i < index.keys.length; i++) {
		if (!(index.keys[i] ?? "").startsWith(wanted)) continue
		if (found >= 0) return null

		found = i
	}

	const text = found < 0 ? undefined : index.texts[found]

	return text === undefined || text.length <= typed.length ? null : text
}
