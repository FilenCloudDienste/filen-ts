// Names, attribute values and text runs are short, so a loop beats a TextDecoder call on them; longer ASCII takes the
// platform's TextDecoder where there is one (Hermes has none). Other text keeps the loop: it builds one-byte strings
// wherever the text fits them, where a native decode of a whole text holds two bytes a character for one wider
// character. Invalid sequences decode to U+FFFD, one per offending byte.

const CHUNK = 8192
// Up to this many bytes, ASCII is copied into a reused array for String.fromCharCode: no view is made per decode, and
// Function.apply over a typed array takes SpiderMonkey's slow path (twice V8's time for short slices). Past it, a
// native decode call costs less.
const SHORT = 40
// One array per length: setting an array's length on every decode costs more than the copy.
const shortUnits: number[][] = Array.from({ length: SHORT + 1 }, (_, length) => new Array<number>(length).fill(0))

interface NativeDecoder {
	decode(input: Uint8Array): string
}

// For ASCII, which it decodes as the loop does.
const native = ((): NativeDecoder | undefined => {
	const constructor = (globalThis as { TextDecoder?: new (label: string, options: object) => NativeDecoder }).TextDecoder

	if (typeof constructor !== "function") return undefined

	try {
		return new constructor("utf-8", { ignoreBOM: true })
	} catch {
		return undefined
	}
})()

export function decodeUtf8(bytes: Uint8Array, start: number = 0, end: number = bytes.length): string {
	if (end - start <= SHORT && start >= 0) {
		const last = Math.min(end, bytes.length)
		const units = shortUnits[Math.max(0, last - start)] ?? []

		for (let i = start; i < last; i++) {
			const b = bytes[i] ?? 0

			if (b >= 0x80) return decodeMultibyte(bytes, start, end)

			units[i - start] = b
		}

		return String.fromCharCode.apply(null, units)
	}

	let ascii = true

	for (let i = start; i < end; i++) {
		if ((bytes[i] ?? 0) >= 0x80) {
			ascii = false

			break
		}
	}

	if (ascii) {
		if (native !== undefined && start >= 0 && end <= bytes.length) return native.decode(bytes.subarray(start, end))
		if (end - start <= CHUNK) {
			return String.fromCharCode.apply(null, bytes.subarray(start, end) as unknown as number[])
		}

		let out = ""

		for (let i = start; i < end; i += CHUNK) {
			out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + CHUNK)) as unknown as number[])
		}

		return out
	}

	return decodeMultibyte(bytes, start, end)
}

function decodeMultibyte(bytes: Uint8Array, start: number, end: number): string {
	const units: number[] = []
	let out = ""
	let i = start

	while (i < end) {
		const b0 = bytes[i] ?? 0
		let code = 0xfffd
		let size = 1

		if (b0 < 0x80) {
			code = b0
		} else if (b0 >= 0xc2 && b0 <= 0xdf) {
			const b1 = bytes[i + 1] ?? 0

			if (i + 1 < end && (b1 & 0xc0) === 0x80) {
				code = ((b0 & 0x1f) << 6) | (b1 & 0x3f)
				size = 2
			}
		} else if (b0 >= 0xe0 && b0 <= 0xef) {
			const b1 = bytes[i + 1] ?? 0
			const b2 = bytes[i + 2] ?? 0

			if (i + 2 < end && (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80) {
				const value = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f)

				// Overlong forms and UTF-16 surrogates are not valid scalar values.
				if (value >= 0x800 && (value < 0xd800 || value > 0xdfff)) {
					code = value
					size = 3
				}
			}
		} else if (b0 >= 0xf0 && b0 <= 0xf4) {
			const b1 = bytes[i + 1] ?? 0
			const b2 = bytes[i + 2] ?? 0
			const b3 = bytes[i + 3] ?? 0

			if (i + 3 < end && (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80) {
				const value = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)

				if (value >= 0x10000 && value <= 0x10ffff) {
					code = value
					size = 4
				}
			}
		}

		if (code > 0xffff) {
			code -= 0x10000
			units.push(0xd800 | (code >> 10), 0xdc00 | (code & 0x3ff))
		} else {
			units.push(code)
		}

		i += size

		if (units.length >= CHUNK) {
			out += String.fromCharCode.apply(null, units)
			units.length = 0
		}
	}

	return out + String.fromCharCode.apply(null, units)
}

const encoder = new TextEncoder()

export function encodeUtf8(text: string): Uint8Array {
	return encoder.encode(text)
}

// UTF-16 (either byte order) to UTF-8, starting after any byte order mark. Unpaired surrogates become U+FFFD.
export function transcodeUtf16(bytes: Uint8Array, start: number, littleEndian: boolean): Uint8Array {
	const units = (bytes.length - start) >> 1
	// Every UTF-16 unit becomes at most three UTF-8 bytes (a surrogate pair, two units, becomes four).
	const out = new Uint8Array(units * 3)
	const low = littleEndian ? 0 : 1
	const high = littleEndian ? 1 : 0
	let o = 0

	for (let u = 0; u < units; u++) {
		const at = start + u * 2
		let code = (bytes[at + low] ?? 0) | ((bytes[at + high] ?? 0) << 8)

		if (code >= 0xd800 && code <= 0xdbff && u + 1 < units) {
			const next = (bytes[at + 2 + low] ?? 0) | ((bytes[at + 2 + high] ?? 0) << 8)

			if (next >= 0xdc00 && next <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
				u++
			}
		}

		if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd

		if (code < 0x80) {
			out[o++] = code
		} else if (code < 0x800) {
			out[o++] = 0xc0 | (code >> 6)
			out[o++] = 0x80 | (code & 0x3f)
		} else if (code < 0x10000) {
			out[o++] = 0xe0 | (code >> 12)
			out[o++] = 0x80 | ((code >> 6) & 0x3f)
			out[o++] = 0x80 | (code & 0x3f)
		} else {
			out[o++] = 0xf0 | (code >> 18)
			out[o++] = 0x80 | ((code >> 12) & 0x3f)
			out[o++] = 0x80 | ((code >> 6) & 0x3f)
			out[o++] = 0x80 | (code & 0x3f)
		}
	}

	return out.slice(0, o)
}
