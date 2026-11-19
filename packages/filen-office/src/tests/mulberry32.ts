// A seeded generator for tests (mulberry32): the same seed draws the same sequence on every run. Free of node
// imports, so DOM tests may use it too.

export type Rand = () => number

export function rng(seed: number): Rand {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = state

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
