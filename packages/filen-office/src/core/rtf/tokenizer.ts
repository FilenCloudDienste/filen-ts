// The lexical layer of RTF (Microsoft RTF Specification 1.9.1, "RTF Syntax"): groups, control words with
// their optional signed parameter and delimiting space, control symbols, \'hh, \binN with its raw bytes,
// and text. Every token keeps the byte range it was read from, so a writer can copy source bytes as they
// were. One pass, no backtracking, no allocation per token besides control-word names (interned).

export const Token = {
	End: 0,
	GroupStart: 1,
	GroupEnd: 2,
	// A control word: `name`, with `param` when `hasParam`.
	Word: 3,
	// A control symbol other than \' (\~, \-, \_, \*, \{ ...): `symbol` is its character code.
	Symbol: 4,
	// \'hh: `value` is the byte (0..255), or -1 when the two characters are not hex digits.
	Hex: 5,
	// Plain text bytes [textStart, textEnd); CR and LF end a text token and are not part of any.
	Text: 6,
	// \binN: the data is [dataStart, dataEnd), clamped to the input (`clamped` set when N reached past it).
	Bin: 7
} as const

export type Token = (typeof Token)[keyof typeof Token]

const BACKSLASH = 0x5c
const OPEN = 0x7b
const CLOSE = 0x7d
const CR = 0x0d
const LF = 0x0a
const SPACE = 0x20
const MINUS = 0x2d
const QUOTE = 0x27

// Parameters are signed 16-bit in most words and 32-bit in some (\binN, \levelstartatN, ids); longer digit
// runs are read in full and clamped.
const PARAM_MAX = 0x7fffffff
// The specification limits names to 32 letters; longer ones are read in full and never match a known word.
const NAME_MAX = 32

export function isLetter(byte: number): boolean {
	return (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x41 && byte <= 0x5a)
}

export function isDigit(byte: number): boolean {
	return byte >= 0x30 && byte <= 0x39
}

function hexValue(byte: number): number {
	if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
	if (byte >= 0x61 && byte <= 0x66) return byte - 0x57
	if (byte >= 0x41 && byte <= 0x46) return byte - 0x37

	return -1
}

export class RtfTokenizer {
	readonly bytes: Uint8Array
	// The current token and its source range [start, end).
	kind: Token = Token.End
	start = 0
	end = 0
	name = ""
	param = 0
	hasParam = false
	symbol = 0
	value = 0
	textStart = 0
	textEnd = 0
	dataStart = 0
	dataEnd = 0
	clamped = false
	private at = 0
	private readonly names = new Map<number, string[]>()

	constructor(bytes: Uint8Array, start = 0) {
		this.bytes = bytes
		this.at = start
	}

	get position(): number {
		return this.at
	}

	// Moves to `position` (a group's end found by skipGroup, or a saved position).
	seek(position: number): void {
		this.at = Math.max(0, Math.min(position, this.bytes.length))
	}

	next(): Token {
		const bytes = this.bytes
		const length = bytes.length
		let at = this.at

		while (at < length && (bytes[at] === CR || bytes[at] === LF)) at++

		this.start = at

		if (at >= length) {
			this.at = at
			this.end = at
			this.kind = Token.End

			return Token.End
		}

		const byte = bytes[at] ?? 0

		if (byte === OPEN || byte === CLOSE) {
			this.at = at + 1
			this.end = at + 1
			this.kind = byte === OPEN ? Token.GroupStart : Token.GroupEnd

			return this.kind
		}

		if (byte !== BACKSLASH) {
			let end = at + 1

			while (end < length) {
				const next = bytes[end] ?? 0

				if (next === BACKSLASH || next === OPEN || next === CLOSE || next === CR || next === LF) break

				end++
			}

			this.at = end
			this.end = end
			this.textStart = at
			this.textEnd = end
			this.kind = Token.Text

			return Token.Text
		}

		at++

		if (at >= length) {
			// A trailing backslash: an empty control symbol, read as nothing.
			this.at = at
			this.end = at
			this.symbol = 0
			this.kind = Token.Symbol

			return Token.Symbol
		}

		const first = bytes[at] ?? 0

		if (!isLetter(first)) {
			if (first === QUOTE) {
				const high = hexValue(bytes[at + 1] ?? -1)
				const low = hexValue(bytes[at + 2] ?? -1)

				if (high >= 0 && low >= 0) {
					this.value = (high << 4) | low
					this.at = at + 3
				} else {
					this.value = -1
					// Consume what hex digits there are so a broken escape never reads as text.
					this.at = at + 1 + (high >= 0 ? 1 : 0)
				}

				this.end = this.at
				this.kind = Token.Hex

				return Token.Hex
			}

			// \<CR> and \<LF> are \par (spec: "a backslash followed by a carriage return or line feed").
			this.symbol = first === CR || first === LF ? LF : first
			this.at = at + 1
			this.end = this.at
			this.kind = Token.Symbol

			return Token.Symbol
		}

		const nameStart = at
		let hash = 0

		while (at < length && isLetter(bytes[at] ?? 0)) {
			hash = (Math.imul(hash, 31) + (bytes[at] ?? 0)) | 0
			at++
		}

		this.name = this.intern(nameStart, at, hash)

		let negative = false
		let digits = 0
		let param = 0

		if (bytes[at] === MINUS && isDigit(bytes[at + 1] ?? 0)) {
			negative = true
			at++
		}

		while (at < length && isDigit(bytes[at] ?? 0)) {
			if (param <= PARAM_MAX) param = param * 10 + ((bytes[at] ?? 0) - 0x30)

			digits++
			at++
		}

		this.hasParam = digits > 0
		param = Math.min(param, PARAM_MAX)
		this.param = negative ? -param : param

		if (bytes[at] === SPACE) at++

		this.at = at
		this.end = at

		if (this.name === "bin" && this.hasParam) {
			const count = Math.max(0, this.param)
			const dataEnd = Math.min(length, at + count)

			this.dataStart = at
			this.dataEnd = dataEnd
			this.clamped = at + count > length
			this.at = dataEnd
			this.end = dataEnd
			this.kind = Token.Bin

			return Token.Bin
		}

		this.kind = Token.Word

		return Token.Word
	}

	// Skips to just past the group the last GroupStart opened (or the end of the input), linear: \binN data
	// is jumped over, braces in it never count. Returns the position after the closing brace.
	skipGroup(): number {
		let depth = 1

		while (depth > 0) {
			const kind = this.next()

			if (kind === Token.End) break
			if (kind === Token.GroupStart) depth++
			else if (kind === Token.GroupEnd) depth--
		}

		return this.at
	}

	private intern(start: number, end: number, hash: number): string {
		const bytes = this.bytes
		const bucket = this.names.get(hash)

		if (bucket !== undefined) {
			for (const name of bucket) {
				if (name.length !== end - start) continue

				let same = true

				for (let k = 0; k < name.length; k++) {
					if (name.charCodeAt(k) !== bytes[start + k]) {
						same = false

						break
					}
				}

				if (same) return name
			}
		}

		let name = ""

		for (let k = start; k < end; k++) name += String.fromCharCode(bytes[k] ?? 0)

		// Over-long names are not interned (they never match a known word and must not grow the table).
		if (end - start <= NAME_MAX) {
			if (bucket === undefined) this.names.set(hash, [name])
			else if (bucket.length < 8) bucket.push(name)
		}

		return name
	}
}
