// Areas text must flow around (floating objects), as rectangles in the layout's coordinate space with the
// side(s) text may use beside each.

export const Wrap = {
	// Text on both sides.
	BOTH: 0,
	// Text only to the left of the obstacle.
	LEFT: 1,
	// Text only to the right.
	RIGHT: 2,
	// Text on the wider side only.
	LARGEST: 3
} as const

export type Wrap = (typeof Wrap)[keyof typeof Wrap]

export const ClearSide = { LEFT: 1, RIGHT: 2, ALL: 3 } as const

export type ClearSide = (typeof ClearSide)[keyof typeof ClearSide]

export class Exclusions {
	count = 0
	private rects = new Float64Array(16)
	private wraps = new Uint8Array(4)

	clear(): void {
		this.count = 0
	}

	add(left: number, top: number, right: number, bottom: number, wrap: Wrap): void {
		if (!(right > left && bottom > top)) return

		if ((this.count + 1) * 4 > this.rects.length) {
			const rects = new Float64Array(this.rects.length * 2)
			const wraps = new Uint8Array(this.wraps.length * 2)

			rects.set(this.rects)
			wraps.set(this.wraps)
			this.rects = rects
			this.wraps = wraps
		}

		const at = this.count * 4

		this.rects[at] = left
		this.rects[at + 1] = top
		this.rects[at + 2] = right
		this.rects[at + 3] = bottom
		this.wraps[this.count++] = wrap
	}

	// Adds `from`'s obstacles moved down by dy.
	addShifted(from: Exclusions, dy: number): void {
		for (let k = 0; k < from.count; k++) {
			const at = k * 4

			this.add(
				from.rects[at] ?? 0,
				(from.rects[at + 1] ?? 0) + dy,
				from.rects[at + 2] ?? 0,
				(from.rects[at + 3] ?? 0) + dy,
				(from.wraps[k] ?? Wrap.BOTH) as Wrap
			)
		}
	}

	// A hash of the obstacles, to tell whether they changed.
	key(): number {
		let hash = this.count

		for (let k = 0; k < this.count * 4; k++) hash = (Math.imul(hash, 31) + Math.round((this.rects[k] ?? 0) * 64)) | 0

		for (let k = 0; k < this.count; k++) hash = (Math.imul(hash, 31) + (this.wraps[k] ?? 0)) | 0

		return hash
	}

	// Whether any obstacle overlaps the band [top, bottom) horizontally within [minX, maxX).
	overlaps(top: number, bottom: number, minX: number, maxX: number): boolean {
		for (let k = 0; k < this.count; k++) {
			const at = k * 4

			if (
				(this.rects[at + 1] ?? 0) < bottom &&
				(this.rects[at + 3] ?? 0) > top &&
				(this.rects[at] ?? 0) < maxX &&
				(this.rects[at + 2] ?? 0) > minX
			)
				return true
		}

		return false
	}

	// The lowest bottom of the obstacles overlapping the rectangle [left, right) x [top, bottom), or -Infinity.
	overlapBottom(left: number, top: number, right: number, bottom: number): number {
		let lowest = -Infinity

		for (let k = 0; k < this.count; k++) {
			const at = k * 4

			if (
				(this.rects[at + 1] ?? 0) < bottom &&
				(this.rects[at + 3] ?? 0) > top &&
				(this.rects[at] ?? 0) < right &&
				(this.rects[at + 2] ?? 0) > left
			)
				lowest = Math.max(lowest, this.rects[at + 3] ?? 0)
		}

		return lowest
	}

	// Free intervals of [minX, maxX) beside the obstacles overlapping the band [top, bottom), left to right,
	// as [start, end) pairs in `out` (room for 2 × (count + 1) numbers). Returns the number of intervals.
	free(top: number, bottom: number, minX: number, maxX: number, out: Float64Array): number {
		out[0] = minX
		out[1] = maxX

		let n = maxX > minX ? 1 : 0

		for (let k = 0; k < this.count && n > 0; k++) {
			const at = k * 4
			const left = this.rects[at] ?? 0
			const right = this.rects[at + 2] ?? 0

			if ((this.rects[at + 1] ?? 0) >= bottom || (this.rects[at + 3] ?? 0) <= top || right <= minX || left >= maxX) continue

			let wrap = this.wraps[k] ?? Wrap.BOTH

			if (wrap === Wrap.LARGEST) wrap = left - minX >= maxX - right ? Wrap.LEFT : Wrap.RIGHT

			const blockStart = wrap === Wrap.RIGHT ? minX : left
			const blockEnd = wrap === Wrap.LEFT ? maxX : right

			n = subtract(out, n, blockStart, blockEnd)
		}

		return n
	}

	// The lowest bottom edge > top among obstacles overlapping the band, where the free space can next
	// change; Infinity when none overlaps.
	nextBottom(top: number, bottom: number, minX: number, maxX: number): number {
		let next = Infinity

		for (let k = 0; k < this.count; k++) {
			const at = k * 4
			const obstacleBottom = this.rects[at + 3] ?? 0

			if (
				(this.rects[at + 1] ?? 0) < bottom &&
				obstacleBottom > top &&
				(this.rects[at] ?? 0) < maxX &&
				(this.rects[at + 2] ?? 0) > minX
			) {
				next = Math.min(next, obstacleBottom)
			}
		}

		return next
	}

	// Where a line break with `clear` continues: below every obstacle at or below `y` on that side of the
	// column's middle.
	clearance(y: number, side: ClearSide, minX: number, maxX: number): number {
		const middle = (minX + maxX) / 2
		let out = y

		for (let k = 0; k < this.count; k++) {
			const at = k * 4
			const bottom = this.rects[at + 3] ?? 0

			if (bottom <= y || (this.rects[at + 1] ?? 0) > y) continue

			const center = ((this.rects[at] ?? 0) + (this.rects[at + 2] ?? 0)) / 2
			const onSide = side === ClearSide.ALL || (side === ClearSide.LEFT ? center < middle : center >= middle)

			if (onSide) out = Math.max(out, bottom)
		}

		return out
	}
}

let scratch = new Float64Array(16)

// Removes [start, end) from the sorted intervals out[0, 2n); returns the new count.
function subtract(out: Float64Array, n: number, start: number, end: number): number {
	if (scratch.length < 2 * n) scratch = new Float64Array(4 * n)

	scratch.set(out.subarray(0, 2 * n))

	let write = 0

	for (let k = 0; k < 2 * n; k += 2) {
		const a = scratch[k] ?? 0
		const b = scratch[k + 1] ?? 0

		if (end <= a || start >= b) {
			out[write++] = a
			out[write++] = b

			continue
		}

		if (start > a) {
			out[write++] = a
			out[write++] = start
		}

		if (end < b) {
			out[write++] = end
			out[write++] = b
		}
	}

	return write / 2
}
