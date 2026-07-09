// Roving-tabindex cursor math for the drive listbox — kept as pure functions so the surrounding
// component only ever wires DOM events to arithmetic, never re-derives it inline.

// Clamps a cursor into [0, length-1]. Callers must not invoke this against an empty list (the
// listbox itself is not rendered in that state — see directory-listing.tsx's empty branch); the 0
// fallback here exists only so a transient zero-length render can never throw.
export function clampListboxIndex(index: number, length: number): number {
	if (length <= 0) {
		return 0
	}

	return Math.min(Math.max(index, 0), length - 1)
}

// Inclusive index range between an anchor and the active cursor, always ascending regardless of
// which side is larger — the shape Shift+Arrow/Shift+Click both need to turn into a selection.
export function listboxRange(anchor: number, active: number): number[] {
	const start = Math.min(anchor, active)
	const end = Math.max(anchor, active)
	const range: number[] = []

	for (let i = start; i <= end; i++) {
		range.push(i)
	}

	return range
}
