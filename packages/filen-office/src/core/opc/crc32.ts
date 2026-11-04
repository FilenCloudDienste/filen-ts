// CRC-32 (ISO-HDLC, as zip uses), slicing by sixteen: sixteen 256-entry tables, sixteen bytes per step.
const TABLES = (() => {
	const tables = new Int32Array(16 * 256)

	for (let n = 0; n < 256; n++) {
		let c = n

		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1

		tables[n] = c
	}

	for (let n = 0; n < 256; n++) {
		let c = tables[n] as number

		for (let t = 1; t < 16; t++) {
			c = (tables[c & 0xff] as number) ^ (c >>> 8)
			tables[t * 256 + n] = c
		}
	}

	return tables
})()

// Continue a CRC over more bytes: crc32(b, crc32(a)) === crc32(a + b).
export function crc32(bytes: Uint8Array, previous: number = 0): number {
	const t = TABLES
	let crc = ~previous
	let i = 0
	const fast = bytes.length - 16

	for (; i <= fast; i += 16) {
		const a =
			crc ^
			((bytes[i] as number) | ((bytes[i + 1] as number) << 8) | ((bytes[i + 2] as number) << 16) | ((bytes[i + 3] as number) << 24))
		const b =
			(bytes[i + 4] as number) | ((bytes[i + 5] as number) << 8) | ((bytes[i + 6] as number) << 16) | ((bytes[i + 7] as number) << 24)
		const c =
			(bytes[i + 8] as number) |
			((bytes[i + 9] as number) << 8) |
			((bytes[i + 10] as number) << 16) |
			((bytes[i + 11] as number) << 24)
		const d =
			(bytes[i + 12] as number) |
			((bytes[i + 13] as number) << 8) |
			((bytes[i + 14] as number) << 16) |
			((bytes[i + 15] as number) << 24)

		crc =
			(t[3840 + (a & 0xff)] as number) ^
			(t[3584 + ((a >>> 8) & 0xff)] as number) ^
			(t[3328 + ((a >>> 16) & 0xff)] as number) ^
			(t[3072 + (a >>> 24)] as number) ^
			(t[2816 + (b & 0xff)] as number) ^
			(t[2560 + ((b >>> 8) & 0xff)] as number) ^
			(t[2304 + ((b >>> 16) & 0xff)] as number) ^
			(t[2048 + (b >>> 24)] as number) ^
			(t[1792 + (c & 0xff)] as number) ^
			(t[1536 + ((c >>> 8) & 0xff)] as number) ^
			(t[1280 + ((c >>> 16) & 0xff)] as number) ^
			(t[1024 + (c >>> 24)] as number) ^
			(t[768 + (d & 0xff)] as number) ^
			(t[512 + ((d >>> 8) & 0xff)] as number) ^
			(t[256 + ((d >>> 16) & 0xff)] as number) ^
			(t[d >>> 24] as number)
	}

	for (; i < bytes.length; i++) crc = (t[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8)

	return ~crc >>> 0
}
