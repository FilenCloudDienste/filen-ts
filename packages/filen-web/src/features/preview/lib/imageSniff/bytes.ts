// Helpers for the header sniffers. Every sniffer reads only the bytes in hand (a head of the file, or the whole file
// when small), walks with strictly increasing offsets and caps its iterations, so hostile bytes cost a bounded scan.

export function viewOf(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
	return bytes.length >= at + magic.length && magic.every((byte, i) => bytes[at + i] === byte)
}

// A byte range of the file, `offset` + `length` within its size.
export interface ByteSpan {
	readonly offset: number
	readonly length: number
}
