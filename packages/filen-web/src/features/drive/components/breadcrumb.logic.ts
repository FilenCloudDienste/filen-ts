export interface CrumbCollapseInput {
	// Each crumb's width, the root first and the current directory last.
	widths: readonly number[]
	// The trail's available width.
	available: number
	// A chevron between two crumbs, and the flex gap on each side of it.
	separator: number
	gap: number
	// The "…" trigger that stands in for the hidden crumbs.
	ellipsis: number
}

// The crumbs folded into the "…" menu, as the index range [start, end): the oldest ancestors below the root
// go first, then the root itself; the current directory always stays. start === end when everything fits
// (or nothing is measured yet).
export interface CrumbRange {
	start: number
	end: number
}

const NONE: CrumbRange = { start: 0, end: 0 }

function trailWidth(widths: readonly number[], step: number): number {
	let total = 0

	for (const width of widths) {
		total += width
	}

	return total + Math.max(0, widths.length - 1) * step
}

export function collapsedCrumbRange({ widths, available, separator, gap, ellipsis }: CrumbCollapseInput): CrumbRange {
	const count = widths.length
	const step = separator + 2 * gap

	if (count < 2 || available <= 0 || trailWidth(widths, step) <= available) {
		return NONE
	}

	const root = widths[0] ?? 0

	for (let end = 2; end < count; end++) {
		if (trailWidth([root, ellipsis, ...widths.slice(end)], step) <= available) {
			return { start: 1, end }
		}
	}

	return { start: 0, end: count - 1 }
}
