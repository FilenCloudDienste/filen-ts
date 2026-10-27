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
import { PresentationError, refused, type Deck, type Refused, type SlideNode, type SlideRef } from "../../presentation/model"
import { Namespaces, NodeKind, XmlError, parseXml } from "../../xml/index"
import { openOdp, type OdpOpen, type OdpParts } from "../read/document"
import { packagePart } from "../read/fills"
import { notesDiffer, slideDiffers } from "./meaning"
import { odpSplice, type OdpSaveInput, type OdpSplice } from "./splice"
import { isRefused } from "./styles"

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
}

function isOdpSnapshot(snapshot: PptxSnapshot): snapshot is OdpSnapshot {
	return "splice" in snapshot && "parts" in snapshot
}

const CHUNK = 1024 * 1024
// The entries the media emit adds (Media/media<id>.<ext>).
const MEDIA_ENTRY = /^Media\//u

export async function odpSnapshot(input: OdpSaveInput): Promise<OdpSnapshot | Refused> {
	const splice = await odpSplice(input)

	if (isRefused(splice)) return splice

	const changes: ZipChanges = { replace: splice.replace, add: splice.add }
	const parts = input.source.parts
	const copies = parts.odf.archive.entries.length - splice.replace.length

	return { revision: splice.revision, changes, copies, splice, parts, deck: input.deck, changed: [...input.changes.parts.keys()] }
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

	const { deck, splice } = snapshot
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

			if (span === undefined || !sameRange(source, page.span.start, page.span.end, opened.parts.content.bytes, span.start, span.end))
				return pageRefusal(snapshot, index, page.ref, "was not copied as it was")

			continue
		}

		const node = deck.nodes.get(page.ref) as SlideNode
		const read = await opened.parts.slide(ref)
		const differs = slideDiffers(node, read, name, {
			at: index,
			count: written.length,
			expected: target => deck.slides.indexOf(target),
			read: target => written.indexOf(target)
		})

		if (differs !== undefined) return pageRefusal(snapshot, index, page.ref, `reads back differently: ${differs}`)

		const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)
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
			if (report.entries - splice.replace.length - splice.add.length !== planned)
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
