import type { SheetRange } from "./protocol"

// The rows a selection's edits pass over on a filtered sheet: Excel's clear, format and fill act on the visible cells
// of filtered data only ("Filter data in a range or table"), so each range is taken as the runs of its rows between
// the hidden ones.

// Hidden rows `first` to `last`: ascending, apart from each other.
export interface RowSpan {
	readonly first: number
	readonly last: number
}

// The first span ending at or after `row` (binary search).
function spanFrom(hidden: readonly RowSpan[], row: number): number {
	let low = 0
	let high = hidden.length

	while (low < high) {
		const middle = (low + high) >>> 1

		if ((hidden[middle]?.last ?? 0) < row) low = middle + 1
		else high = middle
	}

	return low
}

export function rowHidden(hidden: readonly RowSpan[], row: number): boolean {
	const span = hidden[spanFrom(hidden, row)]

	return span !== undefined && span.first <= row
}

// Each range as the runs of its rows no span hides, in order. Without spans, or crossing none, the ranges as given.
export function visibleRanges(ranges: readonly SheetRange[], hidden: readonly RowSpan[]): readonly SheetRange[] {
	if (hidden.length === 0) return ranges

	let out: SheetRange[] | null = null

	for (let r = 0; r < ranges.length; r++) {
		const range = ranges[r] as SheetRange
		let k = spanFrom(hidden, range.startRow)
		let span = hidden[k]

		if (span === undefined || span.first > range.endRow) {
			out?.push(range)

			continue
		}

		out ??= ranges.slice(0, r)

		let start = range.startRow

		for (; span !== undefined && span.first <= range.endRow; span = hidden[++k]) {
			if (span.first > start) out.push({ ...range, startRow: start, endRow: span.first - 1 })

			start = span.last + 1
		}

		if (start <= range.endRow) out.push({ ...range, startRow: start, endRow: range.endRow })
	}

	return out ?? ranges
}
