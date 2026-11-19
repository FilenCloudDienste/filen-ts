// Byte-level helpers of the XML scanners that cut parts without parsing them.

// The chunks joined into one array.
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	let length = 0

	for (const chunk of chunks) length += chunk.length

	const out = new Uint8Array(length)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

// Whether `byte` ends a tag's qualified name: the end of the bytes, XML whitespace, ">" or "/".
export function isXmlNameEnd(byte: number | undefined): boolean {
	return byte === undefined || byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x3e || byte === 0x2f
}

// Index of `sequence` at or after `from`, or -1.
export function indexOfBytes(bytes: Uint8Array, sequence: Uint8Array, from: number): number {
	const first = sequence[0] ?? 0

	for (let at = bytes.indexOf(first, from); at >= 0; at = bytes.indexOf(first, at + 1)) {
		let k = 1

		while (k < sequence.length && bytes[at + k] === sequence[k]) k++

		if (k === sequence.length) return at
	}

	return -1
}
