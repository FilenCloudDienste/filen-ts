import { OdfNs } from "../../odf/namespaces"
import { decodeCData, decodeCharacterData } from "../../xml/entities"
import { XmlError } from "../../xml/errors"
import { parseNumber, parseUint } from "../../xlsx/read/scan"
import { OdsReadError } from "./errors"

// A one-pass scanner over content.xml as it inflates: chunks are pushed in, tags and text come out to a handler,
// nothing but an unfinished tag or text run is carried over, and no tree is built. Names are matched as (namespace,
// local name): the prefixes are resolved from the root's declarations, and again inside any element that declares
// its own (ODF producers declare everything on the root, so that is the rare path).

const LT = 60
const GT = 62
const SLASH = 47
const QUOTE = 34
const APOSTROPHE = 39
const BANG = 33
const QUESTION = 63
const EQUALS = 61
const AMP = 38

type Prefix = "office" | "table" | "text" | "calcext" | "loext" | "xlink" | "draw" | "dc" | "style"

// Element names the reader acts on. Every other one is UNKNOWN (0).
const ELEMENT_NAMES = [
	["office", "body"],
	["office", "spreadsheet"],
	["office", "annotation"],
	["office", "annotation-end"],
	["office", "forms"],
	["office", "event-listeners"],
	["table", "calculation-settings"],
	["table", "content-validations"],
	["table", "label-ranges"],
	["table", "table"],
	["table", "table-column"],
	["table", "table-columns"],
	["table", "table-column-group"],
	["table", "table-header-columns"],
	["table", "table-row"],
	["table", "table-rows"],
	["table", "table-row-group"],
	["table", "table-header-rows"],
	["table", "table-cell"],
	["table", "covered-table-cell"],
	["table", "named-expressions"],
	["table", "database-ranges"],
	["table", "data-pilot-tables"],
	["table", "consolidation"],
	["table", "dde-links"],
	["table", "shapes"],
	["table", "table-source"],
	["table", "scenario"],
	["table", "title"],
	["table", "desc"],
	["table", "cell-range-source"],
	["table", "detective"],
	["table", "tracked-changes"],
	["table", "sub-table"],
	["text", "p"],
	["text", "h"],
	["text", "s"],
	["text", "tab"],
	["text", "line-break"],
	["text", "span"],
	["text", "a"],
	["text", "soft-page-break"],
	["text", "note"],
	["text", "ruby-text"],
	["calcext", "conditional-formats"],
	["loext", "table-protection"],
	["table", "table-protection"],
	["draw", "frame"]
] as const satisfies readonly (readonly [Prefix, string])[]

const ATTRIBUTE_NAMES = [
	["table", "name"],
	["table", "style-name"],
	["table", "default-cell-style-name"],
	["table", "visibility"],
	["table", "number-columns-repeated"],
	["table", "number-rows-repeated"],
	["table", "number-columns-spanned"],
	["table", "number-rows-spanned"],
	["table", "number-matrix-columns-spanned"],
	["table", "number-matrix-rows-spanned"],
	["table", "formula"],
	["table", "content-validation-name"],
	["table", "protected"],
	["table", "protection-key"],
	["table", "protection-key-digest-algorithm"],
	["table", "print-ranges"],
	["table", "print"],
	["table", "display"],
	["table", "structure-protected"],
	["table", "is-sub-table"],
	["table", "end-cell-address"],
	["office", "value-type"],
	["office", "value"],
	["office", "date-value"],
	["office", "time-value"],
	["office", "boolean-value"],
	["office", "string-value"],
	["office", "currency"],
	["office", "display"],
	["calcext", "value-type"],
	["text", "style-name"],
	["text", "c"],
	["xlink", "href"],
	["office", "target-frame-name"],
	["office", "title"],
	["loext", "select-protected-cells"],
	["loext", "select-unprotected-cells"],
	["loext", "insert-columns"],
	["loext", "insert-rows"],
	["loext", "delete-columns"],
	["loext", "delete-rows"],
	["table", "select-protected-cells"],
	["table", "select-unprotected-cells"]
] as const satisfies readonly (readonly [Prefix, string])[]

type QualifiedName<T extends readonly (readonly [string, string])[]> = `${T[number][0]}:${T[number][1]}`

function ids<T extends readonly (readonly [string, string])[]>(names: T): Readonly<Record<QualifiedName<T>, number>> {
	const out: Record<string, number> = {}

	names.forEach(([prefix, local], index) => (out[`${prefix}:${local}`] = index + 1))

	return out as Record<QualifiedName<T>, number>
}

// Element and attribute ids: E["table:table-cell"], A["table:style-name"]; 0 is any other name.
export const E = ids(ELEMENT_NAMES)
export const A = ids(ATTRIBUTE_NAMES)
export const UNKNOWN = 0

const URIS: Readonly<Record<Prefix, string>> = {
	office: OdfNs.office,
	table: OdfNs.table,
	text: OdfNs.text,
	calcext: OdfNs.calcext,
	loext: OdfNs.loext,
	xlink: OdfNs.xlink,
	draw: OdfNs.draw,
	dc: OdfNs.dc,
	style: OdfNs.style
}

const encoder = new TextEncoder()

// A name's hash from its length and a few of its bytes (equal hashes are compared byte for byte): names of the
// same prefix differ there, and nothing loops over the whole name.
function hashName(bytes: Uint8Array, start: number, end: number): number {
	const length = end - start

	if (length <= 0) return 0

	return (
		(length * 0x01000193) ^
		((bytes[start + (length >> 1)] ?? 0) << 24) ^
		((bytes[end - 1] ?? 0) << 16) ^
		((bytes[end - 2] ?? 0) << 8) ^
		(bytes[start + (length >> 2) * 3] ?? 0)
	)
}

// Qualified names under the prefixes in force, in an open-addressed table by hash.
class NameIndex {
	private readonly names: Uint8Array[] = []
	private readonly ids: number[] = []
	private readonly hashes: number[] = []
	// Slot -> entry + 1, chained through `next`.
	private readonly table = new Int32Array(1024)
	private readonly next: number[] = []

	constructor(names: readonly (readonly [Prefix, string])[], prefixes: ReadonlyMap<string, string>, elements: boolean) {
		const byUri = new Map<string, string[]>()

		for (const [prefix, uri] of prefixes) {
			const list = byUri.get(uri) ?? []

			list.push(prefix)
			byUri.set(uri, list)
		}

		names.forEach(([prefix, local], index) => {
			for (const bound of byUri.get(URIS[prefix]) ?? []) {
				// An unprefixed attribute is in no namespace: only elements take the default one.
				if (bound === "" && !elements) continue

				const bytes = encoder.encode(bound === "" ? local : `${bound}:${local}`)
				const hash = hashName(bytes, 0, bytes.length)
				const slot = hash & 1023

				this.names.push(bytes)
				this.ids.push(index + 1)
				this.hashes.push(hash)
				this.next.push(this.table[slot] ?? 0)
				this.table[slot] = this.names.length
			}
		})
	}

	find(bytes: Uint8Array, start: number, end: number, hash: number): number {
		for (let entry = this.table[hash & 1023] ?? 0; entry !== 0; entry = this.next[entry - 1] ?? 0) {
			if (this.hashes[entry - 1] !== hash) continue

			const name = this.names[entry - 1] as Uint8Array

			if (name.length !== end - start) continue

			let same = true

			for (let k = 0; k < name.length; k++) {
				if (name[k] !== bytes[start + k]) {
					same = false

					break
				}
			}

			if (same) return this.ids[entry - 1] ?? UNKNOWN
		}

		return UNKNOWN
	}
}

// Decoded strings by their bytes, one per slot (the last seen there): values that repeat cost one decode and one
// string, the rest a hash. Only a string as long as its bytes is kept (ASCII without references, the common case),
// and its own characters are the key: a hit compares bytes with them, and nothing is copied. Such a string decodes
// from exactly those bytes, so a match is the same string. Bytes longer than `longest` are not kept.
class ByteStrings {
	private readonly values: (string | undefined)[]
	private readonly mask: number
	private readonly longest: number
	private slot = 0

	constructor(size: number, longest: number) {
		this.values = new Array<string | undefined>(size)
		this.mask = size - 1
		this.longest = longest
	}

	get(bytes: Uint8Array, start: number, end: number): string | undefined {
		const length = end - start

		if (length > this.longest) {
			this.slot = -1

			return undefined
		}

		let hash = 0x811c9dc5

		for (let at = start; at < end; at++) hash = Math.imul(hash ^ (bytes[at] ?? 0), 0x01000193)

		this.slot = (hash >>> 0) & this.mask

		const known = this.values[this.slot]

		if (known === undefined || known.length !== length) return undefined

		for (let n = 0; n < length; n++) if (known.charCodeAt(n) !== bytes[start + n]) return undefined

		return known
	}

	// After a get() that missed: keeps `text` for those bytes when it is as long as they are.
	put(start: number, end: number, text: string): string {
		if (this.slot >= 0 && text.length === end - start) this.values[this.slot] = text

		return text
	}
}

export interface ScanHandler {
	// A start or empty-element tag; attributes are read from the scanner while this runs.
	open(element: number, selfClosing: boolean): void
	// An end tag, or right after open() for an empty-element tag.
	close(element: number): void
	// Character data, only while the scanner's `wantText` is set.
	text(text: string): void
	// After open() asked for it (expectParagraph): the element held one plain paragraph and nothing else, read at once;
	// its text (scanner.paragraphText) is there until this returns, then the element closes.
	paragraph(): void
	// The markup of an element whose open() called capture(), whole, once its end tag was read.
	captured(element: number, markup: Uint8Array): void
}

function isSpace(b: number | undefined): boolean {
	return b === 32 || b === 9 || b === 10 || b === 13
}

// Elements one capture may hold, and its bytes: past either the file is refused, not read in part.
const MAX_CAPTURE = 64 * 1024 * 1024
const MAX_DEPTH = 4096
const MAX_ATTRIBUTES = 256

const INDEXES = new WeakMap<ReadonlyMap<string, string>, readonly [NameIndex, NameIndex]>()

export class OdsScanner {
	// Set by the handler: character data is passed to text() while it is.
	wantText = false
	private readonly handler: ScanHandler
	private buffer: Uint8Array = new Uint8Array(0)
	private carry: Uint8Array = new Uint8Array(0)
	private carryLength = 0
	// Bytes of the stream before this one: skipped (the prologue was read elsewhere).
	private skip: number
	private elements: NameIndex
	private attributeNames: NameIndex
	private prefixes: Map<string, string>
	// Open elements: the name hash of each, and where a scope of namespace declarations ends.
	private readonly hashes = new Int32Array(MAX_DEPTH)
	private depth = 0
	private readonly scopes: { depth: number; prefixes: Map<string, string> }[] = []
	// The tag open() is reading: its end in `buffer`, its name's end, and its attributes once read.
	private tagClose = 0
	private nameEnd = 0
	private attributesRead = false
	private attributeCount = 0
	// The start tag holds a namespace declaration (tagEnd).
	private tagDeclares = false
	// Each known attribute's index among the tag's (attributeIds), -1 when the tag lacks it.
	private readonly slots = new Int16Array(ATTRIBUTE_NAMES.length + 1).fill(-1)
	// Strings decoded once for the same bytes: style names and the like (symbol), short cell texts (paragraphText).
	private readonly symbols = new ByteStrings(4096, 64)
	private readonly texts = new ByteStrings(8192, 48)
	private readonly attributeIds = new Int32Array(MAX_ATTRIBUTES)
	private readonly valueStarts = new Int32Array(MAX_ATTRIBUTES)
	private readonly valueEnds = new Int32Array(MAX_ATTRIBUTES)
	// A capture under way: its element, its bytes so far and how deep inside it the scan is.
	private captureElement = -1
	private captureDepth = 0
	private captureBytes = new Uint8Array(0)
	private captureLength = 0
	private captureRequested = false
	private paragraphRequested = false
	private textStart = 0
	private textEnd = 0
	// "<text:p>" and "</text:p>" under the prefixes in force.
	private paragraphOpen: Uint8Array = new Uint8Array(0)
	private paragraphClose: Uint8Array = new Uint8Array(0)
	// Bytes scanned so far, for errors.
	private offset = 0
	tags = 0

	// `prefixes`: the root's namespace declarations (prefix to URI, "" for a default namespace). `skip`: bytes of
	// the stream to pass over first (up to office:body).
	constructor(handler: ScanHandler, prefixes: ReadonlyMap<string, string>, skip = 0) {
		this.handler = handler
		this.prefixes = new Map(prefixes)
		this.skip = skip

		// Scanners over the same declarations (a writer reads row after row back) share their name indexes.
		let indexes = INDEXES.get(prefixes)

		if (indexes === undefined) {
			indexes = [new NameIndex(ELEMENT_NAMES, this.prefixes, true), new NameIndex(ATTRIBUTE_NAMES, this.prefixes, false)]
			INDEXES.set(prefixes, indexes)
		}

		this.elements = indexes[0]
		this.attributeNames = indexes[1]
		this.paragraphNames()
	}

	private paragraphNames(): void {
		let prefix: string | undefined

		for (const [bound, uri] of this.prefixes) if (uri === OdfNs.text && (prefix === undefined || bound !== "")) prefix = bound

		const name = prefix === undefined ? "\u0000" : prefix === "" ? "p" : `${prefix}:p`

		this.paragraphOpen = encoder.encode(`<${name}>`)
		this.paragraphClose = encoder.encode(`</${name}>`)
	}

	push(chunk: Uint8Array): void {
		let bytes = chunk

		if (this.skip > 0) {
			const skipped = Math.min(this.skip, bytes.length)

			this.skip -= skipped
			this.offset += skipped
			bytes = bytes.subarray(skipped)

			if (bytes.length === 0) return
		}

		if (this.carryLength > 0) {
			const joined = this.reserve(this.carryLength + bytes.length)

			joined.set(bytes, this.carryLength)
			this.scanBuffer(joined.subarray(0, this.carryLength + bytes.length), false)
		} else {
			this.scanBuffer(bytes, false)
		}
	}

	end(): void {
		if (this.carryLength > 0) this.scanBuffer(this.carry.subarray(0, this.carryLength), true)
		if (this.depth !== 0 || this.captureElement >= 0) throw this.malformed("The stream ends inside an element")
	}

	// The carry buffer, grown to `size`, holding the carried bytes at its start.
	private reserve(size: number): Uint8Array {
		if (size > this.carry.length) {
			const grown = new Uint8Array(Math.max(size, this.carry.length * 2, 64 * 1024))

			grown.set(this.carry.subarray(0, this.carryLength))
			this.carry = grown
		}

		return this.carry
	}

	private scanBuffer(bytes: Uint8Array, final: boolean): void {
		this.buffer = bytes

		const used = this.scan(bytes, final)

		this.offset += used

		const left = bytes.length - used

		if (left > 0) {
			if (final) throw this.malformed("The stream ends inside a tag")

			// The unread tail moves to the start of the carry (it may already be there).
			if (bytes.buffer === this.carry.buffer && bytes.byteOffset === this.carry.byteOffset) {
				this.carry.copyWithin(0, used, used + left)
			} else {
				this.reserve(left).set(bytes.subarray(used))
			}
		}

		this.carryLength = left
	}

	malformed(message: string): OdsReadError {
		return new OdsReadError("malformed", `${message} (content.xml, near byte ${this.offset})`)
	}

	// Bytes consumed: everything up to the first unfinished tag (or text run, while text is wanted or captured).
	private scan(bytes: Uint8Array, final: boolean): number {
		const end = bytes.length
		let i = 0

		while (i < end) {
			if (bytes[i] !== LT) {
				let lt = bytes.indexOf(LT, i)

				if (lt < 0) {
					if (!final && (this.wantText || this.captureElement >= 0)) return i

					lt = end
				}

				if (this.captureElement >= 0) this.capture(bytes, i, lt)
				else if (this.wantText && this.depth > 0) this.handler.text(this.characterData(bytes, i, lt))

				i = lt

				continue
			}

			if (i + 1 >= end) return final ? this.fail("A tag is not closed") : i

			const next = bytes[i + 1]

			if (next === BANG || next === QUESTION) {
				const close = markupEnd(bytes, i)

				if (close < 0) return final ? this.fail("Markup is not closed") : i
				if (this.captureElement >= 0) this.capture(bytes, i, close)
				else if (this.wantText && isCData(bytes, i)) this.handler.text(decodeCData(bytes, i + 9, close - 3))

				i = close

				continue
			}

			const close = this.tagEnd(bytes, i)

			if (close < 0) return final ? this.fail("A tag is not closed") : i

			this.tags++

			if (next === SLASH) {
				this.endTag(bytes, i, close)
				i = close
			} else {
				i = this.startTag(bytes, i, close)
			}
		}

		return i
	}

	// After the start or end tag whose "<" is at `i` (quoted values may hold ">"), -1 when it is not complete. Notes
	// whether an attribute name starting "xmlns" follows white space (a namespace declaration).
	private tagEnd(bytes: Uint8Array, i: number): number {
		const length = bytes.length
		let j = i + 1
		let declares = false

		while (j < length) {
			const b = bytes[j]

			if (b === GT) {
				this.tagDeclares = declares

				return j + 1
			}

			if (b === QUOTE || b === APOSTROPHE) {
				// A loop, not indexOf: values are short, and the call costs more than the scan.
				j++

				while (j < length && bytes[j] !== b) j++

				if (j >= length) return -1

				j++
			} else if (b === LT) {
				return this.fail("A tag is not closed")
			} else {
				if (
					b === 120 &&
					bytes[j + 1] === 109 &&
					bytes[j + 2] === 108 &&
					bytes[j + 3] === 110 &&
					bytes[j + 4] === 115 &&
					isSpace(bytes[j - 1])
				) {
					declares = true
				}

				j++
			}
		}

		return -1
	}

	private fail(message: string): never {
		throw this.malformed(message)
	}

	private characterData(bytes: Uint8Array, start: number, end: number, attribute = false): string {
		try {
			return decodeCharacterData(bytes, start, end, attribute)
		} catch (error) {
			if (error instanceof XmlError) throw this.malformed(error.message)

			throw error
		}
	}

	// Where the scan goes on: after the tag, or after the whole element when it was read at once.
	private startTag(bytes: Uint8Array, start: number, end: number): number {
		const selfClosing = bytes[end - 2] === SLASH
		let nameEnd = start + 1

		while (nameEnd < end && !isSpace(bytes[nameEnd]) && bytes[nameEnd] !== SLASH && bytes[nameEnd] !== GT) nameEnd++

		if (this.captureElement >= 0) {
			this.capture(bytes, start, end)

			if (!selfClosing) this.captureDepth++

			return end
		}

		const hash = hashName(bytes, start + 1, nameEnd)

		if (this.depth === MAX_DEPTH) this.fail("Elements are nested too deeply")

		this.tagClose = end
		this.nameEnd = nameEnd
		this.attributesRead = false

		if (this.tagDeclares) this.declare()

		const element = this.elements.find(bytes, start + 1, nameEnd, hash)

		this.hashes[this.depth++] = hash
		this.captureRequested = false
		this.paragraphRequested = false
		this.handler.open(element, selfClosing)

		if (this.captureRequested) {
			this.captureRequested = false
			this.captureElement = element
			this.captureDepth = selfClosing ? 0 : 1
			this.captureLength = 0
			this.capture(bytes, start, end)

			if (selfClosing) this.finishCapture()

			return end
		}

		if (selfClosing) {
			this.depth--
			this.handler.close(element)
			if (this.scopes.length > 0) this.popScope()

			return end
		}

		if (this.paragraphRequested) {
			this.paragraphRequested = false

			const after = this.plainParagraph(bytes, end, start + 1, nameEnd)

			if (after >= 0) {
				this.depth--
				this.handler.paragraph()
				this.handler.close(element)
				if (this.scopes.length > 0) this.popScope()

				return after
			}
		}

		return end
	}

	// From open(): the element is likely `<text:p>text</text:p></element>`; read so at once when it is (paragraph()).
	expectParagraph(): void {
		this.paragraphRequested = true
	}

	// The text of the paragraph paragraph() reports, entities resolved (white space as written).
	paragraphText(): string {
		const { buffer, textStart, textEnd } = this

		return (
			this.texts.get(buffer, textStart, textEnd) ?? this.texts.put(textStart, textEnd, this.characterData(buffer, textStart, textEnd))
		)
	}

	// Where `<p>text</p></name>` at `at` ends, -1 when the bytes there are anything else or not all in.
	private plainParagraph(bytes: Uint8Array, at: number, nameStart: number, nameEnd: number): number {
		const open = this.paragraphOpen

		if (at + open.length > bytes.length) return -1

		for (let k = 0; k < open.length; k++) if (bytes[at + k] !== open[k]) return -1

		const textStart = at + open.length
		const lt = bytes.indexOf(LT, textStart)
		const close = this.paragraphClose
		const nameLength = nameEnd - nameStart

		if (lt < 0 || lt + close.length + nameLength + 3 > bytes.length) return -1

		for (let k = 0; k < close.length; k++) if (bytes[lt + k] !== close[k]) return -1

		let at2 = lt + close.length

		if (bytes[at2] !== LT || bytes[at2 + 1] !== SLASH) return -1

		at2 += 2

		for (let k = 0; k < nameLength; k++) if (bytes[at2 + k] !== bytes[nameStart + k]) return -1
		if (bytes[at2 + nameLength] !== GT) return -1

		this.textStart = textStart
		this.textEnd = lt
		this.tags += 3

		return at2 + nameLength + 1
	}

	private endTag(bytes: Uint8Array, start: number, end: number): void {
		let nameEnd = start + 2

		while (nameEnd < end && !isSpace(bytes[nameEnd]) && bytes[nameEnd] !== GT) nameEnd++

		if (this.captureElement >= 0) {
			this.capture(bytes, start, end)

			if (--this.captureDepth === 0) this.finishCapture()

			return
		}

		const hash = hashName(bytes, start + 2, nameEnd)

		// The end tags of elements opened before the scanned part (the root around office:body).
		if (this.depth === 0) return
		if (this.hashes[this.depth - 1] !== hash) this.fail("An end tag does not match its start tag")

		const element = this.elements.find(bytes, start + 2, nameEnd, hash)

		this.depth--
		this.handler.close(element)
		if (this.scopes.length > 0) this.popScope()
	}

	private finishCapture(): void {
		const element = this.captureElement
		const markup = this.captureBytes.slice(0, this.captureLength)

		this.captureElement = -1
		this.captureLength = 0
		this.depth--
		this.handler.captured(element, markup)
		this.handler.close(element)
		if (this.scopes.length > 0) this.popScope()
	}

	private capture(bytes: Uint8Array, start: number, end: number): void {
		const length = this.captureLength + end - start

		if (length > MAX_CAPTURE) throw new OdsReadError("tooLarge", "An element of content.xml is too large")

		if (length > this.captureBytes.length) {
			const grown = new Uint8Array(Math.max(length, this.captureBytes.length * 2, 4096))

			grown.set(this.captureBytes.subarray(0, this.captureLength))
			this.captureBytes = grown
		}

		this.captureBytes.set(bytes.subarray(start, end), this.captureLength)
		this.captureLength = length
	}

	// From open(): the element's whole markup goes to captured() instead of its children to open/close/text.
	captureElementMarkup(): void {
		this.captureRequested = true
	}

	// The namespace declarations in force, for a captured element's own parse.
	get namespaces(): ReadonlyMap<string, string> {
		return this.prefixes
	}

	// --- Attributes of the tag open() is reading ---

	private readAttributes(): void {
		if (this.attributesRead) return

		this.attributesRead = true

		for (let k = 0; k < this.attributeCount; k++) this.slots[this.attributeIds[k] ?? 0] = -1

		this.attributeCount = 0

		const bytes = this.buffer
		const end = this.tagClose - 1
		let i = this.nameEnd

		for (;;) {
			while (i < end && isSpace(bytes[i])) i++

			if (i >= end || bytes[i] === SLASH || bytes[i] === GT) return

			const nameStart = i
			let equals = i

			while (equals < end && bytes[equals] !== EQUALS) equals++

			if (equals >= end) this.fail("An attribute has no value")

			let nameEnd = equals

			while (nameEnd > nameStart && isSpace(bytes[nameEnd - 1])) nameEnd--

			i = equals + 1

			while (i < end && isSpace(bytes[i])) i++

			const quote = bytes[i]

			if (quote !== QUOTE && quote !== APOSTROPHE) this.fail("An attribute value is not quoted")

			const valueStart = i + 1

			i = valueStart

			while (i < end && bytes[i] !== quote) i++

			if (i >= end) this.fail("An attribute value is not closed")
			if (this.attributeCount === MAX_ATTRIBUTES) this.fail("Too many attributes")

			const id = this.attributeNames.find(bytes, nameStart, nameEnd, hashName(bytes, nameStart, nameEnd))

			if (id !== UNKNOWN && (this.slots[id] ?? -1) < 0) {
				this.slots[id] = this.attributeCount
				this.attributeIds[this.attributeCount] = id
				this.valueStarts[this.attributeCount] = valueStart
				this.valueEnds[this.attributeCount] = i
				this.attributeCount++
			}

			i++
		}
	}

	private find(id: number): number {
		this.readAttributes()

		return this.slots[id] ?? -1
	}

	// Which of `values` the attribute's value is (its index), -1 for none or when absent.
	match(id: number, values: readonly string[]): number {
		const k = this.find(id)

		if (k < 0) return -1

		const start = this.valueStarts[k] ?? 0
		const length = (this.valueEnds[k] ?? 0) - start

		for (let v = 0; v < values.length; v++) {
			const value = values[v] ?? ""

			if (value.length !== length) continue

			let same = true

			for (let n = 0; n < length; n++) {
				if (this.buffer[start + n] !== value.charCodeAt(n)) {
					same = false

					break
				}
			}

			if (same) return v
		}

		return -1
	}

	has(id: number): boolean {
		return this.find(id) >= 0
	}

	attribute(id: number): string | undefined {
		const k = this.find(id)

		if (k < 0) return undefined

		const start = this.valueStarts[k] ?? 0
		const end = this.valueEnds[k] ?? 0

		try {
			return decodeCharacterData(this.buffer, start, end, true)
		} catch (error) {
			if (error instanceof XmlError) throw this.malformed(error.message)

			throw error
		}
	}

	// An attribute whose values repeat (style names): the same string for the same bytes, decoded once.
	symbol(id: number): string | undefined {
		const k = this.find(id)

		if (k < 0) return undefined

		const start = this.valueStarts[k] ?? 0
		const end = this.valueEnds[k] ?? 0

		return this.symbols.get(this.buffer, start, end) ?? this.symbols.put(start, end, this.characterData(this.buffer, start, end, true))
	}

	// A numeric attribute (xsd:double), NaN when absent or not a number.
	number(id: number): number {
		const k = this.find(id)

		if (k < 0) return Number.NaN

		const start = this.valueStarts[k] ?? 0
		const end = this.valueEnds[k] ?? 0

		for (let at = start; at < end; at++) if (this.buffer[at] === AMP) return Number(this.attribute(id))

		return parseNumber(this.buffer, start, end)
	}

	// A positive integer attribute (a repeat or span count), `fallback` when absent or not one.
	count(id: number, fallback: number): number {
		const k = this.find(id)

		if (k < 0) return fallback

		const value = parseUint(this.buffer, this.valueStarts[k] ?? 0, this.valueEnds[k] ?? 0)

		if (value >= 1) return value

		const parsed = this.number(id)

		return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback
	}

	// Whether the attribute's value is exactly `ascii`.
	is(id: number, ascii: string): boolean {
		const k = this.find(id)

		if (k < 0) return false

		const start = this.valueStarts[k] ?? 0

		if ((this.valueEnds[k] ?? 0) - start !== ascii.length) return false

		for (let n = 0; n < ascii.length; n++) if (this.buffer[start + n] !== ascii.charCodeAt(n)) return false

		return true
	}

	// --- Namespace scopes ---

	private declare(): void {
		const bytes = this.buffer
		const end = this.tagClose - 1
		const next = new Map(this.prefixes)
		let i = this.nameEnd

		for (;;) {
			while (i < end && isSpace(bytes[i])) i++

			if (i >= end || bytes[i] === SLASH) break

			const nameStart = i

			while (i < end && bytes[i] !== EQUALS && !isSpace(bytes[i])) i++

			const name = decodeCharacterData(bytes, nameStart, i, true)

			while (i < end && bytes[i] !== QUOTE && bytes[i] !== APOSTROPHE) i++

			const quote = bytes[i]
			const valueStart = ++i

			while (i < end && bytes[i] !== quote) i++

			const value = decodeCharacterData(bytes, valueStart, i, true)

			i++

			if (name === "xmlns") next.set("", value)
			else if (name.startsWith("xmlns:")) next.set(name.slice(6), value)
		}

		this.scopes.push({ depth: this.depth, prefixes: this.prefixes })
		this.use(next)
	}

	private popScope(): void {
		const scope = this.scopes[this.scopes.length - 1]

		if (scope === undefined || scope.depth !== this.depth) return

		this.scopes.pop()
		this.use(scope.prefixes)
	}

	private use(prefixes: Map<string, string>): void {
		this.prefixes = prefixes
		this.elements = new NameIndex(ELEMENT_NAMES, prefixes, true)
		this.attributeNames = new NameIndex(ATTRIBUTE_NAMES, prefixes, false)
		this.paragraphNames()
	}
}

function isCData(bytes: Uint8Array, i: number): boolean {
	return bytes[i + 2] === 91 && bytes[i + 3] === 67 && bytes[i + 8] === 91
}

// After a comment, CDATA section or processing instruction at `i`; -1 when not complete.
function markupEnd(bytes: Uint8Array, i: number): number {
	if (bytes[i + 1] === QUESTION) {
		for (let at = bytes.indexOf(QUESTION, i + 2); at >= 0; at = bytes.indexOf(QUESTION, at + 1)) {
			if (at + 1 >= bytes.length) return -1
			if (bytes[at + 1] === GT) return at + 2
		}

		return -1
	}

	if (i + 3 >= bytes.length) return -1

	if (bytes[i + 2] === 45 && bytes[i + 3] === 45) {
		for (let at = bytes.indexOf(45, i + 4); at >= 0; at = bytes.indexOf(45, at + 1)) {
			if (at + 2 >= bytes.length) return -1
			if (bytes[at + 1] === 45 && bytes[at + 2] === GT) return at + 3
		}

		return -1
	}

	if (i + 9 > bytes.length) return -1

	if (isCData(bytes, i)) {
		for (let at = bytes.indexOf(93, i + 9); at >= 0; at = bytes.indexOf(93, at + 1)) {
			if (at + 2 >= bytes.length) return -1
			if (bytes[at + 1] === 93 && bytes[at + 2] === GT) return at + 3
		}

		return -1
	}

	throw new OdsReadError("malformed", "A document type declaration or unknown markup in content.xml")
}
