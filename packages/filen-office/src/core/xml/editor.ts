import { NodeKind, type XmlDocument } from "./document"
import { escapeAttribute, escapeText } from "./entities"
import { XmlError } from "./errors"
import { decodeUtf8, encodeUtf8 } from "./utf8"

export type Markup = Uint8Array | string

interface Splice {
	readonly from: number
	readonly to: number
	readonly data: readonly Uint8Array[]
	// Inserts at the same byte: ascending. "Front" inserts (prepend, insertAfter) use -sequence, "back"
	// inserts (append, insertBefore) +sequence, which is the order a live tree would end up in.
	readonly order: number
}

interface ElementEdit {
	attributes: Map<string, string | null> | null
	// New content of a self-closing element, which has no byte position inside it to splice at.
	inner: { data: Uint8Array; order: number }[] | null
}

const EMPTY = new Uint8Array(0)
const GT = encodeUtf8(">")

function toBytes(markup: Markup): Uint8Array {
	return typeof markup === "string" ? encodeUtf8(markup) : markup
}

function isSpace(b: number | undefined): boolean {
	return b === 32 || b === 9 || b === 10 || b === 13
}

// Edits against an immutable XmlDocument, recorded as byte splices over the original part. serialize()
// copies every untouched byte range as-is, so only edited nodes differ from the input; with no edits the
// output is the input. Markup strings are inserted verbatim (escape values with escapeText/escapeAttribute).
// Edits apply as on a live tree, in call order: setContent drops earlier edits inside the element, and
// replacing a node twice keeps the last. Editing inside a node that was replaced is a conflict, reported
// by serialize().
export class XmlEditor {
	readonly document: XmlDocument
	private readonly ranges = new Map<string, Splice>()
	private inserts: Splice[] = []
	private readonly elements = new Map<number, ElementEdit>()
	private sequence = 0

	constructor(document: XmlDocument) {
		this.document = document
	}

	get changed(): boolean {
		return this.ranges.size > 0 || this.inserts.length > 0 || this.elements.size > 0
	}

	replace(node: number, markup: Markup): void {
		this.range(this.document.start(node), this.document.end(node), toBytes(markup))
	}

	remove(node: number): void {
		this.range(this.document.start(node), this.document.end(node), EMPTY)
	}

	insertBefore(node: number, markup: Markup): void {
		this.insert(this.document.start(node), toBytes(markup), false)
	}

	insertAfter(node: number, markup: Markup): void {
		this.insert(this.document.end(node), toBytes(markup), true)
	}

	// Insert as the first or last content of an element; a self-closing element is expanded.
	prepend(node: number, markup: Markup): void {
		this.addContent(node, toBytes(markup), true)
	}

	append(node: number, markup: Markup): void {
		this.addContent(node, toBytes(markup), false)
	}

	// Replace an element's content with text.
	setText(node: number, text: string): void {
		this.setContent(node, escapeText(text))
	}

	setContent(node: number, markup: Markup): void {
		const document = this.document
		const edit = this.element(node)

		if (document.isSelfClosing(node)) {
			edit.inner = [{ data: toBytes(markup), order: 0 }]

			return
		}

		const from = document.contentStart(node)
		const to = document.contentEnd(node)

		// Everything recorded inside the old content goes with it.
		this.inserts = this.inserts.filter(insert => insert.from < from || insert.from > to)

		for (const [key, splice] of this.ranges) {
			if (splice.from >= from && splice.to <= to) this.ranges.delete(key)
		}

		for (const inner of this.elements.keys()) {
			if (inner !== node && document.start(inner) >= from && document.end(inner) <= to) this.elements.delete(inner)
		}

		this.range(from, to, toBytes(markup))
	}

	// Whether a replacement recorded so far covers the node (an edit inside it would conflict).
	covered(node: number): boolean {
		const start = this.document.start(node)
		const end = this.document.end(node)

		for (const splice of this.ranges.values()) if (splice.from <= start && end <= splice.to && splice.to > splice.from) return true

		return false
	}

	// Change or add an attribute. An existing value is replaced in place; the rest of the tag is kept.
	setAttribute(node: number, qualifiedName: string, value: string): void {
		const edit = this.element(node)

		edit.attributes ??= new Map()
		edit.attributes.set(qualifiedName, value)
	}

	removeAttribute(node: number, qualifiedName: string): void {
		const edit = this.element(node)

		edit.attributes ??= new Map()
		edit.attributes.set(qualifiedName, null)
	}

	// The edited part. A UTF-16 part always comes out as UTF-8 with its declaration saying so; leave a part
	// that has not `changed` to be copied as it was.
	serialize(): Uint8Array {
		const document = this.document
		const source = document.bytes
		const splices = [...this.ranges.values(), ...this.inserts]

		for (const [node, edit] of this.elements) this.materialize(node, edit, splices)

		if (document.encoding !== "utf-8") this.declareUtf8(splices)

		if (splices.length === 0) return source

		// Zero-length inserts sort before a replacement starting at the same byte, then by their order.
		splices.sort((a, b) => a.from - b.from || (a.to === a.from ? 0 : 1) - (b.to === b.from ? 0 : 1) || a.order - b.order)

		let total = source.length

		for (let k = 0; k < splices.length; k++) {
			const splice = splices[k]

			if (splice === undefined) continue

			const previous = splices[k - 1]

			if (previous !== undefined && splice.from < previous.to) {
				throw new XmlError("editConflict", "Overlapping edits", splice.from)
			}

			total -= splice.to - splice.from

			for (const chunk of splice.data) total += chunk.length
		}

		const out = new Uint8Array(total)
		let position = 0
		let written = 0

		for (const splice of splices) {
			out.set(source.subarray(position, splice.from), written)
			written += splice.from - position

			for (const chunk of splice.data) {
				out.set(chunk, written)
				written += chunk.length
			}

			position = splice.to
		}

		out.set(source.subarray(position), written)

		return out
	}

	private range(from: number, to: number, data: Uint8Array): void {
		this.ranges.set(`${from}:${to}`, { from, to, data: [data], order: ++this.sequence })
	}

	private insert(at: number, data: Uint8Array, front: boolean): void {
		const sequence = ++this.sequence

		this.inserts.push({ from: at, to: at, data: [data], order: front ? -sequence : sequence })
	}

	private addContent(node: number, data: Uint8Array, front: boolean): void {
		const document = this.document
		const edit = this.element(node)

		if (document.isSelfClosing(node)) {
			const sequence = ++this.sequence

			edit.inner ??= []
			edit.inner.push({ data, order: front ? -sequence : sequence })

			return
		}

		this.insert(front ? document.contentStart(node) : document.contentEnd(node), data, front)
	}

	private element(node: number): ElementEdit {
		if (this.document.kind(node) !== NodeKind.Element) {
			throw new XmlError("editConflict", "Not an element", this.document.start(node))
		}

		let edit = this.elements.get(node)

		if (edit === undefined) {
			edit = { attributes: null, inner: null }
			this.elements.set(node, edit)
		}

		return edit
	}

	private materialize(node: number, edit: ElementEdit, splices: Splice[]): void {
		const document = this.document
		const bytes = document.bytes
		const selfClosing = document.isSelfClosing(node)
		const openEnd = document.openEnd(node)
		// Where a new attribute goes: before "/>" or ">".
		const tagClose = selfClosing ? openEnd - 2 : openEnd - 1

		if (edit.attributes !== null) {
			const spans = document.attributeSpans(node)
			const added: Uint8Array[] = []

			for (const [name, value] of edit.attributes) {
				const nameBytes = encodeUtf8(name)
				let found = -1

				for (let k = 0; k < spans.length && found < 0; k += 4) {
					const nameStart = spans[k] ?? 0

					if ((spans[k + 1] ?? 0) - nameStart !== nameBytes.length) continue

					let same = true

					for (let b = 0; b < nameBytes.length && same; b++) same = bytes[nameStart + b] === nameBytes[b]

					if (same) found = k
				}

				if (found < 0) {
					if (value !== null) added.push(encodeUtf8(` ${name}="${escapeAttribute(value)}"`))

					continue
				}

				const valueStart = spans[found + 2] ?? 0
				const valueEnd = spans[found + 3] ?? 0

				if (value !== null) {
					splices.push({ from: valueStart, to: valueEnd, data: [encodeUtf8(escapeAttribute(value))], order: 0 })
				} else {
					// Drop the attribute with the whitespace that separated it from what came before.
					let from = spans[found] ?? 0

					while (isSpace(bytes[from - 1])) from--

					splices.push({ from, to: valueEnd + 1, data: [EMPTY], order: 0 })
				}
			}

			if (added.length > 0) splices.push({ from: tagClose, to: tagClose, data: added, order: -Number.MAX_SAFE_INTEGER })
		}

		if (edit.inner === null || !selfClosing) return

		// "<a/>" becomes "<a>…</a>": the "/>" is replaced, whitespace before it stays.
		const inner = [...edit.inner].sort((a, b) => a.order - b.order).map(item => item.data)

		splices.push({ from: openEnd - 2, to: openEnd, data: [GT, ...inner, encodeUtf8(`</${document.name(node)}>`)], order: 0 })
	}

	// A transcoded UTF-16 part is written as UTF-8, so its declaration must stop claiming otherwise.
	private declareUtf8(splices: Splice[]): void {
		const document = this.document
		const declaration = document.firstChild(0)

		if (declaration < 0 || document.kind(declaration) !== NodeKind.ProcessingInstruction || document.name(declaration) !== "xml") return

		const start = document.start(declaration)
		const end = document.end(declaration)
		const text = decodeUtf8(document.bytes, start, end)
		const rewritten = text.replace(/(encoding\s*=\s*)(["'])[^"']*\2/, "$1$2UTF-8$2")

		if (rewritten !== text && !splices.some(splice => splice.from < end && splice.to > start)) {
			splices.push({ from: start, to: end, data: [encodeUtf8(rewritten)], order: 0 })
		}
	}
}
