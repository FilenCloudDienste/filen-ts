import type { SheetAxisLayout } from "./protocol"

// Lookups on an axis layout whose entries may each stand for a run of indices (SheetAxisLayout.counts).

// How many indices entry `k` stands for.
export function entryCount(layout: SheetAxisLayout, k: number): number {
	return layout.counts?.[k] ?? 1
}

// The entries starting before `index` (binary search over the ascending starts).
export function entriesBefore(layout: SheetAxisLayout, index: number): number {
	let low = 0
	let high = layout.indices.length

	while (low < high) {
		const middle = (low + high) >>> 1

		if ((layout.indices[middle] ?? 0) < index) low = middle + 1
		else high = middle
	}

	return low
}

// The entry holding `index`, -1 for none.
export function axisEntryAt(layout: SheetAxisLayout, index: number): number {
	const k = entriesBefore(layout, index + 1) - 1

	return k >= 0 && index < (layout.indices[k] ?? 0) + entryCount(layout, k) ? k : -1
}

export interface AxisRun {
	readonly first: number
	readonly count: number
	readonly size: number
	readonly style: number
	readonly flags: number
}

// Single entries (ascending) and runs (ascending, apart from them and each other) as one layout, `counts` set only
// when a run is there: a layout without runs is the same as before.
export function withRuns(
	defaultSize: number,
	indices: readonly number[],
	sizes: readonly number[],
	styles: readonly number[],
	flags: readonly number[],
	runs: readonly AxisRun[]
): SheetAxisLayout {
	if (runs.length === 0)
		return {
			defaultSize,
			indices: Uint32Array.from(indices),
			sizes: Float32Array.from(sizes),
			styles: Uint32Array.from(styles),
			flags: Uint16Array.from(flags)
		}

	const total = indices.length + runs.length
	const out = {
		defaultSize,
		indices: new Uint32Array(total),
		sizes: new Float32Array(total),
		styles: new Uint32Array(total),
		flags: new Uint16Array(total),
		counts: new Uint32Array(total)
	}
	let i = 0
	let r = 0

	for (let k = 0; k < total; k++) {
		const run = runs[r]

		if (run !== undefined && (i >= indices.length || run.first < (indices[i] ?? 0))) {
			out.indices[k] = run.first
			out.sizes[k] = run.size
			out.styles[k] = run.style
			out.flags[k] = run.flags
			out.counts[k] = run.count
			r++
		} else {
			out.indices[k] = indices[i] ?? 0
			out.sizes[k] = sizes[i] ?? defaultSize
			out.styles[k] = styles[i] ?? 0
			out.flags[k] = flags[i] ?? 0
			out.counts[k] = 1
			i++
		}
	}

	return out
}
