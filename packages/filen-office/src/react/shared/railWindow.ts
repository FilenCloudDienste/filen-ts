// Which rail items are mounted: the ones in view plus `overscan` on each side, from a fixed item extent, so the
// cost of a scroll step is independent of the list's size. A grid packs `columns` items per row; a header row (a
// section's name) always stands alone.

export interface RailRange {
	readonly first: number
	// Inclusive; -1 below first when nothing is mounted.
	readonly last: number
}

export function railRange(count: number, extent: number, offset: number, size: number, overscan: number): RailRange {
	if (count <= 0 || extent <= 0) return { first: 0, last: -1 }

	const first = Math.max(0, Math.min(count - 1, Math.floor(Math.max(0, offset) / extent) - overscan))
	const last = Math.min(count - 1, Math.max(first, Math.ceil((Math.max(0, offset) + Math.max(0, size)) / extent) - 1 + overscan))

	return { first, last }
}

// The scroll offset that brings item `index` fully into view, or undefined when it already is.
export function revealOffset(index: number, extent: number, offset: number, size: number): number | undefined {
	const start = index * extent
	const end = start + extent

	if (start < offset) return start

	if (end > offset + size) return Math.max(0, end - size)

	return undefined
}

// The item a key moves to from `current`, or undefined for a key the rail does not handle. In a grid (`columns` > 1,
// vertical) the left and right arrows step one item, up and down one row, and `page` counts rows.
export function railKeyTarget(
	key: string,
	current: number,
	count: number,
	page: number,
	vertical: boolean,
	columns = 1
): number | undefined {
	if (count === 0) return undefined

	const clamp = (index: number): number => Math.max(0, Math.min(count - 1, index))
	const across = Math.max(1, Math.trunc(columns))

	if (across > 1 && vertical) {
		if (key === "ArrowRight") return clamp(current + 1)
		if (key === "ArrowLeft") return clamp(current - 1)
	}

	switch (key) {
		case vertical ? "ArrowDown" : "ArrowRight":
			return clamp(current + across)
		case vertical ? "ArrowUp" : "ArrowLeft":
			return clamp(current - across)
		case "PageDown":
			return clamp(current + Math.max(1, page) * across)
		case "PageUp":
			return clamp(current - Math.max(1, page) * across)
		case "Home":
			return 0
		case "End":
			return count - 1
		default:
			return undefined
	}
}

// The order thumbnails are asked for over a mounted `range`: the `visible` items first, then the overscan, nearest
// to the view first.
export function thumbnailOrder(range: RailRange, visible: RailRange): number[] {
	const out: number[] = []
	const first = Math.max(range.first, visible.first)
	const last = Math.min(range.last, visible.last)

	for (let index = first; index <= last; index++) out.push(index)

	for (let distance = 1; first - distance >= range.first || last + distance <= range.last; distance++) {
		if (last + distance <= range.last) out.push(last + distance)
		if (first - distance >= range.first) out.push(first - distance)
	}

	return out
}

// A rail with section headers: rows of two extents (a slide's, a header's), laid out once per slide list as their
// start offsets, so a scroll step finds its rows by binary search, whatever the deck's size.
export interface RailRows {
	// Per row: its first item's index, or -1 - section for a header.
	readonly items: Int32Array
	// Per row: how many items it holds (0 for a header).
	readonly counts: Int32Array
	// Per row: its start; one more entry holds the total.
	readonly starts: Float64Array
	// Per item: its row.
	readonly rowOf: Int32Array
}

// Lays out item and header rows; with `columns` > 1, consecutive items share rows of that many.
export function railRows(
	rows: readonly { readonly kind: "slide" | "section"; readonly index?: number; readonly section?: number }[],
	slides: number,
	slideExtent: number,
	headerExtent: number,
	columns = 1
): RailRows {
	const across = Math.max(1, Math.trunc(columns))
	const items: number[] = []
	const counts: number[] = []
	const starts: number[] = []
	const rowOf = new Int32Array(slides).fill(-1)
	let at = 0

	for (const row of rows) {
		if (row.kind === "slide") {
			const slide = row.index ?? 0
			const last = items.length - 1
			const open = last >= 0 && (items[last] ?? -1) >= 0 && (counts[last] ?? 0) < across

			if (open) {
				counts[last] = (counts[last] ?? 0) + 1
			} else {
				starts.push(at)
				items.push(slide)
				counts.push(1)
				at += slideExtent
			}

			if (slide >= 0 && slide < slides) rowOf[slide] = items.length - 1
		} else {
			starts.push(at)
			items.push(-1 - (row.section ?? 0))
			counts.push(0)
			at += headerExtent
		}
	}

	starts.push(at)

	return { items: Int32Array.from(items), counts: Int32Array.from(counts), starts: Float64Array.from(starts), rowOf }
}

// The rows of a plain list of `count` items (no sections), straight into typed arrays.
export function itemRows(count: number, extent: number, columns = 1): RailRows {
	const across = Math.max(1, Math.trunc(columns))
	const rowCount = Math.ceil(Math.max(0, count) / across)
	const items = new Int32Array(rowCount)
	const counts = new Int32Array(rowCount)
	const starts = new Float64Array(rowCount + 1)
	const rowOf = new Int32Array(Math.max(0, count))

	for (let row = 0; row < rowCount; row++) {
		items[row] = row * across
		counts[row] = Math.min(across, count - row * across)
		starts[row] = row * extent
	}

	starts[rowCount] = rowCount * extent

	for (let item = 0; item < count; item++) rowOf[item] = Math.floor(item / across)

	return { items, counts, starts, rowOf }
}

// The last row starting at or before `offset`.
function rowAt(rows: RailRows, offset: number): number {
	let low = 0
	let high = rows.items.length - 1

	while (low < high) {
		const middle = (low + high + 1) >> 1

		if ((rows.starts[middle] ?? 0) <= offset) low = middle
		else high = middle - 1
	}

	return low
}

// The rows mounted for a view: the ones it shows plus `overscan` on each side.
export function rowRange(rows: RailRows, offset: number, size: number, overscan: number): RailRange {
	const count = rows.items.length

	if (count === 0) return { first: 0, last: -1 }

	const first = Math.max(0, rowAt(rows, Math.max(0, offset)) - overscan)
	const end = Math.max(0, offset) + Math.max(0, size)
	let last = rowAt(rows, Math.max(0, end - 0.5))

	last = Math.min(count - 1, Math.max(first, last + overscan))

	return { first, last }
}

// The scroll offset that brings row `row` fully into view, or undefined when it already is.
export function revealRowOffset(rows: RailRows, row: number, offset: number, size: number): number | undefined {
	const start = rows.starts[row]
	const end = rows.starts[row + 1]

	if (start === undefined || end === undefined) return undefined
	if (start < offset) return start
	if (end > offset + size) return Math.max(0, end - size)

	return undefined
}

// Where a drop at `position` (along the rail, content px) puts the dragged slides: before this slide index (the
// slide count: at the end). A header drops before its section's first slide. In a grid, `across` places the drop
// within its row: the position across the rail and the width of a cell.
export function dropBefore(
	rows: RailRows,
	slides: number,
	position: number,
	across?: { readonly position: number; readonly cell: number }
): number {
	const count = rows.items.length

	if (count === 0) return 0

	const row = rowAt(rows, Math.max(0, position))
	const start = rows.starts[row] ?? 0
	const end = rows.starts[row + 1] ?? start
	const item = rows.items[row] ?? 0

	if (item < 0) {
		// The header's section starts at the next slide row.
		for (let next = row + 1; next < count; next++) {
			const slide = rows.items[next] ?? -1

			if (slide >= 0) return slide
		}

		return slides
	}

	if (across !== undefined && across.cell > 0) {
		const span = rows.counts[row] ?? 1
		const column = Math.max(0, Math.min(span, Math.round(across.position / across.cell)))

		return item + column
	}

	return position < (start + end) / 2 ? item : item + 1
}

// In a grid, where the drop marker stands for a drop before item `before`: its row's start along the rail and its
// offset across (a cell boundary); the end of the last row for a drop at the end.
export function dropCell(rows: RailRows, before: number, cell: number): { readonly along: number; readonly across: number } {
	const row = rows.rowOf[before]

	if (row === undefined || row < 0) {
		const last = rows.items.length - 1

		if (last < 0) return { along: 0, across: 0 }

		return { along: rows.starts[last] ?? 0, across: (rows.counts[last] ?? 0) * cell }
	}

	return { along: rows.starts[row] ?? 0, across: (before - (rows.items[row] ?? 0)) * cell }
}

// Where the drop line shows for a drop before slide `before`: above the headers right before that slide (the slides
// join the section of the slide before them), or at the end.
export function dropLineOffset(rows: RailRows, before: number): number {
	const row = rows.rowOf[before]

	if (row === undefined || row < 0) return rows.starts[rows.items.length] ?? 0

	let at = row

	while (at > 0 && (rows.items[at - 1] ?? 0) < 0) at--

	return rows.starts[at] ?? 0
}
