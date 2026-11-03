// A grow-only byte buffer for PDF syntax: ASCII text, numbers and raw bytes. Reused across pages (reset keeps
// the allocation), so writing a page allocates nothing once the buffer has reached that page's size.

// Coordinates never need more: 1/1000 of a unit at 96 px per inch, far below a device pixel.
const MAX_MAGNITUDE = 1e9

export class ByteWriter {
	private buffer: Uint8Array
	length = 0

	constructor(initial: number = 4096) {
		this.buffer = new Uint8Array(initial)
	}

	private ensure(extra: number): void {
		const needed = this.length + extra

		if (needed <= this.buffer.length) return

		let size = this.buffer.length * 2

		while (size < needed) size *= 2

		const grown = new Uint8Array(size)

		grown.set(this.buffer.subarray(0, this.length))
		this.buffer = grown
	}

	reset(): void {
		this.length = 0
	}

	// The written bytes, a view into the buffer: valid until the next write or reset.
	view(): Uint8Array {
		return this.buffer.subarray(0, this.length)
	}

	// A copy of the written bytes.
	take(): Uint8Array {
		return this.buffer.slice(0, this.length)
	}

	byte(value: number): this {
		this.ensure(1)
		this.buffer[this.length++] = value

		return this
	}

	bytes(data: Uint8Array): this {
		this.ensure(data.length)
		this.buffer.set(data, this.length)
		this.length += data.length

		return this
	}

	// Text of code units below 256 (PDF syntax is ASCII; callers escape anything else first).
	ascii(text: string): this {
		const count = text.length

		this.ensure(count)

		const buffer = this.buffer
		let at = this.length

		for (let index = 0; index < count; index++) buffer[at++] = text.charCodeAt(index) & 0xff

		this.length = at

		return this
	}

	int(value: number): this {
		let rest = Math.trunc(value)

		if (rest === 0) return this.byte(0x30)
		// Past the safe integers digits would be lost (and past 2^31 no PDF integer is portable): bounded as a real.
		if (!Number.isSafeInteger(rest)) return this.num(value)

		// A sign and up to 16 digits.
		this.ensure(17)

		if (rest < 0) {
			this.buffer[this.length++] = 0x2d
			rest = -rest
		}

		const start = this.length

		while (rest > 0) {
			this.buffer[this.length++] = 0x30 + (rest % 10)
			rest = Math.floor(rest / 10)
		}

		this.buffer.subarray(start, this.length).reverse()

		return this
	}

	// A real number with at most `digits` decimals (0-6), trailing zeros dropped, never in exponent form.
	num(value: number, digits: number = 3): this {
		const v = Number.isFinite(value) ? Math.max(-MAX_MAGNITUDE, Math.min(MAX_MAGNITUDE, value)) : 0
		const scale = SCALES[digits] ?? 1000
		let scaled = Math.round(Math.abs(v) * scale)

		if (scaled === 0) return this.byte(0x30)
		if (v < 0) this.byte(0x2d)

		const whole = Math.floor(scaled / scale)

		this.int(whole)
		scaled -= whole * scale

		if (scaled === 0) return this

		this.ensure(digits + 1)
		this.buffer[this.length++] = 0x2e

		let place = scale / 10

		while (scaled > 0 && place >= 1) {
			const digit = Math.floor(scaled / place)

			this.buffer[this.length++] = 0x30 + digit
			scaled -= digit * place
			place /= 10
		}

		return this
	}

	// Four upper-case hex digits of a 16-bit value.
	hex4(value: number): this {
		this.ensure(4)

		const buffer = this.buffer
		const at = this.length

		buffer[at] = HEX_DIGITS[(value >>> 12) & 15] ?? 0x30
		buffer[at + 1] = HEX_DIGITS[(value >>> 8) & 15] ?? 0x30
		buffer[at + 2] = HEX_DIGITS[(value >>> 4) & 15] ?? 0x30
		buffer[at + 3] = HEX_DIGITS[value & 15] ?? 0x30
		this.length = at + 4

		return this
	}

	space(): this {
		return this.byte(0x20)
	}

	newline(): this {
		return this.byte(0x0a)
	}
}

const SCALES = [1, 10, 100, 1000, 10000, 100000, 1000000]

const HEX = "0123456789ABCDEF"
const HEX_DIGITS = Uint8Array.from(HEX, char => char.charCodeAt(0))

export function writeHex(out: ByteWriter, data: Uint8Array): void {
	for (const byte of data) out.byte(HEX.charCodeAt(byte >>> 4)).byte(HEX.charCodeAt(byte & 15))
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
	let size = 0

	for (const part of parts) size += part.length

	const out = new Uint8Array(size)
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}
