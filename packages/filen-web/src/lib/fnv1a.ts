// The 32-bit FNV-1a offset basis: where a hash starts.
export const FNV1A_OFFSET_BASIS = 0x811c9dc5

// Deterministic 32-bit FNV-1a string hash, unsigned via `>>> 0` so a modulo on it is always a valid
// index. `seed` continues a running hash (pass the previous result). For stable bucketing and change
// detection (sender name colours, generated artwork, catalog detail hashes), never security.
export function fnv1a(value: string, seed: number = FNV1A_OFFSET_BASIS): number {
	let hash = seed

	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}

	return hash >>> 0
}
