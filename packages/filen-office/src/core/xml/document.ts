import { decodeCData, decodeCharacterData } from "./entities"
import { XmlError } from "./errors"
import { decodeUtf8 } from "./utf8"

export const NodeKind = {
	Document: 0,
	Element: 1,
	Text: 2,
	CData: 3,
	Comment: 4,
	ProcessingInstruction: 5,
	DocumentType: 6
} as const

export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind]

// The part's encoding as read. Parsing transcodes UTF-16, so the document's bytes are always UTF-8.
export type XmlEncoding = "utf-8" | "utf-16le" | "utf-16be"

export interface XmlAttribute {
	readonly name: string
	readonly value: string
}

export interface XmlNodeArrays {
	readonly count: number
	readonly kinds: Uint8Array
	readonly starts: Int32Array
	readonly openEnds: Int32Array
	readonly ends: Int32Array
	readonly parents: Int32Array
	readonly firstChildren: Int32Array
	readonly nextSiblings: Int32Array
	readonly nameIds: Int32Array
	readonly names: readonly string[]
	readonly nameLengths: readonly number[]
	readonly encoding: XmlEncoding
	// Elements whose start tag does not read as whitespace-separated name="value" pairs with distinct names,
	// ascending. Absent means none.
	readonly malformed?: Int32Array | undefined
}

const NO_NODES = new Int32Array(0)

// Above this many attributes, duplicates are found through a set instead of pairwise.
export const PAIRWISE_DUPLICATE_LIMIT = 8

// Spans are collected here and copied out once per element, rather than grown in a fresh array each time.
let scratch = new Int32Array(64)

function isSpace(b: number | undefined): boolean {
	return b === 32 || b === 9 || b === 10 || b === 13
}

// One parsed part. Nodes are indices into parallel typed arrays (29 bytes each); node 0 is the document.
// Every node keeps the byte span it came from, so untouched content is re-emitted as the original bytes:
//   start     first byte of the node ("<" of a tag)
//   openEnd   for an element, the byte after the start tag's ">"; otherwise equal to end
//   end       the byte after the node (after the close tag for an element)
// Nothing is decoded up front: names are interned once, attributes and text decode on request.
export class XmlDocument {
	readonly bytes: Uint8Array
	readonly count: number
	readonly kinds: Uint8Array
	readonly starts: Int32Array
	readonly openEnds: Int32Array
	readonly ends: Int32Array
	readonly parents: Int32Array
	readonly firstChildren: Int32Array
	readonly nextSiblings: Int32Array
	// Interned qualified name per element (and target per processing instruction); -1 otherwise.
	readonly nameIds: Int32Array
	readonly names: readonly string[]
	readonly encoding: XmlEncoding
	// Elements with a malformed start tag (see isMalformed), ascending; found while parsing, at no extra pass.
	readonly malformed: Int32Array
	// Byte length of each interned name, for scanning past it without decoding.
	private readonly nameLengths: readonly number[]
	private nameIndex: Map<string, number> | null = null
	private localNames: (string | undefined)[] = []
	// The last element's attribute spans: readers usually ask one element for several attributes in a row.
	private spansNode = -1
	private spansCache = new Int32Array(0)
	private readonly valueSpan = new Int32Array(2)

	constructor(bytes: Uint8Array, arrays: XmlNodeArrays) {
		this.bytes = bytes
		this.count = arrays.count
		this.kinds = arrays.kinds
		this.starts = arrays.starts
		this.openEnds = arrays.openEnds
		this.ends = arrays.ends
		this.parents = arrays.parents
		this.firstChildren = arrays.firstChildren
		this.nextSiblings = arrays.nextSiblings
		this.nameIds = arrays.nameIds
		this.names = arrays.names
		this.nameLengths = arrays.nameLengths
		this.encoding = arrays.encoding
		this.malformed = arrays.malformed ?? NO_NODES
	}

	kind(node: number): NodeKind {
		return (this.kinds[node] ?? 0) as NodeKind
	}

	start(node: number): number {
		return this.starts[node] ?? 0
	}

	openEnd(node: number): number {
		return this.openEnds[node] ?? 0
	}

	end(node: number): number {
		return this.ends[node] ?? 0
	}

	parent(node: number): number {
		return this.parents[node] ?? -1
	}

	firstChild(node: number): number {
		return this.firstChildren[node] ?? -1
	}

	nextSibling(node: number): number {
		return this.nextSiblings[node] ?? -1
	}

	nameId(node: number): number {
		return this.nameIds[node] ?? -1
	}

	// The root element (the document node's only element child).
	documentElement(): number {
		for (let child = this.firstChild(0); child >= 0; child = this.nextSibling(child)) {
			if (this.kinds[child] === NodeKind.Element) return child
		}

		return -1
	}

	// Qualified name as written ("w:p"); "" for nodes without one.
	name(node: number): string {
		return this.names[this.nameId(node)] ?? ""
	}

	localName(node: number): string {
		const id = this.nameId(node)

		if (id < 0) return ""

		let local = this.localNames[id]

		if (local === undefined) {
			const name = this.names[id] ?? ""

			local = name.slice(name.indexOf(":") + 1)
			this.localNames[id] = local
		}

		return local
	}

	prefix(node: number): string {
		const name = this.name(node)
		const colon = name.indexOf(":")

		return colon < 0 ? "" : name.slice(0, colon)
	}

	// The id interned for a qualified name, or -1 when no node carries it: lets hot loops compare integers.
	nameIdOf(qualifiedName: string): number {
		if (this.nameIndex === null) {
			this.nameIndex = new Map()

			for (let id = 0; id < this.names.length; id++) {
				const name = this.names[id]

				if (name !== undefined && !this.nameIndex.has(name)) this.nameIndex.set(name, id)
			}
		}

		return this.nameIndex.get(qualifiedName) ?? -1
	}

	// Whether an element's start tag failed the attribute syntax check made while parsing: missing "=",
	// unquoted values, attributes not separated by whitespace, or a repeated name. Its attributes are
	// unreliable; attributeSpans throws for it.
	isMalformed(node: number): boolean {
		const malformed = this.malformed
		let low = 0
		let high = malformed.length - 1

		while (low <= high) {
			const middle = (low + high) >> 1
			const value = malformed[middle] ?? 0

			if (value === node) return true
			if (value < node) low = middle + 1
			else high = middle - 1
		}

		return false
	}

	isSelfClosing(node: number): boolean {
		return this.kinds[node] === NodeKind.Element && this.openEnd(node) === this.end(node)
	}

	// Where an element's content starts and ends: [openEnd, start of the close tag).
	contentStart(node: number): number {
		return this.openEnd(node)
	}

	contentEnd(node: number): number {
		if (this.isSelfClosing(node)) return this.end(node)

		// A close tag cannot contain "<", so the last one before the end opens it.
		return this.bytes.lastIndexOf(60, this.end(node) - 1)
	}

	raw(node: number): Uint8Array {
		return this.bytes.subarray(this.start(node), this.end(node))
	}

	// Decoded character data of a text or CDATA node; the content of a comment or processing instruction.
	text(node: number): string {
		const start = this.start(node)
		const end = this.end(node)

		switch (this.kinds[node]) {
			case NodeKind.Text:
				return decodeCharacterData(this.bytes, start, end, false)
			case NodeKind.CData:
				return decodeCData(this.bytes, start + 9, end - 3)
			case NodeKind.Comment:
				return decodeUtf8(this.bytes, start + 4, end - 3)
			case NodeKind.DocumentType:
				return decodeUtf8(this.bytes, start + 9, end - 1).trim()
			case NodeKind.ProcessingInstruction: {
				let from = start + 2 + this.nameLength(this.nameId(node))

				while (from < end - 2 && isSpace(this.bytes[from])) from++

				return decodeUtf8(this.bytes, from, end - 2)
			}
			default:
				return this.textContent(node)
		}
	}

	// Concatenated character data of every descendant text and CDATA node.
	textContent(node: number): string {
		let out = ""
		const end = this.end(node)

		for (let n = node + 1; n < this.count && this.start(n) < end; n++) {
			const kind = this.kinds[n]

			if (kind === NodeKind.Text || kind === NodeKind.CData) out += this.text(n)
		}

		return out
	}

	// Attribute spans of an element as [nameStart, nameEnd, valueStart, valueEnd] quadruples, the value span
	// without its quotes. Validated as it is parsed (separators, quoting, "<" in values, duplicates). The
	// result is shared with the next call for the same element: read it, never write to it.
	attributeSpans(node: number): Int32Array {
		if (node === this.spansNode) return this.spansCache
		if (this.kinds[node] !== NodeKind.Element) return new Int32Array(0)

		const bytes = this.bytes
		const tagEnd = this.openEnd(node) - 1
		let i = this.start(node) + 1 + this.nameLength(this.nameId(node))
		let length = 0

		for (;;) {
			const separated = isSpace(bytes[i])

			while (i < tagEnd && isSpace(bytes[i])) i++

			if (i >= tagEnd || (bytes[i] === 47 && i === tagEnd - 1)) break

			if (!separated) {
				throw new XmlError("invalidAttribute", "Attributes must be separated by whitespace", i)
			}

			const nameStart = i

			while (i < tagEnd && !isSpace(bytes[i]) && bytes[i] !== 61 && bytes[i] !== 47) i++

			const nameEnd = i

			if (nameEnd === nameStart) {
				throw new XmlError("invalidAttribute", "Attribute name expected", i)
			}

			while (i < tagEnd && isSpace(bytes[i])) i++

			if (bytes[i] !== 61) {
				throw new XmlError("invalidAttribute", "Attribute without a value", i)
			}

			i++

			while (i < tagEnd && isSpace(bytes[i])) i++

			const quote = bytes[i]

			if (quote !== 34 && quote !== 39) {
				throw new XmlError("invalidAttribute", "Attribute value must be quoted", i)
			}

			let valueEnd = i + 1

			while (valueEnd < tagEnd && bytes[valueEnd] !== quote) {
				if (bytes[valueEnd] === 60) throw new XmlError("invalidAttribute", '"<" in an attribute value', valueEnd)

				valueEnd++
			}

			if (valueEnd >= tagEnd) {
				throw new XmlError("invalidAttribute", "Unterminated attribute value", i)
			}

			if (length + 4 > scratch.length) {
				const grown = new Int32Array(scratch.length * 2)

				grown.set(scratch)
				scratch = grown
			}

			scratch[length++] = nameStart
			scratch[length++] = nameEnd
			scratch[length++] = i + 1
			scratch[length++] = valueEnd
			i = valueEnd + 1
		}

		const out = scratch.slice(0, length)

		this.assertUniqueNames(out)
		this.spansNode = node
		this.spansCache = out

		return out
	}

	attributes(node: number): XmlAttribute[] {
		const spans = this.attributeSpans(node)
		const out: XmlAttribute[] = []

		for (let k = 0; k < spans.length; k += 4) {
			out.push({
				name: decodeUtf8(this.bytes, spans[k] ?? 0, spans[k + 1] ?? 0),
				value: decodeCharacterData(this.bytes, spans[k + 2] ?? 0, spans[k + 3] ?? 0, true)
			})
		}

		return out
	}

	// The decoded value of one attribute by qualified name, without decoding the others.
	attribute(node: number, qualifiedName: string): string | undefined {
		const span = this.valueSpan

		return this.findAttribute(node, qualifiedName, span) ? decodeCharacterData(this.bytes, span[0] ?? 0, span[1] ?? 0, true) : undefined
	}

	// Writes the raw value span [start, end) of one attribute into `out` and returns whether it exists. Scans
	// the start tag without allocating or validating (assertWellFormed does that), for hot loops.
	findAttribute(node: number, qualifiedName: string, out: Int32Array): boolean {
		if (this.kinds[node] !== NodeKind.Element) return false

		const bytes = this.bytes
		const tagEnd = this.openEnd(node) - 1
		let i = this.start(node) + 1 + this.nameLength(this.nameId(node))

		for (;;) {
			while (i < tagEnd && isSpace(bytes[i])) i++

			if (i >= tagEnd || bytes[i] === 47) return false

			const nameStart = i

			while (i < tagEnd && !isSpace(bytes[i]) && bytes[i] !== 61) i++

			const nameEnd = i

			while (i < tagEnd && bytes[i] !== 34 && bytes[i] !== 39) i++

			const quote = bytes[i]
			const valueStart = i + 1

			i = valueStart

			while (i < tagEnd && bytes[i] !== quote) i++

			if (i >= tagEnd) {
				// Malformed: let the validating parser name the problem.
				this.attributeSpans(node)

				return false
			}

			if (this.bytesEqualString(nameStart, nameEnd, qualifiedName)) {
				out[0] = valueStart
				out[1] = i

				return true
			}

			i++
		}
	}

	// The decoded values of the attributes named in `names` (undefined for absent ones), as attribute() gives each, in
	// one scan of the start tag.
	attributeValues(node: number, names: readonly string[]): (string | undefined)[] {
		const values: (string | undefined)[] = new Array<string | undefined>(names.length).fill(undefined)

		if (this.kinds[node] !== NodeKind.Element) return values

		const bytes = this.bytes
		const tagEnd = this.openEnd(node) - 1
		let i = this.start(node) + 1 + this.nameLength(this.nameId(node))
		let missing = names.length

		while (missing > 0) {
			while (i < tagEnd && isSpace(bytes[i])) i++

			if (i >= tagEnd || bytes[i] === 47) break

			const nameStart = i

			while (i < tagEnd && !isSpace(bytes[i]) && bytes[i] !== 61) i++

			const nameEnd = i

			while (i < tagEnd && bytes[i] !== 34 && bytes[i] !== 39) i++

			const quote = bytes[i]
			const valueStart = i + 1

			i = valueStart

			while (i < tagEnd && bytes[i] !== quote) i++

			if (i >= tagEnd) {
				// Malformed: let the validating parser name the problem, as findAttribute does for a name not found.
				this.attributeSpans(node)

				break
			}

			for (let k = 0; k < names.length; k++) {
				if (values[k] === undefined && this.bytesEqualString(nameStart, nameEnd, names[k] as string)) {
					values[k] = decodeCharacterData(bytes, valueStart, i, true)
					missing--

					break
				}
			}

			i++
		}

		return values
	}

	// First child element, optionally restricted to one interned name id.
	firstChildElement(node: number, nameId: number = -1): number {
		return this.elementFrom(this.firstChild(node), nameId)
	}

	nextSiblingElement(node: number, nameId: number = -1): number {
		return this.elementFrom(this.nextSibling(node), nameId)
	}

	private elementFrom(node: number, nameId: number): number {
		for (let n = node; n >= 0; n = this.nextSibling(n)) {
			if (this.kinds[n] === NodeKind.Element && (nameId < 0 || this.nameIds[n] === nameId)) return n
		}

		return -1
	}

	private nameLength(id: number): number {
		return this.nameLengths[id] ?? 0
	}

	private assertUniqueNames(spans: Int32Array): void {
		const count = spans.length >> 2

		if (count <= PAIRWISE_DUPLICATE_LIMIT) {
			for (let a = 1; a < count; a++) {
				for (let b = 0; b < a; b++) {
					if (this.sameBytes(spans[b * 4] ?? 0, spans[b * 4 + 1] ?? 0, spans[a * 4] ?? 0, spans[a * 4 + 1] ?? 0)) {
						throw new XmlError("invalidAttribute", "Duplicate attribute", spans[a * 4] ?? 0)
					}
				}
			}

			return
		}

		const seen = new Set<string>()

		for (let k = 0; k < spans.length; k += 4) {
			const name = decodeUtf8(this.bytes, spans[k] ?? 0, spans[k + 1] ?? 0)

			if (seen.has(name)) throw new XmlError("invalidAttribute", "Duplicate attribute", spans[k] ?? 0)

			seen.add(name)
		}
	}

	private sameBytes(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
		if (aEnd - aStart !== bEnd - bStart) return false

		for (let k = 0; k < aEnd - aStart; k++) {
			if (this.bytes[aStart + k] !== this.bytes[bStart + k]) return false
		}

		return true
	}

	private bytesEqualString(start: number, end: number, text: string): boolean {
		// Qualified names are almost always ASCII; anything else takes the decoding path.
		if (end - start !== text.length) {
			if (end - start < text.length) return false

			// ASCII decodes to a unit a byte: only a name with other bytes can still match.
			for (let k = start; k < end; k++) if ((this.bytes[k] as number) >= 0x80) return decodeUtf8(this.bytes, start, end) === text

			return false
		}

		for (let k = 0; k < text.length; k++) {
			const code = text.charCodeAt(k)

			if (code >= 0x80) return decodeUtf8(this.bytes, start, end) === text
			if (this.bytes[start + k] !== code) return false
		}

		return true
	}
}
