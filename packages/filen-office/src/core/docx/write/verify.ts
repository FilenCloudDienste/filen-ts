import { zipSync } from "fflate"
import type { Mark, Node } from "prosemirror-model"
import {
	bytesSource,
	parseContentTypes,
	parseRelationships,
	partKey,
	relationshipsPartName,
	sliceClock,
	BytePieces,
	joinBytes,
	type ContentTypes,
	type PartBytes,
	type Relationships,
	type SliceClock,
	type Slicing
} from "../../opc/index"
import {
	NodeKind,
	XmlError,
	assertWellFormed,
	assertWellFormedSliced,
	decodeUtf8,
	encodeUtf8,
	parseXml,
	parseXmlSliced,
	type XmlDocument
} from "../../xml/index"
import { runSliced } from "../../slicing"
import { DocxDocBuilder } from "../edit/build"
import { openDocxEditContext, type DocxEditContext } from "../edit/context"
import { docxSchema } from "../edit/schema"
import { Item, buildDocxModel, type StoryPart } from "../model/index"
import { partReader } from "../model/reader"
import { Ns } from "../model/namespaces"
import { drawingSignature } from "../objects/edit"
import { mathSignature } from "./atoms/math"
import { parseNumbering, type Numbering } from "../numbering/index"
import { openDocxPackage, type DocxPackage } from "../package"
import { PropsStore } from "../props/index"
import { parseStyles, type DocxStyles } from "../styles/index"
import { equalBytes, sameBytes } from "./bytes"
import { canonicalElement, canonicalFragment } from "./canonical"
import { DOCX_CHECKS, checkDone, checkPart, type CheckInput, type DocxCheck, type DocxFact } from "./checks/index"
import { DocxVerifyError, type VerifyFailure } from "./failure"
import { isInsertionPoint } from "./newStory"
import { writtenJustification } from "./paragraph"

export { DocxVerifyError, type VerifyFailure } from "./failure"
import type { DocxChanges, StoryChange } from "./save"
import { cellWithin, inCell, originalBlock, sectionWritten, type StoryOutput } from "./story"
import { writtenLinkTarget } from "../edit/commands/insert"

// Gate 2: the written file is checked before it may be uploaded, in two halves.
// Parts (before the zip is written): every changed part well-formed with declared prefixes, every new part
// typed, every relationship id new markup uses defined, no id space gaining a duplicate, no style or list
// reference newly dangling, list definitions with unique ids, container copies keeping their properties,
// and the rebuilt paragraphs reading back as the editor holds them. A rewritten story is checked by what is
// new in it: copies of whole source nodes stand in as placeholders, their facts carried over from the
// source, so a one-word edit in a 1,000-page document parses a few kilobytes. The copies are not taken on
// the writer's word: each must be byte for byte the whole source nodes it claims, and the story's
// paragraphs, copied and rewritten, must be the editor's, one for one and in order.
// Zip (after): every untouched entry the original compressed bytes, every changed entry the CRC of its
// planned bytes, nothing more and nothing less.

const W_URIS = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]
const R_URIS = [
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	"http://purl.oclc.org/ooxml/officeDocument/relationships"
]
// Elements whose w:id must be unique, per kind.
const REVISION_ELEMENTS = new Set([
	"ins",
	"del",
	"moveFrom",
	"moveTo",
	"rPrChange",
	"pPrChange",
	"sectPrChange",
	"tblPrChange",
	"trPrChange",
	"tcPrChange",
	"tblGridChange",
	"tblPrExChange",
	"numberingChange",
	"cellIns",
	"cellDel",
	"cellMerge",
	"moveFromRangeStart",
	"moveToRangeStart"
])
const PLACEHOLDER = encodeUtf8("<_/>")
const STYLES_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"

// Whether a part typed `type` is XML (a picture is not, an SVG picture included: it is checked as media).
function isXmlType(type: string | undefined): boolean {
	return type === undefined || (!type.toLowerCase().startsWith("image/") && /[/+]xml$/i.test(type))
}
const NUMBERING_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"

function fail(reason: VerifyFailure, message: string): never {
	throw new DocxVerifyError(reason, message)
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// ---- facts ------------------------------------------------------------------------------------------------

interface Facts {
	// Ids per id space, counted: paragraph ids, bookmarks, comment anchors, revisions, drawing ids.
	readonly ids: Map<string, number>
	// Style and list references, counted.
	readonly styles: Map<string, number>
	readonly lists: Map<number, number>
}

function emptyFacts(): Facts {
	return { ids: new Map(), styles: new Map(), lists: new Map() }
}

function bump<K>(map: Map<K, number>, key: K, by: number): void {
	const count = (map.get(key) ?? 0) + by

	if (count === 0) map.delete(key)
	else map.set(key, count)
}

function addFacts(into: Facts, from: Facts, sign: number): void {
	for (const [key, count] of from.ids) bump(into.ids, key, sign * count)
	for (const [key, count] of from.styles) bump(into.styles, key, sign * count)
	for (const [key, count] of from.lists) bump(into.lists, key, sign * count)
}

// Ids the checks add to the facts (DocxCheck.fact), by the WordprocessingML child of a part's root they look
// at.
type FactHooks = ReadonlyMap<string, readonly DocxFact[]>

// Facts of the elements starting in nodes [first, end) of a part.
function collectFacts(document: XmlDocument, first: number, end: number, into: Facts, sign: number, hooks: FactHooks): void {
	const reader = partReader(document)
	const root = document.documentElement()

	for (let node = first; node < end; node++) {
		if (document.kinds[node] !== NodeKind.Element) continue

		const group = reader.group(node)

		if (group === Ns.WP) {
			if (document.localName(node) === "docPr") {
				const id = reader.attr(node, Ns.None, "id")

				if (id !== undefined) bump(into.ids, `docPr:${id}`, sign)
			}

			continue
		}

		if (group !== Ns.W) continue

		const local = document.localName(node)

		const facts = hooks.size === 0 || document.parent(node) !== root ? undefined : hooks.get(local)

		if (facts !== undefined) {
			for (const fact of facts) {
				const id = fact.id(reader, node)

				if (id !== undefined) bump(into.ids, id, sign)
			}
		}

		switch (local) {
			case "p":
			case "tr": {
				const paraId = reader.attr(node, Ns.W14, "paraId")

				if (paraId !== undefined) bump(into.ids, `paraId:${paraId.toUpperCase()}`, sign)

				break
			}
			case "bookmarkStart":
			case "commentRangeStart":
			case "commentReference":
			case "comment":
			case "footnote":
			case "endnote":
			case "footnoteReference":
			case "endnoteReference": {
				const id = reader.attr(node, Ns.W, "id")

				if (id !== undefined) bump(into.ids, `${local}:${id}`, sign)

				break
			}
			case "pStyle":
			case "rStyle":
			case "tblStyle": {
				const value = reader.attr(node, Ns.W, "val")

				if (value !== undefined) bump(into.styles, value, sign)

				break
			}
			case "numId": {
				const value = Number(reader.attr(node, Ns.W, "val"))

				if (Number.isInteger(value) && value > 0) bump(into.lists, value, sign)

				break
			}
			default:
				if (REVISION_ELEMENTS.has(local)) {
					const id = reader.attr(node, Ns.W, "id")

					if (id !== undefined) bump(into.ids, `revision:${id}`, sign)
				}
		}
	}
}

// Nodes looked at between checks of the clock, and start tags searched.
const NODE_STEP = 2048
// Nodes whose facts are collected between looks at the clock (a node's facts cost more than a look at it).
const FACT_STEP = 512
// Positions of a block walked in one go (a longer one is walked child by child).
const LONG_BLOCK = 16384
const TAG_STEP = 4096
// Paragraphs compared between looks at the clock.
const PARAGRAPH_STEP = 256

// How a check collects facts: the checks' own ids, with caches of the source's facts when they are the
// registry's.
interface FactScope {
	readonly hooks: FactHooks
	readonly cached: boolean
	readonly clock: SliceClock | undefined
}

// collectFacts in steps, a turn given between them when the clock says so.
async function collectFactsSliced(
	document: XmlDocument,
	first: number,
	end: number,
	into: Facts,
	sign: number,
	scope: FactScope
): Promise<void> {
	const clock = scope.clock

	if (clock === undefined) {
		collectFacts(document, first, end, into, sign, scope.hooks)

		return
	}

	for (let from = first; from < end; from += FACT_STEP) {
		collectFacts(document, from, Math.min(end, from + FACT_STEP), into, sign, scope.hooks)

		if (clock.due) await clock.pause()
	}
}

// A source part's facts are read once per document (saves repeat).
const factsCache = new WeakMap<XmlDocument, Facts>()

async function partFacts(document: XmlDocument, scope: FactScope): Promise<Facts> {
	let facts = scope.cached ? factsCache.get(document) : undefined

	if (facts === undefined) {
		facts = emptyFacts()
		await collectFactsSliced(document, 0, document.count, facts, 1, scope)

		if (scope.cached) factsCache.set(document, facts)
	}

	return facts
}

// The source's facts, read only by key: ids in a sorted table (one string of the keys, their offsets and counts)
// rather than a map, an entry and a key string each (a long document has hundreds of thousands).
interface SourceFacts {
	readonly ids: { get(key: string): number | undefined }
	readonly styles: ReadonlyMap<string, number>
	readonly lists: ReadonlyMap<number, number>
}

// `keys` sorted by UTF-16 code units, a merge sort that yields between runs of SORT_STEP keys (a long
// document's hundreds of thousands of ids would take one long task to sort at once).
function* sortedKeys(keys: string[]): Generator<void, string[]> {
	const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
	const n = keys.length
	let from = keys

	for (let lo = 0; lo < n; lo += SORT_STEP) {
		const run = from.slice(lo, lo + SORT_STEP).sort(order)

		for (let k = 0; k < run.length; k++) from[lo + k] = run[k] as string

		yield
	}

	let to: string[] = new Array<string>(n)
	let moved = 0

	for (let width = SORT_STEP; width < n; width *= 2) {
		for (let lo = 0; lo < n; lo += 2 * width) {
			const mid = Math.min(lo + width, n)
			const hi = Math.min(lo + 2 * width, n)
			let a = lo
			let b = mid

			for (let k = lo; k < hi; k++) {
				to[k] = b >= hi || (a < mid && (from[a] as string) <= (from[b] as string)) ? (from[a++] as string) : (from[b++] as string)

				if (++moved % SORT_STEP === 0) yield
			}
		}

		const swap = from

		from = to
		to = swap
	}

	return from
}

const SORT_STEP = 8192

class SortedCounts {
	private readonly keys: string
	// Key k is keys.slice(starts[k], starts[k + 1]).
	private readonly starts: Int32Array
	private readonly counts: Int32Array

	// `sorted`: the map's keys in order (sortedKeys).
	constructor(map: ReadonlyMap<string, number>, sorted: readonly string[]) {
		this.starts = new Int32Array(sorted.length + 1)
		this.counts = new Int32Array(sorted.length)

		let at = 0

		sorted.forEach((key, k) => {
			this.starts[k] = at
			this.counts[k] = map.get(key) ?? 0
			at += key.length
		})
		this.starts[sorted.length] = at
		this.keys = sorted.join("")
	}

	get(key: string): number | undefined {
		let low = 0
		let high = this.counts.length - 1

		while (low <= high) {
			const middle = (low + high) >> 1
			const order = this.compare(middle, key)

			if (order === 0) return this.counts[middle]
			if (order < 0) low = middle + 1
			else high = middle - 1
		}

		return undefined
	}

	// Key k against `key`, as the sort orders them (by UTF-16 code units).
	private compare(k: number, key: string): number {
		const start = this.starts[k] ?? 0
		const length = (this.starts[k + 1] ?? 0) - start
		const shared = Math.min(length, key.length)

		for (let i = 0; i < shared; i++) {
			const difference = this.keys.charCodeAt(start + i) - key.charCodeAt(i)

			if (difference !== 0) return difference
		}

		return length - key.length
	}
}

// The facts of every story part of a model, read once (each save needs them: hundreds of milliseconds on a
// long document).
const modelCache = new WeakMap<object, SourceFacts>()

async function modelFacts(model: { readonly parts: readonly StoryPart[] }, scope: FactScope): Promise<SourceFacts> {
	let facts = scope.cached ? modelCache.get(model) : undefined

	if (facts === undefined) {
		const collected = emptyFacts()

		for (const part of model.parts) await collectFactsSliced(part.document, 0, part.document.count, collected, 1, scope)

		const sorted = await runSliced(sortedKeys([...collected.ids.keys()]), scope.clock)

		facts = { ids: new SortedCounts(collected.ids, sorted), styles: collected.styles, lists: collected.lists }

		if (scope.cached) modelCache.set(model, facts)
	}

	return facts
}

// The first node starting at or after byte `offset`.
function nodeAt(document: XmlDocument, offset: number): number {
	const starts = document.starts
	let low = 0
	let high = document.count

	while (low < high) {
		const middle = (low + high) >> 1

		if ((starts[middle] ?? 0) < offset) low = middle + 1
		else high = middle
	}

	return low
}

function rangeFacts(document: XmlDocument, from: number, to: number, into: Facts, sign: number, scope: FactScope): Promise<void> {
	return collectFactsSliced(document, nodeAt(document, from), nodeAt(document, to), into, sign, scope)
}

// Takes out of `into` the facts of the source container [from, to) that its output does not copy: the gaps
// between the copied source ranges, plus once more each range copied again.
async function replacedFacts(
	document: XmlDocument,
	from: number,
	to: number,
	trusted: readonly number[],
	into: Facts,
	scope: FactScope
): Promise<void> {
	const ranges: [number, number][] = []

	for (let k = 0; k < trusted.length; k += 4) ranges.push([trusted[k + 2] ?? 0, trusted[k + 3] ?? 0])

	ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])

	let at = from

	for (const [start, end] of ranges) {
		if (start < at) {
			// Copied before: it counts once more.
			await rangeFacts(document, start, end, into, 1, scope)

			continue
		}

		await rangeFacts(document, at, start, into, -1, scope)
		at = end
	}

	await rangeFacts(document, at, to, into, -1, scope)
}

// ---- relationships ------------------------------------------------------------------------------------------

// Relationship ids `document` uses in attributes of the relationships namespace that `relationships` does
// not define.
async function danglingRelationships(
	relationships: Relationships,
	document: XmlDocument,
	clock: SliceClock | undefined
): Promise<string[]> {
	const out: string[] = []

	await eachRelationshipUse(document, clock, (_node, id) => {
		if (relationships.byId(id) === undefined) out.push(id)
	})

	return out
}

// Calls `visit` with each element of `document` and the relationship id of each attribute of the relationships
// namespace it has (the value decoded). Start tags are searched for the bound prefixes first; only the few that
// hold one have their attributes read.
async function eachRelationshipUse(
	document: XmlDocument,
	clock: SliceClock | undefined,
	visit: (node: number, id: string) => void
): Promise<void> {
	const reader = partReader(document)
	const prefixes: Uint8Array[] = []

	for (const bindings of reader.namespaces.declarations().values()) {
		for (const [prefix, uri] of bindings) {
			if (prefix !== "" && R_URIS.includes(uri)) prefixes.push(encodeUtf8(`${prefix}:`))
		}
	}

	if (prefixes.length === 0) return

	const bytes = document.bytes

	for (let node = 0; node < document.count; node++) {
		if (clock !== undefined && (node & (TAG_STEP - 1)) === 0 && clock.due) await clock.pause()
		if (document.kinds[node] !== NodeKind.Element) continue

		const start = document.start(node)
		const end = document.openEnd(node)
		let found = false

		for (let i = start + 1; i < end && !found; i++) {
			if (bytes[i] !== 32 && bytes[i] !== 9 && bytes[i] !== 10 && bytes[i] !== 13) continue

			for (const prefix of prefixes) {
				let match = true

				for (let k = 0; k < prefix.length && match; k++) match = bytes[i + 1 + k] === prefix[k]

				if (match) found = true
			}
		}

		if (!found) continue

		for (const attribute of document.attributes(node)) {
			const colon = attribute.name.indexOf(":")
			const prefix = colon < 0 ? "" : attribute.name.slice(0, colon)

			if (prefix !== "" && R_URIS.includes(reader.namespaces.uri(node, prefix) ?? "")) visit(node, attribute.value)
		}
	}
}

// A relationship the save removed (the source defined it, the new relationships do not) that the source content
// the new part keeps as it was still uses: `rewritten` are the source ranges the save wrote anew, `copied` the
// source ranges their new content copies.
async function checkRemovedRelationships(
	name: string,
	source: XmlDocument,
	sourceRelationships: Relationships,
	relationships: Relationships,
	rewritten: readonly (readonly [number, number])[],
	copied: readonly (readonly [number, number])[],
	clock: SliceClock | undefined
): Promise<void> {
	const removed = new Set(
		sourceRelationships.all.filter(relationship => relationships.byId(relationship.id) === undefined).map(r => r.id)
	)

	if (removed.size === 0) return

	const within = (ranges: readonly (readonly [number, number])[], pos: number): boolean =>
		ranges.some(([from, to]) => pos >= from && pos < to)

	await eachRelationshipUse(source, clock, (node, id) => {
		if (!removed.has(id)) return

		const pos = source.start(node)

		if (!within(rewritten, pos) || within(copied, pos)) fail("relationship", `${name}: relationship ${id} is removed but still used`)
	})
}

// ---- parts --------------------------------------------------------------------------------------------------

// Every namespace declared on the root: copies keep their meaning wherever they go in the part.
function flat(document: XmlDocument): boolean {
	const root = document.documentElement()

	for (const node of partReader(document).namespaces.declarations().keys()) if (node !== root) return false

	return true
}

// The root's tags; `open` is the start tag as written where the save declared more namespaces on it.
function rootTags(document: XmlDocument, open: string | undefined): { open: Uint8Array; close: Uint8Array } {
	const root = document.documentElement()

	return {
		open: open === undefined ? document.bytes.subarray(document.start(root), document.openEnd(root)) : encodeUtf8(open),
		close: encodeUtf8(`</${document.name(root)}>`)
	}
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
	let size = 0

	for (const chunk of chunks) size += chunk.length

	const out = new Uint8Array(size)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

// The new markup of rewritten stories, each source copy replaced by a placeholder, inside the part's root.
async function skeleton(
	document: XmlDocument,
	root: string | undefined,
	outputs: readonly StoryOutput[],
	clock: SliceClock | undefined
): Promise<Uint8Array> {
	const { open, close } = rootTags(document, root)
	const chunks: Uint8Array[] = [open]

	for (const output of outputs) {
		const bytes = output.bytes
		// The output's contiguous shares, in order, walked once alongside the copies (no lookup per copy).
		const shares: Uint8Array[] = []
		const starts: number[] = []

		if (bytes instanceof Uint8Array) {
			shares.push(bytes)
			starts.push(0)
		} else {
			for (let from = 0; from < bytes.length; from += COMPARE_PIECE) {
				bytes.visit(from, Math.min(COMPARE_PIECE, bytes.length - from), (piece, pieceFrom, count, at) => {
					shares.push(piece.subarray(pieceFrom, pieceFrom + count))
					starts.push(from + at)

					return true
				})

				if (clock?.due === true) await clock.pause()
			}
		}

		let share = 0
		// Bytes [from, to) of the output, as views of its shares.
		const take = (from: number, to: number): void => {
			while (share < shares.length && (starts[share] ?? 0) + (shares[share]?.length ?? 0) <= from) share++

			for (let index = share; index < shares.length && (starts[index] ?? 0) < to; index++) {
				const start = starts[index] ?? 0
				const piece = shares[index] as Uint8Array

				chunks.push(piece.subarray(Math.max(0, from - start), Math.min(piece.length, to - start)))
			}
		}
		let at = 0

		for (let k = 0; k < output.trusted.length; k += 4) {
			const from = output.trusted[k] ?? 0

			take(at, from)
			chunks.push(PLACEHOLDER)
			at = output.trusted[k + 1] ?? from

			if (clock !== undefined && k % (4 * NODE_STEP) === 0 && clock.due) await clock.pause()
		}

		take(at, bytes.length)
	}

	chunks.push(close)

	return clock === undefined ? join(chunks) : joinSliced(chunks, clock)
}

// join() a step at a time.
async function joinSliced(chunks: readonly Uint8Array[], clock: SliceClock): Promise<Uint8Array> {
	let size = 0

	for (const chunk of chunks) size += chunk.length

	const out = new Uint8Array(size)
	let at = 0

	for (let index = 0; index < chunks.length; index++) {
		const chunk = chunks[index] as Uint8Array

		out.set(chunk, at)
		at += chunk.length

		if (index % 4096 === 4095 && clock.due) await clock.pause()
	}

	return out
}

function parseChecked(name: string, bytes: Uint8Array): XmlDocument {
	try {
		const document = parseXml(bytes)

		assertWellFormed(document)

		return document
	} catch (error) {
		return fail("malformedPart", `${name}: ${describe(error)}`)
	}
}

async function parseCheckedSliced(name: string, bytes: Uint8Array, clock: SliceClock | undefined): Promise<XmlDocument> {
	if (clock === undefined) return parseChecked(name, bytes)

	// The save's own clock throughout (the parse continues its slice); only the parser's own errors are a
	// malformed part, a pause that rejects (the save was abandoned) passes through.
	try {
		const document = await parseXmlSliced(bytes, clock)

		await assertWellFormedSliced(document, clock)

		return document
	} catch (error) {
		if (error instanceof XmlError) return fail("malformedPart", `${name}: ${describe(error)}`)

		throw error
	}
}

export interface VerifyPartsInput {
	readonly original: DocxPackage
	readonly context: DocxEditContext
	readonly changes: DocxChanges
	// The features' checks (default: the registry, see checks/index.ts).
	readonly checks?: readonly DocxCheck[]
}

const FACT_HOOKS: FactHooks = factHooks(DOCX_CHECKS)

function factHooks(checks: readonly DocxCheck[]): FactHooks {
	const hooks = new Map<string, DocxFact[]>()

	for (const check of checks) {
		const fact = check.fact

		if (fact === undefined) continue

		for (const local of fact.elements) {
			const list = hooks.get(local)

			if (list === undefined) hooks.set(local, [fact])
			else list.push(fact)
		}
	}

	return hooks
}

// The source bytes a rewritten story replaced: its container, or none where a new container went in.
// `inPackage`: whether the original package has the part.
function storyRange(name: string, part: StoryPart, story: StoryChange, inPackage: boolean): { readonly from: number; readonly to: number } {
	const document = part.document
	const item = story.session.story.story.item

	// A copied note is a story of a part of its own written into its notes part as a new one.
	if (item >= 0 && story.session.story.part === part) {
		const container = part.node(item)

		return { from: document.start(container), to: document.end(container) }
	}

	const range = story.range
	const root = document.documentElement()

	if (range === undefined) return fail("content", `${name}: a new story has no place in its part`)

	// Inserted between elements, or the root of a part the save creates (a header).
	const placed =
		range.from === range.to
			? isInsertionPoint(document, range.from)
			: !inPackage && range.from === document.start(root) && range.to === document.end(root)

	if (!placed) fail("content", `${name}: a new story is not between elements of its part`)

	return range
}

// In slices with `slicing` (a pause that rejects abandons the check with that error).
export async function verifyDocxParts(input: VerifyPartsInput, slicing?: Slicing): Promise<void> {
	const { original, context, changes } = input
	const clock = slicing === undefined ? undefined : sliceClock(slicing)
	const checks = input.checks ?? DOCX_CHECKS
	const scope: FactScope =
		checks === DOCX_CHECKS ? { hooks: FACT_HOOKS, cached: true, clock } : { hooks: factHooks(checks), cached: false, clock }
	const model = context.model
	const changed = [...changes.replace, ...changes.add]
	const byKey = new Map(changed.map(change => [partKey(change.name), change]))
	const removedParts = new Set((changes.remove ?? []).map(partKey))
	const typesChange = byKey.get(partKey("[Content_Types].xml"))
	const originalTypes = await original.opc.contentTypes()
	let types: ContentTypes = originalTypes

	if (typesChange !== undefined) {
		const typesBytes = await joinBytes(typesChange.bytes)

		parseChecked(typesChange.name, typesBytes)
		types = parseContentTypes(typesBytes)

		for (const entry of original.opc.zip.entries) {
			if (removedParts.has(partKey(entry.name))) continue

			const was = originalTypes.typeOf(entry.name)

			if (was !== undefined && types.typeOf(entry.name) !== was) fail("contentType", `${entry.name} is no longer typed ${was}`)
		}
	}

	for (const change of changes.replace) {
		if (!original.has(change.name) && partKey(change.name) !== partKey("[Content_Types].xml"))
			fail("invalidPackage", `${change.name} is replaced but not in the package`)
	}

	for (const change of changes.add) {
		if (original.has(change.name)) fail("invalidPackage", `${change.name} is added but already in the package`)
		if (types.typeOf(change.name) === undefined) fail("contentType", `${change.name} has no content type`)
	}

	if (byKey.size !== changed.length) fail("invalidPackage", "A part is written twice")

	const relationshipsOf = async (part: string): Promise<Relationships> => {
		const rels = byKey.get(partKey(relationshipsPartName(part)))

		return rels === undefined ? original.relationships(part) : parseRelationships(await joinBytes(rels.bytes), part)
	}
	const exists = (part: string): boolean => (original.has(part) && !removedParts.has(partKey(part))) || byKey.has(partKey(part))

	// A removed part is one of the package's that nothing relates to any more.
	if (removedParts.size > 0) {
		for (const key of removedParts) {
			const owner = /^(.*?)_rels\/([^/]*)\.rels$/.exec(key)

			if (!original.has(key) || byKey.has(key)) fail("invalidPackage", `${key} is removed but not an unwritten part of the package`)
			if (key === partKey("[Content_Types].xml")) fail("invalidPackage", "The content types are removed")
			// Relationships go only with their part.
			if (owner !== null && !removedParts.has(partKey(`${owner[1] ?? ""}${owner[2] ?? ""}`)))
				fail("relationship", `${key}: the relationships of a part kept are removed`)
			if (byKey.has(partKey(relationshipsPartName(key)))) fail("relationship", `${key}: a removed part's relationships are written`)
		}

		for (const entry of original.opc.zip.entries) {
			const match = /^(.*?)_rels\/([^/]*)\.rels$/.exec(entry.name)
			const key = partKey(entry.name)

			if (match === null || removedParts.has(key) || byKey.has(key)) continue

			const source = `${match[1] ?? ""}${match[2] ?? ""}`

			if (removedParts.has(partKey(source))) fail("relationship", `${entry.name}: its part is removed`)

			for (const relationship of (await original.relationships(source)).all) {
				if (!relationship.external && relationship.partName !== undefined && !exists(relationship.partName))
					fail("relationship", `${entry.name}: ${relationship.id} points at a removed part`)
			}
		}
	}
	const storyParts = new Map<string, StoryPart>(model.parts.map(part => [partKey(part.name), part]))
	const storiesByPart = new Map<string, StoryChange[]>()
	const cutsByPart = new Map<string, { from: number; to: number }[]>()
	const added = new Set(changes.add.map(change => partKey(change.name)))

	for (const cut of changes.removed) {
		const key = partKey(cut.part.name)
		const document = cut.part.document
		const node = nodeAt(document, cut.from)

		// A whole child of the root.
		if (
			storyParts.get(key) !== cut.part ||
			node >= document.count ||
			document.start(node) !== cut.from ||
			document.end(node) !== cut.to ||
			document.parent(node) !== document.documentElement()
		)
			fail("content", `${cut.part.name}: a removed story is not a container of its part`)

		const list = cutsByPart.get(key)

		if (list === undefined) cutsByPart.set(key, [{ from: cut.from, to: cut.to }])
		else list.push({ from: cut.from, to: cut.to })
	}

	for (const story of changes.stories) {
		const key = partKey(story.part.name)
		const part = storyParts.get(key)

		// A part the save creates holds its stories; any other story is on its package part.
		if (part === undefined && added.has(key)) storyParts.set(key, story.part)
		else if (part !== story.part) fail("content", `${story.part.name}: a story is not on its part`)

		const list = storiesByPart.get(key)

		if (list === undefined) storiesByPart.set(key, [story])
		else list.push(story)
	}

	for (const part of changes.roots.keys())
		if (!storiesByPart.has(partKey(part.name))) fail("content", `${part.name}: its root is written anew but none of its stories is`)

	const rewritten: Rewritten[] = []

	// Facts of every story part: the source's, adjusted below for what changed.
	const before = await modelFacts(model, scope)
	// What the changes add (positive) and take away (negative).
	const after = emptyFacts()

	const checkInput: CheckInput = {
		original,
		context,
		changes,
		types,
		clock,
		relationshipsOf,
		exists,
		ids: key => (before.ids.get(key) ?? 0) + (after.ids.get(key) ?? 0),
		source: key => before.ids.get(key) ?? 0,
		added(space) {
			const out: string[] = []

			for (const [key, change] of after.ids) if (change > 0 && key.startsWith(`${space}:`)) out.push(key.slice(space.length + 1))

			return out
		}
	}
	let stylesDocument: XmlDocument | undefined
	let numberingDocument: XmlDocument | undefined
	let numberingName: string | undefined

	for (const change of changed) {
		const key = partKey(change.name)
		const name = change.name

		if (key === partKey("[Content_Types].xml")) continue

		// Media (a new picture's bytes) are not XML: their checks look at them (checks/drawings.ts).
		if (!isXmlType(types.typeOf(name))) continue

		if (name.endsWith(".rels")) {
			const relsBytes = await joinBytes(change.bytes)

			parseChecked(name, relsBytes)

			const source = name.replace(/_rels\/([^/]+)\.rels$/, "$1")
			const relationships = parseRelationships(relsBytes, source)

			for (const relationship of relationships.all) {
				if (!relationship.external && relationship.partName !== undefined && !exists(relationship.partName)) {
					fail("relationship", `${name}: ${relationship.id} points at a missing part`)
				}
			}

			continue
		}

		const part = storyParts.get(key)
		const stories = storiesByPart.get(key)
		const cuts = cutsByPart.get(key) ?? []
		const outputs = stories?.map(story => story.output)
		const root = part === undefined ? undefined : changes.roots.get(part)
		let skeletonDocument: XmlDocument | undefined

		if (part !== undefined && (stories !== undefined || cuts.length > 0))
			await checkAssembly(name, part, stories ?? [], cuts, root, change.bytes, original.has(name), clock)

		if (part !== undefined && stories !== undefined && outputs !== undefined) {
			skeletonDocument = await parseCheckedSliced(name, await skeleton(part.document, root, outputs, clock), clock)
			await checkParagraphs(name, part, stories, skeletonDocument, rewritten, clock)
		}

		if (part !== undefined && outputs !== undefined && skeletonDocument !== undefined && flat(part.document) && original.has(name)) {
			// The new markup of the rewritten stories; the rest of the part is the source's.
			const document = skeletonDocument
			const relationships = await relationshipsOf(name)

			addFacts(after, await partFacts(document, scope), 1)

			for (const story of changes.stories) {
				if (story.part !== part) continue

				const { from, to } = storyRange(name, part, story, true)

				await replacedFacts(part.document, from, to, story.output.trusted, after, scope)

				checkContainers(part, root, story.output)
			}

			for (const cut of cuts) await replacedFacts(part.document, cut.from, cut.to, [], after, scope)

			if (clock?.due === true) await clock.pause()

			await checkRelationships(
				name,
				await danglingRelationships(relationships, document, clock),
				await original.relationships(name),
				part.document,
				clock
			)

			// The source the new part keeps is trusted as it was: no relationship it uses may have gone.
			const rewritten: [number, number][] = cuts.map(cut => [cut.from, cut.to])
			const copied: [number, number][] = []

			for (const story of changes.stories) {
				if (story.part !== part) continue

				const { from, to } = storyRange(name, part, story, true)
				const trusted = story.output.trusted

				rewritten.push([from, to])

				for (let k = 0; k < trusted.length; k += 4) copied.push([trusted[k + 2] ?? 0, trusted[k + 3] ?? 0])
			}

			await checkRemovedRelationships(
				name,
				part.document,
				await original.relationships(name),
				relationships,
				rewritten,
				copied,
				clock
			)
			if (clock?.due === true) await clock.pause()

			await checkPart(checks, checkInput, { name, part, document, skeleton: true })
		} else {
			// Joined only here: a part that is not a story part, one with namespaces declared below its root, a
			// story part the save creates, or one the save only takes containers out of.
			const document = await parseCheckedSliced(name, await joinBytes(change.bytes), clock)

			if (part !== undefined) {
				if (original.has(name)) addFacts(after, await partFacts(part.document, scope), -1)

				addFacts(after, await partFacts(document, scope), 1)
				await checkRelationships(
					name,
					await danglingRelationships(await relationshipsOf(name), document, clock),
					await original.relationships(name),
					part.document,
					clock
				)
			}

			await checkPart(checks, checkInput, { name, part, document, skeleton: false })

			const type = types.typeOf(name)

			if (type === STYLES_TYPE) stylesDocument = document
			if (type === NUMBERING_TYPE) {
				numberingDocument = document
				numberingName = name
			}
		}
	}

	for (const [key, change] of after.ids) {
		const was = before.ids.get(key) ?? 0

		if (change > 0 && was + change > 1) fail("duplicateId", `${key} appears ${was + change} times`)
	}

	const store = new PropsStore()
	const styles: DocxStyles = stylesDocument === undefined ? context.styles : parseStyles(stylesDocument, store)
	const numbering: Numbering | undefined =
		numberingDocument === undefined ? context.numbering : parseNumbering(numberingDocument, store, styles)

	if (numberingDocument !== undefined) {
		const known =
			numberingName !== undefined && original.has(numberingName)
				? numberingDuplicates(await original.xml(numberingName))
				: new Set<string>()

		for (const id of numberingDuplicates(numberingDocument)) if (!known.has(id)) fail("duplicateId", `numbering: ${id} appears twice`)
	}

	for (const [style, change] of after.styles) {
		if (change > 0 && styles.byId(style) === undefined && !before.styles.has(style))
			fail("danglingReference", `Style ${style} is not defined`)
	}

	for (const [list, change] of after.lists) {
		if (change > 0 && numbering?.has(list) !== true && !before.lists.has(list)) fail("danglingReference", `List ${list} is not defined`)
	}

	await readBack(input, rewritten, relationshipsOf, clock)
	await checkDone(checks, checkInput)
}

// Relationship ids the new markup uses must exist, unless the source used them without defining them too.
async function checkRelationships(
	name: string,
	dangling: readonly string[],
	sourceRelationships: Relationships,
	source: XmlDocument,
	clock: SliceClock | undefined
): Promise<void> {
	if (dangling.length === 0) return

	const before = new Set(await danglingRelationships(sourceRelationships, source, clock))

	for (const id of dangling) if (!before.has(id)) fail("relationship", `${name}: relationship ${id} does not exist`)
}

// w:num and w:abstractNum ids that appear more than once in a numbering part.
function numberingDuplicates(document: XmlDocument): Set<string> {
	const reader = partReader(document)
	const root = document.documentElement()
	const seen = new Set<string>()
	const duplicates = new Set<string>()

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.group(child) !== Ns.W) continue

		const local = document.localName(child)
		const id =
			local === "num"
				? reader.attr(child, Ns.W, "numId")
				: local === "abstractNum"
					? reader.attr(child, Ns.W, "abstractNumId")
					: undefined

		if (id === undefined) continue

		const key = `${local} ${id}`

		if (seen.has(key)) duplicates.add(key)

		seen.add(key)
	}

	return duplicates
}

// A container written as a copy keeps its source's properties, without the children carrying ids.
function checkContainers(part: StoryPart, root: string | undefined, output: StoryOutput): void {
	const { open, close } = rootTags(part.document, root)

	for (const container of output.containers) {
		const expected = container.properties.map(node => canonicalElement(part.document, node, false, new Set(container.strip))).join("\n")
		const document = parseChecked(part.name, join([open, output.bytes.subarray(container.from, container.to), close]))
		const actual = canonicalFragment(document, document.documentElement())

		if (actual !== expected) fail("content", `A copied container of ${part.name} lost its properties`)
	}
}

// The rebuilt paragraphs, read back by the model in a document of their own, must be what the editor holds.
// The rewritten paragraphs of one part, as written (the skeleton's markup) and as the editor holds them.
interface Rewritten {
	readonly part: StoryPart
	readonly markup: Uint8Array[]
	readonly nodes: Node[]
	// Per node, whether it is written with its section break (see sectionWritten).
	readonly sections: boolean[]
}

// Rewritten markup read back at a time.
const READ_BACK_BYTES = 64 * 1024
// Calls `visit` for each contiguous share of bytes [from, from + length) of `bytes`.
function shares(
	bytes: Uint8Array | BytePieces,
	from: number,
	length: number,
	visit: (piece: Uint8Array, pieceFrom: number, count: number, at: number) => boolean
): boolean {
	return bytes instanceof Uint8Array ? from + length <= bytes.length && visit(bytes, from, length, 0) : bytes.visit(from, length, visit)
}

// Whether a[aFrom, aFrom + length) and b[bFrom, bFrom + length) hold the same bytes; pieces that are the very
// same memory compare at once.
function sameRange(a: Uint8Array | BytePieces, aFrom: number, b: Uint8Array | BytePieces, bFrom: number, length: number): boolean {
	return shares(a, aFrom, length, (left, leftFrom, count, at) =>
		shares(b, bFrom + at, count, (right, rightFrom, inner, offset) => equalBytes(left, leftFrom + offset, right, rightFrom, inner))
	)
}

// Bytes compared between checks of the clock.
const COMPARE_PIECE = 4 * 1024 * 1024

// Source bytes [from, to) are whole sibling nodes.
function wholeNodes(document: XmlDocument, from: number, to: number): boolean {
	let node = nodeAt(document, from)

	if (node >= document.count || document.start(node) !== from) return false

	for (;;) {
		const end = document.end(node)

		if (end === to) return true
		if (end > to) return false

		node = document.nextSibling(node)

		if (node < 0 || document.start(node) !== end) return false
	}
}

// The written part is the source outside the rewritten containers, then each container as written, and
// every copy in it is the source's bytes of the whole nodes it claims, inside that container.
async function checkAssembly(
	name: string,
	part: StoryPart,
	stories: readonly StoryChange[],
	cuts: readonly { readonly from: number; readonly to: number }[],
	root: string | undefined,
	written: PartBytes,
	inPackage: boolean,
	clock: SliceClock | undefined
): Promise<void> {
	const bytes = written instanceof Uint8Array || written instanceof BytePieces ? written : await joinBytes(written)
	const document = part.document
	const source = document.bytes
	const rootNode = document.documentElement()
	// A removed container is written as nothing, a root start tag declared anew as that tag.
	const replaced: {
		story: StoryChange | undefined
		from: number
		to: number
		output: Uint8Array | BytePieces
		trusted: readonly number[]
	}[] = cuts.map(cut => ({ story: undefined, ...cut, output: new Uint8Array(), trusted: [] }))

	if (root !== undefined)
		replaced.push({
			story: undefined,
			from: document.start(rootNode),
			to: document.openEnd(rootNode),
			output: encodeUtf8(root),
			trusted: []
		})

	// As the writer assembles them: a new container before one replaced at the same place.
	const ordered = [
		...stories.map(story => ({
			story,
			...storyRange(name, part, story, inPackage),
			output: story.output.bytes,
			trusted: story.output.trusted
		})),
		...replaced
	].sort((a, b) => a.from - b.from || a.to - b.to)
	let from = 0
	let at = 0
	const same = async (length: number, other: Uint8Array | BytePieces, otherFrom: number): Promise<void> => {
		if (at + length > bytes.length) fail("content", `${name} is not what was checked`)

		for (let done = 0; done < length; done += COMPARE_PIECE) {
			const piece = Math.min(COMPARE_PIECE, length - done)

			if (!sameRange(bytes, at + done, other, otherFrom + done, piece)) fail("content", `${name} is not what was checked`)
			if (clock?.due === true) await clock.pause()
		}

		at += length
	}

	for (const { from: start, to: end, output, trusted } of ordered) {
		if (start < from) fail("content", `${name}: rewritten stories overlap`)

		let written = 0

		await same(start - from, source, from)

		for (let k = 0; k < trusted.length; k += 4) {
			const outFrom = trusted[k] ?? 0
			const outTo = trusted[k + 1] ?? 0
			const sourceFrom = trusted[k + 2] ?? 0
			const sourceTo = trusted[k + 3] ?? 0

			if (
				outTo - outFrom !== sourceTo - sourceFrom ||
				sourceFrom < start ||
				sourceTo > end ||
				!wholeNodes(document, sourceFrom, sourceTo)
			) {
				fail("content", `${name}: a copy is not whole source nodes of its story`)
			}

			await same(outFrom - written, output, written)
			await same(outTo - outFrom, source, sourceFrom)
			written = outTo
		}

		await same(output.length - written, output, written)
		from = end
	}

	await same(source.length - from, source, from)

	if (at !== bytes.length) fail("content", `${name} is not what was checked`)
}

// Paragraph items starting in source bytes [from, to), outside other paragraphs (text boxes are stories of
// their own).
function sourceParagraphs(part: StoryPart, from: number, to: number, out: number[]): void {
	paragraphsFrom(part, firstItemAt(part, from), to, out, part.count)
}

// sourceParagraphs in slices of `clock` (a copy can hold most of a long story).
async function sourceParagraphsSliced(
	part: StoryPart,
	from: number,
	to: number,
	out: number[],
	clock: SliceClock | undefined
): Promise<void> {
	for (let item = firstItemAt(part, from); item >= 0;) {
		item = paragraphsFrom(part, item, to, out, ITEM_STEP)

		if (clock?.due === true) await clock.pause()
	}
}

// Source items looked at between looks at the clock.
const ITEM_STEP = 16384

// The first item starting at or after byte `from`.
function firstItemAt(part: StoryPart, from: number): number {
	let low = 0
	let high = part.count

	while (low < high) {
		const middle = (low + high) >> 1

		if (part.start(middle) < from) low = middle + 1
		else high = middle
	}

	return low
}

// Pushes the paragraphs from item `first` on that start before byte `to`, looking at up to `limit` items: the
// item to go on from, or -1 when done.
function paragraphsFrom(part: StoryPart, first: number, to: number, out: number[], limit: number): number {
	const stop = Math.min(part.count, first + limit)
	let item = first

	while (item < stop && part.start(item) < to) {
		if (part.kinds[item] === Item.Paragraph) {
			out.push(item)
			item = part.end(item)
		} else {
			item++
		}
	}

	return item < part.count && item >= stop && part.start(item) < to ? item : -1
}

// A paragraph the writer copied must be its source as the editor first built it (markers before it are
// written apart).
function sameAsSource(original: Node | undefined, node: Node): boolean {
	if (original === undefined) return false
	if (original.eq(node)) return true
	if (!original.content.eq(node.content) || original.marks.length !== node.marks.length) return false
	if (original.marks.some((mark, index) => !mark.eq(node.marks[index] as Mark))) return false

	return Object.keys(original.attrs).every(attr => attr === "before" || original.attrs[attr] === node.attrs[attr])
}

// Every story's paragraphs, in order: the editor's (a locked block stands for the source paragraphs in its
// bytes) against the written story's (each copy for the source paragraphs in it, each new w:p as rewritten).
// A copied paragraph must be the editor's paragraph there, unchanged; a rewritten one is read back below.
async function checkParagraphs(
	name: string,
	part: StoryPart,
	stories: readonly StoryChange[],
	written: XmlDocument,
	out: Rewritten[],
	clock: SliceClock | undefined
): Promise<void> {
	const reader = partReader(written)
	const rewritten: Rewritten = { part, markup: [], nodes: [], sections: [] }
	let container = written.firstChildElement(written.documentElement())

	for (const story of stories) {
		if (container < 0) fail("content", `${name}: a rewritten story is missing`)

		const expected: { readonly node: Node | null; readonly item: number; readonly cell: boolean; readonly section: boolean }[] = []
		// Table cells holding the blocks visited, by their end position.
		const cells: number[] = []

		const visit = (node: Node, pos: number): boolean => {
			while (cells.length > 0 && (cells[cells.length - 1] ?? 0) <= pos) cells.pop()

			if (node.type === nodes.table_cell) cells.push(pos + node.nodeSize)

			if (node.type === nodes.paragraph) {
				const item = node.attrs["src"] as number

				const cell = cells.length > 0

				expected.push({ node, item, cell, section: sectionWritten(part, node.attrs["sectPr"] as number, cell) })

				return false
			}

			if (node.type === nodes.locked_block) {
				const item = node.attrs["src"] as number
				const items: number[] = []

				sourceParagraphs(part, part.start(item), part.byteEnd(item), items)

				for (const paragraph of items)
					expected.push({
						node: null,
						item: paragraph,
						cell: cells.length > 0 || cellWithin(part, paragraph, item),
						section: false
					})

				return false
			}

			return !node.isInline
		}
		// In document order (as nodesBetween visits); a block too long for one slice (a long table) by its children.
		const walk = async (parent: Node, start: number): Promise<void> => {
			for (let index = 0, pos = start; index < parent.childCount; index++) {
				const child = parent.child(index)

				if (child.nodeSize <= LONG_BLOCK) {
					if (visit(child, pos)) child.nodesBetween(0, child.content.size, visit, pos + 1)
				} else if (visit(child, pos)) await walk(child, pos + 1)

				pos += child.nodeSize

				if (clock?.due === true) await clock.pause()
			}
		}

		await walk(story.doc, 0)

		const actual: { readonly element: number; readonly item: number }[] = []
		const trusted = story.output.trusted
		const end = written.end(container)
		let copy = 0
		let skipTo = -1

		for (let node = container + 1; node < written.count && written.start(node) < end; node++) {
			if (clock !== undefined && (node & (NODE_STEP - 1)) === 0 && clock.due) await clock.pause()
			if (written.kinds[node] !== NodeKind.Element) continue

			const placeholder = written.name(node) === "_"

			if (written.start(node) < skipTo) {
				if (placeholder) copy++

				continue
			}

			if (placeholder) {
				const items: number[] = []

				await sourceParagraphsSliced(part, trusted[copy * 4 + 2] ?? 0, trusted[copy * 4 + 3] ?? 0, items, clock)

				for (const item of items) actual.push({ element: -1, item })

				copy++
			} else if (reader.group(node) === Ns.W && written.localName(node) === "p") {
				actual.push({ element: node, item: -1 })
				skipTo = written.end(node)
			}
		}

		if (copy * 4 !== trusted.length) fail("content", `${name}: the copies of a story do not add up`)
		if (actual.length !== expected.length) {
			fail("content", `${name}: a story was written with ${actual.length} paragraphs, the editor has ${expected.length}`)
		}

		if (clock?.due === true) await clock.pause()

		const built = story.session.story

		for (let index = 0; index < actual.length; index++) {
			const paragraph = actual[index]
			const editor = expected[index]

			if (clock !== undefined && (index & (PARAGRAPH_STEP - 1)) === 0 && clock.due) await clock.pause()
			if (paragraph === undefined || editor === undefined) continue

			if (paragraph.item >= 0) {
				const same =
					editor.node === null
						? editor.item === paragraph.item
						: editor.item === paragraph.item && sameAsSource(originalBlock(built, paragraph.item), editor.node)

				if (!same) fail("content", `${name}: a copied paragraph is not the editor's paragraph there`)

				// Its bytes keep a section break only where its source had it: in a table cell or out of one.
				if ((part.paragraphs.sectPr[part.aux[paragraph.item] ?? -1] ?? -1) >= 0 && inCell(part, paragraph.item) !== editor.cell)
					fail("content", `${name}: a copied section break moved into or out of a table cell`)
			} else {
				if (editor.node === null) fail("content", `${name}: a locked block was rewritten`)

				rewritten.markup.push(written.bytes.subarray(written.start(paragraph.element), written.end(paragraph.element)))
				rewritten.nodes.push(editor.node)
				rewritten.sections.push(editor.section)
			}
		}

		container = written.nextSiblingElement(container)
	}

	out.push(rewritten)
}

// Read-back signatures of rewritten paragraphs by their markup and what else the read-back reads (the part's root
// tag, relationships and the save's list ids): the same markup reads back the same, so a paragraph a save wrote
// before as it is written now is not read back again. Found by a hash of the markup, taken only when the bytes are
// the same. One generation per part: the last save's (one Rewritten per part holds all of its stories).
interface ReadBackEntry {
	readonly markup: Uint8Array
	readonly actual: string
}

const readBackCache = new WeakMap<StoryPart, { readonly scope: string; readonly entries: Map<number, ReadBackEntry[]> }>()

// How many paragraphs of `part` the next save finds read back already (for tests).
export function readBacksKept(part: StoryPart): number {
	let count = 0

	for (const list of readBackCache.get(part)?.entries.values() ?? []) count += list.length

	return count
}

// FNV-1a of `bytes`.
function hashBytes(bytes: Uint8Array): number {
	let hash = 0x811c9dc5

	for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ (bytes[i] ?? 0), 0x01000193)

	return hash >>> 0
}

function cached(
	entries: ReadonlyMap<number, readonly ReadBackEntry[]> | undefined,
	hash: number,
	markup: Uint8Array
): ReadBackEntry | undefined {
	return entries?.get(hash)?.find(entry => sameBytes(entry.markup, markup))
}

function keep(entries: Map<number, ReadBackEntry[]>, hash: number, entry: ReadBackEntry): void {
	const list = entries.get(hash)

	if (list === undefined) entries.set(hash, [entry])
	else if (!list.includes(entry)) list.push(entry)
}

async function readBack(
	input: VerifyPartsInput,
	rewritten: readonly Rewritten[],
	relationshipsOf: (part: string) => Promise<Relationships>,
	clock: SliceClock | undefined
): Promise<void> {
	for (const story of rewritten) {
		const root = input.changes.roots.get(story.part)
		const relationships = await relationshipsOf(story.part.name)
		const scope =
			`${root ?? ""}\u0001${relationships.all.map(item => `${item.id} ${item.type} ${item.target} ${String(item.external)}`).join("\u0002")}` +
			`\u0001${[...input.changes.numIds].join(" ")}`
		const last = readBackCache.get(story.part)
		const known = last?.scope === scope ? last.entries : undefined
		const kept = new Map<number, ReadBackEntry[]>()
		// Paragraphs read back in a document of their own (each reads back alone, but for fields spanning
		// paragraphs): those outside any such field without one of their own are found by their markup.
		const pending: number[] = []
		const hashes = new Map<number, number>()
		let depth = 0

		for (let index = 0; index < story.nodes.length; index++) {
			const node = story.nodes[index]
			const own = fieldCharDepth(node)
			const markup = story.markup[index]

			if (depth === 0 && own === 0 && markup !== undefined && !hasFieldChar(node)) {
				const hash = hashBytes(markup)
				const entry = cached(known, hash, markup)

				if (entry !== undefined) {
					compareReadBack(input, story, index, entry.actual)
					keep(kept, hash, entry)

					continue
				}

				hashes.set(index, hash)
			}

			depth += own
			pending.push(index)
		}

		// Read back in batches of about READ_BACK_BYTES of markup, so a save that rewrote much of a long
		// document checks it a short step at a time.
		for (let first = 0; first < pending.length;) {
			let last = first
			let size = 0
			let open = 0

			while (last < pending.length && (last === first || size < READ_BACK_BYTES || open > 0)) {
				const index = pending[last++] ?? 0

				open += fieldCharDepth(story.nodes[index])
				size += story.markup[index]?.length ?? 0
			}

			const indices = pending.slice(first, last)
			const actual = await readBackBatch(input, story, indices, root, relationships, clock)

			indices.forEach((index, k) => {
				const hash = hashes.get(index)
				const signature = actual[k]
				const markup = story.markup[index]

				// A copy: the markup is a view of the whole story as written, which it would keep.
				if (hash !== undefined && signature !== undefined && markup !== undefined)
					keep(kept, hash, { markup: markup.slice(), actual: signature })
			})
			first = last

			if (clock?.due === true) await clock.pause()
		}

		readBackCache.set(story.part, { scope, entries: kept })
	}
}

function hasFieldChar(paragraph: Node | undefined): boolean {
	let found = false

	paragraph?.forEach(child => {
		if (child.type === nodes.field_char) found = true
	})

	return found
}

// Refuses the save when paragraph `index` of a rewritten story does not read back as `actual` says.
function compareReadBack(input: VerifyPartsInput, story: Rewritten, index: number, actual: string): void {
	const paragraph = story.nodes[index]

	if (paragraph === undefined) return

	const expected = paragraphSignature(paragraph, input.changes.numIds, story.sections[index], input.context, story.part)

	if (expected !== actual)
		fail("content", `A rewritten paragraph of ${story.part.name} reads back differently:\n${actual}\n!=\n${expected}`)
}

// How many fields spanning paragraphs a paragraph opens (begins less ends of its field characters).
function fieldCharDepth(paragraph: Node | undefined): number {
	let depth = 0

	paragraph?.forEach(child => {
		if (child.type === nodes.field_char) depth += child.attrs["kind"] === "begin" ? 1 : child.attrs["kind"] === "end" ? -1 : 0
	})

	return depth
}

// Paragraphs `indices` of a rewritten story, read back by the model in a document of their own; their read-back
// signatures (undefined for one that does not read back as a paragraph).
async function readBackBatch(
	input: VerifyPartsInput,
	story: Rewritten,
	indices: readonly number[],
	rootTag: string | undefined,
	relationships: Relationships,
	clock: SliceClock | undefined
): Promise<(string | undefined)[]> {
	const paragraphs = indices.map(index => story.nodes[index] as Node)
	const document = story.part.document
	const reader = partReader(document)
	const root = document.documentElement()
	const prefix = W_URIS.map(uri => reader.namespaces.prefixFor(root, uri)).find(found => found !== undefined) ?? ""
	const qualify = (local: string): string => (prefix === "" ? local : `${prefix}:${local}`)
	const open = (rootTag ?? decodeUtf8(document.bytes, document.start(root), document.openEnd(root))).replace(
		/^<[^\s>/]+/,
		`<${qualify("document")}`
	)
	const body = join([
		encodeUtf8(
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${open.endsWith("/>") ? open.slice(0, -2) + ">" : open}<${qualify("body")}>`
		),
		...indices.map(index => story.markup[index] ?? new Uint8Array(0)),
		encodeUtf8(`</${qualify("body")}></${qualify("document")}>`)
	])
	const files: Record<string, Uint8Array> = {
		"[Content_Types].xml": encodeUtf8(
			'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
				'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
		),
		"_rels/.rels": encodeUtf8(
			'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
		),
		"word/document.xml": body,
		"word/_rels/document.xml.rels": encodeUtf8(
			'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				relationships.all
					.map(
						relationship =>
							`<Relationship Id="${escape(relationship.id)}" Type="${escape(relationship.type)}" Target="${escape(relationship.target)}"${relationship.external ? ' TargetMode="External"' : ""}/>`
					)
					.join("") +
				"</Relationships>"
		)
	}
	const opened = await openDocxPackage(bytesSource(zipSync(files, { level: 0 })))

	if (!opened.ok) fail("model", `The rewritten ${story.part.name} does not read back: ${opened.message}`)

	const model = await buildDocxModel(opened.package, clock === undefined ? {} : { slicing: clock })

	if (model.malformed || model.body === undefined) fail("model", `The rewritten ${story.part.name} has malformed markup`)

	const context = await openDocxEditContext(opened.package, model)
	const builder = new DocxDocBuilder(context)
	const built =
		clock === undefined ? builder.build(model.body) : await builder.buildSliced(model.body, clock.pause, clock.sliceMs, clock.now)
	const readBlocks = textblocks(built.doc)
	const readPart = model.parts[model.body.part]

	if (readBlocks.length !== paragraphs.length)
		fail("content", `${paragraphs.length} rewritten paragraphs read back as ${readBlocks.length}`)

	return indices.map((index, k) => {
		const other = readBlocks[k]

		if (other === undefined || other.type !== nodes.paragraph) return undefined

		const actual = paragraphSignature(other, input.changes.numIds, undefined, context, readPart)

		compareReadBack(input, story, index, actual)

		return actual
	})
}

function escape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

export { verifyDocxZip } from "./zip"

const nodes = docxSchema.nodes
const marks = docxSchema.marks
const IGNORED_MARKS = new Set([marks.run, marks.plain])
const IDENTITY_MARKS = new Set([marks.insertion, marks.deletion, marks.move_from, marks.move_to, marks.content_control, marks.wrapper])

function sorted(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value
	if (Array.isArray(value)) return value.map(sorted)

	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([key, entry]) => [key, sorted(entry)])
	)
}

function writtenTarget(target: unknown): string {
	return typeof target !== "string" || target === "" ? "null" : writtenLinkTarget(target)
}

function markSignature(mark: Mark): string {
	if (IDENTITY_MARKS.has(mark.type)) return mark.type.name
	// A tracked formatting change split over several runs gets new ids: who and when is what counts.
	if (mark.type === marks.format_change) return `format_change:${String(mark.attrs["author"])}:${String(mark.attrs["date"])}`
	// A target as written (a file's link that is no URI reference is written encoded, see save.ts).
	if (mark.type === marks.link) return `link:${String(mark.attrs["anchor"] || null)}:${writtenTarget(mark.attrs["target"])}`

	return `${mark.type.name}${JSON.stringify(sorted(mark.attrs))}`
}

// The paragraphs and locked blocks of a document, in order.
export function textblocks(doc: Node): Node[] {
	const out: Node[] = []

	doc.descendants(node => {
		if (node.type === nodes.paragraph || node.type === nodes.locked_block) {
			out.push(node)

			return false
		}

		return !node.isInline
	})

	return out
}

// What a reader sees and edits of a paragraph, without source items: properties, then text and atoms with
// their marks (text with the same marks joined).
// Text as XML can carry it: a lone surrogate (half a pair an undo can bring back) is written as U+FFFD.
function xmlText(text: string): string {
	let out: string | undefined

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)

		if (code < 0xd800 || code > 0xdfff) continue

		const next = text.charCodeAt(i + 1)

		if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
			i++

			continue
		}

		out = (out ?? text).slice(0, i) + "\ufffd" + (out ?? text).slice(i + 1)
	}

	return out ?? text
}

// `section`: whether the paragraph is a section break as written (its own w:sectPr by default). With the
// `context` the paragraph was built in, a drawing is what its markup and a command's overrides make it (its
// size, placement, rotation and alt text), not its node's attributes. With the `part` its sources are in, an
// equation is what it is written as (its new OMML, else its source element).
export function paragraphSignature(
	node: Node,
	numIds: ReadonlyMap<number, number>,
	section = (node.attrs["sectPr"] as number) >= 0,
	context?: DocxEditContext,
	part?: StoryPart
): string {
	const numId = node.attrs["numId"] as number | null
	const parts: string[] = [
		JSON.stringify([
			node.attrs["styleId"],
			numId !== null && numId < 0 ? (numIds.get(numId) ?? numId) : numId,
			node.attrs["ilvl"],
			// As written: start and end are the same edges as left and right.
			node.attrs["align"] === null ? null : writtenJustification(node.attrs["align"] as string),
			sorted(node.attrs["indent"]),
			sorted(node.attrs["spacing"]),
			sorted(node.attrs["borders"]),
			section
		])
	]
	let lastText = -1

	node.forEach(child => {
		if (child.type === nodes.proof_err || child.type === nodes.rendered_break) return

		const markPart = child.marks
			.filter(mark => !IGNORED_MARKS.has(mark.type))
			.map(markSignature)
			.join(",")

		if (child.isText) {
			const previous = parts[lastText]
			const text = xmlText(child.text ?? "")

			if (lastText === parts.length - 1 && previous !== undefined && previous.startsWith(`t[${markPart}]`)) {
				parts[lastText] = previous + text
			} else {
				parts.push(`t[${markPart}]${text}`)
				lastText = parts.length - 1
			}

			return
		}

		if (child.type === nodes.drawing && context !== undefined) {
			parts.push(`drawing${drawingSignature(context, child)}[${markPart}]`)

			return
		}

		if (child.type === nodes.math) {
			parts.push(`math${JSON.stringify([child.attrs["display"], mathSignature(child, part)])}[${markPart}]`)

			return
		}

		const attributes = { ...child.attrs }

		// A legacy form field's `state` is what its w:ffData now says (write/sdt.ts), which this reading does not
		// take back into the attribute.
		for (const name of ["src", "end", "node", "markers", "index", "simple", "state"]) delete attributes[name]

		// A bookmark's name is in its start's bytes, a new one's on its marker (checks/fields.ts checks them).
		if (child.type === nodes.marker) delete attributes["name"]

		// A field's tracked update gets the save's own revision ids.
		if (child.type === nodes.field && attributes["update"] !== null && typeof attributes["update"] === "object")
			attributes["update"] = { ...(attributes["update"] as Record<string, unknown>), id: null }

		// An instruction text deleted reads back as the file's deleted one (w:delInstrText).
		if (child.type === nodes.field_char && attributes["kind"] === "deletedInstruction") attributes["kind"] = "instruction"

		parts.push(`${child.type.name}${JSON.stringify(sorted(attributes))}[${markPart}]`)
	})

	return parts.join("\n")
}
