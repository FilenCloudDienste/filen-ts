import { maxOf } from "../../arrays"
import {
	ZipArchive,
	chunksSource,
	memorySink,
	partKey,
	planZip,
	writeZip,
	type ByteSink,
	type ByteSource,
	type ZipChanges
} from "../../opc/index"
import { arrivalChecked, checkedItems, IN_MEMORY_LIMIT } from "../../pptx/write/save"
import type { PptxSaveOptions, PptxSaveOutcome, PptxSnapshot } from "../../pptx/write/types"
import { noteIssuedNames } from "../../presentation/issuedNames"
import { mediaDropped, noteRestoredMedia } from "../../presentation/restoredMedia"
import { PresentationError, refused, type Deck, type Refused, type SlideNode, type SlideRef } from "../../presentation/model"
import { Namespaces, NodeKind, XmlError, decodeUtf8, parseXml } from "../../xml/index"
import { openOdp, type OdpOpen, type OdpParts } from "../read/document"
import { packagePart } from "../read/fills"
import { notesDiffer, slideDiffers } from "./meaning"
import { withManifestEntries, withoutManifestEntries } from "./manifestPrune"
import { odpSplice, sameCopied, type OdpSaveInput, type OdpSplice } from "./splice"
import { isRefused } from "../../presentation/refusal"

// Saving an ODP deck into its own source (§1.5.4): the splice (splice.ts) at revision R, proof gate 2, then the zip.
// Gate 2 reads the written pages back with the reader and compares them with the session's slides (meaning.ts):
//   - a package up to the in-memory limit is written to memory, re-opened whole, every rewritten page read back and
//     every copied page compared by its bytes, before a byte reaches the sink;
//   - a larger one is checked before its first byte, on a package made of the new content.xml, styles.xml, the
//     manifest and the entries the rewritten pages name (what the reader reads for them), then streamed with every
//     copy CRC-checked on arrival and the copy count checked before the central directory.
// A mismatch refuses the save as proofFailed naming the model parts of the pages it found on (each page and its notes
// are a part of their own in the session, `/content.xml#<ref>`), so the engine reverts only the ops that touched
// them; a mismatch of the whole stream names every changed part. The sink is never closed then, so the upload behind
// it aborts without a new version.

export interface OdpSnapshot extends PptxSnapshot {
	readonly splice: OdpSplice
	readonly parts: OdpParts
	readonly deck: Deck
	// The model parts the save's changes touch (what a refusal of the whole stream names).
	readonly changed: readonly string[]
	// The pages written from the model, and the slide order, as the snapshot saw them: the proof reads the written file
	// back against these, not against the deck, which an edit made since may have changed (the next save writes that).
	readonly expected: ReadonlyMap<SlideRef, { readonly node: SlideNode; readonly notes: SlideNode | undefined }>
	readonly order: readonly SlideRef[]
}

// A model value as it is now: objects and arrays copied, byte arrays (never edited in place) shared.
function frozen<T>(value: T): T {
	if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value
	if (Array.isArray(value)) return value.map(item => frozen(item) as unknown) as unknown as T

	const out: Record<string, unknown> = {}

	for (const key of Object.keys(value)) out[key] = frozen((value as Record<string, unknown>)[key])

	return out as T
}

function isOdpSnapshot(snapshot: PptxSnapshot): snapshot is OdpSnapshot {
	return "splice" in snapshot && "parts" in snapshot
}

const CHUNK = 1024 * 1024
// The entries the media emit adds (Media/media<id>.<ext>).
const MEDIA_ENTRY = /^Media\//u
const MANIFEST = "META-INF/manifest.xml"
const THUMBNAIL = "Thumbnails/thumbnail.png"

export async function odpSnapshot(input: OdpSaveInput): Promise<OdpSnapshot | Refused> {
	const parts = input.source.parts
	const archive = parts.odf.archive

	// The package's names are the session's from now on: no entry this save or a later one adds takes one of them.
	noteIssuedNames(
		input.deck,
		archive.entries.map(entry => entry.name)
	)

	// What a save let go of reads as the package's while the session holds it (a picture an undo put back).
	parts.holdMedia(name => heldOdpMedia(input.deck, name))

	const splice = await odpSplice(input)

	if (isRefused(splice)) return splice

	const replacedNames = new Set(splice.replace.map(change => change.name))
	// Entries this session wrote that nothing reaches any more (dom/presentation/prune.ts), and their manifest entries,
	// but those the content.xml and styles.xml this save writes name (a page copied as the package has it).
	const proposed = (input.prune ?? []).filter(name => !replacedNames.has(name) && archive.entries.some(entry => entry.name === name))
	const media = await releasedMedia(
		input,
		splice,
		parts,
		new Set([...replacedNames, ...proposed, ...(input.own ?? [])].map(name => name.toLowerCase()))
	)
	const pruned = proposed.length === 0 ? proposed : unnamed(proposed, splice, parts)
	// ODF Part 2 §3.8: the preview shows the first page; a save that rewrites the pages cannot redraw it, so drops it.
	const thumbnail =
		(replacedNames.has("content.xml") || replacedNames.has("styles.xml")) &&
		!pruned.includes(THUMBNAIL) &&
		archive.entries.some(entry => entry.name === THUMBNAIL)
			? [THUMBNAIL]
			: []
	const prune = [...pruned, ...thumbnail, ...media.released]
	const unlisted = [...pruned, ...thumbnail, ...media.manifest]
	let replace = splice.replace

	if (unlisted.length > 0 || media.restored.length > 0) {
		const written = replace.find(change => change.name === MANIFEST)
		const entry = archive.entries.find(candidate => candidate.name === MANIFEST)
		const source = written?.bytes instanceof Uint8Array ? written.bytes : entry === undefined ? undefined : await archive.read(entry)
		const without = source === undefined ? undefined : withoutManifestEntries(source, unlisted)
		const bytes =
			without === undefined || media.restored.length === 0
				? without
				: withManifestEntries(
						without,
						media.restored.flatMap(unit => unit.manifest)
					)

		if (bytes === undefined) return refused("malformed", "The manifest has no end to add the entries an undo brings back")

		const manifest = { name: MANIFEST, bytes }

		replace = written === undefined ? [...replace, manifest] : replace.map(change => (change.name === MANIFEST ? manifest : change))
	}

	const back = media.restored.flatMap(unit => unit.entries)

	for (const entry of back) noteRestoredMedia(input.deck, entry.name)

	const add = [...splice.add, ...back.map(entry => ({ name: entry.name, bytes: entry.bytes }))]
	const changes: ZipChanges = { replace, add, ...(prune.length === 0 ? {} : { remove: prune }) }
	const copies = archive.entries.length - replace.length - prune.length

	const expected = new Map<SlideRef, { readonly node: SlideNode; readonly notes: SlideNode | undefined }>()

	for (const page of splice.pages) {
		const node = page.kind === "copied" ? undefined : input.deck.nodes.get(page.ref)

		if (node === undefined) continue

		const notes = node.notes === undefined ? undefined : input.deck.nodes.get(node.notes)

		expected.set(page.ref, { node: frozen(node), notes: notes === undefined ? undefined : frozen(notes) })
	}

	const order = [...input.deck.slides]
	let orders = snapshotOrders.get(input.deck)

	if (orders === undefined) {
		orders = new Map()
		snapshotOrders.set(input.deck, orders)
	}

	orders.set(splice.revision, order)

	return {
		revision: splice.revision,
		changes,
		copies,
		splice,
		parts,
		deck: input.deck,
		changed: [...input.changes.parts.keys()],
		expected,
		order
	}
}

// The slide order each snapshot of a deck wrote, by the save's revision: the pages of the file that save makes, in
// order, whatever the deck does while it is uploaded or waits for its commit (a commit may come after a later save's
// snapshot). Kept until a commit at that revision or a later one lands.
const snapshotOrders = new WeakMap<Deck, Map<number, readonly SlideRef[]>>()

// The slides the deck's snapshot at `revision` wrote, page by page (what the rebase onto that save's file binds its
// pages to).
export function snapshotSlideOrder(deck: Deck, revision: number): readonly SlideRef[] | undefined {
	return snapshotOrders.get(deck)?.get(revision)
}

// The revision of the deck's latest snapshot still kept (a caller that does not say which save's file it rebases
// onto takes that one's order).
export function latestSnapshotRevision(deck: Deck): number | undefined {
	const orders = snapshotOrders.get(deck)

	return orders === undefined || orders.size === 0 ? undefined : maxOf(orders.keys())
}

// A commit at `revision` landed: the orders of it and every earlier save are no file's to come.
export function releaseSnapshotOrders(deck: Deck, revision: number): void {
	const orders = snapshotOrders.get(deck)

	if (orders === undefined) return

	for (const saved of [...orders.keys()]) if (saved <= revision) orders.delete(saved)
}

// Pictures, media and embedded objects of the source a save lets go of (a picture, medium or object deleted, an image
// replaced): those the source content.xml names that neither the written content.xml nor styles.xml does. An object
// goes whole: its Object N/ folder, its ObjectReplacements image and their manifest entries. Held by deck while a step
// the history holds names them (OdpSaveInput.keep), so the save writing them again (an undo) adds every entry back as
// it was, with its manifest entries.
interface HeldMedia {
	readonly bytes: Uint8Array
	readonly mediaType: string
}

// One thing the markup names: a picture or medium (its entry), or an object (its folder, by name without the slash).
interface HeldUnit {
	readonly entries: readonly { readonly name: string; readonly bytes: Uint8Array; readonly mediaType: string }[]
	readonly manifest: readonly { readonly path: string; readonly mediaType: string }[]
	// The object's own media type (its folder's manifest entry); undefined for a picture or medium.
	readonly folder?: string
}

const heldMedia = new WeakMap<Deck, Map<string, HeldUnit>>()
const SOURCE_MEDIA = /^(?:Pictures|Media)\/[^/]+$/u
const EMBEDDED = "application/vnd.oasis.opendocument."
const NO_BYTES = new Uint8Array(0)

function bare(name: string): string {
	return name.replace(/^\.?\//u, "")
}

// An entry a save let go of that the session holds for an undo: its bytes and media type (an object's folder: none and
// its type).
export function heldOdpMedia(deck: Deck, name: string): HeldMedia | undefined {
	const wanted = bare(name).replace(/\/$/u, "")

	for (const [key, unit] of heldMedia.get(deck) ?? []) {
		if (key === wanted && unit.folder !== undefined) return { bytes: NO_BYTES, mediaType: unit.folder }

		const entry = unit.entries.find(each => each.name === wanted)

		if (entry !== undefined) return { bytes: entry.bytes, mediaType: entry.mediaType }
	}

	return undefined
}

export function hasHeldOdpMedia(deck: Deck): boolean {
	return (heldMedia.get(deck)?.size ?? 0) > 0
}

// Lets go of held media no step the history names any more.
export function keepHeldOdpMedia(deck: Deck, named: ReadonlySet<string>): void {
	const held = heldMedia.get(deck)

	if (held === undefined) return

	for (const key of held.keys()) if (!named.has(key)) held.delete(key)
}

// The manifest's media type of each path (full-path → media-type).
function manifestTypes(manifest: string): Map<string, string> {
	const out = new Map<string, string>()

	for (const [entry] of manifest.matchAll(/<[\w.-]*:?file-entry\b[^>]*>/gu)) {
		const path = /full-path="([^"]*)"/u.exec(entry)?.[1]

		if (path !== undefined) out.set(path, /media-type="([^"]*)"/u.exec(entry)?.[1] ?? "")
	}

	return out
}

// Whether `text` names `key` as an href does: "Pictures/1.png", "./Object 1", "./Object 1/…" (never "Object 10").
function names(text: string, key: string): boolean {
	return [`"${key}"`, `"./${key}"`, `"${key}/`, `"./${key}/`].some(form => text.includes(form))
}

async function releasedMedia(
	input: OdpSaveInput,
	splice: OdpSplice,
	parts: OdpParts,
	settled: ReadonlySet<string>
): Promise<{ readonly released: string[]; readonly manifest: readonly string[]; readonly restored: HeldUnit[] }> {
	const archive = parts.odf.archive
	const content = splice.content
	const held = heldMedia.get(input.deck)
	const none = { released: [], manifest: [], restored: [] }

	if (content === undefined) return none

	const has = new Set(archive.entries.map(entry => entry.name))
	const text = held === undefined || held.size === 0 ? undefined : decodeUtf8(content)
	const restored = [...(held ?? [])]
		.filter(([key, unit]) => unit.entries.every(entry => !has.has(entry.name)) && text !== undefined && names(text, key))
		.map(([, unit]) => unit)
	const dropped = mediaDropped(input.deck, input.changes)

	if (!dropped) return { ...none, restored }

	const styles = splice.replace.find(change => change.name === "styles.xml")?.bytes ?? parts.sheet.stylesDocument?.bytes

	// Styles written as chunks are not searched: nothing goes.
	if (styles !== undefined && !(styles instanceof Uint8Array)) return { ...none, restored }

	const source = decodeUtf8(parts.content.bytes)
	const written = [decodeUtf8(content), styles === undefined ? "" : decodeUtf8(styles)]
	const manifestEntry = archive.entries.find(entry => entry.name === MANIFEST)
	const types = manifestTypes(manifestEntry === undefined ? "" : decodeUtf8(await archive.read(manifestEntry)))
	// What the markup names, with the entries and manifest paths that go with it.
	const units = new Map<string, { readonly entries: string[]; readonly manifest: string[]; readonly folder?: string }>()

	for (const entry of archive.entries)
		if (SOURCE_MEDIA.test(entry.name)) units.set(entry.name, { entries: [entry.name], manifest: [entry.name] })

	for (const [path, type] of types) {
		if (!path.endsWith("/") || path === "/" || !type.startsWith(EMBEDDED)) continue

		const folder = path.slice(0, -1)
		const replacement = `ObjectReplacements/${folder}`
		const inside = archive.entries.map(entry => entry.name).filter(name => name.startsWith(path))
		const all = has.has(replacement) ? [...inside, replacement] : inside

		const listed = [...types.keys()].filter(name => name.startsWith(path) || name === replacement)

		units.set(folder, { entries: all, manifest: listed, folder: type })
	}

	const keep = new Set(input.keep ?? [])
	const released: string[] = []
	const manifest: string[] = []
	let map = held

	for (const [key, unit] of units) {
		if (
			unit.entries.length === 0 ||
			unit.entries.some(name => settled.has(name.toLowerCase())) ||
			!names(source, key) ||
			written.some(each => names(each, key))
		)
			continue

		released.push(...unit.entries)
		manifest.push(...unit.manifest)

		if (!keep.has(key)) continue

		if (map === undefined) {
			map = new Map()
			heldMedia.set(input.deck, map)
		}

		const entries: { name: string; bytes: Uint8Array; mediaType: string }[] = []

		for (const name of unit.entries) {
			const entry = archive.entries.find(candidate => candidate.name === name)

			if (entry !== undefined) entries.push({ name, bytes: await archive.read(entry), mediaType: types.get(name) ?? "" })
		}

		map.set(key, {
			entries,
			manifest: unit.manifest.map(path => ({ path, mediaType: types.get(path) ?? "" })),
			...(unit.folder === undefined ? {} : { folder: unit.folder })
		})
	}

	return { released, manifest, restored }
}

// The entries of `names` neither the written content.xml nor styles.xml names (by its full name, as hrefs give it).
function unnamed(names: readonly string[], splice: OdpSplice, parts: OdpParts): string[] {
	const styles = splice.replace.find(change => change.name === "styles.xml")?.bytes ?? parts.sheet.stylesDocument?.bytes

	// Styles written as chunks are not searched: every entry stays.
	if (styles !== undefined && !(styles instanceof Uint8Array)) return []

	const texts = [decodeUtf8(splice.content ?? parts.content.bytes), styles === undefined ? "" : decodeUtf8(styles)]

	return names.filter(name => !texts.some(text => text.includes(name)))
}

// A refusal of the whole content stream, naming every part the save changes.
function wholeRefusal(snapshot: OdpSnapshot, what: string): Refused {
	return refused("proofFailed", `content.xml ${what} (${snapshot.changed.join(" ")})`)
}

// A refusal of one page, naming its model parts (the page and its notes).
function pageRefusal(snapshot: OdpSnapshot, index: number, ref: SlideRef, what: string): Refused {
	const node = snapshot.deck.nodes.get(ref)
	const notes = node?.notes === undefined ? undefined : snapshot.deck.nodes.get(node.notes)
	const parts = [...new Set([node?.part, notes?.part].filter((part): part is string => part !== undefined))]

	return refused("proofFailed", `page ${String(index + 1)} (${parts.join(" ")}) ${what}`)
}

// The written pages read back and compared with the session's slides; copied pages compared by their bytes.
async function verifyPages(snapshot: OdpSnapshot, opened: OdpOpen, copiedBytes: boolean): Promise<Refused | undefined> {
	if (opened.kind === "refused") return wholeRefusal(snapshot, `does not read back: ${opened.detail ?? opened.reason}`)

	const { splice } = snapshot
	const written = opened.deck.slides

	if (written.length !== splice.pages.length) return wholeRefusal(snapshot, "reads back with another page count")

	const source = snapshot.parts.content.bytes

	for (const [index, page] of splice.pages.entries()) {
		const ref = written[index]

		if (ref === undefined) return wholeRefusal(snapshot, "lost a page")

		const name = splice.names.get(page.ref) ?? ""

		if (opened.parts.pageName(ref) !== name) return pageRefusal(snapshot, index, page.ref, "reads back as another name")

		if (page.kind === "copied") {
			if (!copiedBytes) continue

			const span = opened.parts.content.pages[index]

			if (span === undefined || !sameCopied(source, page, opened.parts.content.bytes, span.start, span.end))
				return pageRefusal(snapshot, index, page.ref, "was not copied as it was")

			continue
		}

		const at = snapshot.expected.get(page.ref)

		if (at === undefined) return pageRefusal(snapshot, index, page.ref, "has no state the snapshot saw")

		const node = at.node
		const read = await opened.parts.slide(ref)
		const differs = slideDiffers(node, read, name, {
			at: index,
			count: written.length,
			expected: target => snapshot.order.indexOf(target),
			read: target => written.indexOf(target)
		})

		if (differs !== undefined) return pageRefusal(snapshot, index, page.ref, `reads back differently: ${differs}`)

		const notes = at.notes
		const readNotes = read.notes === undefined ? undefined : opened.deck.nodes.get(read.notes)
		const notesDiffers = notesDiffer(notes, readNotes)

		if (notesDiffers !== undefined) return pageRefusal(snapshot, index, page.ref, `reads back differently: ${notesDiffers}`)
	}

	return undefined
}

function sameRange(a: Uint8Array, aStart: number, aEnd: number, b: Uint8Array, bStart: number, bEnd: number): boolean {
	if (aEnd - aStart !== bEnd - bStart) return false

	for (let k = 0; k < aEnd - aStart; k++) if (a[aStart + k] !== b[bStart + k]) return false

	return true
}

const XLINK = "http://www.w3.org/1999/xlink"

// The package entries a written page names by an xlink:href (§19.910, any prefix bound to XLink, either quote, its
// entities decoded): read from the page parsed under content.xml's root, as the reader reads them.
function hrefsOf(bytes: Uint8Array, content: OdpParts["content"]): string[] | undefined {
	let document

	try {
		document = parseXml(concat(content.rootOpen, bytes, content.rootClose))
	} catch (error) {
		if (error instanceof XmlError) return undefined

		throw error
	}

	const namespaces = new Namespaces(document, { lenient: true })
	const out: string[] = []

	for (let node = 0; node < document.count; node++) {
		if (document.kind(node) !== NodeKind.Element) continue

		for (const attribute of document.attributes(node)) {
			const colon = attribute.name.indexOf(":")

			if (colon < 0 || attribute.name.slice(colon + 1) !== "href" || attribute.value.startsWith("#")) continue
			if (namespaces.uri(node, attribute.name.slice(0, colon)) === XLINK) out.push(attribute.value)
		}
	}

	return out
}

function concat(...chunks: readonly Uint8Array[]): Uint8Array {
	let length = 0

	for (const chunk of chunks) length += chunk.length

	const out = new Uint8Array(length)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

// The package gate 2 reads a streamed save's pages from: the new content.xml, styles.xml, the manifest, and every
// entry the rewritten pages name (a picture, an object's streams); nothing else is read from the source.
async function verificationPackage(snapshot: OdpSnapshot, content: Uint8Array): Promise<ByteSource> {
	const archive = snapshot.parts.odf.archive
	const wanted = new Set(["mimetype", "styles.xml", "META-INF/manifest.xml"])

	for (const [index, page] of snapshot.splice.pages.entries()) {
		if (page.kind !== "written") continue

		const hrefs = hrefsOf(page.bytes, snapshot.parts.content)

		if (hrefs === undefined) {
			const refusal = pageRefusal(snapshot, index, page.ref, "is not well formed")

			throw new PresentationError(refusal.reason, refusal.detail)
		}

		for (const href of hrefs) {
			const part = packagePart(href)

			if (part === undefined) continue

			const name = part.slice(1)

			for (const entry of archive.entries) if (entry.name === name || entry.name.startsWith(`${name}/`)) wanted.add(entry.name)
		}
	}

	const replaced = new Set((snapshot.changes.replace ?? []).map(change => change.name))
	const removed = archive.entries.filter(entry => !wanted.has(entry.name) && !replaced.has(entry.name)).map(entry => entry.name)
	// The manifest and the entries the splice added (an inserted picture) are the snapshot's.
	const plan = planZip(
		{ entries: archive.entries, comment: archive.comment, zip64: archive.zip64 },
		{
			replace: [
				{ name: "content.xml", bytes: content },
				...(snapshot.changes.replace ?? []).filter(change => change.name !== "content.xml")
			],
			remove: removed,
			// Media entries stay out of the read-back package: the reader never reads a draw:plugin's bytes, and a medium
			// may be far larger than memory should hold.
			add: (snapshot.changes.add ?? []).filter(change => !MEDIA_ENTRY.test(change.name))
		}
	)
	const sink = memorySink()

	await writeZip(plan, archive, sink)

	return chunksSource(sink.chunks())
}

export async function writeOdpSnapshot(snapshot: PptxSnapshot, sink: ByteSink, options: PptxSaveOptions = {}): Promise<PptxSaveOutcome> {
	if (!isOdpSnapshot(snapshot)) return refused("failed", "Not an ODP writer snapshot")

	const { parts, splice } = snapshot
	const archive = parts.odf.archive
	const content = splice.content

	if (content === undefined) return { kind: "unchanged" }

	try {
		const plan = planZip({ entries: archive.entries, comment: archive.comment, zip64: archive.zip64 }, snapshot.changes)
		const planned = plan.items.filter(item => item.kind === "copy").length
		const limit = options.inMemoryLimit ?? IN_MEMORY_LIMIT
		const zipOptions = {
			...(options.slicing === undefined ? {} : { slicing: options.slicing }),
			...(options.deflate === undefined ? {} : { deflate: options.deflate })
		}

		if (planned !== snapshot.copies) return refused("proofFailed", "The zip plans a different number of copies than the splice")

		if (archive.source.size <= limit) {
			const memory = memorySink()
			const report = await writeZip(plan, archive, memory, zipOptions)
			// Read back over the pieces as written: joining them would hold the package twice.
			const chunks = memory.chunks()
			const back = await ZipArchive.open(chunksSource(chunks))
			const entry = back.entries.find(candidate => partKey(candidate.name) === partKey("content.xml"))

			if (entry === undefined || !sameRange(await back.read(entry), 0, entry.uncompressedSize, content, 0, content.length))
				return wholeRefusal(snapshot, "reads back from the zip differently")
			if (report.entries - (snapshot.changes.replace?.length ?? 0) - (snapshot.changes.add?.length ?? 0) !== planned)
				return refused("proofFailed", "The zip copied a different number of parts than planned")

			const checked = await verifyPages(snapshot, await openOdp(chunksSource(chunks), { budgets: parts.budgets }), true)

			if (checked !== undefined) return checked

			for (const chunk of chunks) {
				for (let at = 0; at < chunk.length; at += CHUNK) await sink.write(chunk.subarray(at, Math.min(chunk.length, at + CHUNK)))
			}

			await sink.close()

			return { kind: "written", report, revision: snapshot.revision }
		}

		const checked = await verifyPages(
			snapshot,
			await openOdp(await verificationPackage(snapshot, content), { budgets: parts.budgets }),
			false
		)

		if (checked !== undefined) return checked

		const report = await writeZip(
			{
				items: checkedItems(plan, planned),
				...(plan.comment === undefined ? {} : { comment: plan.comment }),
				...(plan.zip64End === undefined ? {} : { zip64End: plan.zip64End })
			},
			arrivalChecked(archive.source),
			sink,
			zipOptions
		)

		return { kind: "written", report, revision: snapshot.revision }
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)

		throw error
	}
}

// The ODP splice writer, in the shape of the pptx one (the engine's save runs either).
export const odpSpliceWriter = {
	snapshot: (input: OdpSaveInput): Promise<OdpSnapshot | Refused> => odpSnapshot(input),
	write: (snapshot: PptxSnapshot, sink: ByteSink, options: PptxSaveOptions): Promise<PptxSaveOutcome> =>
		writeOdpSnapshot(snapshot, sink, options)
}

// The save of an ODP deck into its own source: unchanged without changes (nothing uploaded), else splice and write.
export async function saveOdp(input: OdpSaveInput, sink: ByteSink, options: PptxSaveOptions = {}): Promise<PptxSaveOutcome> {
	if (input.changes.empty) return { kind: "unchanged" }

	const snapshot = await odpSnapshot(input)

	if (isRefused(snapshot)) return snapshot
	if (snapshot.splice.content === undefined) return { kind: "unchanged" }

	return writeOdpSnapshot(snapshot, sink, options)
}
