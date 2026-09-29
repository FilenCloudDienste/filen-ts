export interface SplitterKeyBounds {
	step: number
	min: number
	max: number
}

// WAI-ARIA window-splitter keys for a trailing-edge divider: ArrowRight grows, ArrowLeft shrinks,
// Home/End jump to the clamps. null = a key the separator does not handle, so the caller leaves the
// event alone.
export function splitterKeyValue(key: string, value: number, { step, min, max }: SplitterKeyBounds): number | null {
	switch (key) {
		case "ArrowLeft":
			return Math.min(max, Math.max(min, value - step))
		case "ArrowRight":
			return Math.min(max, Math.max(min, value + step))
		case "Home":
			return min
		case "End":
			return max
		default:
			return null
	}
}
