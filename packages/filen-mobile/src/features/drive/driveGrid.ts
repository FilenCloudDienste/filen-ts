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
