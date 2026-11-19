import { axisEntryAt, entryCount } from "../../core/sheet/axisRuns"
import { AxisFlag, type SheetAxisLayout } from "../../core/sheet/protocol"

// One axis of the grid as drawn: where each row or column starts and how large it is, in screen pixels at the
// sheet's zoom. Only the indices that differ from the default are stored, a run of alike ones as one entry (sorted,
// with the running difference from the default before each), so an axis of a million rows costs memory for its
// exceptions alone and every lookup is a binary search over them.

export interface GridAxis {
	readonly count: number
	readonly total: number
	readonly defaultSize: number
	size(index: number): number
	// Where `index` starts (clamped to 0..count).
	offset(index: number): number
	// The index whose span holds `position`, clamped to the axis.
	indexAt(position: number): number
	hidden(index: number): boolean
	// The last index with a size (-1: none), so a run of hidden indices at the end is never walked.
	readonly lastShown: number
	// The next shown index from `index` (inclusive) in `direction`, or -1, stepping over a hidden run at once. A
	// hand-built axis may leave it out: shownIndex then steps index by index.
	readonly nextShown?: ((index: number, direction: 1 | -1) => number) | undefined
}

// Pixels at 100 % (a resize being dragged); NaN takes an index back to the default.
export type AxisOverrides = ReadonlyMap<number, number>

export function createGridAxis(layout: SheetAxisLayout, count: number, scale: number, overrides?: AxisOverrides): GridAxis {
	const defaultSize = Math.max(1, Math.round(layout.defaultSize * scale))
	// Entries: where each starts, how many indices it covers, and their size (each the same).
	const starts: number[] = []
	const counts: number[] = []
	const sizes: number[] = []
	const push = (start: number, length: number, size: number): void => {
		if (length > 0) {
			starts.push(start)
			counts.push(length)
			sizes.push(size)
		}
	}
	const changed =
		overrides === undefined || overrides.size === 0 ? [] : [...overrides].filter(([index]) => index < count).sort((a, b) => a[0] - b[0])
	let o = 0
	// Overrides before `end` and from `from` on, each its own entry (NaN: the default).
	const overridden = (from: number, end: number): void => {
		while (o < changed.length && (changed[o]?.[0] ?? 0) < end) {
			const [index = 0, px = Number.NaN] = changed[o] ?? []

			if (index >= from) push(index, 1, Number.isNaN(px) ? defaultSize : Math.round(px * scale))

			o++
		}
	}

	for (let k = 0; k < layout.indices.length; k++) {
		const first = layout.indices[k] ?? 0

		if (first >= count) break

		const end = Math.min(count, first + entryCount(layout, k))
		const size = scaled(layout, k, scale)

		overridden(0, first)

		// The run, cut around the overrides inside it.
		let at = first

		while (o < changed.length && (changed[o]?.[0] ?? 0) < end) {
			const index = changed[o]?.[0] ?? 0

			push(at, index - at, size)
			overridden(index, index + 1)
			at = index + 1
		}

		push(at, end - at, size)
	}

	overridden(0, count)

	const n = starts.length
	// before[k]: the summed difference from the default of the entries before k.
	const before = new Float64Array(n + 1)

	for (let k = 0; k < n; k++) before[k + 1] = (before[k] ?? 0) + ((sizes[k] ?? 0) - defaultSize) * (counts[k] ?? 1)

	// The entries starting before `index`.
	function startingBefore(index: number): number {
		let low = 0
		let high = n

		while (low < high) {
			const middle = (low + high) >>> 1

			if ((starts[middle] ?? 0) < index) low = middle + 1
			else high = middle
		}

		return low
	}

	function offset(index: number): number {
		const clamped = Math.max(0, Math.min(index, count))
		const k = startingBefore(clamped) - 1

		if (k < 0) return clamped * defaultSize

		// Entry k may reach past `index`: only its indices before it count.
		const covered = Math.min(counts[k] ?? 1, clamped - (starts[k] ?? 0))

		return clamped * defaultSize + (before[k] ?? 0) + ((sizes[k] ?? 0) - defaultSize) * covered
	}

	// The entry holding `index`, -1 for none.
	function entryOf(index: number): number {
		const k = startingBefore(index + 1) - 1

		return k >= 0 && index < (starts[k] ?? 0) + (counts[k] ?? 1) ? k : -1
	}

	function size(index: number): number {
		const k = entryOf(index)

		return k < 0 ? defaultSize : (sizes[k] ?? 0)
	}

	const total = offset(count)

	function indexAt(position: number): number {
		if (count === 0) return 0
		if (position >= total) return count - 1
		if (position < 0) return 0

		// The last entry starting at or before `position`.
		let low = 0
		let high = n

		while (low < high) {
			const middle = (low + high) >>> 1
			const start = (starts[middle] ?? 0) * defaultSize + (before[middle] ?? 0)

			if (start <= position) low = middle + 1
			else high = middle
		}

		const k = low - 1

		if (k < 0) return Math.min(count - 1, Math.floor(position / defaultSize))

		const first = starts[k] ?? 0
		const start = first * defaultSize + (before[k] ?? 0)
		const each = sizes[k] ?? 0
		const end = start + each * (counts[k] ?? 1)

		if (position < end) return first + Math.floor((position - start) / each)

		const last = first + (counts[k] ?? 1) - 1
		const next = k + 1 < n ? (starts[k + 1] ?? count) : count

		return Math.min(count - 1, next - 1, last + 1 + Math.floor((position - end) / defaultSize))
	}

	// Walks back over the hidden entries at the end.
	let lastShown = count - 1

	for (let k = entryOf(lastShown); lastShown >= 0 && k >= 0 && sizes[k] === 0; k = entryOf(lastShown)) lastShown = (starts[k] ?? 0) - 1

	// One binary search per entry of size 0 stepped over (a default-size gap between entries is shown).
	function nextShown(from: number, direction: 1 | -1): number {
		let index = direction === 1 ? Math.max(0, from) : Math.min(from, count - 1)

		while (index >= 0 && index < count && (direction === -1 || index <= lastShown)) {
			const k = entryOf(index)

			if (k < 0 || (sizes[k] ?? 0) > 0) return index

			index = direction === 1 ? (starts[k] ?? 0) + (counts[k] ?? 1) : (starts[k] ?? 0) - 1
		}

		return -1
	}

	return { count, total, defaultSize, size, offset, indexAt, hidden: index => size(index) === 0, lastShown, nextShown }
}

function scaled(layout: SheetAxisLayout, k: number, scale: number): number {
	return ((layout.flags[k] ?? 0) & AxisFlag.HIDDEN) !== 0 ? 0 : Math.round((layout.sizes[k] ?? layout.defaultSize) * scale)
}

// The axis's style for the cells of `index` that have no tile entry, and its flags.
export function axisEntry(layout: SheetAxisLayout, index: number): { readonly style: number; readonly flags: number } | null {
	const k = axisEntryAt(layout, index)

	return k < 0 ? null : { style: layout.styles[k] ?? 0, flags: layout.flags[k] ?? 0 }
}

// The next shown index from `from` (inclusive, past the end: the last index) in `direction`, or -1.
export function shownIndex(axis: GridAxis, from: number, direction: 1 | -1): number {
	const start = Math.min(from, axis.count - 1)

	if (axis.nextShown !== undefined) return axis.nextShown(start, direction)

	const end = direction === 1 ? axis.lastShown : 0

	for (let index = start; direction === 1 ? index <= end : index >= end; index += direction) if (!axis.hidden(index)) return index

	return -1
}

// The shown indices from `first` to `last`, in order.
export function shownIndices(axis: GridAxis, first: number, last: number): number[] {
	const out: number[] = []

	for (
		let index = shownIndex(axis, first, 1);
		index >= 0 && index <= last;
		index = index + 1 < axis.count ? shownIndex(axis, index + 1, 1) : -1
	)
		out.push(index)

	return out
}

// The tiles (`size` indices each) from the one holding `first` to the one holding `last` that hold a shown index of
// that span, in order: a hidden run is stepped over at once, so a filtered sheet costs its shown indices.
export function shownTiles(axis: GridAxis, first: number, last: number, size: number): number[] {
	const out: number[] = []

	for (let index = shownIndex(axis, first, 1); index >= 0 && index <= last;) {
		const tile = Math.floor(index / size)
		const next = (tile + 1) * size

		out.push(tile)
		index = next < axis.count ? shownIndex(axis, next, 1) : -1
	}

	return out
}

// The shown index `steps` shown indices from `from` in `direction`, or the farthest there is.
export function shownStep(axis: GridAxis, from: number, steps: number, direction: 1 | -1): number {
	let at = from

	for (let step = 0; step < steps; step++) {
		const next = at + direction < 0 || at + direction >= axis.count ? -1 : shownIndex(axis, at + direction, direction)

		if (next < 0) break

		at = next
	}

	return at
}
