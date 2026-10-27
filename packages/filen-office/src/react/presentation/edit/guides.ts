import type { Bounds } from "./selection"

// Smart guides while dragging: the moving box snaps to the edges and centres of the other shapes and of the slide,
// and to equal spacing among the shapes beside it in its row or column (the slide edges count as neighbours), when
// it comes within SNAP_PX screen px. The targets are built once per drag (sorted lines, binary searched), so each
// pointer move costs O(log n) for lines plus one pass over the shapes for spacing.

// How near (screen px) a box comes before it snaps.
export const SNAP_PX = 6

export type Axis = "x" | "y"

// A line the box aligned to: at x = `at` (axis "x", a vertical line) or y = `at`, drawn from `from` to `to` across.
export interface Guide {
	readonly axis: Axis
	readonly at: number
	readonly from: number
	readonly to: number
}

// An equal gap: the span [from, to] along `axis`, drawn at `at` across.
export interface Spacing {
	readonly axis: Axis
	readonly from: number
	readonly to: number
	readonly at: number
}

export interface Snap {
	readonly dx: number
	readonly dy: number
	readonly guides: readonly Guide[]
	readonly spacing: readonly Spacing[]
}

interface Lines {
	// Sorted line positions; owner[k] is the index of the bounds the line k belongs to (-1: the slide).
	readonly at: Float64Array
	readonly owner: Int32Array
}

const NO_SNAP: Snap = { dx: 0, dy: 0, guides: [], spacing: [] }

function linesOf(items: readonly Bounds[], axis: Axis, size: number): Lines {
	const count = items.length * 3 + 3
	const values = new Float64Array(count)
	const owners = new Int32Array(count)
	let k = 0
	const add = (value: number, owner: number): void => {
		values[k] = value
		owners[k] = owner
		k++
	}

	add(0, -1)
	add(size / 2, -1)
	add(size, -1)

	items.forEach((item, index) => {
		const start = axis === "x" ? item.x : item.y
		const end = axis === "x" ? item.r : item.b

		add(start, index)
		add((start + end) / 2, index)
		add(end, index)
	})

	const order = Array.from({ length: count }, (_, index) => index).sort((a, b) => (values[a] as number) - (values[b] as number))

	return {
		at: Float64Array.from(order, index => values[index] as number),
		owner: Int32Array.from(order, index => owners[index] as number)
	}
}

// The first index whose line is >= value.
function lowerBound(lines: Float64Array, value: number): number {
	let low = 0
	let high = lines.length

	while (low < high) {
		const mid = (low + high) >>> 1

		if ((lines[mid] as number) < value) low = mid + 1
		else high = mid
	}

	return low
}

function nearest(lines: Float64Array, value: number): number | undefined {
	const at = lowerBound(lines, value)
	const above = lines[at]
	const below = lines[at - 1]

	if (above === undefined) return below
	if (below === undefined) return above

	return above - value < value - below ? above : below
}

function startOf(box: Bounds, axis: Axis): number {
	return axis === "x" ? box.x : box.y
}

function endOf(box: Bounds, axis: Axis): number {
	return axis === "x" ? box.r : box.b
}

function shifted(box: Bounds, dx: number, dy: number): Bounds {
	return { x: box.x + dx, y: box.y + dy, r: box.r + dx, b: box.b + dy }
}

export class SnapTargets {
	private readonly items: readonly Bounds[]
	private readonly slide: { readonly cx: number; readonly cy: number }
	private readonly x: Lines
	private readonly y: Lines

	// `items`: the bounds of the shapes that do not move; `slide`: its size. EMU.
	constructor(items: readonly Bounds[], slide: { readonly cx: number; readonly cy: number }) {
		this.items = items
		this.slide = slide
		this.x = linesOf(items, "x", slide.cx)
		this.y = linesOf(items, "y", slide.cy)
	}

	private lines(axis: Axis): Lines {
		return axis === "x" ? this.x : this.y
	}

	private extent(owner: number, axis: Axis): { from: number; to: number } {
		if (owner < 0) return { from: 0, to: axis === "x" ? this.slide.cy : this.slide.cx }

		const item = this.items[owner] as Bounds

		return axis === "x" ? { from: item.y, to: item.b } : { from: item.x, to: item.r }
	}

	// The smallest move along `axis` that puts one of `values` on a line, within `threshold`.
	snapValues(axis: Axis, values: readonly number[], threshold: number): number | undefined {
		const lines = this.lines(axis).at
		let best: number | undefined

		for (const value of values) {
			const line = nearest(lines, value)

			if (line === undefined) continue

			const delta = line - value

			if (Math.abs(delta) <= threshold && (best === undefined || Math.abs(delta) < Math.abs(best))) best = delta
		}

		return best
	}

	// Guides for every line one of `values` lies on, spanning the lines' owners and `box` across.
	guidesAt(axis: Axis, values: readonly number[], box: Bounds): Guide[] {
		const { at, owner } = this.lines(axis)
		const guides: Guide[] = []
		const across = axis === "x" ? { from: box.y, to: box.b } : { from: box.x, to: box.r }

		for (const value of new Set(values)) {
			let from = across.from
			let to = across.to
			let found = false

			for (let k = lowerBound(at, value - 0.5); k < at.length && (at[k] as number) <= value + 0.5; k++) {
				const extent = this.extent(owner[k] as number, axis)

				found = true
				from = Math.min(from, extent.from)
				to = Math.max(to, extent.to)
			}

			if (found) guides.push({ axis, at: value, from, to })
		}

		return guides
	}

	// Equal spacing for `box` along `axis` among the shapes that overlap it across (the slide edges as neighbours):
	// the move that places it, and the gaps to mark.
	private spacingFor(axis: Axis, box: Bounds, threshold: number): { delta: number; marks: Spacing[] } | undefined {
		const size = axis === "x" ? this.slide.cx : this.slide.cy
		const start = startOf(box, axis)
		const end = endOf(box, axis)
		const length = end - start
		const middle = (start + end) / 2
		const acrossStart = axis === "x" ? box.y : box.x
		const acrossEnd = axis === "x" ? box.b : box.r
		// The nearest two neighbours on each side (closest first); the slide's edges are walls of no width.
		const before: Bounds[] = []
		const after: Bounds[] = []
		const wallBefore: Bounds =
			axis === "x" ? { x: 0, y: acrossStart, r: 0, b: acrossEnd } : { x: acrossStart, y: 0, r: acrossEnd, b: 0 }
		const wallAfter: Bounds =
			axis === "x" ? { x: size, y: acrossStart, r: size, b: acrossEnd } : { x: acrossStart, y: size, r: acrossEnd, b: size }
		const keep = (list: Bounds[], item: Bounds, closer: (a: Bounds, b: Bounds) => boolean): void => {
			list.push(item)
			list.sort((a, b) => (closer(a, b) ? -1 : closer(b, a) ? 1 : 0))

			if (list.length > 2) list.length = 2
		}

		const consider = (item: Bounds): void => {
			const itemAcrossStart = axis === "x" ? item.y : item.x
			const itemAcrossEnd = axis === "x" ? item.b : item.r

			if (itemAcrossEnd < acrossStart || itemAcrossStart > acrossEnd) return

			if (endOf(item, axis) <= middle) keep(before, item, (a, b) => endOf(a, axis) > endOf(b, axis))
			else if (startOf(item, axis) >= middle) keep(after, item, (a, b) => startOf(a, axis) < startOf(b, axis))
		}

		for (const item of this.items) consider(item)

		consider(wallBefore)
		consider(wallAfter)

		const markAt = (a: Bounds, b: Bounds): number => {
			const from = Math.max(axis === "x" ? a.y : a.x, axis === "x" ? b.y : b.x)
			const to = Math.min(axis === "x" ? a.b : a.r, axis === "x" ? b.b : b.r)

			return (from + to) / 2
		}
		const candidates: { position: number; marks: (position: number) => Spacing[] }[] = []
		const near = before[0]
		const far = before[1]
		const next = after[0]
		const beyond = after[1]
		const placed = (position: number): Bounds =>
			axis === "x" ? { ...box, x: position, r: position + length } : { ...box, y: position, b: position + length }

		if (near !== undefined && next !== undefined) {
			const gap = (startOf(next, axis) - endOf(near, axis) - length) / 2

			if (gap >= 0) {
				candidates.push({
					position: endOf(near, axis) + gap,
					marks: position => [
						{ axis, from: endOf(near, axis), to: position, at: markAt(near, placed(position)) },
						{ axis, from: position + length, to: startOf(next, axis), at: markAt(next, placed(position)) }
					]
				})
			}
		}

		if (near !== undefined && far !== undefined) {
			const gap = startOf(near, axis) - endOf(far, axis)

			if (gap > 0) {
				candidates.push({
					position: endOf(near, axis) + gap,
					marks: position => [
						{ axis, from: endOf(far, axis), to: startOf(near, axis), at: markAt(far, near) },
						{ axis, from: endOf(near, axis), to: position, at: markAt(near, placed(position)) }
					]
				})
			}
		}

		if (next !== undefined && beyond !== undefined) {
			const gap = startOf(beyond, axis) - endOf(next, axis)

			if (gap > 0) {
				candidates.push({
					position: startOf(next, axis) - gap - length,
					marks: position => [
						{ axis, from: position + length, to: startOf(next, axis), at: markAt(next, placed(position)) },
						{ axis, from: endOf(next, axis), to: startOf(beyond, axis), at: markAt(next, beyond) }
					]
				})
			}
		}

		let best: { delta: number; marks: Spacing[] } | undefined

		for (const candidate of candidates) {
			const delta = candidate.position - start

			if (Math.abs(delta) <= threshold && (best === undefined || Math.abs(delta) < Math.abs(best.delta))) {
				best = { delta, marks: candidate.marks(candidate.position) }
			}
		}

		return best
	}

	// Where a box dragged to `box` lands, and what to draw: per axis, an edge or centre line, or equal spacing,
	// whichever is nearer; `threshold` in EMU. `free` axes (none snapped) keep the pointer's position.
	snapMove(box: Bounds, threshold: number, axes: { readonly x: boolean; readonly y: boolean } = { x: true, y: true }): Snap {
		if (threshold <= 0) return NO_SNAP

		const values = (target: Bounds, axis: Axis): number[] => {
			const start = startOf(target, axis)
			const end = endOf(target, axis)

			return [start, (start + end) / 2, end]
		}
		const lineX = axes.x ? this.snapValues("x", values(box, "x"), threshold) : undefined
		const lineY = axes.y ? this.snapValues("y", values(box, "y"), threshold) : undefined
		// Spacing is measured with the other axis already snapped, so a row is found where the box will be.
		const acrossY = shifted(box, 0, lineY ?? 0)
		const spaceX = axes.x ? this.spacingFor("x", acrossY, threshold) : undefined
		const acrossX = shifted(box, lineX ?? 0, 0)
		const spaceY = axes.y ? this.spacingFor("y", acrossX, threshold) : undefined
		const pick = (line: number | undefined, space: { delta: number } | undefined): "line" | "space" | undefined => {
			if (line === undefined) return space === undefined ? undefined : "space"
			if (space === undefined) return "line"

			return Math.abs(space.delta) < Math.abs(line) ? "space" : "line"
		}
		const chosenX = pick(lineX, spaceX)
		const chosenY = pick(lineY, spaceY)
		const dx = chosenX === "line" ? (lineX as number) : chosenX === "space" ? (spaceX as { delta: number }).delta : 0
		const dy = chosenY === "line" ? (lineY as number) : chosenY === "space" ? (spaceY as { delta: number }).delta : 0
		const landed = shifted(box, dx, dy)
		const guides: Guide[] = []
		const spacing: Spacing[] = []

		if (chosenX === "line") guides.push(...this.guidesAt("x", values(landed, "x"), landed))
		if (chosenY === "line") guides.push(...this.guidesAt("y", values(landed, "y"), landed))
		if (chosenX === "space") spacing.push(...(this.spacingFor("x", landed, 0.5)?.marks ?? []))
		if (chosenY === "space") spacing.push(...(this.spacingFor("y", landed, 0.5)?.marks ?? []))

		return { dx, dy, guides, spacing }
	}
}

// The threshold in EMU for SNAP_PX at `scale` screen px per slide px.
export function snapThreshold(scale: number, emuPerPx: number): number {
	return scale > 0 ? (SNAP_PX / scale) * emuPerPx : 0
}
