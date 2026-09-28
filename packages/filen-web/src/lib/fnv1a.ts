// Deterministic 32-bit FNV-1a string hash, unsigned via `>>> 0` so a modulo on it is always a valid
// index. For stable visual bucketing (sender name colours, generated playlist artwork), never security.
export function fnv1a(value: string): number {
	let hash = 0x811c9dc5

	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}

	return hash >>> 0
}
