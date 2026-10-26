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
