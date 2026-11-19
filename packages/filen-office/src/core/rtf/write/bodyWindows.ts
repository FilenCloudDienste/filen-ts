import type { OpcPackage, ZipEntry } from "../../opc/index"
import { parseXml, type XmlDocument } from "../../xml/index"
import { CHECKPOINT_SPACING, type Checkpoint, type RtfCheckpoints } from "../checkpoint"
import type { SourceBlock } from "../story"
import { commonHead, commonTail } from "./bytes"
import { RtfWriteRefusal, joinChunks, latin1Bytes } from "./out"
import { childNamed } from "./styles"
import type { RtfSource } from "./writer"

// The translated body against the edited one: where the edit changed it, and the windows of both a span is written
// and proved from (bodyWindows).

export const BODY_PART = "word/document.xml"
// How far past the bytes it changed a span is read before the whole file is.
export const SPAN_REACH = 4 * CHECKPOINT_SPACING

// A notes or comments part's root children by w:id (the first with each), found once per document: every note and
// comment is looked up by id on each preparation and proof.
const CHILDREN_BY_ID = new WeakMap<XmlDocument, Map<string, number>>()

// The container element of `container` in its part's document: the body, the header or footer root, the w:footnote,
// w:endnote or w:comment with its id.
export function containerElement(document: XmlDocument, container: { readonly part: string; readonly id: string }): number {
	const root = document.documentElement()

	if (container.part === "word/document.xml") {
		for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child))
			if (document.localName(child) === "body") return child

		return -1
	}

	if (container.id === "") return root

	let ids = CHILDREN_BY_ID.get(document)

	if (ids === undefined) {
		ids = new Map()

		for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
			const id = document.attribute(child, "w:id")

			if (id !== undefined && !ids.has(id)) ids.set(id, child)
		}

		CHILDREN_BY_ID.set(document, ids)
	}

	return ids.get(container.id) ?? -1
}

// The last checkpoint a span starting before `head` (the first byte written differently) may start from: its
// tokens end before the bytes the writing changed, and the tables were whole by then.
export function startingPoint(checkpoints: RtfCheckpoints, head: number): Checkpoint | undefined {
	const list = checkpoints.list
	let low = 0
	let high = list.length - 1
	let found: Checkpoint | undefined

	while (low <= high) {
		const middle = (low + high) >> 1
		const checkpoint = list[middle] as Checkpoint

		if (checkpoint.offset + 2 <= head) {
			found = checkpoint
			low = middle + 1
		} else high = middle - 1
	}

	for (let k = found === undefined ? -1 : list.indexOf(found); k >= 0; k--) {
		const checkpoint = list[k] as Checkpoint

		if (checkpoint.unplain <= checkpoints.tablesUntil) return undefined
		if (!checkpoint.end) return checkpoint
	}

	return undefined
}

export function hasSection(document: XmlDocument, paragraph: number): boolean {
	const pPr = childNamed(document, paragraph, "pPr")

	return pPr >= 0 && childNamed(document, pPr, "sectPr") >= 0
}

// The translation's body: where its content is, and each child element's bytes and kind.
export interface BodyIndex {
	readonly size: number
	readonly contentStart: number
	readonly contentEnd: number
	readonly starts: Int32Array
	readonly ends: Int32Array
	readonly kinds: Uint8Array
}

const Child = { Other: 0, Paragraph: 1, Break: 2, Table: 3, Section: 4 } as const

export function indexBody(document: XmlDocument, size: number): BodyIndex | undefined {
	const body = containerElement(document, { part: BODY_PART, id: "" })

	if (body < 0) return undefined

	let count = 0

	for (let child = document.firstChildElement(body); child >= 0; child = document.nextSiblingElement(child)) count++

	const starts = new Int32Array(count)
	const ends = new Int32Array(count)
	const kinds = new Uint8Array(count)
	let k = 0

	for (let child = document.firstChildElement(body); child >= 0; child = document.nextSiblingElement(child), k++) {
		const local = document.localName(child)

		starts[k] = document.start(child)
		ends[k] = document.end(child)
		kinds[k] =
			local === "p"
				? hasSection(document, child)
					? Child.Break
					: Child.Paragraph
				: local === "tbl"
					? Child.Table
					: local === "sectPr"
						? Child.Section
						: Child.Other
	}

	return {
		size,
		contentStart: document.contentStart(body),
		contentEnd: document.contentEnd(body),
		starts,
		ends,
		kinds
	}
}

export interface BodyWindows {
	readonly edited: XmlDocument
	readonly original: XmlDocument
}

// Where a change of the body lies among its children (BodyIndex), and what a span proving it reads (spanProof):
// from the checkpoint before the first block changed to SPAN_REACH source bytes past the last.
class BodyChange {
	private readonly blockOf: Int32Array
	private readonly index: BodyIndex
	private readonly blocks: readonly SourceBlock[]
	private readonly checkpoints: RtfCheckpoints

	private constructor(index: BodyIndex, blocks: readonly SourceBlock[], checkpoints: RtfCheckpoints) {
		this.index = index
		this.blocks = blocks
		this.checkpoints = checkpoints

		const { kinds } = index
		let count = 0

		this.blockOf = new Int32Array(kinds.length)

		for (let k = 0; k < kinds.length; k++) {
			const kind = kinds[k]

			this.blockOf[k] = kind === Child.Paragraph || kind === Child.Break || kind === Child.Table ? count++ : -1
		}

		if (count !== blocks.length) throw new RtfWriteRefusal("map", "the body's blocks are not the translation's")
	}

	static of(source: RtfSource, index: BodyIndex): BodyChange | undefined {
		const body = source.read.containers.find(container => container.kind === "body")
		const checkpoints = source.read.checkpoints

		if (body === undefined || checkpoints === undefined) return undefined

		try {
			return new BodyChange(index, body.blocks, checkpoints)
		} catch {
			return undefined
		}
	}

	// The source block nearest child `k` (looking back, or on): its start, or its end.
	private sourceOf(k: number, end: boolean): number {
		const count = this.blockOf.length

		for (let at = k; at >= 0 && at < count; at += end ? -1 : 1) {
			const block = this.blocks[this.blockOf[at] ?? -1]

			if (block !== undefined) return end ? block.end : block.from
		}

		return -1
	}

	// Whether a span from `from` can reach a state the source had past child `last`: only plain tokens between the
	// two in the source (see the reader's checkpoints).
	reaches(from: Checkpoint, last: number): boolean {
		const end = this.sourceOf(last, true)

		return this.checkpoints.list.some(checkpoint => checkpoint.offset >= end && checkpoint.unplain === from.unplain)
	}

	// The first child the window holds for a change from byte `head`, where the window starts, and the checkpoint a
	// span reads from.
	start(head: number): { readonly first: number; readonly from: number; readonly checkpoint: Checkpoint } | undefined {
		const { ends } = this.index
		// The first child ending past `head`.
		const first = firstAbove(ends, head)
		let at = first

		const checkpoint = startingPoint(this.checkpoints, this.sourceOf(first, false))

		if (checkpoint === undefined) return undefined

		while (at > 0 && !(this.blockOf[at - 1] !== -1 && (this.blockOf[at - 1] ?? 0) < checkpoint.blocks)) at--

		return { first: at, from: at === 0 ? this.index.contentStart : (ends[at - 1] ?? 0), checkpoint }
	}

	// The last child starting before `tailStart`.
	lastBefore(tailStart: number): number {
		return firstAbove(this.index.starts, tailStart - 1) - 1
	}

	// The last child the window holds for a change up to byte `tailStart`, and where the window ends.
	end(tailStart: number): { readonly last: number; readonly to: number } {
		const { starts, kinds } = this.index
		const count = starts.length
		let last = this.lastBefore(tailStart)

		const reach = this.sourceOf(last, true) + SPAN_REACH + CHECKPOINT_SPACING

		while (last < count - 1 && kinds[last + 1] !== Child.Section && this.sourceOf(last + 1, false) < reach) last++

		return { last, to: last === count - 1 ? this.index.contentEnd : (starts[last + 1] ?? 0) }
	}
}

// The first index whose value is past `value` in ascending `values` (their length when none is).
function firstAbove(values: Int32Array, value: number): number {
	let low = 0
	let high = values.length

	while (low < high) {
		const middle = (low + high) >> 1

		if ((values[middle] ?? 0) > value) high = middle
		else low = middle + 1
	}

	return low
}

// The body as edited and as translated, each parsed only where the edit changed it: the blocks it left as they
// were (the bytes around the change, alike in both) stand in as empty elements named by their index, so a block
// kept is still one alike in both. Undefined where the change reaches beyond the blocks.
export async function bodyWindows(source: RtfSource, edited: Uint8Array): Promise<BodyWindows | undefined> {
	const translation = source.translation
	const entry = translation.entry(BODY_PART)
	let index = source.body

	if (entry === undefined) return undefined

	if (index === undefined || index.size !== entry.uncompressedSize) {
		const original = await translation.read(BODY_PART)

		index = indexBody(parseXml(original), original.length)
		source.body = index

		const change = index === undefined ? undefined : BodyChange.of(source, index)

		if (index === undefined || change === undefined) return undefined

		const head = commonHead(original, edited)
		const tailStart = Math.max(
			original.length - commonTail(original, edited, original.length),
			head,
			head - (edited.length - original.length)
		)

		return windowsOf(index, change, edited, original.length, head, tailStart, (from, to) => original.subarray(from, to))
	}

	const change = BodyChange.of(source, index)

	if (change === undefined) return undefined

	const compared = await compareStreamed(translation, entry, edited, change)

	if (compared === undefined) return undefined

	return windowsOf(index, change, edited, index.size, compared.head, compared.tailStart, compared.slice)
}

// Bytes of the translated body kept before its first change is known: what a window may start back to.
const LOOKBACK = 4 * 1024 * 1024
// Bytes kept past a window's end while no later change shows (one that does past them leaves the edit to the
// whole document's writing).
const LOOKAHEAD = 4 * 1024 * 1024

// The translated body streamed against the edited one (never inflated whole): the bytes both start with, where the
// bytes both end with begin, and the translated bytes a window needs.
async function compareStreamed(
	translation: OpcPackage,
	entry: ZipEntry,
	edited: Uint8Array,
	change: BodyChange
): Promise<{ head: number; tailStart: number; slice: (from: number, to: number) => Uint8Array | undefined } | undefined> {
	const delta = edited.length - entry.uncompressedSize
	const ring = new Uint8Array(LOOKBACK)
	let offset = 0
	let head = -1
	let lastDiff = -1
	// Kept from `keptFrom` (once the head is known), in copies; none past `keptUntil` once frozen.
	const kept: Uint8Array[] = []
	let keptFrom = -1
	let keptEnd = -1
	let frozen = false
	let need = -1
	let lost = false

	try {
		for await (const chunk of translation.zip.stream(entry)) {
			const end = offset + chunk.length

			if (head < 0) {
				const shared = Math.max(0, Math.min(end, edited.length) - offset)
				const same = commonHead(chunk.subarray(0, shared), edited.subarray(offset, offset + shared))

				if (same < chunk.length) {
					head = offset + same

					const start = change.start(head)

					if (start === undefined || start.from < Math.max(0, offset - LOOKBACK)) return undefined

					keptFrom = start.from
					keptEnd = Math.max(offset, keptFrom)

					// What the ring holds of [from, offset).
					if (keptFrom < offset) {
						const out = new Uint8Array(offset - keptFrom)

						for (let at = keptFrom; at < offset; at++) out[at - keptFrom] = ring[at % LOOKBACK] ?? 0

						kept.push(out)
					}
				}
			}

			// The last byte that differs where the edited body would line up with this one at its end.
			const valid = Math.max(offset, -delta)

			if (valid > offset) lastDiff = Math.max(lastDiff, Math.min(valid, end) - 1)

			if (valid < end) {
				const tail = commonTail(chunk.subarray(valid - offset), edited.subarray(valid + delta, end + delta), end - valid)

				if (tail < end - valid) {
					lastDiff = Math.max(lastDiff, end - 1 - tail)

					if (frozen && end - 1 - tail >= keptEnd) lost = true

					need = -1
				}
			}

			if (head < 0) {
				for (let at = 0; at < chunk.length;) {
					const position = (offset + at) % LOOKBACK
					const length = Math.min(chunk.length - at, LOOKBACK - position)

					ring.set(chunk.subarray(at, at + length), position)
					at += length
				}
			} else if (!frozen) {
				kept.push(chunk.slice(Math.max(0, keptFrom - offset)))
				keptEnd = end

				if (need < 0) need = change.end(Math.max(lastDiff + 1, head, head - delta)).to

				if (end > need + LOOKAHEAD) frozen = true
			}

			offset = end
		}
	} catch {
		return undefined
	}

	if (lost) return undefined
	if (head < 0) head = Math.min(offset, edited.length)

	const tailStart = Math.max(lastDiff + 1, head, head - delta)
	const bytes = joinChunks(kept)

	return {
		head,
		tailStart,
		slice: (from, to) => (from < keptFrom || to > keptEnd ? undefined : bytes.subarray(from - keptFrom, to - keptFrom))
	}
}

// The two windows of a change [head, tailStart) of the translated body (`size` bytes); `slice` gives its bytes.
function windowsOf(
	index: BodyIndex,
	change: BodyChange,
	edited: Uint8Array,
	size: number,
	head: number,
	tailStart: number,
	slice: (from: number, to: number) => Uint8Array | undefined
): BodyWindows | undefined {
	const start = change.start(head)

	if (start === undefined) return undefined

	const { first, from } = start
	const { last, to } = change.end(tailStart)

	if (!change.reaches(start.checkpoint, Math.min(last, change.lastBefore(tailStart)))) return undefined
	const { starts, ends, kinds } = index
	const count = starts.length
	const delta = edited.length - size

	if (first > last || from > head || to < tailStart) return undefined

	for (let k = first; k <= last; k++) if (kinds[k] === Child.Section) return undefined

	const middle = slice(from, to)

	if (middle === undefined) return undefined

	// Outside the window the edited bytes are the translated ones (shifted by `delta` past it).
	const held = (start: number, end: number, shift: number): Uint8Array[] => {
		const out: Uint8Array[] = []
		let text = ""

		for (let k = start; k < end; k++) {
			switch (kinds[k]) {
				case Child.Paragraph:
					text += `<w:p w:held="${k}"/>`
					break
				case Child.Break:
					text += `<w:p w:held="${k}"><w:pPr><w:sectPr/></w:pPr></w:p>`
					break
				case Child.Table:
					text += `<w:tbl w:held="${k}"/>`
					break
				case Child.Section:
					out.push(latin1Bytes(text), edited.subarray((starts[k] ?? 0) + shift, (ends[k] ?? 0) + shift))
					text = ""
					break
				default:
					break
			}
		}

		out.push(latin1Bytes(text))

		return out
	}
	const before = held(0, first, 0)
	const after = held(last + 1, count, delta)
	const window = (bytes: Uint8Array): XmlDocument =>
		parseXml(
			joinChunks([edited.subarray(0, index.contentStart), ...before, bytes, ...after, edited.subarray(index.contentEnd + delta)])
		)

	return { edited: window(edited.subarray(from, to + delta)), original: window(middle) }
}
