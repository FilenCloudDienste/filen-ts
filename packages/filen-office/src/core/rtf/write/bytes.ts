// Byte comparisons of WordprocessingML markup the writer makes: word-aligned where the offsets allow.

const BOOKMARK_END = Array.from("<w:bookmarkEnd", character => character.charCodeAt(0))
// The bookmarkEnd's "k", rarer in markup than its "<".
const BOOKMARK_END_K = BOOKMARK_END.indexOf(0x6b)

const RELATIONSHIP_ATTRIBUTE = Array.from(" r:", character => character.charCodeAt(0))

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && commonHead(a, b) === a.length
}

// How many bytes `a` and `b` start with alike: compared four at a time, through an aligned copy of `b` where its
// offset does not allow a view.
export function commonHead(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length)
	let k = 0

	while (k < n && ((a.byteOffset + k) & 3) !== 0) {
		if (a[k] !== b[k]) return k

		k++
	}

	const scratch = ((b.byteOffset + k) & 3) === 0 ? undefined : new Uint8Array(COMPARE_CHUNK)

	while (n - k >= 4) {
		const length = Math.min(COMPARE_CHUNK, (n - k) & ~3)
		const words = length >> 2
		const x = new Uint32Array(a.buffer, a.byteOffset + k, words)
		const y = wordsOf(b, k, length, scratch)
		let w = 0

		while (w < words && x[w] === y[w]) w++

		k += w * 4

		if (w < words) break
	}

	while (k < n && a[k] === b[k]) k++

	return k
}

// How many bytes `a` and `b` end with alike, at most `most` (as commonHead, from the end).
export function commonTail(a: Uint8Array, b: Uint8Array, most: number): number {
	const n = Math.min(a.length, b.length, most)
	const aEnd = a.byteOffset + a.length
	let k = 0

	while (k < n && ((aEnd - k) & 3) !== 0) {
		if (a[a.length - 1 - k] !== b[b.length - 1 - k]) return k

		k++
	}

	const scratch = ((b.byteOffset + b.length - k) & 3) === 0 ? undefined : new Uint8Array(COMPARE_CHUNK)

	while (n - k >= 4) {
		const length = Math.min(COMPARE_CHUNK, (n - k) & ~3)
		const words = length >> 2
		const x = new Uint32Array(a.buffer, aEnd - k - length, words)
		const y = wordsOf(b, b.length - k - length, length, scratch)
		let w = words - 1

		while (w >= 0 && x[w] === y[w]) w--

		k += (words - 1 - w) * 4

		if (w >= 0) break
	}

	while (k < n && a[a.length - 1 - k] === b[b.length - 1 - k]) k++

	return k
}

const COMPARE_CHUNK = 64 * 1024

// `length` bytes of `bytes` from `at` as words: a view where aligned, else copied into `scratch`.
function wordsOf(bytes: Uint8Array, at: number, length: number, scratch: Uint8Array | undefined): Uint32Array {
	if (scratch === undefined) return new Uint32Array(bytes.buffer, bytes.byteOffset + at, length >> 2)

	scratch.set(bytes.subarray(at, at + length))

	return new Uint32Array(scratch.buffer, 0, length >> 2)
}

// Whether the markup holds a w:bookmarkEnd.
export function endsBookmark(bytes: Uint8Array): boolean {
	for (let at = bytes.indexOf(0x6b, BOOKMARK_END_K); at >= 0; at = bytes.indexOf(0x6b, at + 1)) {
		const start = at - BOOKMARK_END_K

		if (start + BOOKMARK_END.length > bytes.length) return false

		let k = 0

		while (k < BOOKMARK_END.length && bytes[start + k] === BOOKMARK_END[k]) k++

		if (k === BOOKMARK_END.length) return true
	}

	return false
}

export function includes(bytes: Uint8Array, pattern: readonly number[]): boolean {
	const first = pattern[0] ?? 0

	for (let at = bytes.indexOf(first); at >= 0 && at + pattern.length <= bytes.length; at = bytes.indexOf(first, at + 1)) {
		let k = 1

		while (k < pattern.length && bytes[at + k] === pattern[k]) k++

		if (k === pattern.length) return true
	}

	return false
}

// Whether markup bytes hold a relationship attribute (r:id, r:embed...).
export function namesRelationship(bytes: Uint8Array): boolean {
	const [space, r, colon] = RELATIONSHIP_ATTRIBUTE

	for (let at = bytes.indexOf(r ?? 0); at > 0 && at + 1 < bytes.length; at = bytes.indexOf(r ?? 0, at + 1)) {
		if (bytes[at - 1] === space && bytes[at + 1] === colon) return true
	}

	return false
}
