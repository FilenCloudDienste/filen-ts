// A small deterministic generator (xorshift32), so a failure reproduces from its seed: numbers in [0, 1).
export function random(seed: number): () => number {
	let state = seed >>> 0 || 1

	return () => {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5

		return (state >>> 0) / 0x100000000
	}
}
