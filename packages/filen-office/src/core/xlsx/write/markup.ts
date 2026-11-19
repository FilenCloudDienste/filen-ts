import { ENCODING_DECLARATION } from "../../xml/editor"
import { XmlEditor, decodeUtf8, encodeUtf8, escapeAttribute, parseXml, transcodeUtf16 } from "../../xml/index"
import type { SliceClock } from "../../slicing"
import { XlsxReadError } from "../read/errors"
import { Scanner } from "../read/scan"
import { XlsxWriteError } from "./failure"

export { toBytes } from "../../xml/editor"

// Byte-level helpers the splice writer shares: tag scanning over source bytes (no parse of a whole part),
// attribute splices on small elements, and new markup as pieces.

const LT = 60
const GT = 62
const SLASH = 47
const EQUALS = 61
const DQUOTE = 34
const SQUOTE = 39
const BANG = 33
const QUESTION = 63

export function isSpace(b: number | undefined): boolean {
	return b === 32 || b === 9 || b === 10 || b === 13
}

export function onlySpace(bytes: Uint8Array, from: number, to: number): boolean {
	for (let i = from; i < to; i++) if (!isSpace(bytes[i])) return false

	return true
}

// The xml:space attribute text that keeps leading or trailing white space, for cells and shared strings alike.
export function preserved(text: string): string {
	return text.length > 0 && /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ""
}

export function attr(name: string, value: string | number): string {
	return ` ${name}="${escapeAttribute(String(value))}"`
}

// The qualified name of a SpreadsheetML element in a part whose root uses `prefix` for the main namespace.
export function qualify(prefix: string, local: string): string {
	return prefix === "" ? local : `${prefix}:${local}`
}

// A start tag in source bytes: where its name ends, where the tag ends (past ">") and its attributes as
// [nameStart, nameEnd, valueStart, valueEnd] quadruples (value without its quotes).
export interface ScannedTag {
	readonly start: number
	readonly nameEnd: number
	readonly end: number
	readonly selfClosing: boolean
	readonly attributes: readonly number[]
}

// The start tag at `start` ("<" there), or undefined when it is not one (a close tag, comment, PI).
// The start tag at `start` read for its r attribute alone, without allocating: into `out` the end of the tag's
// name, the r value's span (-1, -1 without one) and the tag's end; false when it is not a start tag.
export function scanReference(bytes: Uint8Array, start: number, out: Int32Array): boolean {
	const first = bytes[start + 1]

	if (bytes[start] !== LT || first === SLASH || first === BANG || first === QUESTION || first === undefined) return false

	let i = start + 1

	while (i < bytes.length && !isSpace(bytes[i]) && bytes[i] !== GT && bytes[i] !== SLASH) i++

	out[0] = i
	out[1] = -1
	out[2] = -1

	for (;;) {
		while (i < bytes.length && isSpace(bytes[i])) i++

		const b = bytes[i]

		if (b === undefined) return false

		if (b === GT || b === SLASH) {
			out[3] = b === GT ? i + 1 : i + 2

			return b === GT || bytes[i + 1] === GT
		}

		const nameStart = i

		while (i < bytes.length && !isSpace(bytes[i]) && bytes[i] !== EQUALS) i++

		const single = i - nameStart === 1 && bytes[nameStart] === 114

		while (isSpace(bytes[i])) i++

		if (bytes[i] !== EQUALS) return false

		i++

		while (isSpace(bytes[i])) i++

		const quote = bytes[i]

		if (quote !== DQUOTE && quote !== SQUOTE) return false

		const valueEnd = bytes.indexOf(quote, i + 1)

		if (valueEnd < 0) return false

		if (single) {
			out[1] = i + 1
			out[2] = valueEnd
		}

		i = valueEnd + 1
	}
}

export function scanTag(bytes: Uint8Array, start: number): ScannedTag | undefined {
	const first = bytes[start + 1]

	if (bytes[start] !== LT || first === SLASH || first === BANG || first === QUESTION || first === undefined) return undefined

	let i = start + 1

	while (i < bytes.length && !isSpace(bytes[i]) && bytes[i] !== GT && bytes[i] !== SLASH) i++

	const nameEnd = i
	const attributes: number[] = []

	for (;;) {
		while (i < bytes.length && isSpace(bytes[i])) i++

		const b = bytes[i]

		if (b === undefined) return undefined
		if (b === GT) return { start, nameEnd, end: i + 1, selfClosing: false, attributes }
		if (b === SLASH) return bytes[i + 1] === GT ? { start, nameEnd, end: i + 2, selfClosing: true, attributes } : undefined

		const nameStart = i

		while (i < bytes.length && !isSpace(bytes[i]) && bytes[i] !== EQUALS) i++

		const attributeNameEnd = i

		while (isSpace(bytes[i])) i++

		if (bytes[i] !== EQUALS) return undefined

		i++

		while (isSpace(bytes[i])) i++

		const quote = bytes[i]

		if (quote !== DQUOTE && quote !== SQUOTE) return undefined

		const valueStart = i + 1
		const valueEnd = bytes.indexOf(quote, valueStart)

		if (valueEnd < 0) return undefined

		attributes.push(nameStart, attributeNameEnd, valueStart, valueEnd)
		i = valueEnd + 1
	}
}

// Whether bytes [from, to) spell `ascii`.
export function spells(bytes: Uint8Array, from: number, to: number, ascii: string): boolean {
	if (to - from !== ascii.length) return false

	for (let k = 0; k < ascii.length; k++) if (bytes[from + k] !== ascii.charCodeAt(k)) return false

	return true
}

// The index of attribute `name` (exact qualified name) in a scanned tag's quadruples, or -1.
export function findAttribute(bytes: Uint8Array, tag: ScannedTag, name: string): number {
	const spans = tag.attributes

	for (let k = 0; k < spans.length; k += 4) if (spells(bytes, spans[k] ?? 0, spans[k + 1] ?? 0, name)) return k

	return -1
}

// The root element of a part: its start tag and the prefix its name carries. The prolog's comments and processing
// instructions are skipped to their own terminators (markup inside a comment is no root), a document type
// declaration to its ">" (one with an internal subset refuses, as the reader refuses it).
export function rootTag(bytes: Uint8Array): { readonly tag: ScannedTag; readonly prefix: string; readonly name: string } {
	let scanner: Scanner | null = null
	let i = 0

	for (;;) {
		i = bytes.indexOf(LT, i)

		if (i < 0) throw new XlsxWriteError("malformedPart", "A part without a root element")

		const next = bytes[i + 1]

		if (next === BANG && spells(bytes, i + 2, i + 9, "DOCTYPE")) {
			i = doctypeEnd(bytes, i)
		} else if (next === BANG || next === QUESTION) {
			scanner ??= new Scanner(bytes, "")

			try {
				i = scanner.markupEnd(i)
			} catch (error) {
				if (error instanceof XlsxReadError) throw new XlsxWriteError("malformedPart", error.message)

				throw error
			}
		} else {
			const tag = scanTag(bytes, i)

			if (tag === undefined) throw new XlsxWriteError("malformedPart", `The root element's start tag at ${i} does not read`)

			const name = decodeUtf8(bytes, i + 1, tag.nameEnd)
			const colon = name.indexOf(":")

			return { tag, prefix: colon < 0 ? "" : name.slice(0, colon), name }
		}
	}
}

// After the document type declaration whose "<" is at `i`: quoted literals may hold ">".
function doctypeEnd(bytes: Uint8Array, i: number): number {
	for (let j = i + 9; j < bytes.length; j++) {
		const b = bytes[j]

		if (b === GT) return j + 1
		if (b === 91) throw new XlsxWriteError("malformedPart", "A document type declaration with an internal subset")

		if (b === DQUOTE || b === SQUOTE) {
			const close = bytes.indexOf(b, j + 1)

			if (close < 0) break

			j = close
		}
	}

	throw new XlsxWriteError("malformedPart", "A document type declaration is not closed")
}

// One element's bytes with attributes set (value) or removed (null), everything else as written. Attributes
// not present are added in the order given.
export function spliceAttributes(element: Uint8Array, updates: ReadonlyMap<string, string | null>): Uint8Array {
	if (updates.size === 0) return element

	const document = parseXml(element)
	const editor = new XmlEditor(document)
	const root = document.documentElement()

	for (const [name, value] of updates) {
		const current = document.attribute(root, name)

		if (value === null) {
			if (current !== undefined) editor.removeAttribute(root, name)
		} else if (current !== value) {
			editor.setAttribute(root, name, value)
		}
	}

	return editor.changed ? editor.serialize() : element
}

// Output assembled as pieces: views of source bytes and new markup, never joined here.
export class Pieces {
	readonly items: Uint8Array[] = []
	length = 0

	push(bytes: Uint8Array): void {
		if (bytes.length === 0) return

		this.items.push(bytes)
		this.length += bytes.length
	}

	text(markup: string): void {
		if (markup !== "") this.push(encodeUtf8(markup))
	}
}

// One growing buffer for consecutive new markup (rewritten rows), handed out as one piece per run.
export class ByteBuilder {
	private buffer = new Uint8Array(4096)
	length = 0

	private reserve(extra: number): void {
		if (this.length + extra <= this.buffer.length) return

		let size = this.buffer.length * 2

		while (size < this.length + extra) size *= 2

		const grown = new Uint8Array(size)

		grown.set(this.buffer.subarray(0, this.length))
		this.buffer = grown
	}

	bytes(bytes: Uint8Array, from: number = 0, to: number = bytes.length): void {
		this.reserve(to - from)

		// Short runs (between two attribute values) copied by hand: no view per run.
		if (to - from < 64) {
			const buffer = this.buffer
			let at = this.length

			for (let i = from; i < to; i++) buffer[at++] = bytes[i] ?? 0

			this.length = at

			return
		}

		this.buffer.set(bytes.subarray(from, to), this.length)
		this.length += to - from
	}

	// ASCII-only text (names, numbers, references) without an encoder.
	ascii(text: string): void {
		this.reserve(text.length)

		for (let k = 0; k < text.length; k++) this.buffer[this.length++] = text.charCodeAt(k)
	}

	text(text: string): void {
		let ascii = true

		for (let k = 0; k < text.length && ascii; k++) ascii = text.charCodeAt(k) < 0x80

		if (ascii) this.ascii(text)
		else this.bytes(encodeUtf8(text))
	}

	// What was built since the last take, as its own array; the builder starts again.
	take(): Uint8Array {
		const out = this.buffer.slice(0, this.length)

		this.length = 0

		return out
	}
}

// A scanned start tag with attributes set (existing values replaced in place, new ones added before its end),
// as new bytes; `open` turns a self-closing tag into a start tag.
export function spliceTag(bytes: Uint8Array, tag: ScannedTag, updates: ReadonlyMap<string, string>, open: boolean = false): Uint8Array {
	const builder = new ByteBuilder()
	const added: string[] = []
	const edits: [number, number, string][] = []

	for (const [name, value] of updates) {
		const at = findAttribute(bytes, tag, name)

		if (at >= 0) edits.push([tag.attributes[at + 2] ?? 0, tag.attributes[at + 3] ?? 0, escapeAttribute(value)])
		else added.push(attr(name, value))
	}

	edits.sort((a, b) => a[0] - b[0])

	const head = tag.end - (tag.selfClosing ? 2 : 1)
	let at = tag.start

	for (const [from, to, text] of edits) {
		builder.bytes(bytes, at, from)
		builder.text(text)
		at = to
	}

	builder.bytes(bytes, at, head)
	builder.text(added.join(""))
	builder.ascii(tag.selfClosing && !open ? "/>" : ">")

	return builder.take()
}

// The last start of `ascii` within [from, to), or -1.
export function lastIndexOfText(bytes: Uint8Array, ascii: string, from: number, to: number): number {
	const first = ascii.charCodeAt(0)

	if (to - ascii.length < from) return -1

	for (let i = bytes.lastIndexOf(first, to - ascii.length); i >= from; i = bytes.lastIndexOf(first, i - 1)) {
		if (spells(bytes, i, i + ascii.length, ascii)) return i
		if (i === 0) break
	}

	return -1
}

// A part as UTF-8, as the model's spans index it: a UTF-16 part transcoded as the reader does, its declaration
// made to say UTF-8 without changing its length (the space XMLDecl allows before "?>" takes up the difference).
export function utf8Part(bytes: Uint8Array): Uint8Array {
	const b0 = bytes[0]
	const b1 = bytes[1]
	const little = (b0 === 0xff && b1 === 0xfe) || (b0 === 0x3c && b1 === 0)

	if (!little && !((b0 === 0xfe && b1 === 0xff) || (b0 === 0 && b1 === 0x3c))) return bytes

	const utf8 = transcodeUtf16(bytes, b0 === 0xff || b0 === 0xfe ? 2 : 0, little)

	if (!spells(utf8, 0, 5, "<?xml")) return utf8

	const end = utf8.indexOf(62)
	const declaration = decodeUtf8(utf8, 0, end + 1)
	const match = ENCODING_DECLARATION.exec(declaration)

	if (match === null) return utf8

	const replacement = `${match[1] ?? ""}${match[2] ?? ""}UTF-8${match[2] ?? ""}`

	if (replacement.length > match[0].length) return utf8

	utf8.set(encodeUtf8(replacement.padEnd(match[0].length, " ")), match.index)

	return utf8
}

// Tags a walk reads between looks at the slice clock.
const WALK_TAGS = 1024

// The child elements of the element whose start tag starts at `parent` and ends at `from`, each as
// visit(start, end), walked with `scanner` (over the same bytes) in steps a clock slices; returns where the
// parent's end tag starts, checked to name the parent. Text, comments and processing instructions between
// children are skipped.
export async function eachChild(
	scanner: Scanner,
	parent: number,
	from: number,
	clock: SliceClock | undefined,
	visit: (start: number, end: number) => void
): Promise<number> {
	const bytes = scanner.bytes
	const parentName = scanTag(bytes, parent)
	let at = from

	if (parentName === undefined) throw new XlsxWriteError("malformedPart", `No element at ${parent}`)

	for (;;) {
		const lt = bytes.indexOf(LT, at)

		if (lt < 0) throw new XlsxWriteError("malformedPart", `An element at ${parent} is not closed`)

		const next = bytes[lt + 1]

		if (next === SLASH) {
			const length = parentName.nameEnd - parent - 1

			if (!sameRun(bytes, lt + 2, parent + 1, length) || !(bytes[lt + 2 + length] === GT || isSpace(bytes[lt + 2 + length])))
				throw new XlsxWriteError("malformedPart", `An end tag at ${lt} does not close its element`)

			return lt
		}

		if (next === BANG || next === QUESTION) {
			at = scanner.markupEnd(lt)

			continue
		}

		scanner.beginElement(lt)

		let end = scanner.walk(WALK_TAGS)

		while (end < 0) {
			if (clock?.due === true) await clock.pause()

			end = scanner.walk(WALK_TAGS)
		}

		visit(lt, end)
		at = end

		if (clock?.due === true) await clock.pause()
	}
}

function sameRun(bytes: Uint8Array, a: number, b: number, length: number): boolean {
	for (let k = 0; k < length; k++) if (bytes[a + k] !== bytes[b + k]) return false

	return true
}
