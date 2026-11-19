import { isXmlNameEnd } from "../xml/bytes"
import { Namespaces, assertWellFormed, parseXml, type XmlDocument } from "../xml/index"

// content.xml's body cut into its top-level blocks (the children of office:text) without ever holding the
// body as one tree: a depth-tracking byte scan finds where each block starts and ends, and consecutive blocks
// are parsed together as a small document of their own (a batch) under copies of the root, office:body and
// office:text start tags, so prefixes resolve as in the stream. Peak memory is one batch plus the bytes of a
// block still arriving.

export class OdtScanError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "OdtScanError"
	}
}

// One top-level block: its element in the batch document and its byte span [start, end) in the stream.
export interface BodyBlock {
	readonly node: number
	readonly start: number
	readonly end: number
}

export interface BodyBatch {
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	readonly blocks: readonly BodyBlock[]
}

const LT = 60
const GT = 62
const SLASH = 47
const BANG = 33
const QUESTION = 63
const QUOTE = 34
const APOSTROPHE = 39
const DASH = 45
const BRACKET = 91

// Bytes of blocks gathered before they are parsed together.
const BATCH_BYTES = 256 * 1024

function indexOfAscii(bytes: Uint8Array, ascii: string, from: number, to: number): number {
	const first = ascii.charCodeAt(0)

	for (let at = bytes.indexOf(first, from); at >= 0 && at + ascii.length <= to; at = bytes.indexOf(first, at + 1)) {
		let k = 1

		while (k < ascii.length && bytes[at + k] === ascii.charCodeAt(k)) k++

		if (k === ascii.length) return at
	}

	return -1
}

function qualifiedName(tag: Uint8Array): Uint8Array {
	let end = 1

	while (!isXmlNameEnd(tag[end])) end++

	return tag.subarray(1, end)
}

// Container start tags as written, closed by an end tag of the same name.
function closing(tags: readonly Uint8Array[]): Uint8Array {
	const parts: number[] = []

	for (let k = tags.length - 1; k >= 0; k--) {
		const tag = tags[k]

		if (tag === undefined) continue

		parts.push(LT, SLASH, ...qualifiedName(tag), GT)
	}

	return Uint8Array.from(parts)
}

export class BodyScanner {
	// The root's start tag (namespace declarations), then office:body's and office:text's as they arrive.
	private readonly containers: Uint8Array[]
	private buffer = new Uint8Array(64 * 1024)
	// Stream offset of buffer[0] and the bytes held.
	private base: number
	private length = 0
	// Stream offset the scan continues from.
	private at: number
	// Element depth below the root: 1 inside office:body, 2 inside office:text, 3+ inside a block.
	private depth = 0
	private blockStart = -1
	private readonly pending: { start: number; end: number }[] = []
	private pendingBytes = 0
	private done = false
	private readonly batchBytes: number
	private readonly strict: boolean

	// `rootTag`: the root element's start tag; `bodyStart`: stream offset of office:body's start tag. `strict`: each
	// batch is checked for every well-formedness rule (assertWellFormed), not only its structure.
	constructor(rootTag: Uint8Array, bodyStart: number, options: { readonly batchBytes?: number; readonly strict?: boolean } = {}) {
		this.containers = [rootTag.slice()]
		this.base = bodyStart
		this.at = bodyStart
		this.batchBytes = options.batchBytes ?? BATCH_BYTES
		this.strict = options.strict === true
	}

	get finished(): boolean {
		return this.done
	}

	// The stream's next bytes from offset `offset`; bytes before office:body are ignored.
	push(chunk: Uint8Array, offset: number): BodyBatch[] {
		if (this.done) return []

		const end = offset + chunk.length

		if (end <= this.base + this.length) return []

		const from = Math.max(0, this.base + this.length - offset)

		this.append(chunk.subarray(from))

		const out: BodyBatch[] = []

		this.scan(out)

		return out
	}

	// The end of the stream: what is pending is parsed; a body left open is damage.
	finish(): BodyBatch[] {
		if (!this.done) throw new OdtScanError("content.xml ends inside office:body")

		return []
	}

	private append(bytes: Uint8Array): void {
		// Drop what no block needs any more before growing.
		const keep = Math.min(this.at, this.blockStart >= 0 ? this.blockStart : Infinity, this.pending[0]?.start ?? Infinity)

		if (keep > this.base) {
			const drop = Math.min(keep - this.base, this.length)

			this.buffer.copyWithin(0, drop, this.length)
			this.length -= drop
			this.base += drop
		}

		if (this.length + bytes.length > this.buffer.length) {
			const grown = new Uint8Array(Math.max(this.buffer.length * 2, this.length + bytes.length))

			grown.set(this.buffer.subarray(0, this.length))
			this.buffer = grown
		}

		this.buffer.set(bytes, this.length)
		this.length += bytes.length
	}

	private scan(out: BodyBatch[]): void {
		const bytes = this.buffer
		const limit = this.length

		while (!this.done) {
			const local = bytes.subarray(0, limit).indexOf(LT, this.at - this.base)

			if (local < 0) {
				this.at = this.base + limit

				return
			}

			const next = bytes[local + 1]

			if (local + 1 >= limit) {
				this.at = this.base + local

				return
			}

			let tokenEnd: number

			if (next === BANG) {
				if (local + 9 > limit) {
					this.at = this.base + local

					return
				}

				if (bytes[local + 2] === DASH && bytes[local + 3] === DASH) {
					const close = indexOfAscii(bytes, "-->", local + 4, limit)

					tokenEnd = close < 0 ? -1 : close + 3
				} else if (bytes[local + 2] === BRACKET) {
					const close = indexOfAscii(bytes, "]]>", local + 9, limit)

					tokenEnd = close < 0 ? -1 : close + 3
				} else {
					throw new OdtScanError("A declaration inside office:body")
				}
			} else if (next === QUESTION) {
				const close = indexOfAscii(bytes, "?>", local + 2, limit)

				tokenEnd = close < 0 ? -1 : close + 2
			} else if (next === SLASH) {
				const close = bytes.subarray(0, limit).indexOf(GT, local + 2)

				if (close < 0) {
					this.at = this.base + local

					return
				}

				tokenEnd = close + 1
				this.depth--

				if (this.depth === 2 && this.blockStart >= 0) {
					this.block(this.blockStart, this.base + tokenEnd, out)
					this.blockStart = -1
				} else if (this.depth < 2) {
					this.flush(out)
					this.done = true
				}
			} else {
				tokenEnd = this.startTagEnd(bytes, local, limit)

				if (tokenEnd < 0) {
					this.at = this.base + local

					return
				}

				const selfClosing = bytes[tokenEnd - 2] === SLASH

				if (this.depth === 2) {
					if (selfClosing) this.block(this.base + local, this.base + tokenEnd, out)
					else this.blockStart = this.base + local
				} else if (this.depth < 2) {
					if (selfClosing) {
						this.flush(out)
						this.done = true
					} else {
						this.containers.push(bytes.slice(local, tokenEnd))
					}
				}

				if (!selfClosing) this.depth++
			}

			if (tokenEnd < 0) {
				this.at = this.base + local

				return
			}

			this.at = this.base + tokenEnd
		}
	}

	// The byte after a start tag's ">", quotes respected; -1 when the tag has not fully arrived.
	private startTagEnd(bytes: Uint8Array, start: number, limit: number): number {
		let quote = 0

		for (let at = start + 1; at < limit; at++) {
			const byte = bytes[at]

			if (quote !== 0) {
				if (byte === quote) quote = 0
			} else if (byte === QUOTE || byte === APOSTROPHE) {
				quote = byte
			} else if (byte === GT) {
				return at + 1
			} else if (byte === LT) {
				throw new OdtScanError("A start tag holds '<'")
			}
		}

		return -1
	}

	private block(start: number, end: number, out: BodyBatch[]): void {
		this.pending.push({ start, end })
		this.pendingBytes += end - start

		if (this.pendingBytes >= this.batchBytes) this.flush(out)
	}

	private flush(out: BodyBatch[]): void {
		const first = this.pending[0]
		const last = this.pending[this.pending.length - 1]

		if (first === undefined || last === undefined) return

		const head = this.containers
		const tail = closing(head)
		let size = tail.length + (last.end - first.start)

		for (const tag of head) size += tag.length

		const wrapped = new Uint8Array(size)
		let offset = 0

		for (const tag of head) {
			wrapped.set(tag, offset)
			offset += tag.length
		}

		const prefix = offset

		wrapped.set(this.buffer.subarray(first.start - this.base, last.end - this.base), offset)
		offset += last.end - first.start
		wrapped.set(tail, offset)

		const document = parseXml(wrapped)

		if (this.strict) assertWellFormed(document)

		let container = document.documentElement()

		for (let level = 1; level < head.length; level++) container = document.firstChildElement(container)

		const blocks: BodyBlock[] = []
		let k = 0

		for (let node = document.firstChildElement(container); node >= 0; node = document.nextSiblingElement(node)) {
			const span = this.pending[k++]

			if (span === undefined || document.start(node) - prefix !== span.start - first.start) {
				throw new OdtScanError("Block boundaries disagree with the parse")
			}

			blocks.push({ node, start: span.start, end: span.end })
		}

		if (k !== this.pending.length) throw new OdtScanError("Block boundaries disagree with the parse")

		this.pending.length = 0
		this.pendingBytes = 0
		out.push({ document, namespaces: new Namespaces(document), blocks })
	}
}
