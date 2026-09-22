// A transferred/total ratio clamped into [0, scale], tolerant of a non-positive or NaN denominator
// (falls to 0 rather than dividing) — the numerator is free to exceed the denominator, since callers
// can observe a byte count that overshoots the declared total mid-transfer.
export function clampedRatio(numerator: number, denominator: number, scale: number = 1): number {
	return denominator > 0 ? Math.min(scale, Math.max(0, (numerator / denominator) * scale)) : 0
}
