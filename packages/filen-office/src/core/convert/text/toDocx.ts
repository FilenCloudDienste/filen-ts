import type { DocDecryption } from "../../doc/decrypt"
import { DocError } from "../../doc/errors"
import { convertDocToDocx, docxPackage, type ProtectionKeyHash } from "../../doc/toDocx/index"
import { nativeDeflate } from "../../docx/write/zip"
import { bytesSource, memorySink, writeZip, ZipArchive, type ZipPlanItem } from "../../opc/index"
import { isRtf, readRtf, type RtfReadResult } from "../../rtf/reader"
import { translateOdt } from "../../odt/translate"
import type { OdtTranslation } from "../../odt/types"
import { RtfAborted, jobOf, turn, type RtfJob, type RtfTurns } from "../../rtf/turns"
import { decodeUtf8, encodeUtf8 } from "../../xml/index"
import { standaloneParts } from "./odtPackage"
import { LossyCounts, TextConversionError, type TextLossyKind, type TextRefusalReason } from "./report"
import { relsName, STORY } from "./shared"

// OpenDocument text, RTF and Word 97–2003 documents as .docx: each written from the translation the viewer opens
// (the ODT translator's, the RTF reader's, the Word binary converter's), which is a complete WordprocessingML
// package, so nothing is parsed or serialized a second time.

export interface ToDocxOptions {
	readonly turns?: RtfTurns | undefined
	readonly decryption?: DocDecryption | undefined
	readonly protectionKey?: ((verifier: number) => Promise<ProtectionKeyHash>) | undefined
}

export interface ToDocxResult {
	readonly bytes: Uint8Array
	readonly lossy: LossyCounts
}

const STORED = /\.(?:png|jpe?g|gif|webp|tiff?|emf|wmf|bmp|svg)$/iu

// `<w:r w:rsidR="XXXXXXXX">`: the ODT translator names the content.xml offset of the source span a run came from
// on its runs (for the ODT writer, which reads its style back from it). An internal offset is no revision session
// id: it is never written into a .docx. The translator writes it as the start tag's
// only attribute, upper-case hex, eight digits; character data cannot hold "<" (escaped), so the start tag is
// matched exactly.
const ORIGIN_OPEN = new TextEncoder().encode('<w:r w:rsidR="')
const ORIGIN_LENGTH = ORIGIN_OPEN.length + 8 + 2

function isOrigin(bytes: Uint8Array, at: number): boolean {
	for (let k = 1; k < ORIGIN_OPEN.length; k++) if (bytes[at + k] !== ORIGIN_OPEN[k]) return false

	const hex = at + ORIGIN_OPEN.length

	for (let k = 0; k < 8; k++) {
		const byte = bytes[hex + k] ?? 0

		if (!((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46))) return false
	}

	return bytes[hex + 8] === 0x22 && bytes[hex + 9] === 0x3e
}

// The part with every origin start tag written `<w:r>`; the same array when it has none.
export function withoutOrigins(bytes: Uint8Array): Uint8Array {
	let out: Uint8Array | undefined
	let written = 0
	let copied = 0

	for (let at = bytes.indexOf(0x3c); at >= 0 && at + ORIGIN_LENGTH <= bytes.length; at = bytes.indexOf(0x3c, at + 1)) {
		if (bytes[at + 1] !== 0x77 || !isOrigin(bytes, at)) continue

		out ??= new Uint8Array(bytes.length)
		out.set(bytes.subarray(copied, at + 4), written)
		written += at + 4 - copied
		out[written++] = 0x3e
		copied = at + ORIGIN_LENGTH
		at = copied - 1
	}

	if (out === undefined) return bytes

	out.set(bytes.subarray(copied), written)

	return out.subarray(0, written + bytes.length - copied)
}

function rethrow(error: unknown): never {
	if (error instanceof RtfAborted) throw new TextConversionError("aborted", "aborted")
	if (error instanceof TextConversionError) throw error

	throw new TextConversionError("corrupt", error instanceof Error ? `${error.name}: ${error.message}` : String(error))
}

// `source`: the archive "copy" items are copied from.
async function zipped(items: ZipPlanItem[], job: RtfJob | undefined, source: Uint8Array | null = null): Promise<Uint8Array> {
	const sink = memorySink()
	const deflate = nativeDeflate()

	await writeZip({ items }, source === null ? null : bytesSource(source), sink, {
		level: 6,
		...(deflate === undefined ? {} : { deflate }),
		...(job === undefined ? {} : { slicing: job.aborting })
	})

	return sink.bytes()
}

export async function translationDocx(translation: OdtTranslation, lossy: LossyCounts, job: RtfJob | undefined): Promise<Uint8Array> {
	const parts = new Map<string, Uint8Array>()

	for (const [name, part] of translation.parts) {
		const read = part instanceof Uint8Array ? part : await part.read()

		parts.set(name, STORY.test(name) ? withoutOrigins(read) : read)
	}

	await turn(job)
	standaloneParts(parts, lossy)
	await turn(job)

	return zipped(
		[...parts].map(([name, bytes]) => ({ kind: "data", name, bytes, compress: !STORED.test(name) })),
		job
	)
}

// A WordprocessingML package the ODT translator made, as the document editor edited it (the parts the docx writer
// wrote over the translation), as a standalone .docx: what odtToDocx does to the translation itself.
export async function odtTranslationToDocx(source: Uint8Array, options: ToDocxOptions): Promise<ToDocxResult> {
	const job = jobOf(options.turns)

	try {
		let archive: ZipArchive

		try {
			archive = await ZipArchive.open(bytesSource(source))
		} catch (error) {
			throw new TextConversionError("notSource", error instanceof Error ? error.message : String(error))
		}

		if (archive.get("word/document.xml") === undefined)
			throw new TextConversionError("notSource", "the package has no word/document.xml")

		const parts = new Map<string, Uint8Array>()

		for (const entry of archive.entries) {
			if (entry.name.endsWith("/")) continue

			await turn(job)

			const read = await archive.read(entry)

			parts.set(entry.name, STORY.test(entry.name) ? withoutOrigins(read) : read)
		}

		const lossy = new LossyCounts()

		standaloneParts(parts, lossy)
		await turn(job)

		return {
			bytes: await zipped(
				[...parts].map(([name, bytes]) => ({ kind: "data", name, bytes, compress: !STORED.test(name) })),
				job
			),
			lossy
		}
	} catch (error) {
		return rethrow(error)
	}
}

const ODF_REFUSALS: Readonly<Record<string, TextRefusalReason>> = {
	encrypted: "encrypted",
	notZip: "notSource",
	compoundFile: "notSource",
	notOdf: "notSource",
	wrongKind: "notSource",
	tooLarge: "tooLarge",
	invalidPackage: "corrupt",
	malformed: "corrupt"
}

export async function odtToDocx(source: Uint8Array, options: ToDocxOptions): Promise<ToDocxResult> {
	const job = jobOf(options.turns)

	try {
		const translated = await translateOdt(bytesSource(source), job === undefined ? {} : { slicing: job.aborting })

		if (!translated.ok) throw new TextConversionError(ODF_REFUSALS[translated.reason] ?? "corrupt", translated.message)

		const lossy = new LossyCounts()

		for (const [reason, count] of translated.translation.lossy) lossy.add(reason, count)

		return { bytes: await translationDocx(translated.translation, lossy, job), lossy }
	} catch (error) {
		return rethrow(error)
	}
}

const RTF_KINDS: Readonly<Record<string, TextLossyKind>> = {
	destination: "rtfDestination",
	shape: "rtfShape",
	shapeGroup: "rtfShapeGroup",
	textbox: "rtfTextbox",
	drawingObject: "rtfDrawingObject",
	object: "rtfObject",
	math: "rtfMath",
	formField: "rtfFormField",
	picture: "rtfPicture",
	tooDeep: "rtfTooDeep",
	word: "rtfWord",
	unclosedGroup: "rtfUnclosedGroup",
	trailing: "rtfTrailing"
}

// What a .docx of an RTF file lacks, from what its reader kept aside.
export function rtfLossy(read: Pick<RtfReadResult, "preserved" | "unsupportedCodepages" | "truncatedBinary">): LossyCounts {
	const lossy = new LossyCounts()

	for (const preserved of read.preserved) lossy.add(RTF_KINDS[preserved.kind] ?? "rtfDestination")

	lossy.add("rtfCodepage", read.unsupportedCodepages.length)

	if (read.truncatedBinary) lossy.add("rtfTruncatedBinary")

	return lossy
}

export async function rtfToDocx(source: Uint8Array, options: ToDocxOptions): Promise<ToDocxResult> {
	try {
		const read = await readRtf(source, options.turns === undefined ? {} : { turns: options.turns })

		if (!read.ok) throw new TextConversionError("notSource", "not an RTF file")

		const lossy = rtfLossy(read)

		// The reader's package is a complete .docx, deflated where the platform deflates natively.
		return { bytes: read.docx, lossy }
	} catch (error) {
		return rethrow(error)
	}
}

const DOC_REFUSALS: Readonly<Record<string, TextRefusalReason>> = {
	notWordBinary: "notSource",
	encryptedPackage: "encrypted",
	badSignature: "notSource",
	legacyVersion: "legacyVersion",
	encrypted: "encrypted",
	wrongPassword: "wrongPassword",
	corrupt: "corrupt",
	tooLarge: "tooLarge"
}

// A ".doc" that is an RTF file (Word saves RTF under .doc) converts as RTF; one that is a WordprocessingML package
// (a renamed .docx) is that package already.
export async function docToDocx(source: Uint8Array, options: ToDocxOptions): Promise<ToDocxResult> {
	if (isRtf(source)) return rtfToDocx(source, options)
	if (source[0] === 0x50 && source[1] === 0x4b) {
		const archive = await wordPackage(source)

		if (archive !== undefined) {
			try {
				return await asDocx(source, archive, options)
			} catch (error) {
				return rethrow(error)
			}
		}
	}

	try {
		if (options.turns?.signal.aborted === true) throw new RtfAborted()

		const result = await convertDocToDocx(bytesSource(source), {
			...(options.decryption === undefined ? {} : { decryption: options.decryption }),
			...(options.protectionKey === undefined ? {} : { protectionKey: options.protectionKey })
		})

		const lossy = new LossyCounts()

		// Without a hasher the converter reports a password on the editing restrictions as passwordProtection.
		for (const item of result.notConverted) lossy.add(item.kind, item.count)

		const deflate = nativeDeflate()

		return { bytes: await docxPackage(result.parts, deflate === undefined ? {} : { deflate }), lossy }
	} catch (error) {
		if (error instanceof DocError) throw new TextConversionError(DOC_REFUSALS[error.code] ?? "corrupt", error.message, error.encryption)

		return rethrow(error)
	}
}

async function wordPackage(source: Uint8Array): Promise<ZipArchive | undefined> {
	try {
		const archive = await ZipArchive.open(bytesSource(source))

		return archive.get("word/document.xml") !== undefined && archive.get("[Content_Types].xml") !== undefined ? archive : undefined
	} catch {
		return undefined
	}
}

const DOCUMENT_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
// Main parts of a macro-enabled document, a template and a macro-enabled template (ECMA-376 Part 1 §11.3.10, [MS-OFFMACRO2]).
const OTHER_MAINS = new Set([
	"application/vnd.ms-word.document.macroenabled.main+xml",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
	"application/vnd.ms-word.template.macroenabledtemplate.main+xml"
])
const VBA_PROJECT = "http://schemas.microsoft.com/office/2006/relationships/vbaProject"
const ELEMENT = (local: string): RegExp => new RegExp(`<${local}\\b[^>]*?/>`, "gu")
const attribute = (element: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`, "u").exec(element)?.[1]

// The part a relationship of `source` targets (an internal one): its package name.
function target(source: string, value: string): string {
	const base = value.startsWith("/") ? [] : source.split("/").slice(0, -1)

	for (const segment of value.replace(/^\//u, "").split("/")) {
		if (segment === "..") base.pop()
		else if (segment !== "." && segment !== "") base.push(segment)
	}

	return base.join("/")
}

// A WordprocessingML package renamed .doc, as a .docx: a macro-enabled document's or a template's main part typed as a
// document's, its macros (the VBA project its main part relates, and what that relates) left out and counted. A
// .docx is its own bytes.
async function asDocx(source: Uint8Array, archive: ZipArchive, options: ToDocxOptions): Promise<ToDocxResult> {
	const job = jobOf(options.turns)
	const lossy = new LossyCounts()
	const text = async (name: string): Promise<string | undefined> => {
		const entry = archive.get(name)

		return entry === undefined ? undefined : decodeUtf8(await archive.read(entry))
	}
	const replaced = new Map<string, string>()
	// Every part's internal relationships, by the part that holds them ("" the package's).
	const related = new Map<string, { readonly type: string; readonly target: string }[]>()

	for (const entry of archive.entries) {
		const match = /^(.*?)_rels\/([^/]+)\.rels$/u.exec(entry.name)

		if (match === null) continue

		const owner = `${match[1] ?? ""}${match[2] ?? ""}`
		const xml = (await text(entry.name)) ?? ""

		related.set(
			owner,
			(xml.match(ELEMENT("Relationship")) ?? [])
				.filter(element => attribute(element, "TargetMode") !== "External")
				.map(element => ({ type: attribute(element, "Type") ?? "", target: target(owner, attribute(element, "Target") ?? "") }))
		)
	}

	const MAIN = "word/document.xml"
	const projects = (related.get(MAIN) ?? []).filter(item => item.type === VBA_PROJECT).map(item => item.target)
	// The VBA projects and what they relate, transitively: what the macros are.
	const reached = new Set<string>()

	for (const start of projects) {
		const stack = [start]

		for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
			if (reached.has(name)) continue
			if (name === MAIN || name === "[Content_Types].xml" || name === "" || name.endsWith(".rels"))
				throw new TextConversionError("corrupt", `A VBA project relates ${name}.`)

			reached.add(name)

			for (const item of related.get(name) ?? []) stack.push(item.target)
		}
	}

	// Left out: what only the macros relate; a part anything else relates stays.
	const kept = new Set<string>()

	for (const [owner, items] of related)
		if (!reached.has(owner)) for (const item of items) if (!(owner === MAIN && item.type === VBA_PROJECT)) kept.add(item.target)

	const removed = new Set<string>()

	for (const name of reached)
		if (!kept.has(name)) {
			removed.add(name)
			removed.add(relsName(name))
		}

	const documentRels = relsName(MAIN)
	const withoutMacros = ((await text(documentRels)) ?? "").replace(ELEMENT("Relationship"), element =>
		attribute(element, "Type") === VBA_PROJECT ? "" : element
	)
	const macros = projects.length

	if (macros > 0) {
		lossy.add("macros", macros)
		replaced.set(documentRels, withoutMacros)
	}

	const types = (await text("[Content_Types].xml")) ?? ""
	let retyped = false
	const written = types
		.replace(ELEMENT("Override"), element => {
			const part = (attribute(element, "PartName") ?? "").replace(/^\//u, "")

			if (removed.has(part)) return ""
			if (part === "word/document.xml" && OTHER_MAINS.has((attribute(element, "ContentType") ?? "").toLowerCase())) {
				retyped = true

				return element.replace(/\sContentType="[^"]*"/u, ` ContentType="${DOCUMENT_MAIN}"`)
			}

			return element
		})
		.replace(ELEMENT("Default"), element => (/vbaProject/iu.test(attribute(element, "ContentType") ?? "") ? "" : element))

	if (!retyped && macros === 0) return { bytes: source, lossy }

	replaced.set("[Content_Types].xml", written)
	await turn(job)

	const items: ZipPlanItem[] = archive.entries
		.filter(entry => !removed.has(entry.name))
		.map(entry => {
			const markup = replaced.get(entry.name)

			return markup === undefined
				? { kind: "copy", entry }
				: { kind: "data", name: entry.name, bytes: encodeUtf8(markup), compress: true, template: entry }
		})

	return { bytes: await zipped(items, job, source), lossy }
}
