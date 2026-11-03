// Byte ranges compared four bytes at a time (several times faster than byte by byte on the large parts a save
// compares): `a` read as aligned words, `b` as aligned words too when it lines up with `a`, else through a
// DataView.
export function equalBytes(a: Uint8Array, aFrom: number, b: Uint8Array, bFrom: number, length: number): boolean {
	if (a.buffer === b.buffer && a.byteOffset + aFrom === b.byteOffset + bFrom) return true

	let i = 0

	while (i < length && ((a.byteOffset + aFrom + i) & 3) !== 0) {
		if (a[aFrom + i] !== b[bFrom + i]) return false

		i++
	}

	const words = (length - i) >> 2

	if (words >= 8) {
		const left = new Int32Array(a.buffer, a.byteOffset + aFrom + i, words)
		const offset = b.byteOffset + bFrom + i

		if ((offset & 3) === 0) {
			const right = new Int32Array(b.buffer, offset, words)

			for (let k = 0; k < words; k++) if (left[k] !== right[k]) return false
		} else {
			const right = new DataView(b.buffer, offset, words * 4)

			for (let k = 0; k < words; k++) if (left[k] !== right.getInt32(k * 4, true)) return false
		}

		i += words * 4
	}

	for (; i < length; i++) if (a[aFrom + i] !== b[bFrom + i]) return false

	return true
}

// Whether two byte arrays hold the same bytes.
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a === b || (a.length === b.length && equalBytes(a, 0, b, 0, a.length))
}
