// How the ribbon's command row fits its groups into its width, as Office's simplified ribbon does: every group in
// full while there is room; then, lowest priority first, groups collapse into one dropdown button each (tablet);
// then they move into the row's overflow menu (`[..]`), last of all those that always stay. On a phone groups skip
// collapsing and overflow directly.

export interface RibbonGroupSize {
	readonly id: string
	// px in full, its divider included.
	readonly width: number
	// px as one dropdown button; null: the group never collapses (it is one control already).
	readonly collapsedWidth: number | null
	// Higher stays longer; Infinity never leaves the row.
	readonly priority: number
}

export type RibbonGroupState = "full" | "collapsed" | "overflow"

// The overflow button with its gap.
const RIBBON_OVERFLOW_WIDTH = 34

export function ribbonFit(width: number, groups: readonly RibbonGroupSize[], collapse: boolean): ReadonlyMap<string, RibbonGroupState> {
	const states = new Map<string, RibbonGroupState>(groups.map(group => [group.id, "full"]))
	let total = groups.reduce((sum, group) => sum + group.width, 0)

	// Not measured yet, or room for all.
	if (width <= 0 || total <= width) {
		return states
	}

	// Lowest priority first; of equals, the later in the row.
	const order = groups
		.map((group, index) => ({ group, index }))
		.sort((a, b) => a.group.priority - b.group.priority || b.index - a.index)
		.map(entry => entry.group)

	if (collapse) {
		for (const group of order) {
			if (total <= width) {
				return states
			}

			if (group.collapsedWidth !== null && group.collapsedWidth < group.width && group.priority !== Infinity) {
				states.set(group.id, "collapsed")
				total -= group.width - group.collapsedWidth
			}
		}

		if (total <= width) {
			return states
		}
	}

	const room = width - RIBBON_OVERFLOW_WIDTH

	for (const group of order) {
		if (total <= room || group.priority === Infinity) {
			break
		}

		total -= states.get(group.id) === "collapsed" ? (group.collapsedWidth ?? group.width) : group.width
		states.set(group.id, "overflow")
	}

	return states
}
