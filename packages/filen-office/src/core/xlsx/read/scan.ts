import type { SliceClock } from "../../slicing"
import { decodeCData, decodeCharacterData, XmlError } from "../../xml/index"
import { XlsxReadError } from "./errors"

// A forward scanner over a part's UTF-8 bytes for what the tree parser would cost too much on: worksheets and
// shared strings, read in one pass without a node per element. It checks what reading needs (tags closed by
// their own names, quoted attributes, terminated comments, CDATA and processing instructions) and refuses a
// document type declaration, so no entity can expand.

export const LT = 60
export const GT = 62
export const SLASH = 47
export const QUOTE = 34
export const APOSTROPHE = 39
export const EQUALS = 61
export const BANG = 33
export const QUESTION = 63
export const COLON = 58
export const AMP = 38

export function isSpace(b: number | undefined): boolean {
	return b === 32 || b === 10 || b === 13 || b === 9
}

// The end of an XML name starting at `i`.
export function nameEnd(bytes: Uint8Array, i: number): number {
	const length = bytes.length

	while (i < length) {
		const b = bytes[i] ?? 0

		if (b === 32 || b === 10 || b === 13 || b === 9 || b === SLASH || b === GT || b === EQUALS) break

		i++
	}

	return i
}

// Where the local part of the name [start, end) begins (after its prefix).
export function localStart(bytes: Uint8Array, start: number, end: number): number {
	for (let i = start; i < end; i++) if (bytes[i] === COLON) return i + 1

	return start
}

// Whether the bytes [start, end) are `ascii`.
export function bytesAre(bytes: Uint8Array, start: number, end: number, ascii: string): boolean {
	if (end - start !== ascii.length) return false

	for (let k = 0; k < ascii.length; k++) if (bytes[start + k] !== ascii.charCodeAt(k)) return false

	return true
}

// Whether the local part of the name [start, end) is `local`.
export function localIs(bytes: Uint8Array, start: number, end: number, local: string): boolean {
	const from = end - local.length

	if (from < start) return false
	if (from > start && bytes[from - 1] !== COLON) return false

	for (let k = 0; k < local.length; k++) if (bytes[from + k] !== local.charCodeAt(k)) return false

	return true
}

export class Scanner {
	readonly bytes: Uint8Array
	readonly part: string
	// Set by tagEnd: the tag just read ended with "/>".
	selfClosing = false
	// Elements elementEnd walked through (its own included), added to by every call.
	elements = 0
	// Name spans of the open elements elementEnd walks through.
	private stack = new Int32Array(64)

	constructor(bytes: Uint8Array, part: string) {
		this.bytes = bytes
		this.part = part
	}

	fail(message: string, at: number): never {
		throw new XlsxReadError("malformed", message, this.part, at)
	}

	// After the start or empty-element tag whose "<" is at `i`: quoted values may hold ">".
	tagEnd(i: number): number {
		const bytes = this.bytes
		const length = bytes.length
		let j = i + 1

		while (j < length) {
			const b = bytes[j]

			if (b === GT) {
				this.selfClosing = bytes[j - 1] === SLASH

				return j + 1
			}

			if (b === QUOTE || b === APOSTROPHE) {
				const close = bytes.indexOf(b, j + 1)

				if (close < 0) break

				j = close + 1
			} else if (b === LT) {
				this.fail("A tag is not closed", i)
			} else {
				j++
			}
		}

		return this.fail("A tag is not closed", i)
	}

	// After the comment, CDATA section or processing instruction whose "<" is at `i`.
	markupEnd(i: number): number {
		const bytes = this.bytes

		if (bytes[i + 1] === QUESTION) {
			const close = indexOfPair(bytes, QUESTION, GT, i + 2)

			if (close < 0) this.fail("A processing instruction is not closed", i)

			return close + 2
		}

		if (bytes[i + 2] === 45 && bytes[i + 3] === 45) {
			for (let at = bytes.indexOf(45, i + 4); at >= 0; at = bytes.indexOf(45, at + 1)) {
				if (bytes[at + 1] === 45 && bytes[at + 2] === GT) return at + 3
			}

			return this.fail("A comment is not closed", i)
		}

		if (bytesAre(bytes, i + 2, i + 9, "[CDATA[")) {
			for (let at = bytes.indexOf(93, i + 9); at >= 0; at = bytes.indexOf(93, at + 1)) {
				if (bytes[at + 1] === 93 && bytes[at + 2] === GT) return at + 3
			}

			return this.fail("A CDATA section is not closed", i)
		}

		return this.fail("A document type declaration or unknown markup", i)
	}

	// After the element whose start tag's "<" is at `i`, checking that each end tag closes its own element.
	elementEnd(i: number): number {
		this.beginElement(i)

		return this.walk(Number.POSITIVE_INFINITY)
	}

	// The element walk() goes through: where it starts, the next byte to read and how deep it is.
	private walkStart = 0
	private walkAt = 0
	private walkDepth = 0

	// Starts walking the element whose start tag's "<" is at `i`, in steps of walk().
	beginElement(i: number): void {
		this.walkStart = i
		this.walkAt = i
		this.walkDepth = 0
	}

	// Reads up to `tags` more tags of the element begun; where it ends, or -1 when it has more.
	walk(tags: number): number {
		const bytes = this.bytes
		const length = bytes.length
		const start = this.walkStart
		let depth = this.walkDepth
		let at = this.walkAt

		for (let read = 0; read < tags; read++) {
			if (at >= length || bytes[at] !== LT) {
				at = bytes.indexOf(LT, at)

				if (at < 0) this.fail("An element is not closed", start)
			}

			const next = bytes[at + 1]

			if (next === BANG || next === QUESTION) {
				at = this.markupEnd(at)
			} else if (next === SLASH) {
				const end = nameEnd(bytes, at + 2)
				const nameStart = this.stack[(depth - 1) * 2] ?? 0
				const nameLength = this.stack[(depth - 1) * 2 + 1] ?? 0

				if (depth === 0 || end - (at + 2) !== nameLength || !sameBytes(bytes, nameStart, at + 2, nameLength)) {
					this.fail("An end tag does not match its start tag", at)
				}

				const close = bytes.indexOf(GT, end)

				if (close < 0) this.fail("An end tag is not closed", at)

				depth--
				at = close + 1

				if (depth === 0) return at
			} else {
				const end = nameEnd(bytes, at + 1)

				if (end === at + 1) this.fail("An element has no name", at)

				const after = this.tagEnd(at)

				this.elements++

				if (!this.selfClosing) {
					if ((depth + 1) * 2 > this.stack.length) {
						const grown = new Int32Array(this.stack.length * 2)

						grown.set(this.stack)
						this.stack = grown
					}

					this.stack[depth * 2] = at + 1
					this.stack[depth * 2 + 1] = end - (at + 1)
					depth++
				} else if (depth === 0) {
					return after
				}

				at = after
			}
		}

		this.walkDepth = depth
		this.walkAt = at

		return -1
	}

	// The root element's "<": skips the XML declaration, comments, processing instructions and white space.
	rootStart(from: number): number {
		const bytes = this.bytes
		let i = from

		for (;;) {
			while (isSpace(bytes[i])) i++

			if (i >= bytes.length || bytes[i] !== LT) this.fail("No root element", i)

			const next = bytes[i + 1]

			if (next === QUESTION || next === BANG) i = this.markupEnd(i)
			else return i
		}
	}

	// The decoded character data of the element whose content starts at `i` (after its start tag), and where
	// its end tag ends (`textEnd`). Child elements contribute their text when `nested`; otherwise they are
	// skipped.
	textEnd = 0

	text(i: number, nested: boolean): string {
		const bytes = this.bytes
		let out = ""
		let at = i
		let depth = 0

		for (;;) {
			const lt = bytes.indexOf(LT, at)

			if (lt < 0) this.fail("An element is not closed", i)

			if (lt > at) out += this.characters(at, lt)

			const next = bytes[lt + 1]

			if (next === SLASH) {
				const close = bytes.indexOf(GT, lt)

				if (close < 0) this.fail("An end tag is not closed", lt)

				at = close + 1

				if (depth === 0) {
					this.textEnd = at

					return out
				}

				depth--
			} else if (next === BANG && bytesAre(bytes, lt + 2, lt + 9, "[CDATA[")) {
				const end = this.markupEnd(lt)

				out += decodeCData(bytes, lt + 9, end - 3)
				at = end
			} else if (next === BANG || next === QUESTION) {
				at = this.markupEnd(lt)
			} else if (nested) {
				at = this.tagEnd(lt)

				if (!this.selfClosing) depth++
			} else {
				at = this.elementEnd(lt)
			}
		}
	}

	characters(start: number, end: number): string {
		try {
			return decodeCharacterData(this.bytes, start, end, false)
		} catch (error) {
			if (error instanceof XmlError) this.fail(error.message, start)

			throw error
		}
	}

	attributeValue(start: number, end: number): string {
		try {
			return decodeCharacterData(this.bytes, start, end, true)
		} catch (error) {
			if (error instanceof XmlError) this.fail(error.message, start)

			throw error
		}
	}

	// Calls `visit` with each attribute's name and value spans in the start tag [tagStart, tagEnd).
	attributes(
		tagStart: number,
		tagEnd: number,
		visit: (nameStart: number, nameEnd: number, valueStart: number, valueEnd: number) => void
	): void {
		const bytes = this.bytes
		let j = nameEnd(bytes, tagStart + 1)

		for (;;) {
			while (j < tagEnd && isSpace(bytes[j])) j++

			const b = bytes[j]

			if (j >= tagEnd || b === SLASH || b === GT) return

			const nameStart = j

			j = nameEnd(bytes, j)

			const attributeNameEnd = j

			while (isSpace(bytes[j])) j++

			if (bytes[j] !== EQUALS || attributeNameEnd === nameStart) this.fail("An attribute has no value", nameStart)

			j++

			while (isSpace(bytes[j])) j++

			const quote = bytes[j]

			if (quote !== QUOTE && quote !== APOSTROPHE) this.fail("An attribute value is not quoted", j)

			const close = bytes.indexOf(quote, j + 1)

			if (close < 0 || close >= tagEnd) this.fail("An attribute value is not closed", j)

			visit(nameStart, attributeNameEnd, j + 1, close)
			j = close + 1
		}
	}
}

function sameBytes(bytes: Uint8Array, a: number, b: number, length: number): boolean {
	for (let k = 0; k < length; k++) if (bytes[a + k] !== bytes[b + k]) return false

	return true
}

function indexOfPair(bytes: Uint8Array, first: number, second: number, from: number): number {
	for (let at = bytes.indexOf(first, from); at >= 0; at = bytes.indexOf(first, at + 1)) {
		if (bytes[at + 1] === second) return at
	}

	return -1
}

// An unsigned decimal integer in [start, end) (surrounding white space allowed), or -1.
export function parseUint(bytes: Uint8Array, start: number, end: number): number {
	while (start < end && isSpace(bytes[start])) start++
	while (end > start && isSpace(bytes[end - 1])) end--

	if (start === end || end - start > 15) return -1

	let value = 0

	for (let i = start; i < end; i++) {
		const digit = (bytes[i] ?? 0) - 48

		if (digit < 0 || digit > 9) return -1

		value = value * 10 + digit
	}

	return value
}

// 2^53: every integer below it, and so each partial sum of one, is exact.
const EXACT = 9_007_199_254_740_992
const POWERS = [
	1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22
]

// A number as Number() reads the text [start, end), the same double: a plain decimal whose digits form an integer
// below 2^53 is exact as integer / 10^k (both exact, one correctly rounded division, as Number() rounds); anything
// else goes through Number(). NaN for text that is not a number, as Number() gives it, and for empty text.
export function parseNumber(bytes: Uint8Array, start: number, end: number): number {
	while (start < end && isSpace(bytes[start])) start++
	while (end > start && isSpace(bytes[end - 1])) end--

	if (start === end) return Number.NaN

	let i = start
	const negative = bytes[i] === 45

	if (negative || bytes[i] === 43) i++

	const integerStart = i
	let mantissa = 0

	for (; i < end; i++) {
		const digit = (bytes[i] as number) - 48

		if (digit < 0 || digit > 9) break

		mantissa = mantissa * 10 + digit
	}

	if (i > integerStart) {
		if (i === end) {
			if (mantissa < EXACT) return negative ? -mantissa : mantissa
		} else if (bytes[i] === 46) {
			const fractionStart = ++i

			for (; i < end; i++) {
				const digit = (bytes[i] as number) - 48

				if (digit < 0 || digit > 9) break

				mantissa = mantissa * 10 + digit
			}

			const fraction = i - fractionStart

			if (i === end && fraction > 0 && fraction < POWERS.length && mantissa < EXACT) {
				const value = mantissa / (POWERS[fraction] as number)

				return negative ? -value : value
			}
		}
	}

	const units = numberUnits[end - start]

	if (units === undefined) return Number(decodeLatin1(bytes, start, end))

	// Copied into a reused array for one String.fromCharCode, as decodeUtf8 does short text.
	for (let k = start; k < end; k++) units[k - start] = bytes[k] ?? 0

	return Number(String.fromCharCode.apply(null, units))
}

// Reused arrays, one per length, for number text up to 32 bytes.
const numberUnits: number[][] = Array.from({ length: 33 }, (_, length) => new Array<number>(length).fill(0))

function decodeLatin1(bytes: Uint8Array, start: number, end: number): string {
	let text = ""

	for (let k = start; k < end; k++) text += String.fromCharCode(bytes[k] ?? 0)

	return text
}

// The elements of a document, counted with no node per element and in slices of `clock`; refuses once past
// `limit`, so a part of tiny elements is turned away before a tree is built for it. Text never holds "<"
// (escaped), so each "<" outside a comment, CDATA section or processing instruction starts a tag, and each start
// or empty-element tag is an element.
export async function countElements(bytes: Uint8Array, part: string, limit: number, clock: SliceClock | undefined): Promise<number> {
	const scanner = new Scanner(bytes, part)
	let count = 0
	let tags = 0

	for (let at = bytes.indexOf(LT); at >= 0; at = bytes.indexOf(LT, at)) {
		const next = bytes[at + 1]

		if (next === BANG || next === QUESTION) {
			at = scanner.markupEnd(at)

			continue
		}

		if (next !== SLASH && ++count > limit) throw new XlsxReadError("tooLarge", "The part holds too many elements", part)
		if (++tags % TAGS_PER_LOOK === 0 && clock?.due === true) await clock.pause()

		at++
	}

	return count
}

// Tags counted between two looks at the clock.
const TAGS_PER_LOOK = 65_536
