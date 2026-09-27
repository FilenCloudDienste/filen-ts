// One axis of the grid (its rows or its columns): where each index starts and how large it is. Most rows
// and columns have the default size, so only the exceptions are stored, sorted, with their running
// difference from the default. A position lookup is then a binary search over the exceptions, and the
// axis costs memory for them alone, however many rows the sheet has.
export interface Axis {
	count: number
	total: number
	size: (index: number) => number
	offset: (index: number) => number
	// The index whose span holds `position` (clamped to the axis).
	indexAt: (position: number) => number
}

export function createAxis(count: number, defaultSize: number, sizes: ReadonlyMap<number, number>, hidden: readonly number[]): Axis {
	const custom = new Map<number, number>()

	for (const [index, size] of sizes) {
		if (index < count) {
			custom.set(index, size)
		}
	}

	for (const index of hidden) {
		if (index < count) {
			custom.set(index, 0)
		}
	}

	const indices = [...custom.keys()].sort((a, b) => a - b)
	// deltaBefore[k]: the summed difference from the default of indices[0..k).
	const deltaBefore = new Float64Array(indices.length + 1)

	indices.forEach((index, k) => {
		deltaBefore[k + 1] = (deltaBefore[k] ?? 0) + (custom.get(index) ?? defaultSize) - defaultSize
	})

	// How many exceptions lie before `index`.
	function exceptionsBefore(index: number): number {
		let low = 0
		let high = indices.length

		while (low < high) {
			const middle = (low + high) >>> 1

			if ((indices[middle] ?? 0) < index) {
				low = middle + 1
			} else {
				high = middle
			}
		}

		return low
	}

	function offset(index: number): number {
		const clamped = Math.max(0, Math.min(index, count))

		return clamped * defaultSize + (deltaBefore[exceptionsBefore(clamped)] ?? 0)
	}

	function size(index: number): number {
		return custom.get(index) ?? defaultSize
	}

	const total = offset(count)

	function indexAt(position: number): number {
		if (count === 0 || position <= 0) {
			return 0
		}

		if (position >= total) {
			return count - 1
		}

		let low = 0
		let high = count - 1

		while (low < high) {
			const middle = (low + high + 1) >>> 1

			if (offset(middle) <= position) {
				low = middle
			} else {
				high = middle - 1
			}
		}

		return low
	}

	return { count, total, size, offset, indexAt }
}
