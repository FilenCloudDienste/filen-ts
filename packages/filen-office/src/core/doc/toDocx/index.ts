import { BytePieces } from "../../opc/pieces"
import { writeZip, type WriteZipOptions } from "../../opc/zipWriter"
import { memorySink, type ByteSource } from "../../opc/io"
import { encodeUtf8 } from "../../xml/index"
import type { DocCipherScheme } from "../decrypt"
import type { DocHeaderSet, DocPlaceholder, DocStory, DocTextBox } from "../model"
import { type DocFile, type DocReadOptions, readDocFile } from "../read"
import { type Conversion, type NoteRef, PartRelationships, StoryWriter } from "./convert"
import { readFormFields } from "./formFields"
import { MediaStore, objectPreview } from "./media"
import { numberingPart } from "./numbering"
import { readArtContent } from "./officeArt"
import type { PropsContext } from "./props"
import { ConversionReport, type DocNotConverted } from "./report"
import { fontTablePart, type HeaderReferences, sectionProperties } from "./sections"
import { dopProtection, type ProtectionKeyHash, settingsPart } from "./settings"
import { StyleMap, stylesPart } from "./styles"
import { attr, DECLARATION, NS_PKG_RELS, NS_R, STORY_NAMESPACES } from "./xml"

export type { DocNotConverted, DocNotConvertedKind } from "./report"

// A Word 97–2003 binary document (.doc/.dot, [MS-DOC]) converted to a WordprocessingML package
// (ECMA-376), written directly from the binary reader's model: Word 97–2003 layout (compatibilityMode 11).

export interface DocConversionOptions extends DocReadOptions {
	// Hashes the document's protection key (the legacy verifier) for w:documentProtection; without it a password
	// on the editing restrictions is not carried over (reported). "later": the settings part is written without
	// the hash and the result carries the key (`protectionKey`) for the caller to hash when it needs the package
	// with its password (withProtectionHash): the hash spins 100,000 SHA-1s.
	readonly protectionKey?: ((verifier: number) => Promise<ProtectionKeyHash>) | "later"
}

export type { ProtectionKeyHash } from "./settings"
export { withProtectionHash } from "./settings"

export interface DocConversionResult {
	// The parts by zip entry name.
	readonly parts: ReadonlyMap<string, Uint8Array>
	// What could not be carried over as it was (shown as placeholders or drawn differently), by kind.
	readonly notConverted: readonly DocNotConverted[]
	// How the source was encrypted when it was opened with its password; the package itself is not encrypted.
	readonly encryption: DocCipherScheme | undefined
	// With protectionKey "later": the key of the editing restrictions' password, which word/settings.xml does not
	// carry yet; undefined when there is none.
	readonly protectionKey: number | undefined
}

const CT_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
const CT_WML = "application/vnd.openxmlformats-officedocument.wordprocessingml"

function encode(markup: string): Uint8Array {
	return encodeUtf8(DECLARATION + markup)
}

function relationshipsXml(relationships: PartRelationships): string {
	return (
		`<Relationships xmlns="${NS_PKG_RELS}">` +
		relationships.entries
			.map(
				entry =>
					`<Relationship${attr("Id", entry.id)}${attr("Type", entry.type)}${attr("Target", entry.target)}${entry.external ? ' TargetMode="External"' : ""}/>`
			)
			.join("") +
		"</Relationships>"
	)
}

function relsPart(part: string): string {
	const slash = part.lastIndexOf("/")

	return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

// Reads `source` and converts it; a file that cannot be read is refused with a DocError.
export async function convertDocToDocx(source: ByteSource, options: DocConversionOptions = {}): Promise<DocConversionResult> {
	return convertDocFile(await readDocFile(source, options), options)
}

export async function convertDocFile(
	file: DocFile,
	options: Pick<DocConversionOptions, "protectionKey"> = {}
): Promise<DocConversionResult> {
	const model = file.model
	const report = new ConversionReport()
	const props: PropsContext = { fonts: model.fonts, note: kind => report.note(kind) }
	const styles = new StyleMap(model)
	const numbering = numberingPart(model.lists, props)
	const media = new MediaStore()
	const art = readArtContent(file.table, ...model.fib.fcLcb("dggInfo"), file.word)
	const parts = new Map<string, Uint8Array>()
	const types = new Map<string, string>()
	const documentRels = new PartRelationships()

	if (model.issues.length > 0) report.note("damagedContent", model.issues.length)

	// Embedded objects (EMBED fields, flt 0x3A): their result picture is converted, the object's own data is not.
	const embeds = model.fields.filter(field => field.type === 0x3a)
	const loose = model.placeholders.filter(
		placeholder => placeholder.kind === "ole" && !embeds.some(field => placeholder.cp > field.begin && placeholder.cp < field.end)
	).length
	const embedded = embeds.length + loose

	if (embedded > 0) report.note("embeddedObject", embedded)

	// Embedded objects' presentations from the ObjectPool (Word shows the field result picture for most).
	const objectPreviews = new Map<number, string>()

	for (const placeholder of model.placeholders) {
		if (placeholder.kind !== "ole" || objectPreviews.has(placeholder.objectId)) continue

		const streams = await file.objectStreams(placeholder.objectId)
		const preview = streams === undefined ? undefined : objectPreview(streams)

		if (preview !== undefined)
			objectPreviews.set(placeholder.objectId, media.add(`object:${String(placeholder.objectId)}`, preview).part)
	}

	const noteRefs = new Map<number, NoteRef>()
	const noteMarks = new Map<number, NoteRef>()

	for (const [kind, notes] of [
		["footnote", model.footnotes],
		["endnote", model.endnotes]
	] as const) {
		notes.forEach((note, k) => {
			const ref: NoteRef = { kind, id: k + 1, auto: note.auto }

			noteRefs.set(note.reference, ref)

			// The note's own reference mark: the first 0x02 of its text (it may follow other characters).
			const mark = model.text.indexOf("\u0002", note.text.start)

			if (mark >= 0 && mark < note.text.end) noteMarks.set(mark, ref)
		})
	}

	// Range markup: ends before starts at the same CP.
	const ends = new Map<number, string[]>()
	const starts = new Map<number, string[]>()
	const push = (map: Map<number, string[]>, cp: number, markup: string): void => {
		const list = map.get(cp)

		if (list === undefined) map.set(cp, [markup])
		else list.push(markup)
	}
	const storyOf = (cp: number): DocStory | undefined => model.stories.find(story => cp >= story.start && cp < story.end)
	const commentRefs = new Map<number, number>()

	model.comments.forEach((comment, id) => {
		commentRefs.set(comment.reference, id)

		const start = comment.rangeStart ?? comment.reference
		const end = comment.rangeEnd ?? comment.reference
		const story = storyOf(comment.reference)

		push(
			starts,
			story !== undefined && start >= story.start && start <= comment.reference ? start : comment.reference,
			`<w:commentRangeStart${attr("w:id", id)}/>`
		)
		push(ends, end <= comment.reference && end >= start ? end : comment.reference, `<w:commentRangeEnd${attr("w:id", id)}/>`)
	})

	const names = new Set<string>()
	let bookmarkId = 0

	for (const bookmark of model.bookmarks) {
		const story = storyOf(bookmark.start)

		if (story === undefined || bookmark.end < bookmark.start) continue

		let name = bookmark.name === "" ? `_Bookmark${String(bookmarkId)}` : bookmark.name

		for (let n = 2; names.has(name.toLowerCase()); n++) name = `${bookmark.name}_${String(n)}`

		names.add(name.toLowerCase())

		const id = bookmarkId++

		push(starts, bookmark.start, `<w:bookmarkStart${attr("w:id", id)}${attr("w:name", name)}/>`)
		push(ends, Math.min(bookmark.end, story.end), `<w:bookmarkEnd${attr("w:id", id)}/>`)
	}

	const events = new Map<number, string[]>()

	for (const cp of new Set([...ends.keys(), ...starts.keys()])) events.set(cp, [...(ends.get(cp) ?? []), ...(starts.get(cp) ?? [])])

	const fieldFlags = new Map<number, number>()

	for (const field of model.fields) fieldFlags.set(field.begin, field.flags)

	const fieldMarks = balancedFieldMarks(model)

	const placeholders = new Map<number, DocPlaceholder>()

	for (const placeholder of model.placeholders) placeholders.set(placeholder.cp, placeholder)

	const textBoxes = new Map<number, DocTextBox>()

	for (const box of model.textBoxes) if (!textBoxes.has(box.spid)) textBoxes.set(box.spid, box)

	const sectionEnds = new Map<number, number>()

	model.sections.forEach((section, k) => {
		if (k + 1 < model.sections.length && section.end > section.start) sectionEnds.set(section.end - 1, k)
	})

	// Headers and footers: one part per story, referenced by every section that shows it.
	const sectionReferences: HeaderReferences[] = []
	const headerParts = new Map<number, { part: string; kind: "header" | "footer"; story: DocStory; relationships: PartRelationships }>()
	let headerCount = 0
	let footerCount = 0
	const reference = (story: DocStory | undefined, kind: "header" | "footer"): string | undefined => {
		if (story === undefined) return undefined

		let entry = headerParts.get(story.start)

		if (entry === undefined) {
			const part = kind === "header" ? `word/header${String(++headerCount)}.xml` : `word/footer${String(++footerCount)}.xml`

			entry = { part, kind, story, relationships: new PartRelationships() }
			headerParts.set(story.start, entry)
		}

		return documentRels.add(`${NS_R}/${entry.kind}`, entry.part.slice("word/".length))
	}
	const set = (
		headers: DocHeaderSet,
		header: "evenHeader" | "oddHeader" | "firstHeader",
		footer: "evenFooter" | "oddFooter" | "firstFooter"
	) => {
		const h = reference(headers[header], "header")
		const f = reference(headers[footer], "footer")

		return { ...(h === undefined ? {} : { header: h }), ...(f === undefined ? {} : { footer: f }) }
	}

	for (const section of model.sections) {
		sectionReferences.push({
			odd: set(section.headers, "oddHeader", "oddFooter"),
			even: set(section.headers, "evenHeader", "evenFooter"),
			first: set(section.headers, "firstHeader", "firstFooter")
		})
	}

	const eventCps = [...events.keys()].sort((a, b) => a - b)
	const conversion: Conversion = {
		model,
		file,
		styles,
		props,
		numIds: numbering?.numIds ?? new Set(),
		art,
		media,
		report,
		noteRefs,
		noteMarks,
		commentRefs,
		textBoxes,
		placeholders,
		fieldMarks,
		fieldFlags,
		sectionEnds,
		sectionReferences,
		events,
		eventCps,
		formFields: readFormFields(model, file),
		ids: { docPr: 1, revision: 1, order: art.stacking.size + 1 },
		objectPreviews,
		shownBoxes: new Set()
	}
	const storyRange = (kind: DocStory["kind"]): DocStory | undefined =>
		model.stories.find(story => story.kind === kind && story.end > story.start)
	const write = (relationships: PartRelationships, story: DocStory): string => {
		const content = new StoryWriter(conversion, relationships, story.kind, story.start, story.end).write()

		return content.includes("<w:p>") || content.includes("<w:p/>") ? content : `${content}<w:p/>`
	}

	// The main document.
	const main = storyRange("main")
	const body = main === undefined ? "<w:p/>" : write(documentRels, main)
	const lastSection = model.sections.at(-1)
	const finalSectPr =
		lastSection === undefined ? "" : sectionProperties(lastSection.props, sectionReferences[model.sections.length - 1] ?? {}, props)

	types.set("/word/document.xml", CT_MAIN)

	for (const entry of headerParts.values()) {
		const root = entry.kind === "header" ? "w:hdr" : "w:ftr"

		parts.set(entry.part, encode(`<${root} ${STORY_NAMESPACES}>${write(entry.relationships, entry.story)}</${root}>`))
		types.set(`/${entry.part}`, `${CT_WML}.${entry.kind}+xml`)

		if (entry.relationships.entries.length > 0) parts.set(relsPart(entry.part), encode(relationshipsXml(entry.relationships)))
	}

	// Notes, with their separators.
	const notePart = (kind: "footnote" | "endnote"): boolean => {
		const notes = kind === "footnote" ? model.footnotes : model.endnotes

		if (notes.length === 0) return false

		const relationships = new PartRelationships()
		const separators = model.noteSeparators
		const separator = kind === "footnote" ? separators.footnoteSeparator : separators.endnoteSeparator
		const continuation = kind === "footnote" ? separators.footnoteContinuationSeparator : separators.endnoteContinuationSeparator
		const special = (type: string, id: number, story: DocStory | undefined, fallback: string): string =>
			`<w:${kind}${attr("w:type", type)}${attr("w:id", id)}>${story === undefined ? fallback : write(relationships, story)}</w:${kind}>`
		const out: string[] = [`<w:${kind}s ${STORY_NAMESPACES}>`]

		out.push(
			special(
				"separator",
				-1,
				separator,
				'<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p>'
			)
		)
		out.push(
			special(
				"continuationSeparator",
				0,
				continuation,
				'<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p>'
			)
		)

		notes.forEach((note, k) => out.push(`<w:${kind}${attr("w:id", k + 1)}>${write(relationships, note.text)}</w:${kind}>`))
		out.push(`</w:${kind}s>`)

		const part = `word/${kind}s.xml`

		parts.set(part, encode(out.join("")))
		types.set(`/${part}`, `${CT_WML}.${kind}s+xml`)
		documentRels.add(`${NS_R}/${kind}s`, `${kind}s.xml`)

		if (relationships.entries.length > 0) parts.set(relsPart(part), encode(relationshipsXml(relationships)))

		return true
	}
	const footnotes = notePart("footnote")
	const endnotes = notePart("endnote")

	if (model.comments.length > 0) {
		const relationships = new PartRelationships()
		const out: string[] = [`<w:comments ${STORY_NAMESPACES}>`]

		model.comments.forEach((comment, id) => {
			out.push(
				`<w:comment${attr("w:id", id)}${attr("w:author", comment.author === "" ? "Unknown" : comment.author)}${comment.date === undefined ? "" : attr("w:date", `${comment.date}Z`)}${comment.initials === "" ? "" : attr("w:initials", comment.initials)}>${write(
					relationships,
					comment.text
				)}</w:comment>`
			)
		})
		out.push("</w:comments>")
		parts.set("word/comments.xml", encode(out.join("")))
		types.set("/word/comments.xml", `${CT_WML}.comments+xml`)
		documentRels.add(`${NS_R}/comments`, "comments.xml")

		if (relationships.entries.length > 0) parts.set(relsPart("word/comments.xml"), encode(relationshipsXml(relationships)))
	}

	// Text boxes no shape showed (inside groups, or anchors the reader did not resolve).
	const shown = new Set<number>()

	for (const placeholder of model.placeholders) if (placeholder.kind === "shape") shown.add(placeholder.spid)
	for (const spid of conversion.shownBoxes) shown.add(spid)

	// Their text after the body's (where no anchor says), so none is left out.
	let unanchored = ""

	for (const box of model.textBoxes) {
		if (shown.has(box.spid)) continue

		report.note("shape")
		unanchored += write(documentRels, box.story)
	}

	parts.set(
		"word/document.xml",
		encode(`<w:document ${STORY_NAMESPACES}><w:body>${body}${unanchored}${finalSectPr}</w:body></w:document>`)
	)

	if (file.macros) report.note("macros")

	// pnNext is meaningful in templates only (§2.5.2: it is 0 unless fDot is set).
	if (model.fib.fDot && model.fib.pnNext !== 0) report.note("autoText")

	parts.set("word/styles.xml", encode(stylesPart(model, styles, props, numbering?.numIds ?? new Set())))
	types.set("/word/styles.xml", `${CT_WML}.styles+xml`)
	documentRels.add(`${NS_R}/styles`, "styles.xml")

	if (numbering !== undefined) {
		parts.set("word/numbering.xml", encode(numbering.xml))
		types.set("/word/numbering.xml", `${CT_WML}.numbering+xml`)
		documentRels.add(`${NS_R}/numbering`, "numbering.xml")
	}

	// A password on the editing restrictions, carried over as the hash of its key, or reported.
	const protection = dopProtection(model.dop)
	let protectionHash: ProtectionKeyHash | undefined
	let protectionKey: number | undefined

	if (protection !== undefined && protection.key !== 0) {
		const hasher = options.protectionKey

		if (hasher === "later") protectionKey = protection.key
		else {
			protectionHash = hasher === undefined ? undefined : await hasher(protection.key).catch(() => undefined)

			if (protectionHash === undefined) report.note("passwordProtection")
		}
	}

	parts.set("word/settings.xml", encode(settingsPart(model, { footnotes, endnotes }, protectionHash)))
	types.set("/word/settings.xml", `${CT_WML}.settings+xml`)
	documentRels.add(`${NS_R}/settings`, "settings.xml")
	parts.set("word/fontTable.xml", encode(fontTablePart(model.fonts)))
	types.set("/word/fontTable.xml", `${CT_WML}.fontTable+xml`)
	documentRels.add(`${NS_R}/fontTable`, "fontTable.xml")

	for (const [part, bytes] of media.parts) parts.set(part, bytes)

	parts.set("word/_rels/document.xml.rels", encode(relationshipsXml(documentRels)))
	parts.set(
		"_rels/.rels",
		encode(
			`<Relationships xmlns="${NS_PKG_RELS}"><Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="word/document.xml"/></Relationships>`
		)
	)

	const defaults = [
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
		'<Default Extension="xml" ContentType="application/xml"/>',
		...[...media.types].map(([extension, type]) => `<Default${attr("Extension", extension)}${attr("ContentType", type)}/>`)
	]
	const overrides = [...types].map(([part, type]) => `<Override${attr("PartName", part)}${attr("ContentType", type)}/>`)

	parts.set(
		"[Content_Types].xml",
		encode(
			`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join("")}${overrides.join("")}</Types>`
		)
	)

	// The package in a conventional order: content types and relationships first.
	const ordered = new Map<string, Uint8Array>()

	for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]) {
		const bytes = parts.get(name)

		if (bytes !== undefined) ordered.set(name, bytes)
	}

	for (const [name, bytes] of parts) if (!ordered.has(name)) ordered.set(name, bytes)

	return { parts: ordered, notConverted: report.list(), encryption: file.encryption, protectionKey }
}

const MAX_FIELD_DEPTH = 64

// Field characters written as fldChar: the PLC fields' and fSpec 0x13/0x14/0x15 characters the PLCs miss (as the
// text export reads them), kept only where they nest within their story, so every begin has its end.
function balancedFieldMarks(model: DocFile["model"]): Set<number> {
	const candidates = new Set<number>()

	for (const field of model.fields) {
		candidates.add(field.begin).add(field.end)

		if (field.separator !== undefined) candidates.add(field.separator)
	}

	for (const run of model.runs) {
		if (!run.props.special) continue

		for (let cp = run.start; cp < run.end; cp++) {
			const code = model.text.charCodeAt(cp)

			if (code >= 0x13 && code <= 0x15) candidates.add(cp)
		}
	}

	const out = new Set<number>()
	const sorted = [...candidates].sort((a, b) => a - b)
	let at = 0

	for (const story of model.stories) {
		// Per open field: its begin and separator.
		const stack: { begin: number; separator: number | undefined }[] = []

		for (; at < sorted.length && (sorted[at] ?? 0) < story.end; at++) {
			const cp = sorted[at] ?? 0

			if (cp < story.start) continue

			const code = model.text.charCodeAt(cp)

			if (code === 0x13) {
				if (stack.length < MAX_FIELD_DEPTH) stack.push({ begin: cp, separator: undefined })
			} else if (code === 0x14) {
				const open = stack.at(-1)

				if (open !== undefined && open.separator === undefined) open.separator = cp
			} else {
				const open = stack.pop()

				if (open !== undefined) {
					out.add(open.begin).add(cp)

					if (open.separator !== undefined) out.add(open.separator)
				}
			}
		}
	}

	return out
}

// The parts as a .docx: XML deflated, media that is already compressed stored.
export async function docxPackage(
	parts: ReadonlyMap<string, Uint8Array>,
	options: Pick<WriteZipOptions, "deflate"> = {}
): Promise<Uint8Array> {
	const sink = memorySink()
	const stored = /\.(?:png|jpe?g|gif|tiff?)$/iu

	await writeZip(
		{
			items: [...parts].map(([name, bytes]) => ({
				kind: "data" as const,
				name,
				bytes: BytePieces.of([bytes]),
				compress: !stored.test(name)
			}))
		},
		null,
		sink,
		options
	)

	return sink.bytes()
}
