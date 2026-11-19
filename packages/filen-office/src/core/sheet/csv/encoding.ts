// The byte encodings a CSV or TSV file is read and written in, decoded as the Encoding Standard decodes them
// (https://encoding.spec.whatwg.org/), a leading byte order mark skipped as TextDecoder skips it. The
// platform's TextDecoder does UTF-8 and UTF-16 where there is one (it is faster); Hermes has none, so the
// decoders below are the standard's own algorithms and give the same text. windows-1252 is always decoded
// here: some Node releases decode it as Latin-1.

import { CP1252_HIGH } from "../../text/codepage"

export type BomEncoding = "utf-8" | "utf-16le" | "utf-16be"

export type CsvEncoding = BomEncoding | "windows-1252"

// The byte order mark a file opens with: UTF-8's (EF BB BF), UTF-16LE's (FF FE) or UTF-16BE's (FE FF).
export function detectBom(bytes: Uint8Array): { encoding: BomEncoding; length: number } | null {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return { encoding: "utf-8", length: 3 }
	}

	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		return { encoding: "utf-16le", length: 2 }
	}

	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		return { encoding: "utf-16be", length: 2 }
	}

	return null
}

interface NativeDecoder {
	decode(input: Uint8Array): string
}

type NativeDecoderConstructor = new (label: string, options?: { fatal?: boolean }) => NativeDecoder

function nativeDecoder(label: BomEncoding, fatal: boolean): NativeDecoder | null {
	const constructor = (globalThis as { TextDecoder?: NativeDecoderConstructor }).TextDecoder

	if (constructor === undefined) {
		return null
	}

	try {
		return new constructor(label, { fatal })
	} catch {
		return null
	}
}

const REPLACEMENT = 0xfffd
const BOM = 0xfeff
const CHUNK = 8192

// Code units as a string, in chunks small enough for one String.fromCharCode call each. A leading U+FEFF goes,
// as the standard's decode skips it.
function unitsText(units: Uint16Array, length: number): string {
	const start = length > 0 && units[0] === BOM ? 1 : 0
	let out = ""

	for (let i = start; i < length; i += CHUNK) {
		out += String.fromCharCode.apply(null, units.subarray(i, Math.min(length, i + CHUNK)) as unknown as number[])
	}

	return out
}

// UTF-8, or null where the bytes are not UTF-8 (the decoder's fatal mode).
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
	const native = nativeDecoder("utf-8", true)

	if (native !== null) {
		try {
			return native.decode(bytes)
		} catch {
			return null
		}
	}

	return decodeUtf8Fallback(bytes)
}

// The standard's UTF-8 decoder, failing on the first error.
export function decodeUtf8Fallback(bytes: Uint8Array): string | null {
	const units = new Uint16Array(bytes.length)
	let length = 0
	let needed = 0
	let seen = 0
	let codePoint = 0
	let lower = 0x80
	let upper = 0xbf

	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i] ?? 0

		if (needed === 0) {
			if (byte <= 0x7f) {
				units[length++] = byte
			} else if (byte >= 0xc2 && byte <= 0xdf) {
				needed = 1
				codePoint = byte & 0x1f
			} else if (byte >= 0xe0 && byte <= 0xef) {
				lower = byte === 0xe0 ? 0xa0 : 0x80
				upper = byte === 0xed ? 0x9f : 0xbf
				needed = 2
				codePoint = byte & 0x0f
			} else if (byte >= 0xf0 && byte <= 0xf4) {
				lower = byte === 0xf0 ? 0x90 : 0x80
				upper = byte === 0xf4 ? 0x8f : 0xbf
				needed = 3
				codePoint = byte & 0x07
			} else {
				return null
			}

			continue
		}

		if (byte < lower || byte > upper) {
			return null
		}

		lower = 0x80
		upper = 0xbf
		codePoint = (codePoint << 6) | (byte & 0x3f)

		if (++seen < needed) {
			continue
		}

		if (codePoint > 0xffff) {
			units[length++] = 0xd800 + ((codePoint - 0x10000) >> 10)
			units[length++] = 0xdc00 + ((codePoint - 0x10000) & 0x3ff)
		} else {
			units[length++] = codePoint
		}

		needed = 0
		seen = 0
		codePoint = 0
	}

	return needed === 0 ? unitsText(units, length) : null
}

// UTF-16 in either byte order, an unpaired surrogate or a last odd byte read as U+FFFD.
export function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
	const native = nativeDecoder(littleEndian ? "utf-16le" : "utf-16be", false)

	return native !== null ? native.decode(bytes) : decodeUtf16Fallback(bytes, littleEndian)
}

// The standard's UTF-16 decoder.
export function decodeUtf16Fallback(bytes: Uint8Array, littleEndian: boolean): string {
	const count = bytes.length >> 1
	const units = new Uint16Array(count + 1)
	let length = 0
	let lead = -1

	for (let i = 0; i < count; i++) {
		const first = bytes[i * 2] ?? 0
		const second = bytes[i * 2 + 1] ?? 0
		const unit = littleEndian ? first | (second << 8) : (first << 8) | second

		if (lead !== -1) {
			if (unit >= 0xdc00 && unit <= 0xdfff) {
				units[length++] = lead
				units[length++] = unit
				lead = -1

				continue
			}

			units[length++] = REPLACEMENT
			lead = -1
		}

		if (unit >= 0xd800 && unit <= 0xdbff) {
			lead = unit
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			units[length++] = REPLACEMENT
		} else {
			units[length++] = unit
		}
	}

	// A lead surrogate left over, or an odd byte, ends the stream as one error.
	if (lead !== -1 || bytes.length % 2 === 1) {
		units[length++] = REPLACEMENT
	}

	return unitsText(units, length)
}

let windows1252Table: Uint16Array | null = null

function windows1252Decoding(): Uint16Array {
	if (windows1252Table === null) {
		windows1252Table = new Uint16Array(256)

		for (let byte = 0; byte < 256; byte++) {
			windows1252Table[byte] = byte >= 0x80 && byte <= 0x9f ? (CP1252_HIGH[byte - 0x80] ?? byte) : byte
		}
	}

	return windows1252Table
}

export function decodeWindows1252(bytes: Uint8Array): string {
	const table = windows1252Decoding()
	let out = ""

	for (let start = 0; start < bytes.length; start += CHUNK) {
		const end = Math.min(bytes.length, start + CHUNK)
		const units = new Uint16Array(end - start)

		for (let i = start; i < end; i++) {
			units[i - start] = table[bytes[i] ?? 0] ?? 0
		}

		out += String.fromCharCode.apply(null, units as unknown as number[])
	}

	return out
}

// The bytes windows-1252 leaves undefined.
export function isWindows1252Undefined(byte: number): boolean {
	return byte === 0x81 || byte === 0x8d || byte === 0x8f || byte === 0x90 || byte === 0x9d
}

let windows1252Encoding: Map<number, number> | null = null

// windows-1252 bytes, or null when the text holds a character it cannot represent (the five undefined
// bytes have no character either: text holding their C1 code points is never written). Per UTF-16 code unit:
// every representable character is in the BMP, so a surrogate half is unrepresentable anyway.
export function encodeWindows1252(text: string): Uint8Array | null {
	if (windows1252Encoding === null) {
		windows1252Encoding = new Map()

		CP1252_HIGH.forEach((code, index) => {
			if (!isWindows1252Undefined(0x80 + index)) {
				windows1252Encoding?.set(code, 0x80 + index)
			}
		})
	}

	const bytes = new Uint8Array(text.length)

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)

		if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
			bytes[i] = code

			continue
		}

		const mapped = windows1252Encoding.get(code)

		if (mapped === undefined) {
			return null
		}

		bytes[i] = mapped
	}

	return bytes
}

// A string is UTF-16 code units already: each is split into its two bytes in the given order, surrogate
// pairs included.
// `prefix` (a byte order mark) is written first, into the same buffer, so the body is never copied to make room for it.
export function encodeUtf16(text: string, littleEndian: boolean, prefix: readonly number[] = []): Uint8Array {
	const offset = prefix.length
	const bytes = new Uint8Array(offset + text.length * 2)

	bytes.set(prefix)

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		const high = (code >> 8) & 0xff
		const low = code & 0xff

		bytes[offset + i * 2] = littleEndian ? low : high
		bytes[offset + i * 2 + 1] = littleEndian ? high : low
	}

	return bytes
}
