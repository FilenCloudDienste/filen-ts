import { NodeKind, decodeUtf8, encodeUtf8, escapeAttribute, escapeText, type XmlDocument } from "../../xml/index"
import { Ns } from "../model/namespaces"
import type { PartReader } from "../model/reader"

// Output of one part or element: copied byte ranges of the source and new markup, joined once. Copies of
// whole source nodes made with copy() are recorded as `trusted` ([output from, output to, source from,
// source to] each): they are well-formed by the source's parse, so gate 2 checks only what is around them.
// Copies shorter than this go into the scratch buffer with new markup; longer ones stay views of the source.
const SMALL = 64
const SCRATCH_MAX = 64 * 1024

export class Out {
	private readonly chunks: Uint8Array[] = []
	readonly trusted: number[] = []
	private length = 0
	// New markup and short copies, encoded in place until it is flushed as a chunk.
	private scratch: Uint8Array = new Uint8Array(256)
	private used = 0

	get size(): number {
		return this.length
	}

	private reserve(count: number): void {
		if (this.used + count <= this.scratch.length) return

		if (this.used + count <= SCRATCH_MAX) {
			const grown = new Uint8Array(Math.max(this.scratch.length * 2, this.used + count))

			grown.set(this.scratch.subarray(0, this.used))
			this.scratch = grown

			return
		}

		this.flush()

		if (count > this.scratch.length) this.scratch = new Uint8Array(count)
	}

	private flush(): void {
		if (this.used === 0) return

		this.chunks.push(this.scratch.slice(0, this.used))
		this.used = 0
	}

	bytes(source: Uint8Array, from: number, to: number): void {
		if (to <= from) return

		if (to - from < SMALL) {
			this.reserve(to - from)

			for (let i = from; i < to; i++) this.scratch[this.used++] = source[i] ?? 0
		} else {
			this.flush()
			this.chunks.push(source.subarray(from, to))
		}

		this.length += to - from
	}

	// Whole nodes of the story's own part, copied as they are.
	copy(source: Uint8Array, from: number, to: number): void {
		if (to <= from) return

		const last = this.trusted.length - 4

		// Adjacent copies of adjacent source bytes are one span.
		if (last >= 0 && this.trusted[last + 1] === this.length && this.trusted[last + 3] === from) {
			this.trusted[last + 1] = this.length + to - from
			this.trusted[last + 3] = to
		} else {
			this.trusted.push(this.length, this.length + to - from, from, to)
		}

		this.bytes(source, from, to)
	}

	// UTF-8, lone surrogates as U+FFFD (as TextEncoder writes them).
	text(markup: string): void {
		const count = markup.length

		if (count === 0) return

		this.reserve(count * 3)

		const scratch = this.scratch
		let at = this.used

		for (let i = 0; i < count; i++) {
			let code = markup.charCodeAt(i)

			if (code < 0x80) {
				scratch[at++] = code

				continue
			}

			if (code < 0x800) {
				scratch[at++] = 0xc0 | (code >> 6)
				scratch[at++] = 0x80 | (code & 0x3f)

				continue
			}

			if (code >= 0xd800 && code <= 0xdfff) {
				const next = markup.charCodeAt(i + 1)

				if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
					code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
					i++
					scratch[at++] = 0xf0 | (code >> 18)
					scratch[at++] = 0x80 | ((code >> 12) & 0x3f)
					scratch[at++] = 0x80 | ((code >> 6) & 0x3f)
					scratch[at++] = 0x80 | (code & 0x3f)

					continue
				}

				code = 0xfffd
			}

			scratch[at++] = 0xe0 | (code >> 12)
			scratch[at++] = 0x80 | ((code >> 6) & 0x3f)
			scratch[at++] = 0x80 | (code & 0x3f)
		}

		this.length += at - this.used
		this.used = at
	}

	// Bytes [from, to) of what was written, a copy. Walked back from the end, so reading the tail (writeTop's
	// use) costs the chunks it covers, not every chunk written before it.
	slice(from: number, to: number): Uint8Array {
		const start = Math.max(0, from)
		const end = Math.min(this.length, to)
		const out = new Uint8Array(Math.max(0, end - start))

		if (end <= start) return out

		const piece = (chunk: Uint8Array, at: number): void => {
			const chunkEnd = at + chunk.length

			if (chunkEnd > start && at < end)
				out.set(chunk.subarray(Math.max(0, start - at), Math.min(chunk.length, end - at)), Math.max(0, at - start))
		}
		let at = this.length - this.used

		piece(this.scratch.subarray(0, this.used), at)

		for (let index = this.chunks.length - 1; index >= 0 && at > start; index--) {
			const chunk = this.chunks[index]

			if (chunk === undefined) break

			at -= chunk.length
			piece(chunk, at)
		}

		return out
	}

	// Whether what was written is exactly source[from, to).
	equals(source: Uint8Array, from: number, to: number): boolean {
		if (to - from !== this.length) return false

		let at = from

		for (const chunk of this.chunks) {
			// A view of these very source bytes is equal as it is.
			if (chunk.buffer !== source.buffer || chunk.byteOffset !== source.byteOffset + at) {
				for (let i = 0; i < chunk.length; i++) if (chunk[i] !== source[at + i]) return false
			}

			at += chunk.length
		}

		for (let i = 0; i < this.used; i++) if (this.scratch[i] !== source[at + i]) return false

		return true
	}

	// What was written as pieces, never joined: views of the source for copies, the new markup in chunks of
	// its own (see BytePieces). Nothing may be written after.
	views(): readonly Uint8Array[] {
		this.flush()

		return this.chunks
	}

	finish(): Uint8Array {
		if (this.chunks.length === 0) return this.scratch.slice(0, this.used)
		if (this.chunks.length === 1 && this.used === 0 && this.chunks[0] !== undefined) return this.chunks[0].slice()

		const out = new Uint8Array(this.length)
		let at = 0

		for (const chunk of this.chunks) {
			out.set(chunk, at)
			at += chunk.length
		}

		out.set(this.scratch.subarray(0, this.used), at)

		return out
	}
}

// Qualified names for new markup, with the prefixes the part itself binds.
export class Names {
	readonly w: string
	readonly r: string

	constructor(w: string, r: string) {
		this.w = w
		this.r = r
	}

	el(local: string): string {
		return this.w === "" ? local : `${this.w}:${local}`
	}

	attr(local: string): string {
		return this.w === "" ? local : `${this.w}:${local}`
	}

	relId(): string {
		return this.r === "" ? "id" : `${this.r}:id`
	}

	// <w:name w:val="value"/>, or with more attributes.
	empty(local: string, attributes: readonly (readonly [string, string | null | undefined])[] = []): string {
		let out = `<${this.el(local)}`

		for (const [name, value] of attributes) {
			if (value !== null && value !== undefined) out += ` ${this.attr(name)}="${escapeAttribute(value)}"`
		}

		return `${out}/>`
	}

	val(local: string, value: string): string {
		return this.empty(local, [["val", value]])
	}
}

// Word marks text xml:space="preserve" exactly when it starts or ends with whitespace (inner runs of spaces
// it writes as they are, and reads them so).
const PRESERVE = /^[ \t\r\n]|[ \t\r\n]$/

// A w:t (or w:delText) holding `text`.
export function textElement(names: Names, text: string, deleted: boolean): string {
	const local = names.el(deleted ? "delText" : "t")
	const space = PRESERVE.test(text) ? ' xml:space="preserve"' : ""

	return `<${local}${space}>${escapeText(text)}</${local}>`
}

// The start tag of an element, as an opening tag even when it closes itself ("<w:p/>" -> "<w:p>").
export function openTag(out: Out, document: XmlDocument, node: number): void {
	const bytes = document.bytes
	const start = document.start(node)
	const openEnd = document.openEnd(node)

	if (!document.isSelfClosing(node)) {
		out.bytes(bytes, start, openEnd)

		return
	}

	let end = openEnd - 2

	while (end > start && isSpace(bytes[end - 1])) end--

	out.bytes(bytes, start, end)
	out.text(">")
}

// A start tag without the attributes `drop` names (by qualified name), as an opening tag.
export function openTagWithout(out: Out, document: XmlDocument, node: number, drop: ReadonlySet<string>): void {
	const bytes = document.bytes
	const spans = document.attributeSpans(node)
	let at = document.start(node)
	let removed = false

	for (let k = 0; k < spans.length; k += 4) {
		const nameStart = spans[k] ?? 0

		if (!drop.has(decodeUtf8(bytes, nameStart, spans[k + 1] ?? 0))) continue

		let from = nameStart

		while (from > at && isSpace(bytes[from - 1])) from--

		out.bytes(bytes, at, from)
		at = (spans[k + 3] ?? 0) + 1
		removed = true
	}

	if (!removed) {
		openTag(out, document, node)

		return
	}

	const openEnd = document.openEnd(node)

	if (document.isSelfClosing(node)) {
		let end = openEnd - 2

		while (end > at && isSpace(bytes[end - 1])) end--

		out.bytes(bytes, at, end)
		out.text(">")
	} else {
		out.bytes(bytes, at, openEnd)
	}
}

export function closeTag(out: Out, document: XmlDocument, node: number): void {
	if (document.isSelfClosing(node)) out.text(`</${document.name(node)}>`)
	else out.bytes(document.bytes, document.contentEnd(node), document.end(node))
}

function isSpace(b: number | undefined): boolean {
	return b === 32 || b === 9 || b === 10 || b === 13
}

export function copyNode(out: Out, document: XmlDocument, node: number): void {
	out.bytes(document.bytes, document.start(node), document.end(node))
}

// A WordprocessingML property container (w:rPr, w:pPr, w:numPr...) with some children replaced, removed
// ("" as the new markup) or added at their schema position (`order`); everything else is copied as it was,
// whitespace included. `extra` adds markup after the last child, before the close tag.
export function spliceChildren(
	out: Out,
	reader: PartReader,
	container: number,
	changes: ReadonlyMap<string, string>,
	order: readonly string[]
): void {
	const document = reader.document
	const rankOf = (local: string): number => {
		const rank = order.indexOf(local)

		return rank < 0 ? order.length : rank
	}
	// New children in schema order; names the order does not know go last.
	const pending = [...changes]
		.filter(([, markup]) => markup !== "")
		.map(([local, markup]) => ({ local, markup, rank: rankOf(local) }))
		.sort((a, b) => a.rank - b.rank)
	const done = new Set<string>()
	const flushBefore = (rank: number): void => {
		for (const item of pending) {
			if (done.has(item.local) || item.rank >= rank) continue

			out.text(item.markup)
			done.add(item.local)
		}
	}
	const ranked = (child: number): boolean =>
		document.kinds[child] === NodeKind.Element && reader.group(child) === Ns.W && order.includes(document.localName(child))
	// Children the schema does not order (extensions such as w14:*) come after the WordprocessingML ones:
	// new children go before the first of them that no ordered child follows.
	let lastRanked = -1
	let sequence: number[] = []
	let previousRank = -1
	let disordered = false

	for (let child = document.firstChild(container); child >= 0; child = document.nextSibling(child)) {
		sequence.push(child)

		if (!ranked(child)) continue

		const rank = rankOf(document.localName(child))

		disordered ||= rank < previousRank
		previousRank = rank
		lastRanked = child
	}

	// A source out of schema order is rewritten in order: each ordered child with what follows it up to the
	// next one (whitespace, extensions); what precedes the first and follows the last stays in place.
	if (disordered) {
		const lead: number[] = []
		const groups: { rank: number; nodes: number[] }[] = []
		const tail: number[] = []
		const last = document.start(lastRanked)

		for (const child of sequence) {
			if (ranked(child)) groups.push({ rank: rankOf(document.localName(child)), nodes: [child] })
			else if (groups.length === 0) lead.push(child)
			else if (document.start(child) > last) tail.push(child)
			else groups.at(-1)?.nodes.push(child)
		}

		groups.sort((a, b) => a.rank - b.rank)
		sequence = [...lead, ...groups.flatMap(group => group.nodes), ...tail]
		lastRanked = groups.at(-1)?.nodes[0] ?? -1
	}

	let afterRanked = lastRanked < 0
	// The record of a tracked change of the properties (w:rPrChange, w:pPrChange...) is their last child, after
	// the extensions too (Word's schemas put w14:* and the like inside the properties it records).
	const last = order[order.length - 1] ?? ""
	const beforeExtensions = last.endsWith("Change") ? order.length - 1 : order.length + 1

	openTag(out, document, container)

	for (const child of sequence) {
		if (document.kinds[child] === NodeKind.Element) {
			const isRanked = ranked(child)

			if (isRanked) flushBefore(rankOf(document.localName(child)))
			else if (afterRanked) flushBefore(beforeExtensions)

			if (reader.group(child) === Ns.W) {
				const local = document.localName(child)
				const replacement = changes.get(local)

				if (replacement !== undefined) {
					if (!done.has(local)) out.text(replacement)

					done.add(local)

					if (child === lastRanked) afterRanked = true

					continue
				}
			}
		}

		copyNode(out, document, child)

		if (child === lastRanked) afterRanked = true
	}

	flushBefore(order.length + 1)
	closeTag(out, document, container)
}

// New property container markup from (local name, markup) children, in schema order; "" without children.
export function freshContainer(names: Names, local: string, children: ReadonlyMap<string, string>, order: readonly string[]): string {
	const sorted = [...children].filter(([, markup]) => markup !== "").sort(([a], [b]) => rank(order, a) - rank(order, b))

	if (sorted.length === 0) return ""

	return `<${names.el(local)}>${sorted.map(([, markup]) => markup).join("")}</${names.el(local)}>`
}

function rank(order: readonly string[], local: string): number {
	const index = order.indexOf(local)

	return index < 0 ? order.length : index
}

// A start tag with one attribute set to a new value (added when absent); `close` keeps a self-closing tag so.
export function startTagWith(out: Out, document: XmlDocument, node: number, qualifiedName: string, value: string, close = false): void {
	const bytes = document.bytes
	const spans = document.attributeSpans(node)
	const name = encodeUtf8(qualifiedName)
	const start = document.start(node)
	const openEnd = document.openEnd(node)

	for (let k = 0; k < spans.length; k += 4) {
		const nameStart = spans[k] ?? 0
		const nameEnd = spans[k + 1] ?? 0

		if (nameEnd - nameStart !== name.length) continue

		let same = true

		for (let b = 0; b < name.length && same; b++) same = bytes[nameStart + b] === name[b]

		if (!same) continue

		out.bytes(bytes, start, spans[k + 2] ?? 0)
		out.text(escapeAttribute(value))

		if (document.isSelfClosing(node)) {
			let end = openEnd - 2

			while (end > start && isSpace(bytes[end - 1])) end--

			out.bytes(bytes, spans[k + 3] ?? 0, end)
			out.text(close ? "/>" : ">")
		} else {
			out.bytes(bytes, spans[k + 3] ?? 0, openEnd)
		}

		return
	}

	let end = document.isSelfClosing(node) ? openEnd - 2 : openEnd - 1

	while (end > start && isSpace(bytes[end - 1])) end--

	out.bytes(bytes, start, end)
	out.text(` ${qualifiedName}="${escapeAttribute(value)}"${close && document.isSelfClosing(node) ? "/>" : ">"}`)
}
