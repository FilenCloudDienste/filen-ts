import { BytePieces, bytesSource, ZipArchive } from "../../opc/index"
import { metaDate } from "../../odf/meta"
import { OdfPackage, readContentPrologue } from "../../odf/index"
import { readContentPrologueSliced } from "../../odf/prologue"
import { OdfStyleSheet } from "../../odf/styles"
import { sliceClock } from "../../slicing"
import { RtfAborted, turn, type RtfJob } from "../../rtf/turns"
import { assertWellFormed, assertWellFormedSliced, decodeUtf8, encodeUtf8, parseXml, type Slicing, type XmlDocument } from "../../xml/index"
import { translateOdt } from "../translate"
import { OdtWriteRefusal } from "./emit"
import { Meaning } from "./meaning"
import { runMeaning, translateRun, type SpanFrame } from "./span"
import type { OdtSource } from "./source"
import { BODY_PART, OdtPlan, type Segment } from "./plan"
import { bodyOf, EditedDocument, equalBytes, relationshipsOf, RELS_PART, type WriteResult } from "./edited"
import { META, savedMeta, THUMBNAIL, withoutThumbnail } from "./package"

// The proof of a save: the written file translated again and compared with what the edit made.

// A meaning as a digest: two independent 32-bit hashes of its UTF-16 code units and its length.
function digestOf(text: string): string {
	let a = 0x811c9dc5
	let b = 0x01000193

	for (let k = 0; k < text.length; k++) {
		const code = text.charCodeAt(k)

		a = Math.imul(a ^ code, 0x01000193)
		b = Math.imul(b ^ code, 0x5bd1e995) ^ (b >>> 15)
	}

	return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${text.length.toString(36)}`
}

// The meaning of a translation's body blocks and sections, and of the edit's.
async function meaningOf(
	parts: (name: string) => XmlDocument | undefined,
	rels: Map<string, { target: string; external: boolean; type: string }>,
	media: (part: string) => string,
	job: RtfJob | undefined
): Promise<{ blocks: string[]; sections: string[] }> {
	const body = parts(BODY_PART)

	if (body === undefined) return { blocks: [], sections: [] }

	const stories = new Map<string, string>()
	const target = (id: string): string => {
		const relationship = rels.get(id)

		if (relationship === undefined) return `?${id}`
		if (relationship.external) return `url:${relationship.target}`

		const part = relationship.target.startsWith("/") ? relationship.target.slice(1) : `word/${relationship.target}`

		return `part:${media(part)}`
	}
	const meaning: Meaning = new Meaning({
		styles: parts("word/styles.xml"),
		numbering: parts("word/numbering.xml"),
		footnotes: parts("word/footnotes.xml"),
		endnotes: parts("word/endnotes.xml"),
		comments: parts("word/comments.xml"),
		target,
		compact: digestOf,
		story: id => {
			const known = stories.get(id)

			if (known !== undefined) return known

			const relationship = rels.get(id)
			const name = relationship === undefined ? undefined : `word/${relationship.target}`
			const document = name === undefined ? undefined : parts(name)
			const text = document === undefined ? "?" : digestOf(meaning.story(document, document.documentElement()).join("\u0002"))

			stories.set(id, text)

			return text
		}
	})

	return meaning.bodyIn(body, bodyOf(body), job === undefined ? undefined : async () => (job.due() ? turn(job) : undefined))
}

// What the edit means (verify's expectation); the same from one write to the next.
export async function expectedOf(
	plan: OdtPlan,
	doc: EditedDocument,
	result: WriteResult,
	job: RtfJob | undefined
): Promise<{ blocks: string[]; sections: string[] }> {
	doc.expected ??= await meaningOf(
		name => plan.editedXml(name),
		doc.eRels,
		part => plan.translation.media.get(part) ?? result.pictureParts.get(part) ?? part,
		job
	)

	return doc.expected
}

// Compares the written file's reading with the edit, segment by segment. Units whose kept bytes read differently
// come back to be rewritten; a rewritten segment that reads differently refuses (or, in Gate 1, locks).
export async function verify(
	expected: { readonly blocks: readonly string[]; readonly sections: readonly string[] },
	result: WriteResult,
	packaged: Uint8Array,
	source: ZipArchive,
	job: RtfJob | undefined
): Promise<{
	readonly again: Set<number>
	readonly wrong: Set<number>
	readonly wrongBlocks: Set<number>
	readonly message: string | undefined
	readonly detail: string | undefined
}> {
	// Every part listed in the manifest and every listing a part (Part 2 §3.2, §4.3), as far as the source had them so.
	const written = await ZipArchive.open(bytesSource(packaged))
	const was = await manifestGaps(source)

	for (const gap of await manifestGaps(written)) {
		if (!was.has(gap)) throw new OdtWriteRefusal("proof", `the written manifest does not match the package (${gap})`)
	}

	const read = await translateOdt(bytesSource(packaged), job === undefined ? { strict: true } : { slicing: job.aborting, strict: true })

	if (!read.ok) throw new OdtWriteRefusal("proof", `the written file does not open (${read.message})`)

	await turn(job)

	const reread = read.translation
	const rereadDocs = new Map<string, XmlDocument>()
	const rereadPart = (name: string): XmlDocument | undefined => {
		let document = rereadDocs.get(name)

		if (document === undefined) {
			const part = reread.parts.get(name)

			if (!(part instanceof Uint8Array)) return undefined

			document = parseXml(part)
			rereadDocs.set(name, document)
		}

		return document
	}
	await turn(job)

	const actual = await meaningOf(
		rereadPart,
		relationshipsOf(reread.parts.get(RELS_PART) as Uint8Array | undefined),
		part => reread.media.get(part) ?? part,
		job
	)

	await turn(job)

	const again = new Set<number>()
	const wrong = new Set<number>()
	const wrongBlocks = new Set<number>()
	const wholeUnits = new Set<number>()
	let message: string | undefined
	let detail: string | undefined

	const origins = reread.origins
		.filter(origin => origin.part === BODY_PART && origin.stream === "content.xml" && origin.count > 0)
		.sort((a, b) => a.start - b.start)
	// The reread blocks of each segment, by where their source elements start: the origins starting within it, found
	// by a binary search (segments come in no order).
	const rangeOf = (segment: Segment): { from: number; to: number } => {
		let low = 0
		let high = origins.length

		while (low < high) {
			const middle = (low + high) >>> 1

			if ((origins[middle]?.start ?? 0) < segment.start) low = middle + 1
			else high = middle
		}

		let from = Number.MAX_SAFE_INTEGER
		let to = -1

		for (let k = low; k < origins.length; k++) {
			const origin = origins[k]

			if (origin === undefined || origin.start > segment.end) break

			if (origin.end <= segment.end) {
				from = Math.min(from, origin.first)
				to = Math.max(to, origin.first + origin.count)
			}
		}

		return to < 0 ? { from: 0, to: 0 } : { from, to }
	}
	let paired = 0

	for (const segment of result.segments) {
		if (++paired % 4096 === 0 && job?.due() === true) await turn(job)

		const range = rangeOf(segment)
		const want = expected.blocks.slice(segment.from, segment.to)
		const got = actual.blocks.slice(range.from, range.to)
		const same = want.length === got.length && want.every((block, k) => block === got[k])

		if (same) continue

		const units = segment.units.map(unit => unit.index)

		if (segment.kind === "kept") for (const unit of units) again.add(unit)
		else if (want.length === got.length && segment.from >= 0) {
			// Block by block where they pair (Gate 1 locks only the blocks that read differently).
			want.forEach((block, k) => {
				if (block !== got[k]) wrongBlocks.add(segment.from + k)
			})

			for (const unit of units) wrong.add(unit)
		} else
			for (const unit of units) {
				wrong.add(unit)
				wholeUnits.add(unit)
			}

		if (message === undefined) {
			const k = Math.max(
				0,
				want.findIndex((block, index) => block !== got[index])
			)

			const difference = readBackDifference(segment.from + k, got[k], want[k])

			message = difference.message
			detail = difference.detail
		}
	}

	// The whole body, for what no segment covers (blocks the writer added where the source had none).
	if (again.size === 0 && wrong.size === 0) {
		if (expected.blocks.length !== actual.blocks.length || expected.blocks.some((block, k) => block !== actual.blocks[k])) {
			const k = expected.blocks.findIndex((block, index) => block !== actual.blocks[index])
			const at = k < 0 ? expected.blocks.length : k

			const difference = readBackDifference(at, actual.blocks[at], expected.blocks[at])

			message = difference.message
			detail = difference.detail
			wrong.add(-1)
		} else if (expected.sections.join("\u0001") !== actual.sections.join("\u0001")) {
			message = "the sections read differently"
			wrong.add(-1)
		}
	}

	// A unit whose blocks did not pair locks whole: its blocks then stand for the unit.
	for (const unit of wholeUnits) wrongBlocks.add(-1 - unit)

	return { again, wrong, wrongBlocks, message, detail }
}

// Where a block reads back differently, never what it reads as: the message is logged, and a block's reading is a
// short digest of its meaning (digestOf), which a guess at a short block's text could confirm. Both digests go on
// the detail (OdtWriteRefusal.detail).
function readBackDifference(
	block: number,
	actual: string | undefined,
	expected: string | undefined
): { readonly message: string; readonly detail: string } {
	const what = actual === undefined ? ": nothing read back" : expected === undefined ? ": nothing expected" : ""

	return { message: `block ${String(block)} reads back differently${what}`, detail: `${actual ?? "nothing"} != ${expected ?? "nothing"}` }
}

// One changed run of top-level blocks: the edit's blocks [from, to) it must read as, the bytes [start, end) of the
// written content.xml holding it, and the translator's state where it starts (Translator.blockState).
export interface SpanWindow {
	readonly from: number
	readonly to: number
	readonly start: number
	readonly end: number
	readonly state: string
}

export interface SpanPlan {
	readonly windows: readonly SpanWindow[]
	// The edit's top-level blocks.
	readonly blocks: number
	readonly frame: SpanFrame
	// Where office:body starts in the written content.xml.
	readonly prologueEnd: number
	readonly settings: { readonly tabsRelativeToIndent: boolean }
	// The translation's styles part: the windows' translation must make the same.
	readonly stylesPart: Uint8Array | undefined
}

// The span proof (span.ts) of `packaged` as the file of an edit planned as `span`: true when it reads as `expected`
// (content.xml as written outside the windows, each window as the edit's blocks there); false leaves the save to
// the whole file's proof.
export async function proveSpans(
	span: SpanPlan,
	expected: { readonly blocks: readonly string[] },
	content: BytePieces,
	packaged: Uint8Array,
	source: ZipArchive,
	manifest: Uint8Array | undefined,
	meta: Uint8Array | undefined,
	job: RtfJob | undefined
): Promise<boolean> {
	if (span.stylesPart === undefined) return false

	const opened = await OdfPackage.open(bytesSource(packaged), { kinds: ["text", "text-master", "text-web"] })

	if (!opened.ok) return false

	const odf = opened.package

	// Every entry but content.xml is the source's as stored (styles.xml, settings...), the manifest and meta.xml the
	// ones written and the preview image gone: the proof reads only content.xml, so what it takes as copied is checked,
	// not assumed.
	const dropped = source.get(THUMBNAIL) === undefined ? 0 : 1

	if (odf.archive.entries.length !== source.entries.length - dropped || odf.archive.get(THUMBNAIL) !== undefined) return false

	for (const entry of odf.archive.entries) {
		if (entry.name === "content.xml") continue

		if (entry.name === "META-INF/manifest.xml" && manifest !== undefined) {
			if (!equalBytes(await odf.archive.read(entry), manifest)) return false

			continue
		}

		if (entry.name === META && meta !== undefined) {
			if (!equalBytes(await odf.archive.read(entry), meta)) return false

			continue
		}

		const was = source.get(entry.name)

		if (
			was === undefined ||
			was.crc32 !== entry.crc32 ||
			was.method !== entry.method ||
			was.compressedSize !== entry.compressedSize ||
			was.uncompressedSize !== entry.uncompressedSize
		)
			return false
	}
	const entry = odf.archive.get("content.xml")
	const clock = job === undefined ? undefined : sliceClock(job.aborting)

	if (entry === undefined || entry.uncompressedSize !== content.length) return false

	// content.xml read from the file: as written outside the windows; the windows' bytes as the file has them.
	const windows = span.windows.map(window => ({ window, bytes: new Uint8Array(window.end - window.start) }))
	let offset = 0

	try {
		for await (const chunk of odf.archive.stream(entry, clock)) {
			let at = 0

			for (const { window, bytes } of windows) {
				const from = Math.max(window.start - offset, at)
				const to = Math.min(window.end - offset, chunk.length)

				if (from >= to) continue
				if (!sameAs(content, offset + at, chunk, at, from - at)) return false

				bytes.set(chunk.subarray(from, to), offset + from - window.start)
				at = to
			}

			if (!sameAs(content, offset + at, chunk, at, chunk.length - at)) return false

			offset += chunk.length
		}
	} catch (error) {
		if (error instanceof RtfAborted) throw error

		return false
	}

	await turn(job)

	if (expected.blocks.length !== span.blocks) return false

	try {
		// The written prologue (read as the file has it: content.xml was just compared with it) and styles.xml.
		const slicing = job?.aborting
		const head = content.copy(0, Math.min(content.length, span.prologueEnd + 64))
		const prologue = slicing === undefined ? readContentPrologue(head) : await readContentPrologueSliced(head, slicing)

		if (prologue.bodyStart !== span.prologueEnd) return false

		// What was written in the prologue (automatic styles, font faces, declarations) is checked strictly: the
		// lenient parse that reads it would take markup a reader refuses.
		await strictly(prologue.document, slicing)

		const stylesXml = await odf.xml("styles.xml", slicing)
		const sheet =
			slicing === undefined ? new OdfStyleSheet(stylesXml, prologue) : await OdfStyleSheet.build(stylesXml, prologue, slicing)
		const styles = { odf, sheet, settings: span.settings }
		const stylesPart = decodeUtf8(span.stylesPart)
		const stylesDocument = parseXml(span.stylesPart)

		for (const { window, bytes } of windows) {
			await turn(job)

			const run = translateRun(styles, span.frame, bytes, window.state, true)

			if (run === undefined || run.styles !== stylesPart) return false

			const got = runMeaning(run.blocks, stylesDocument, digestOf)
			const want = expected.blocks.slice(window.from, window.to)

			if (got === undefined || got.length !== want.length || got.some((block, k) => block !== want[k])) return false
		}
	} catch (error) {
		// What does not read here is left to the whole file's proof.
		if (error instanceof RtfAborted || !(error instanceof Error)) throw error

		return false
	}

	return true
}

async function strictly(document: XmlDocument, slicing: Slicing | undefined): Promise<void> {
	if (slicing === undefined) assertWellFormed(document)
	else await assertWellFormedSliced(document, slicing)
}

// Whether `count` bytes of `chunk` from `chunkFrom` are those written at `from`.
function sameAs(written: BytePieces, from: number, chunk: Uint8Array, chunkFrom: number, count: number): boolean {
	return written.visit(from, count, (piece, pieceFrom, length, at) => {
		for (let k = 0; k < length; k++) if (piece[pieceFrom + k] !== chunk[chunkFrom + at + k]) return false

		return true
	})
}

// Where a package and its manifest disagree: entries the manifest does not list ("unlisted:"), and files it lists
// that the package does not hold ("missing:"). The mimetype stream and META-INF/ need no listing (Part 2 §3.2).
async function manifestGaps(archive: ZipArchive): Promise<Set<string>> {
	const gaps = new Set<string>()
	const entry = archive.get("META-INF/manifest.xml")

	if (entry === undefined) return gaps

	const document = parseXml(await archive.read(entry))
	const listed = new Set<string>()

	for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node)) {
		const path = [...document.attributes(node)].find(
			attribute => attribute.name.endsWith(":full-path") || attribute.name === "full-path"
		)?.value

		if (path !== undefined) listed.add(path)
	}

	for (const item of archive.entries) {
		if (item.name === "mimetype" || item.name.startsWith("META-INF/") || item.name.endsWith("/")) continue
		if (!listed.has(item.name)) gaps.add(`unlisted:${item.name}`)
	}

	for (const path of listed) {
		if (path === "/" || path.endsWith("/")) continue
		if (archive.get(path) === undefined) gaps.add(`missing:${path}`)
	}

	return gaps
}

// The manifest a write without new pictures writes (undefined: the source's, copied).
export async function expectedManifest(source: OdtSource): Promise<Uint8Array | undefined> {
	const entry = source.archive.get("META-INF/manifest.xml")

	if (source.archive.get(THUMBNAIL) === undefined || entry === undefined) return undefined

	return encodeUtf8(withoutThumbnail(decodeUtf8(await source.archive.read(entry))))
}

// The meta.xml a write saved when `written` was dated: the source's as a save then leaves it (undefined: copied).
export async function expectedMeta(source: OdtSource, written: Uint8Array): Promise<Uint8Array | undefined> {
	const archive = await ZipArchive.open(bytesSource(written))
	const entry = archive.get(META)
	const date = entry === undefined ? undefined : metaDate(await archive.read(entry))

	return date === undefined ? undefined : savedMeta(source, date)
}
