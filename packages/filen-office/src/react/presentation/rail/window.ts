// Which rail items are mounted: the ones in view plus `overscan` on each side, from a fixed item extent, so the
// cost of a scroll step is independent of the deck's size.

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

// The item a key moves to from `current`, or undefined for a key the rail does not handle.
export function railKeyTarget(key: string, current: number, count: number, page: number, vertical: boolean): number | undefined {
	if (count === 0) return undefined

	const clamp = (index: number): number => Math.max(0, Math.min(count - 1, index))

	switch (key) {
		case vertical ? "ArrowDown" : "ArrowRight":
			return clamp(current + 1)
		case vertical ? "ArrowUp" : "ArrowLeft":
			return clamp(current - 1)
		case "PageDown":
			return clamp(current + Math.max(1, page))
		case "PageUp":
			return clamp(current - Math.max(1, page))
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
	// Per row: a slide's index, or -1 - section for a header.
	readonly items: Int32Array
	// Per row: its start; one more entry holds the total.
	readonly starts: Float64Array
	// Per slide: its row.
	readonly rowOf: Int32Array
}

export function railRows(
	rows: readonly { readonly kind: "slide" | "section"; readonly index?: number; readonly section?: number }[],
	slides: number,
	slideExtent: number,
	headerExtent: number
): RailRows {
	const items = new Int32Array(rows.length)
	const starts = new Float64Array(rows.length + 1)
	const rowOf = new Int32Array(slides).fill(-1)
	let at = 0

	rows.forEach((row, index) => {
		starts[index] = at

		if (row.kind === "slide") {
			const slide = row.index ?? 0

			items[index] = slide

			if (slide >= 0 && slide < slides) rowOf[slide] = index

			at += slideExtent
		} else {
			items[index] = -1 - (row.section ?? 0)
			at += headerExtent
		}
	})
	starts[rows.length] = at

	return { items, starts, rowOf }
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
// slide count: at the end). A header drops before its section's first slide.
export function dropBefore(rows: RailRows, slides: number, position: number): number {
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

	return position < (start + end) / 2 ? item : item + 1
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
