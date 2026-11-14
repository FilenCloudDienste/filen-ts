import type { PageRange } from "./pageRanges"

// Page order arithmetic for organising a PDF: an order is the list of old 0-based page indices in their new order.
// Pure, allocation-light (one array per call), no document access.

// The pages, deduplicated, ascending, within [0, count).
export function selectionPages(count: number, pages: Iterable<number>): number[] {
	const seen = new Uint8Array(Math.max(0, count))
	const out: number[] = []

	for (const page of pages) {
		if (Number.isInteger(page) && page >= 0 && page < count && seen[page] === 0) {
			seen[page] = 1
			out.push(page)
		}
	}

	return out.sort((a, b) => a - b)
}

// The order after moving `pages` (keeping their relative order) to stand before page `before` (0..count; count: at the
// end), as a drag drops them.
export function moveBeforeOrder(count: number, pages: Iterable<number>, before: number): number[] {
	const moving = selectionPages(count, pages)
	const marked = new Uint8Array(Math.max(0, count))

	for (const page of moving) marked[page] = 1

	const at = Math.max(0, Math.min(count, Math.trunc(before)))
	const order: number[] = []

	for (let page = 0; page < at; page++) if (marked[page] === 0) order.push(page)

	order.push(...moving)

	for (let page = at; page < count; page++) if (marked[page] === 0) order.push(page)

	return order
}

// The order after moving the selection `delta` places as one block (Alt+arrows: ±1 along a rail, ±columns in a grid),
// or null when it cannot move further. A scattered selection is gathered where its first (moving back) or last
// (moving on) page lands.
export function shiftOrder(count: number, pages: Iterable<number>, delta: number): number[] | null {
	const moving = selectionPages(count, pages)
	const first = moving[0]
	const last = moving.at(-1)

	if (first === undefined || last === undefined || delta === 0) return null

	const before = delta < 0 ? Math.max(0, first + delta) : Math.min(count, last + 1 + delta)
	const order = moveBeforeOrder(count, moving, before)

	return isIdentityOrder(order) ? null : order
}

export function isIdentityOrder(order: readonly number[]): boolean {
	return order.every((page, index) => page === index)
}

// True when `order` holds every page of a `count`-page document exactly once.
export function isPermutation(order: readonly number[], count: number): boolean {
	if (order.length !== count) return false

	const seen = new Uint8Array(count)

	for (const page of order) {
		if (!Number.isInteger(page) || page < 0 || page >= count || seen[page] === 1) return false

		seen[page] = 1
	}

	return true
}

// Where each old page went: new index per old index, -1 for a page the order dropped.
export function orderPositions(order: readonly number[], count: number): Int32Array {
	const positions = new Int32Array(Math.max(0, count)).fill(-1)

	order.forEach((page, index) => {
		if (page >= 0 && page < count) positions[page] = index
	})

	return positions
}

// The pages left after deleting `pages`, as an order.
export function deleteOrder(count: number, pages: Iterable<number>): number[] {
	const marked = new Uint8Array(Math.max(0, count))

	for (const page of selectionPages(count, pages)) marked[page] = 1

	const order: number[] = []

	for (let page = 0; page < count; page++) if (marked[page] === 0) order.push(page)

	return order
}

// Split plans: the parts (1-based, inclusive) a document of `count` pages is cut into.

// Parts of `size` pages each; the last holds the rest.
export function splitEvery(count: number, size: number): PageRange[] {
	const step = Math.max(1, Math.trunc(size))
	const parts: PageRange[] = []

	for (let first = 1; first <= count; first += step) parts.push({ first, last: Math.min(count, first + step - 1) })

	return parts
}

// Parts starting at each of `starts` (1-based; at the selected pages, or at top-level bookmarks); the pages before the
// first start form their own part.
export function splitBefore(count: number, starts: Iterable<number>): PageRange[] {
	const cuts = selectionPages(count + 1, starts).filter(page => page > 1)
	const parts: PageRange[] = []
	let first = 1

	for (const cut of cuts) {
		parts.push({ first, last: cut - 1 })
		first = cut
	}

	if (count >= first) parts.push({ first, last: count })

	return parts
}

// The files an extraction writes: one per page when `separate`, else one holding every range.
export function extractGroups(ranges: readonly PageRange[], separate: boolean): PageRange[][] {
	if (!separate) return ranges.length === 0 ? [] : [[...ranges]]

	const groups: PageRange[][] = []

	for (const range of ranges) {
		for (let page = range.first; page <= range.last; page++) groups.push([{ first: page, last: page }])
	}

	return groups
}

// The 0-based pages of 1-based ranges, in order.
export function rangesToPages(ranges: readonly PageRange[]): number[] {
	const pages: number[] = []

	for (const range of ranges) {
		for (let page = range.first; page <= range.last; page++) pages.push(page - 1)
	}

	return pages
}
