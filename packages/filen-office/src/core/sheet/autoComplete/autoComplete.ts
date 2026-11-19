import type { DvListItem } from "../dv/validate"

// AutoComplete of cell entries (support.microsoft.com, "Turn automatic completion of cell entries on or off"): the
// text already in the column completes what is typed, and Option+Down (Alt+Down here) lists it. The entries are the
// text cells of the run of filled cells above and below the edited one (numbers, dates, booleans and formulas are not
// completed), each once regardless of case, nearest first.

declare module "../protocol" {
	interface SheetQueryMap {
		// The column's entries for a cell, each as shown and as typed in the session's locale. `more`: the run of filled
		// cells goes on past what was read (columnEntries' bounds).
		"autoComplete.entries": { request: SheetCell; result: { readonly entries: readonly DvListItem[]; readonly more: boolean } }
	}
}

// One sheet's column as AutoComplete reads it: a cell's text entry, null when it holds something else, undefined
// when it holds nothing at all (which ends the run). One read per cell.
export interface AutoCompleteCells {
	entry(row: number, col: number): string | null | undefined
}

// The most cells read each way from the edited one: the entries are gathered for every entry typed, so a run
// hundreds of thousands of rows long is read only as far as this. Ordinary sheets never reach it.
export const AUTO_COMPLETE_REACH = 10_000

// The most distinct entries kept: each is formatted and sent to the editor, and matched on every key typed. A column
// of that many distinct texts completes from the nearest of them.
export const AUTO_COMPLETE_ENTRIES = 2_000

// The distinct text entries of the run of filled cells round (row, col) in its column (the cell itself left out),
// with the row each was first found at: up from the cell, then down, at most AUTO_COMPLETE_REACH cells each way and
// AUTO_COMPLETE_ENTRIES entries in all. `more`: the run goes on past what was read. `rows`: the sheet's row extent.
export function columnEntries(
	cells: AutoCompleteCells,
	row: number,
	col: number,
	rows: number
): { readonly entries: { readonly row: number; readonly text: string }[]; readonly more: boolean } {
	const seen = new Set<string>()
	const entries: { row: number; text: string }[] = []
	// Reads the run from `from` by `step` up to `end` (excluded): whether it goes on past what was read.
	const walk = (from: number, step: number, end: number): boolean => {
		for (let at = from; step > 0 ? at < end : at > end; at += step) {
			const text = cells.entry(at, col)

			if (text === undefined) return false
			if (entries.length === AUTO_COMPLETE_ENTRIES) return true
			if (text === null || text === "") continue

			const key = text.toLowerCase()

			if (seen.has(key)) continue

			seen.add(key)
			entries.push({ row: at, text })
		}

		// Stopped by the reach, not the sheet's edge.
		return end >= 0 && end < rows && cells.entry(end, col) !== undefined
	}

	const up = walk(row - 1, -1, Math.max(-1, row - 1 - AUTO_COMPLETE_REACH))
	const down = walk(row + 1, 1, Math.min(rows, row + 1 + AUTO_COMPLETE_REACH))

	return { entries, more: up || down }
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
