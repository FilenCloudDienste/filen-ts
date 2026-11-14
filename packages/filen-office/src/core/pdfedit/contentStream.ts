// A PDF content stream lexer for rewriting: operations with their operands and the byte range they came from, so a
// rewrite copies everything it does not change verbatim. Also used to read every string a stream carries (literal and
// hex, escapes decoded), which is how a check finds text that is not drawn as glyphs (marked-content properties).

export type PdfOperand =
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "name"; readonly value: string }
	| { readonly kind: "string"; readonly bytes: Uint8Array }
	| { readonly kind: "array"; readonly items: readonly PdfOperand[] }
	| { readonly kind: "dict"; readonly entries: ReadonlyMap<string, PdfOperand> }
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "null" }

export interface PdfOperation {
	readonly operator: string
	readonly operands: readonly PdfOperand[]
	// Byte range in the stream, operands included.
	readonly start: number
	readonly end: number
}

const SPACE = new Uint8Array(256)
const DELIMITER = new Uint8Array(256)

for (const code of [0, 9, 10, 12, 13, 32]) SPACE[code] = 1
for (const char of "()<>[]{}/%") DELIMITER[char.charCodeAt(0)] = 1

// \n \r \t \b \f in a literal string; any other escaped byte stands for itself.
const ESCAPES = new Map([
	[110, 10],
	[114, 13],
	[116, 9],
	[98, 8],
	[102, 12]
])

const isRegular = (code: number): boolean => SPACE[code] !== 1 && DELIMITER[code] !== 1
const hexValue = (code: number): number =>
	code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1

type Lexeme =
	| { readonly kind: "operand"; readonly value: PdfOperand }
	| { readonly kind: "keyword"; readonly value: string }
	| { readonly kind: "open"; readonly value: "[" | "<<" }
	| { readonly kind: "close"; readonly value: "]" | ">>" }

class Lexer {
	position = 0
	readonly bytes: Uint8Array

	constructor(bytes: Uint8Array) {
		this.bytes = bytes
	}

	skipSpace(): void {
		const { bytes } = this

		while (this.position < bytes.length) {
			const code = bytes[this.position] ?? 0

			if (SPACE[code] === 1) {
				this.position++
			} else if (code === 37) {
				while (this.position < bytes.length && bytes[this.position] !== 10 && bytes[this.position] !== 13) this.position++
			} else {
				return
			}
		}
	}

	// The next lexeme, or null at the end.
	next(): Lexeme | null {
		this.skipSpace()

		const { bytes } = this

		if (this.position >= bytes.length) return null

		const code = bytes[this.position] ?? 0

		if (code === 40) return { kind: "operand", value: { kind: "string", bytes: this.literal() } }
		if (code === 60) {
			if (bytes[this.position + 1] === 60) {
				this.position += 2

				return { kind: "open", value: "<<" }
			}

			return { kind: "operand", value: { kind: "string", bytes: this.hex() } }
		}
		if (code === 62) {
			this.position += bytes[this.position + 1] === 62 ? 2 : 1

			return { kind: "close", value: ">>" }
		}
		if (code === 91) {
			this.position++

			return { kind: "open", value: "[" }
		}
		if (code === 93) {
			this.position++

			return { kind: "close", value: "]" }
		}
		if (code === 47) return { kind: "operand", value: { kind: "name", value: this.name() } }
		if (code === 123 || code === 125 || code === 41) {
			// Braces (PostScript calculator functions) and a stray ")" carry nothing here.
			this.position++

			return { kind: "keyword", value: String.fromCharCode(code) }
		}

		const start = this.position

		while (this.position < bytes.length && isRegular(bytes[this.position] ?? 0)) this.position++

		let word = ""

		for (let index = start; index < this.position; index++) word += String.fromCharCode(bytes[index] ?? 0)

		if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { kind: "operand", value: { kind: "number", value: Number(word) } }
		if (word === "true" || word === "false") return { kind: "operand", value: { kind: "bool", value: word === "true" } }
		if (word === "null") return { kind: "operand", value: { kind: "null" } }

		return { kind: "keyword", value: word }
	}

	private literal(): Uint8Array {
		const { bytes } = this
		const out: number[] = []
		let depth = 1

		this.position++

		while (this.position < bytes.length) {
			const code = bytes[this.position++] ?? 0

			if (code === 92) {
				const escaped = bytes[this.position++] ?? 0

				if (escaped >= 48 && escaped <= 55) {
					let value = escaped - 48

					for (let digits = 1; digits < 3; digits++) {
						const next = bytes[this.position] ?? 0

						if (next < 48 || next > 55) break

						value = value * 8 + next - 48
						this.position++
					}

					out.push(value & 0xff)
				} else if (escaped === 13) {
					if (bytes[this.position] === 10) this.position++
				} else if (escaped !== 10) {
					out.push(ESCAPES.get(escaped) ?? escaped)
				}
			} else if (code === 40) {
				depth++
				out.push(code)
			} else if (code === 41) {
				depth--

				if (depth === 0) break

				out.push(code)
			} else {
				out.push(code)
			}
		}

		return Uint8Array.from(out)
	}

	private hex(): Uint8Array {
		const { bytes } = this
		const out: number[] = []
		let high = -1

		this.position++

		while (this.position < bytes.length) {
			const code = bytes[this.position++] ?? 0

			if (code === 62) break

			const value = hexValue(code)

			if (value < 0) continue
			if (high < 0) {
				high = value
			} else {
				out.push(high * 16 + value)
				high = -1
			}
		}

		if (high >= 0) out.push(high * 16)

		return Uint8Array.from(out)
	}

	private name(): string {
		const { bytes } = this
		let name = ""

		this.position++

		while (this.position < bytes.length && isRegular(bytes[this.position] ?? 0)) {
			const code = bytes[this.position++] ?? 0

			if (code === 35) {
				const high = hexValue(bytes[this.position] ?? 0)
				const low = hexValue(bytes[this.position + 1] ?? 0)

				if (high >= 0 && low >= 0) {
					name += String.fromCharCode(high * 16 + low)
					this.position += 2

					continue
				}
			}

			name += String.fromCharCode(code)
		}

		return name
	}
}

// Reads one composite operand after its opening lexeme.
function composite(lexer: Lexer, open: "[" | "<<"): PdfOperand {
	const items: PdfOperand[] = []

	for (;;) {
		const lexeme = lexer.next()

		if (lexeme === null || lexeme.kind === "close") break
		if (lexeme.kind === "open") items.push(composite(lexer, lexeme.value))
		else if (lexeme.kind === "operand") items.push(lexeme.value)
		// A keyword inside an array or dictionary is malformed; it is dropped.
	}

	if (open === "[") return { kind: "array", items }

	const entries = new Map<string, PdfOperand>()

	for (let index = 0; index + 1 < items.length; index += 2) {
		const key = items[index]
		const value = items[index + 1]

		if (key?.kind === "name" && value !== undefined) entries.set(key.value, value)
	}

	return { kind: "dict", entries }
}

// The end of an inline image's data: whitespace, "EI", then whitespace, a delimiter or the end.
function inlineImageEnd(bytes: Uint8Array, from: number): number {
	for (let index = from; index + 1 < bytes.length; index++) {
		if (
			bytes[index] === 69 &&
			bytes[index + 1] === 73 &&
			(index === from || SPACE[bytes[index - 1] ?? 0] === 1) &&
			(index + 2 >= bytes.length || !isRegular(bytes[index + 2] ?? 0))
		)
			return index
	}

	return bytes.length
}

// Every operation in the stream. An inline image (BI … ID data EI) is one operation "BI" whose operands are its
// dictionary; its data stays inside the byte range.
export function parseContent(bytes: Uint8Array): PdfOperation[] {
	const lexer = new Lexer(bytes)
	const operations: PdfOperation[] = []
	let operands: PdfOperand[] = []
	let start = -1

	for (;;) {
		lexer.skipSpace()

		const at = lexer.position
		const lexeme = lexer.next()

		if (lexeme === null) break
		if (start < 0) start = at
		if (lexeme.kind === "open") {
			operands.push(composite(lexer, lexeme.value))

			continue
		}
		if (lexeme.kind === "operand") {
			operands.push(lexeme.value)

			continue
		}
		if (lexeme.kind === "close") continue
		if (lexeme.value === "BI") {
			const pairs: PdfOperand[] = []

			for (;;) {
				const item = lexer.next()

				if (item === null || (item.kind === "keyword" && item.value === "ID")) break
				if (item.kind === "open") pairs.push(composite(lexer, item.value))
				else if (item.kind === "operand") pairs.push(item.value)
			}

			// One whitespace byte separates ID from the data.
			const dataStart = lexer.position + 1
			const end = inlineImageEnd(bytes, dataStart)

			lexer.position = Math.min(bytes.length, end + 2)

			const entries = new Map<string, PdfOperand>()

			for (let index = 0; index + 1 < pairs.length; index += 2) {
				const key = pairs[index]
				const value = pairs[index + 1]

				if (key?.kind === "name" && value !== undefined) entries.set(key.value, value)
			}

			operations.push({ operator: "BI", operands: [{ kind: "dict", entries }], start, end: lexer.position })
		} else {
			operations.push({ operator: lexeme.value, operands, start, end: lexer.position })
		}

		operands = []
		start = -1
	}

	return operations
}

// Every string and name in the bytes, decoded from PDF escapes, hex or #xx, wherever it sits (operands, arrays,
// dictionaries).
export function contentStrings(bytes: Uint8Array): Uint8Array[] {
	const lexer = new Lexer(bytes)
	const strings: Uint8Array[] = []

	for (;;) {
		const lexeme = lexer.next()

		if (lexeme === null) break
		if (lexeme.kind === "operand" && lexeme.value.kind === "string") strings.push(lexeme.value.bytes)
		if (lexeme.kind === "operand" && lexeme.value.kind === "name") strings.push(latin1(lexeme.value.value))
		if (lexeme.kind === "keyword" && lexeme.value === "BI") {
			// Skip the inline image's data, which is binary.
			while (lexer.position < bytes.length) {
				const item = lexer.next()

				if (item === null || (item.kind === "keyword" && item.value === "ID")) break
			}

			lexer.position = Math.min(bytes.length, inlineImageEnd(bytes, lexer.position + 1) + 2)
		}
	}

	return strings
}

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, char => char.charCodeAt(0) & 0xff)

function writeOperand(operand: PdfOperand): string {
	switch (operand.kind) {
		case "number":
			return Number.isInteger(operand.value) ? String(operand.value) : String(Math.round(operand.value * 1e6) / 1e6)
		case "name": {
			let out = "/"

			for (const char of operand.value) {
				const code = char.charCodeAt(0)

				out += code < 33 || code > 126 || !isRegular(code) || code === 35 ? `#${code.toString(16).padStart(2, "0")}` : char
			}

			return out
		}
		case "string": {
			let out = "<"

			for (const byte of operand.bytes) out += byte.toString(16).padStart(2, "0")

			return `${out}>`
		}
		case "array":
			return `[${operand.items.map(writeOperand).join(" ")}]`
		case "dict":
			return `<<${[...operand.entries].map(([key, value]) => `${writeOperand({ kind: "name", value: key })} ${writeOperand(value)}`).join(" ")}>>`
		case "bool":
			return operand.value ? "true" : "false"
		case "null":
			return "null"
	}
}

// One operation written out (never used for inline images, whose data only the original bytes hold).
export function writeOperation(operator: string, operands: readonly PdfOperand[]): Uint8Array {
	return latin1([...operands.map(writeOperand), operator].join(" "))
}

// What to do with a byte range of the original stream: drop it, or replace it with new bytes.
export interface ContentEdit {
	readonly start: number
	readonly end: number
	readonly replacement?: Uint8Array
}

// The stream with the edits applied; edits must not overlap. Untouched bytes are copied verbatim.
export function spliceContent(bytes: Uint8Array, edits: readonly ContentEdit[]): Uint8Array {
	const sorted = [...edits].sort((left, right) => left.start - right.start)
	const parts: Uint8Array[] = []
	let cursor = 0

	for (const edit of sorted) {
		if (edit.start < cursor) throw new Error("overlapping content edits")

		parts.push(bytes.subarray(cursor, edit.start))

		if (edit.replacement !== undefined) parts.push(Uint8Array.of(32), edit.replacement, Uint8Array.of(32))

		cursor = edit.end
	}

	parts.push(bytes.subarray(cursor))

	let length = 0

	for (const part of parts) length += part.length

	const out = new Uint8Array(length)
	let offset = 0

	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}

	return out
}

// The index of the EMC closing the marked-content section opened at `open` (BDC or BMC), or -1 when unbalanced.
export function sectionEnd(operations: readonly PdfOperation[], open: number): number {
	let depth = 0

	for (let index = open; index < operations.length; index++) {
		const operator = operations[index]?.operator

		if (operator === "BDC" || operator === "BMC") depth++
		else if (operator === "EMC" && --depth === 0) return index
	}

	return -1
}
