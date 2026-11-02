import { fromCharCodes } from "../../arrays"
import { decodeCharacterData } from "../../xml/entities"

// A one-pass tag scanner over content.xml as it inflates, for the writer: start, end and empty tags come out with
// their absolute offsets in the stream and the id of their name among the ones asked for (0 for any other). Text,
// comments, processing instructions and CDATA sections pass by. The bytes from `keep` on stay readable (bytes()),
// so the writer can copy what it leaves alone and take whole elements it rewrites.

const LT = 60
const GT = 62
const SLASH = 47
const QUOTE = 34
const APOSTROPHE = 39
const BANG = 33
const QUESTION = 63
const SPACE = 32
const TAB = 9
const LF = 10
const CR = 13
const EQUALS = 61

export const TagKind = {
	START: 1,
	END: 2,
	EMPTY: 3
} as const

export type TagKind = (typeof TagKind)[keyof typeof TagKind]

export interface StreamHandler {
	// A tag [start, end) (end past its ">"); `name` the id of its qualified name, 0 for one not asked for.
	tag(kind: TagKind, name: number, start: number, end: number): void
}

export class StreamError extends Error {}

function isSpace(b: number | undefined): boolean {
	return b === SPACE || b === TAB || b === LF || b === CR
}

// Qualified names by length and bytes: ids from 1 in the order given.
class Names {
	private readonly byLength = new Map<number, { bytes: Uint8Array; id: number }[]>()

	constructor(names: readonly string[]) {
		const encoder = new TextEncoder()

		names.forEach((name, index) => {
			const bytes = encoder.encode(name)
			let list = this.byLength.get(bytes.length)

			if (list === undefined) this.byLength.set(bytes.length, (list = []))

			list.push({ bytes, id: index + 1 })
		})
	}

	find(buffer: Uint8Array, start: number, end: number): number {
		const list = this.byLength.get(end - start)

		if (list === undefined) return 0

		for (const entry of list) {
			let k = 0

			while (k < entry.bytes.length && entry.bytes[k] === buffer[start + k]) k++

			if (k === entry.bytes.length) return entry.id
		}

		return 0
	}
}

export class TagStream {
	private readonly handler: StreamHandler
	private readonly names: Names
	private buffer = new Uint8Array(256 * 1024)
	// Absolute offset of buffer[0], and how many bytes it holds.
	private base = 0
	private length = 0
	// Absolute offset scanned up to.
	private scanned = 0
	// Bytes before this are no longer needed.
	keep = 0
	// An element whose inside is passed over (skipTo): its name's bytes, and where the search for its end is.
	private skipName: Uint8Array | null = null
	private skipFrom = 0
	// Absolute offset of the stream's end so far, and of the end of the last whole tag or text scanned.
	get offset(): number {
		return this.base + this.length
	}

	get scannedOffset(): number {
		return this.scanned
	}

	constructor(handler: StreamHandler, names: readonly string[]) {
		this.handler = handler
		this.names = new Names(names)
	}

	push(chunk: Uint8Array): void {
		this.append(chunk)
		this.scan(false)
	}

	end(): void {
		this.scan(true)

		if (this.scanned < this.base + this.length) throw new StreamError("The stream ends inside markup")
	}

	private append(chunk: Uint8Array): void {
		const drop = Math.max(0, Math.min(this.keep, this.scanned) - this.base)

		if (drop > 0) {
			this.buffer.copyWithin(0, drop, this.length)
			this.length -= drop
			this.base += drop
		}

		if (this.length + chunk.length > this.buffer.length) {
			const grown = new Uint8Array(Math.max(this.length + chunk.length, this.buffer.length * 2))

			grown.set(this.buffer.subarray(0, this.length))
			this.buffer = grown
		}

		this.buffer.set(chunk, this.length)
		this.length += chunk.length
	}

	// The bytes [from, to) of the stream: a view, valid until the next push.
	bytes(from: number, to: number): Uint8Array {
		if (from < this.base || to > this.base + this.length) throw new StreamError(`Bytes ${from}-${to} are no longer held`)

		return this.buffer.subarray(from - this.base, to - this.base)
	}

	// Passes over the inside of the element whose start tag was just handled (named `name`, as it is written): its end
	// tag is handed on next. Nothing between is: not for an element that holds another of its name, a comment, a
	// processing instruction or CDATA, where every tag is scanned as before.
	skipTo(name: Uint8Array): void {
		this.skipName = name
		this.skipFrom = this.scanned
	}

	// The end tag of the element skipped: its offset in the buffer, -2 once it cannot be skipped, -1 when the bytes
	// held end first.
	private skipEnd(buffer: Uint8Array, from: number, end: number, name: Uint8Array): number {
		for (let lt = buffer.indexOf(LT, from); lt >= 0 && lt < end; lt = buffer.indexOf(LT, lt + 1)) {
			if (lt + name.length + 2 >= end) return -1

			const next = buffer[lt + 1]

			if (next === BANG || next === QUESTION) return -2

			const at = next === SLASH ? lt + 2 : lt + 1
			let same = true

			for (let k = 0; same && k < name.length; k++) same = buffer[at + k] === name[k]

			const after = buffer[at + name.length]

			if (!same || !(after === GT || after === SLASH || isSpace(after))) continue

			return next === SLASH ? lt : -2
		}

		return -1
	}

	private scan(final: boolean): void {
		const buffer = this.buffer
		const end = this.length
		let i = this.scanned - this.base

		while (i < end) {
			if (this.skipName !== null) {
				const found = this.skipEnd(buffer, Math.max(i, this.skipFrom - this.base), end, this.skipName)

				if (found === -1) {
					// Not held yet: look on from near where this search stopped.
					this.skipFrom = this.base + Math.max(i, end - this.skipName.length - 3)

					break
				}

				this.skipName = null

				if (found >= 0) i = found
			}

			if (buffer[i] !== LT) {
				const lt = buffer.indexOf(LT, i)

				if (lt < 0 || lt >= end) {
					i = end

					break
				}

				i = lt
			}

			if (i + 1 >= end) break

			const next = buffer[i + 1]

			if (next === BANG || next === QUESTION) {
				const close = markupEnd(buffer, i, end)

				if (close < 0) break

				i = close

				continue
			}

			const close = tagEnd(buffer, i, end)

			if (close < 0) break

			const absolute = this.base + i

			if (next === SLASH) {
				let n = i + 2

				while (n < close - 1 && !isSpace(buffer[n]) && buffer[n] !== GT) n++

				this.handler.tag(TagKind.END, this.names.find(buffer, i + 2, n), absolute, this.base + close)
			} else {
				let n = i + 1

				while (n < close - 1 && !isSpace(buffer[n]) && buffer[n] !== SLASH && buffer[n] !== GT) n++

				const empty = buffer[close - 2] === SLASH

				this.handler.tag(empty ? TagKind.EMPTY : TagKind.START, this.names.find(buffer, i + 1, n), absolute, this.base + close)
			}

			i = close
		}

		this.scanned = this.base + i

		if (final && i < end) throw new StreamError("The stream ends inside a tag")
	}
}

// Past the ">" of the tag whose "<" is at `i`, -1 when it is not complete.
function tagEnd(bytes: Uint8Array, i: number, end: number): number {
	let j = i + 1

	while (j < end) {
		const b = bytes[j]

		if (b === GT) return j + 1

		if (b === QUOTE || b === APOSTROPHE) {
			j++

			while (j < end && bytes[j] !== b) j++

			if (j >= end) return -1
		}

		j++
	}

	return -1
}

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
	for (let k = 0; k < text.length; k++) if (bytes[at + k] !== text.charCodeAt(k)) return false

	return true
}

// Past a comment, CDATA section, processing instruction or declaration starting at `i`, -1 when not complete.
function markupEnd(bytes: Uint8Array, i: number, end: number): number {
	const find = (text: string, from: number): number => {
		for (let k = from; k + text.length <= end; k++)
			if (bytes[k] === text.charCodeAt(0) && startsWith(bytes, k, text)) return k + text.length

		return -1
	}

	if (startsWith(bytes, i, "<!--")) return find("-->", i + 4)
	if (startsWith(bytes, i, "<![CDATA[")) return find("]]>", i + 9)
	if (bytes[i + 1] === QUESTION) return find("?>", i + 2)

	return tagEnd(bytes, i, end)
}

// The attributes of a start tag (its bytes, "<" to ">"), qualified name to decoded value, in order.
// One attribute of a start tag by its qualified name, without reading the others.
export function tagAttribute(tag: Uint8Array, name: string): string | undefined {
	let i = 1

	while (i < tag.length && !isSpace(tag[i]) && tag[i] !== SLASH && tag[i] !== GT) i++

	while (i < tag.length) {
		while (i < tag.length && isSpace(tag[i])) i++

		if (i >= tag.length || tag[i] === SLASH || tag[i] === GT) return undefined

		const nameStart = i

		while (i < tag.length && tag[i] !== EQUALS && !isSpace(tag[i])) i++

		let same = i - nameStart === name.length

		for (let k = 0; same && k < name.length; k++) same = tag[nameStart + k] === name.charCodeAt(k)

		while (i < tag.length && tag[i] !== QUOTE && tag[i] !== APOSTROPHE) i++

		const quote = tag[i]
		const valueStart = i + 1

		i = valueStart

		while (i < tag.length && tag[i] !== quote) i++

		if (same) return decodeCharacterData(tag, valueStart, i, true)

		i++
	}

	return undefined
}

export function tagAttributes(tag: Uint8Array): Map<string, string> {
	const out = new Map<string, string>()
	let i = 1

	while (i < tag.length && !isSpace(tag[i]) && tag[i] !== SLASH && tag[i] !== GT) i++

	while (i < tag.length) {
		while (i < tag.length && isSpace(tag[i])) i++

		if (i >= tag.length || tag[i] === SLASH || tag[i] === GT) break

		const nameStart = i

		while (i < tag.length && tag[i] !== EQUALS && !isSpace(tag[i])) i++

		const name = fromCharCodes(tag.subarray(nameStart, i))

		while (i < tag.length && tag[i] !== QUOTE && tag[i] !== APOSTROPHE) i++

		const quote = tag[i]
		const valueStart = i + 1

		i = valueStart

		while (i < tag.length && tag[i] !== quote) i++

		out.set(name, decodeCharacterData(tag, valueStart, i, true))
		i++
	}

	return out
}

// The qualified name of a tag (start or end), from its bytes.
export function tagName(tag: Uint8Array): string {
	let i = tag[1] === SLASH ? 2 : 1
	const start = i

	while (i < tag.length && !isSpace(tag[i]) && tag[i] !== SLASH && tag[i] !== GT) i++

	return fromCharCodes(tag.subarray(start, i))
}
