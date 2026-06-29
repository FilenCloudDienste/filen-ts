// Responsive column count for the drive grid view, by available width (dp). Tiers chosen so phones
// show 3, small tablets 5, larger tablets 6-7 — the cell width is then width / columns (computed by
// the caller). Pure so it is unit-tested; the caller measures width via useViewLayout and recomputes
// on rotation/resize.
export function gridColumnsForWidth(width: number): number {
	if (width >= 1200) {
		return 7
	}

	if (width >= 900) {
		return 6
	}

	if (width >= 600) {
		return 5
	}

	return 3
}

// Grid spacing (dp). GRID_EDGE_PADDING is the horizontal inset between the grid and the screen edges
// (applied to the grid container — and reflected in its `px-2` className, which is 8dp; keep in sync).
// GRID_CELL_PADDING is each cell's padding (half the gap between adjacent cells). With equal values
// the gutter is uniform: edge gap = edge-inset + cell-padding, between-items gap = 2× cell-padding.
export const GRID_EDGE_PADDING = 8
export const GRID_CELL_PADDING = 8
