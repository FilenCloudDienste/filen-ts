// The little PDF syntax the verifier reads from raw bytes itself: cross-reference sections and trailers, which MuPDF's
// object access does not expose per revision. Values are parsed shallowly and bounded; anything unexpected is null.

export type PdfValue =
	| { readonly type: "number"; readonly value: number }
	| { readonly type: "name"; readonly value: string }
	| { readonly type: "string"; readonly value: Uint8Array }
	| { readonly type: "ref"; readonly num: number; readonly gen: number }
	| { readonly type: "array"; readonly items: readonly PdfValue[] }
	| { readonly type: "dict"; readonly entries: ReadonlyMap<string, PdfValue> }
	| { readonly type: "bool"; readonly value: boolean }
	| { readonly type: "null" }

const MAX_DEPTH = 32
const ESCAPES = new Map([
	[0x6e, 0x0a],
	[0x72, 0x0d],
	[0x74, 0x09],
	[0x62, 0x08],
	[0x66, 0x0c]
])
const MAX_ITEMS = 100_000

export function isWhite(byte: number): boolean {
	return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00
}

function isDelimiter(byte: number): boolean {
	return (
		byte === 0x28 ||
		byte === 0x29 ||
		byte === 0x3c ||
		byte === 0x3e ||
		byte === 0x5b ||
		byte === 0x5d ||
		byte === 0x7b ||
		byte === 0x7d ||
		byte === 0x2f ||
		byte === 0x25
	)
}

export function isHexDigit(byte: number): boolean {
	return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66)
}

function hexValue(byte: number): number {
	if (byte <= 0x39) return byte - 0x30
	if (byte <= 0x46) return byte - 0x37

	return byte - 0x57
}

// Hex digits only (no whitespace): odd length pads a 0, as PDF hex strings do.
export function decodeHex(bytes: Uint8Array): Uint8Array | null {
	const out = new Uint8Array((bytes.length + 1) >> 1)

	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i] ?? 0

		if (!isHexDigit(byte)) return null

		const value = hexValue(byte)
		const at = i >> 1

		out[at] = (i & 1) === 0 ? value << 4 : (out[at] ?? 0) | value
	}

	return out
}

export function latin1(bytes: Uint8Array): string {
	let text = ""

	for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))

	return text
}

export function asciiBytes(text: string): Uint8Array {
	const out = new Uint8Array(text.length)

	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff

	return out
}

// Index of `needle` in `haystack` at or after `from`, or -1.
export function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
	const first = needle[0]

	outer: for (let i = Math.max(0, from); i <= haystack.length - needle.length; i++) {
		if (haystack[i] !== first) continue

		for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer

		return i
	}

	return -1
}

export function lastIndexOf(haystack: Uint8Array, needle: Uint8Array, before = haystack.length): number {
	outer: for (let i = Math.min(before, haystack.length) - needle.length; i >= 0; i--) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer

		return i
	}

	return -1
}

export class PdfLexer {
	readonly bytes: Uint8Array
	position: number

	constructor(bytes: Uint8Array, start = 0) {
		this.bytes = bytes
		this.position = start
	}

	skipWhite(): void {
		const bytes = this.bytes

		while (this.position < bytes.length) {
			const byte = bytes[this.position] ?? 0

			if (byte === 0x25) {
				while (this.position < bytes.length && bytes[this.position] !== 0x0a && bytes[this.position] !== 0x0d) this.position++
			} else if (isWhite(byte)) this.position++
			else return
		}
	}

	// A keyword or number token, or null at a delimiter or the end.
	word(): string | null {
		this.skipWhite()

		const start = this.position
		const bytes = this.bytes

		while (this.position < bytes.length) {
			const byte = bytes[this.position] ?? 0

			if (isWhite(byte) || isDelimiter(byte)) break

			this.position++
		}

		return this.position === start ? null : latin1(bytes.subarray(start, this.position))
	}

	integer(): number | null {
		const word = this.word()

		return word !== null && /^\d{1,15}$/.test(word) ? Number(word) : null
	}

	expect(keyword: string): boolean {
		const at = this.position

		if (this.word() === keyword) return true

		this.position = at

		return false
	}

	value(depth = 0): PdfValue | null {
		if (depth > MAX_DEPTH) return null

		this.skipWhite()

		const bytes = this.bytes
		const byte = bytes[this.position]

		if (byte === undefined) return null

		if (byte === 0x2f) {
			this.position++

			const start = this.position

			while (this.position < bytes.length) {
				const next = bytes[this.position] ?? 0

				if (isWhite(next) || isDelimiter(next)) break

				this.position++
			}

			return { type: "name", value: decodeName(latin1(bytes.subarray(start, this.position))) }
		}

		if (byte === 0x3c && bytes[this.position + 1] === 0x3c) return this.dict(depth)

		if (byte === 0x3c) {
			const end = this.bytes.indexOf(0x3e, this.position)

			if (end < 0) return null

			const digits = bytes.subarray(this.position + 1, end).filter(digit => !isWhite(digit))

			this.position = end + 1

			const value = decodeHex(digits)

			return value === null ? null : { type: "string", value }
		}

		if (byte === 0x28) return this.literal()

		if (byte === 0x5b) {
			this.position++

			const items: PdfValue[] = []

			for (;;) {
				this.skipWhite()

				if (bytes[this.position] === 0x5d) {
					this.position++

					return { type: "array", items }
				}

				const item = this.value(depth + 1)

				if (item === null || items.length >= MAX_ITEMS) return null

				items.push(item)
			}
		}

		const word = this.word()

		if (word === null) return null
		if (word === "true" || word === "false") return { type: "bool", value: word === "true" }
		if (word === "null") return { type: "null" }

		if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return null

		const number = Number(word)

		// "num gen R"
		if (/^\d+$/.test(word)) {
			const at = this.position
			const gen = this.word()

			if (gen !== null && /^\d+$/.test(gen) && this.word() === "R") return { type: "ref", num: number, gen: Number(gen) }

			this.position = at
		}

		return { type: "number", value: number }
	}

	private dict(depth: number): PdfValue | null {
		this.position += 2

		const entries = new Map<string, PdfValue>()

		for (;;) {
			this.skipWhite()

			if (this.bytes[this.position] === 0x3e && this.bytes[this.position + 1] === 0x3e) {
				this.position += 2

				return { type: "dict", entries }
			}

			const key = this.value(depth + 1)

			if (key?.type !== "name" || entries.size >= MAX_ITEMS) return null

			const value = this.value(depth + 1)

			if (value === null) return null

			entries.set(key.value, value)
		}
	}

	private literal(): PdfValue | null {
		const bytes = this.bytes
		const out: number[] = []
		let depth = 0

		this.position++

		while (this.position < bytes.length) {
			const byte = bytes[this.position++] ?? 0

			if (byte === 0x5c) {
				const next = bytes[this.position++] ?? 0
				const escaped = ESCAPES.get(next)

				if (escaped !== undefined) out.push(escaped)
				else if (next >= 0x30 && next <= 0x37) {
					let code = next - 0x30

					for (let i = 0; i < 2 && (bytes[this.position] ?? 0) >= 0x30 && (bytes[this.position] ?? 0) <= 0x37; i++)
						code = code * 8 + (bytes[this.position++] ?? 0) - 0x30

					out.push(code & 0xff)
				} else if (next === 0x0d) {
					if (bytes[this.position] === 0x0a) this.position++
				} else if (next !== 0x0a) out.push(next)
			} else if (byte === 0x28) {
				depth++
				out.push(byte)
			} else if (byte === 0x29) {
				if (depth === 0) return { type: "string", value: Uint8Array.from(out) }

				depth--
				out.push(byte)
			} else out.push(byte)
		}

		return null
	}
}

function decodeName(raw: string): string {
	return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

export function dictNumber(dict: ReadonlyMap<string, PdfValue>, key: string): number | null {
	const value = dict.get(key)

	return value?.type === "number" ? value.value : null
}

export function dictName(dict: ReadonlyMap<string, PdfValue>, key: string): string | null {
	const value = dict.get(key)

	return value?.type === "name" ? value.value : null
}
