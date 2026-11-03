import { partKey } from "../../../opc/index"
import { commentTime, drawingParagraphs, slideComments, type CommentEntry, type SlideComments } from "../../../presentation/comments"
import { parseInScope } from "../../../presentation/edit/canonical"
import { refused, type Author, type Deck, type Refused, type SlideNode } from "../../../presentation/model"
import { XmlEditor, decodeUtf8, encodeUtf8, escapeAttribute, escapeText, parseXml, type XmlDocument } from "../../../xml/index"
import {
	COMMENT_REL_EXT,
	LEGACY_POS_EMU,
	MODERN_AUTHORS_RELATIONSHIP,
	MODERN_AUTHORS_TYPE,
	MODERN_COMMENTS_RELATIONSHIP,
	MODERN_COMMENTS_TYPE,
	P15,
	P188,
	PC,
	THREADING_EXT,
	modernBodyText,
	readLegacyComments,
	readModernComments
} from "../../read/comments"
import { G, P_MAIN, partReader } from "../../read/xml"
import { PART_CONTENT_TYPES, RELATIONSHIPS, type PackageWriter } from "../parts"
import type { PptxEmitFamily } from "../types"
import type { ReviewSpliceInput } from "./notes"
import { URIS } from "./shape"
import { sameBytes } from "../../../docx/write/bytes"

// The comment parts of the slides whose comments changed, and the deck's author parts, written after the splice
// writer's slides. A comment part is edited in place: elements whose bytes the session still holds stay where they
// are, the ones it no longer has go, new and changed ones go in at their place in the session's order; so an undo
// after a save gives the part back byte for byte. A comment the session holds unchanged is its source bytes; a changed
// one is written from the model around the source children it does not model (anchors, positions, extensions), a new
// one wholly from the model: modern (MS-PPTX §2.16.3.3, anchored to its slide by pc:sldMkLst with the slide's p:sldId
// and p14:creationId, related from the slide with p188:commentRel in its p:extLst, §2.2.10) or legacy (ECMA-376 Part
// 1 §19.4.1; a reply threaded by p15:threadingInfo, MS-PPTX §2.4.3.2). Each written part is read back and compared
// with the session's comments (the save's proof).

const LEGACY_RELATIONSHIP = `${RELATIONSHIPS}comments`
const LEGACY_AUTHORS_RELATIONSHIP = `${RELATIONSHIPS}commentAuthors`
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const P = URIS["p"] ?? P_MAIN
const A = URIS["a"] ?? ""
const R = URIS["r"] ?? ""
const CREATION_EXT = "{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"

export const emitPptxComment: PptxEmitFamily = {
	emit: request => (request.shape === undefined ? { kind: "unchanged" } : refused("unsupported", "pptx emit comment: a shape"))
}

type Scope = ReadonlyMap<string, string>

// Declarations an element needs where `scope` does not bind `prefix` to `uri`.
function declare(scope: Scope, bindings: readonly (readonly [string, string])[]): string {
	let out = ""

	for (const [prefix, uri] of bindings) if (scope.get(prefix) !== uri) out += ` xmlns:${prefix}="${escapeAttribute(uri)}"`

	return out
}

// `raw` (one element) with the declarations of `from` the target scope lacks added to its start tag.
function inScope(raw: Uint8Array, from: Scope, target: Scope): Uint8Array {
	const missing = [...from].filter(([prefix, uri]) => uri !== "" && target.get(prefix) !== uri)

	if (missing.length === 0) return raw

	let end = 1

	while (end < raw.length && ![0x20, 0x09, 0x0a, 0x0d, 0x2f, 0x3e].includes(raw[end] ?? 0)) end++

	const head = encodeUtf8(
		missing
			.map(([prefix, uri]) => (prefix === "" ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${prefix}="${escapeAttribute(uri)}"`))
			.join("")
	)
	const out = new Uint8Array(raw.length + head.length)

	out.set(raw.subarray(0, end), 0)
	out.set(head, end)
	out.set(raw.subarray(end), end + head.length)

	return out
}

function rootScope(document: XmlDocument): Scope {
	const root = document.documentElement()

	return partReader(document).namespaces.inScope(root)
}

// The source element of an entry, parsed alone.
function parsedSource(entry: CommentEntry, scope: Scope): { readonly document: XmlDocument; readonly node: number } | undefined {
	return entry.source === undefined ? undefined : parseInScope(entry.source, scope)
}

function attributesExcept(document: XmlDocument, node: number, skip: ReadonlySet<string>): string {
	let out = ""

	for (const attribute of document.attributes(node)) {
		if (skip.has(attribute.name)) continue

		out += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`
	}

	return out
}

interface SlideFacts {
	readonly sldId: number | undefined
	readonly creationId: number | undefined
}

// --- Modern ---

function modernBody(text: string): string {
	return `<p188:txBody><a:bodyPr/><a:lstStyle/>${drawingParagraphs(text)}</p188:txBody>`
}

function statusOf(entry: CommentEntry): string {
	return entry.resolved ? ' status="resolved"' : entry.status === undefined ? "" : ` status="${escapeAttribute(entry.status)}"`
}

// A changed modern comment or reply around what its source holds that the model does not; a new one from the model.
function modernElement(
	entry: CommentEntry,
	replies: readonly CommentEntry[] | undefined,
	held: SlideComments,
	target: Scope,
	slide: SlideFacts
): string | Refused {
	const local = entry.parent === undefined ? "cm" : "reply"
	const bindings = declare(target, [
		["p188", P188],
		["a", A]
	])
	const replyList =
		replies === undefined || replies.length === 0
			? ""
			: `<p188:replyLst>${replies.map(reply => modernReply(reply, held, target)).join("")}</p188:replyLst>`
	const source = parsedSource(entry, held.scope)

	if (source === undefined) {
		const head = `<p188:${local}${bindings} id="${escapeAttribute(entry.id)}" authorId="${escapeAttribute(entry.author)}"${statusOf(entry)} created="${escapeAttribute(commentTime(entry.created) || new Date(0).toISOString())}">`

		if (entry.parent !== undefined) return `${head}${modernBody(entry.text)}</p188:${local}>`
		if (slide.sldId === undefined) return refused("failed", "A new comment on a slide without a slide id")

		const anchor =
			`<pc:sldMkLst xmlns:pc="${PC}"><pc:docMk/><pc:sldMk` +
			(slide.creationId === undefined ? "" : ` cId="${String(slide.creationId)}"`) +
			` sldId="${String(slide.sldId)}"/></pc:sldMkLst>`
		const at = entry.anchor
		const pos =
			at?.x === undefined || at.y === undefined ? "" : `<p188:pos x="${String(Math.round(at.x))}" y="${String(Math.round(at.y))}"/>`

		return `${head}${anchor}${pos}${replyList}${modernBody(entry.text)}</p188:${local}>`
	}

	const { document, node } = source
	let out = `<p188:${local}${bindings}${declareHeld(held, target)}${attributesExcept(document, node, new Set(["status"]))}${statusOf(entry)}>`
	let body = false

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const name = document.localName(child)

		if (name === "replyLst") continue
		if (name === "txBody") {
			body = true
			out += replyList
			out += modernBodyText(document, child).text === entry.text ? decodeUtf8(document.raw(child)) : modernBody(entry.text)
			continue
		}

		if (name === "extLst" && !body) {
			body = true
			out += replyList + modernBody(entry.text)
		}

		out += decodeUtf8(document.raw(child))
	}

	if (!body) out += replyList + modernBody(entry.text)

	return `${out}</p188:${local}>`
}

function declareHeld(held: SlideComments, target: Scope): string {
	let out = ""

	for (const [prefix, uri] of held.scope) {
		if (uri === "" || target.get(prefix) === uri || prefix === "p188" || prefix === "a") continue

		out += prefix === "" ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${prefix}="${escapeAttribute(uri)}"`
	}

	return out
}

function modernReply(reply: CommentEntry, held: SlideComments, target: Scope): string {
	if (!reply.changed && reply.source !== undefined) return decodeUtf8(inScope(reply.source, held.scope, target))

	const written = modernElement(reply, undefined, held, target, { sldId: undefined, creationId: undefined })

	return typeof written === "string" ? written : ""
}

// A root's bytes as the part gets them: its source when it and its replies are as read, else written.
function modernRootBytes(
	root: CommentEntry,
	replies: readonly CommentEntry[],
	held: SlideComments,
	target: Scope,
	slide: SlideFacts
): Uint8Array | Refused {
	const asRead =
		!root.changed &&
		root.source !== undefined &&
		replies.every(reply => !reply.changed && reply.source !== undefined) &&
		replies.length === (root.sourceReplies?.length ?? 0) &&
		replies.every((reply, index) => root.sourceReplies?.[index] === reply.id)

	if (asRead && root.source !== undefined) return inScope(root.source, held.scope, target)

	const written = modernElement(root, replies, held, target, slide)

	return typeof written === "string" ? encodeUtf8(written) : written
}

// --- Legacy ---

function legacyThreading(entry: CommentEntry): string {
	const parent = entry.legacy?.parent

	return parent === undefined
		? ""
		: `<p:extLst><p:ext uri="${THREADING_EXT}"><p15:threadingInfo xmlns:p15="${P15}" timeZoneBias="0"><p15:parentCm authorId="${String(parent.authorId)}" idx="${String(parent.idx)}"/></p15:threadingInfo></p:ext></p:extLst>`
}

function legacyBytes(entry: CommentEntry, held: SlideComments, target: Scope): Uint8Array {
	if (!entry.changed && entry.source !== undefined) return inScope(entry.source, held.scope, target)

	const bindings = declare(target, [["p", P]])
	const text = `<p:text>${escapeText(entry.text)}</p:text>`
	const source = parsedSource(entry, held.scope)

	if (source !== undefined) {
		const { document, node } = source
		let out = `<p:cm${bindings}${declareHeld(held, target)}${attributesExcept(document, node, new Set())}>`
		let wrote = false

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) === "text") {
				out += text
				wrote = true
			} else out += decodeUtf8(document.raw(child))
		}

		return encodeUtf8(`${out}${wrote ? "" : text}</p:cm>`)
	}

	const legacy = entry.legacy ?? { authorId: Number(entry.author), idx: 1 }
	const x = Math.round((entry.anchor?.x ?? 0) / LEGACY_POS_EMU)
	const y = Math.round((entry.anchor?.y ?? 0) / LEGACY_POS_EMU)

	return encodeUtf8(
		`<p:cm${bindings} authorId="${String(legacy.authorId)}" dt="${escapeAttribute(commentTime(entry.created) || new Date(0).toISOString())}" idx="${String(legacy.idx)}">` +
			`<p:pos x="${String(x)}" y="${String(y)}"/>${text}${legacyThreading(entry)}</p:cm>`
	)
}

// --- Splicing a part's list ---

// The part's comment elements made `wanted`, in order: an element whose bytes `wanted` has at its place stays, others
// go, the rest go in where they belong.
function spliceList(
	editor: XmlEditor,
	document: XmlDocument,
	root: number,
	elements: readonly number[],
	wanted: readonly Uint8Array[]
): void {
	let i = 0

	for (const bytes of wanted) {
		let match = -1

		for (let k = i; k < elements.length; k++) {
			if (sameBytes(document.raw(elements[k] as number), bytes)) {
				match = k
				break
			}
		}

		if (match >= 0) {
			for (let k = i; k < match; k++) editor.remove(elements[k] as number)

			i = match + 1
			continue
		}

		const next = elements[i]

		if (next === undefined) editor.append(root, bytes)
		else editor.insertBefore(next, bytes)
	}

	for (let k = i; k < elements.length; k++) editor.remove(elements[k] as number)
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
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

interface FormSpec {
	readonly relationship: string
	readonly contentType: string
	readonly root: string
	readonly rootBindings: string
	readonly elementLocal: string
	readonly group: (typeof G)[keyof typeof G]
	readonly read: (document: XmlDocument) => SlideComments
}

const MODERN: FormSpec = {
	relationship: MODERN_COMMENTS_RELATIONSHIP,
	contentType: MODERN_COMMENTS_TYPE,
	root: "p188:cmLst",
	rootBindings: `xmlns:a="${A}" xmlns:r="${R}" xmlns:p188="${P188}"`,
	elementLocal: "cm",
	group: G.P188,
	read: readModernComments
}

const LEGACY: FormSpec = {
	relationship: LEGACY_RELATIONSHIP,
	contentType: PART_CONTENT_TYPES.comments,
	root: "p:cmLst",
	rootBindings: `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`,
	elementLocal: "cm",
	group: G.P,
	read: readLegacyComments
}

// What the written part must read back as: per entry its id, parent, author, text and resolved state.
function proofOf(entries: readonly CommentEntry[]): string {
	return JSON.stringify(entries.map(entry => [entry.id, entry.parent ?? "", entry.author, entry.text, entry.resolved]))
}

async function slideFactsOf(input: ReviewSpliceInput, node: SlideNode, slidePart: string): Promise<SlideFacts> {
	const document = await input.writer.loadDocument(slidePart)
	const r = partReader(document)
	let creationId: number | undefined

	for (const ext of r.children(r.child(r.child(document.documentElement(), G.P, "cSld"), G.P, "extLst"), G.P, "ext")) {
		if (r.attr(ext, "uri") === CREATION_EXT) creationId = r.int(r.child(ext, G.P14, "creationId"), "val")
	}

	return { sldId: input.slideId(node.ref), creationId }
}

// One form's comments of a slide written: its part edited, added or removed. Answers whether the slide relates a
// modern comment part after the save.
async function writeForm(
	input: ReviewSpliceInput,
	spec: FormSpec,
	node: SlideNode,
	slidePart: string,
	held: SlideComments,
	entries: readonly CommentEntry[]
): Promise<Refused | undefined> {
	const { writer } = input
	const relationships = await writer.loadRelationships(slidePart)
	const related = relationships.all().find(relationship => relationship.type === spec.relationship && !relationship.external)
	const modern = spec === MODERN
	const roots = modern ? entries.filter(entry => entry.parent === undefined) : entries
	const repliesOf = (root: CommentEntry): CommentEntry[] => entries.filter(entry => entry.parent === root.id)

	if (entries.length === 0) {
		if (related === undefined) return undefined

		writer.remove(related.target)
		relationships.remove(related.id)

		if (modern) commentRel(writer, slidePart, undefined)

		return undefined
	}

	const facts = modern ? await slideFactsOf(input, node, slidePart) : { sldId: undefined, creationId: undefined }
	const bytesOf = (target: Scope): Uint8Array[] | Refused => {
		const out: Uint8Array[] = []

		for (const root of roots) {
			const bytes = modern ? modernRootBytes(root, repliesOf(root), held, target, facts) : legacyBytes(root, held, target)

			if (!(bytes instanceof Uint8Array)) return bytes

			out.push(bytes)
		}

		return out
	}

	let written: Uint8Array
	let name: string

	if (related !== undefined && writer.exists(related.target)) {
		name = related.target

		const document = await writer.loadDocument(name)
		const root = document.documentElement()
		const r = partReader(document)
		const wanted = bytesOf(rootScope(document))

		if (!Array.isArray(wanted)) return wanted

		const editor = new XmlEditor(document)

		spliceList(editor, document, root, r.children(root, spec.group, spec.elementLocal), wanted)

		if (!editor.changed) return undefined

		written = editor.serialize()
		writer.replace(name, written)
	} else {
		const scope: Scope = new Map(
			modern
				? [
						["a", A],
						["r", R],
						["p188", P188]
					]
				: [
						["a", A],
						["r", R],
						["p", P]
					]
		)
		const wanted = bytesOf(scope)

		if (!Array.isArray(wanted)) return wanted

		name = writer.allocateOwn(
			`${partKey(slidePart)} ${spec.relationship}`,
			"comments",
			spec.contentType,
			modern ? "ppt/comments/modernComment1.xml" : undefined
		)
		written = joinBytes([encodeUtf8(`${XML_DECLARATION}<${spec.root} ${spec.rootBindings}>`), ...wanted, encodeUtf8(`</${spec.root}>`)])
		writer.add(name, spec.contentType, written)

		if (related !== undefined) relationships.remove(related.id)

		const id = writer.relate(slidePart, name, spec.relationship)

		if (modern) commentRel(writer, slidePart, id)
	}

	return proveForm(spec, written, entries)
}

function proveForm(spec: FormSpec, written: Uint8Array, entries: readonly CommentEntry[]): Refused | undefined {
	const read = spec.read(parseXml(written))

	return proofOf(read.entries) === proofOf(entries)
		? undefined
		: refused("failed", "A comment part does not read back as the session's comments")
}

// The slide's p188:commentRel (in its p:extLst) naming `id`, or none: made on the slide's final bytes, after the
// splice writer's own edits of it (a whole-root rewrite included).
function commentRel(writer: PackageWriter, slidePart: string, id: string | undefined): void {
	writer.patchAfter(slidePart, (document, editor) => {
		const r = partReader(document)
		const root = document.documentElement()
		const list = r.child(root, G.P, "extLst")
		const exts = r.children(list, G.P, "ext")
		const existing = exts.find(ext => r.attr(ext, "uri") === COMMENT_REL_EXT)

		if (id === undefined) {
			if (existing === undefined) return

			editor.remove(exts.length === 1 ? list : existing)

			return
		}

		const scope = r.namespaces.inScope(root)
		const prefix = r.namespaces.prefixFor(root, P)
		const p = prefix ?? "p"
		const q = (local: string): string => (p === "" ? local : `${p}:${local}`)
		const rel = r.namespaces.prefixFor(root, R)
		const bindings = (prefix === undefined ? ` xmlns:p="${P}"` : "") + (rel === undefined ? ` xmlns:r="${R}"` : "")
		const ext = `<${q("ext")}${bindings} uri="${COMMENT_REL_EXT}"><p188:commentRel${declare(scope, [["p188", P188]])} ${rel ?? "r"}:id="${escapeAttribute(id)}"/></${q("ext")}>`

		if (existing !== undefined) editor.replace(existing, ext)
		else if (list >= 0) editor.append(list, ext)
		else editor.append(root, `<${q("extLst")}${bindings}>${ext}</${q("extLst")}>`)
	})
}

// --- Authors ---

async function spliceAuthors(input: ReviewSpliceInput, legacy: boolean): Promise<Refused | undefined> {
	const { writer, deck } = input
	const main = input.mainPart
	const relationships = await writer.loadRelationships(main)
	const type = legacy ? LEGACY_AUTHORS_RELATIONSHIP : MODERN_AUTHORS_RELATIONSHIP
	const related = relationships.all().find(relationship => relationship.type === type && !relationship.external)
	const wanted = deck.authors.filter(author => (author.legacyId !== undefined) === legacy)
	const lastIdx = legacy ? legacyLastIndices(deck) : new Map<number, number>()

	if (related === undefined || !writer.exists(related.target)) {
		if (wanted.length === 0) return undefined

		const name = legacy ? "ppt/commentAuthors.xml" : "ppt/authors.xml"
		const own = writer.claim(name)
			? name
			: writer.allocate("commentAuthors", legacy ? PART_CONTENT_TYPES.commentAuthors : MODERN_AUTHORS_TYPE)
		const items = wanted.map((author, index) => authorMarkup(author, legacy, lastIdx, index)).join("")
		const markup = legacy
			? `${XML_DECLARATION}<p:cmAuthorLst xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">${items}</p:cmAuthorLst>`
			: `${XML_DECLARATION}<p188:authorLst xmlns:a="${A}" xmlns:r="${R}" xmlns:p188="${P188}">${items}</p188:authorLst>`

		writer.add(own, legacy ? PART_CONTENT_TYPES.commentAuthors : MODERN_AUTHORS_TYPE, encodeUtf8(markup))

		if (related !== undefined) relationships.remove(related.id)

		writer.relate(main, own, type)

		return undefined
	}

	const document = await writer.loadDocument(related.target)
	const r = partReader(document)
	const root = document.documentElement()
	const elements = r.children(root, legacy ? G.P : G.P188, legacy ? "cmAuthor" : "author")
	const editor = new XmlEditor(document)
	const ids = new Set(wanted.map(author => author.id))
	const present = new Set<string>()
	let clr = 0

	for (const element of elements) {
		const id = r.attr(element, "id") ?? ""

		clr = Math.max(clr, (r.int(element, "clrIdx") ?? 0) + 1)

		if (!ids.has(id)) {
			editor.remove(element)
			continue
		}

		present.add(id)

		if (legacy) {
			const last = lastIdx.get(Number(id)) ?? 0

			if (last > (r.int(element, "lastIdx") ?? 0)) editor.setAttribute(element, "lastIdx", String(last))
		}
	}

	const added = wanted.filter(author => !present.has(author.id))

	if (added.length > 0) {
		const bindings = declare(r.namespaces.inScope(root), [legacy ? ["p", P] : ["p188", P188]])

		editor.append(root, added.map((author, index) => authorMarkup(author, legacy, lastIdx, clr + index, bindings)).join(""))
	}

	if (!editor.changed) return undefined

	// The last author an undo took back: the part goes, as it came.
	if (wanted.length === 0 && present.size === 0) {
		writer.remove(related.target)
		relationships.remove(related.id)

		return undefined
	}

	writer.replace(related.target, editor.serialize())

	return undefined
}

function authorMarkup(author: Author, legacy: boolean, lastIdx: ReadonlyMap<number, number>, clrIdx: number, bindings = ""): string {
	const initials = author.initials === undefined ? "" : ` initials="${escapeAttribute(author.initials)}"`

	if (legacy)
		return `<p:cmAuthor${bindings} id="${String(author.legacyId ?? 0)}" name="${escapeAttribute(author.name)}"${initials} lastIdx="${String(lastIdx.get(author.legacyId ?? 0) ?? 0)}" clrIdx="${String(clrIdx)}"/>`

	return `<p188:author${bindings} id="${escapeAttribute(author.id)}" name="${escapeAttribute(author.name)}"${initials} userId="${escapeAttribute(author.userId ?? author.name)}" providerId="${escapeAttribute(author.providerId ?? "None")}"/>`
}

// Each legacy author's highest comment index among the comments the session read.
function legacyLastIndices(deck: Deck): Map<number, number> {
	const out = new Map<number, number>()

	for (const ref of deck.slides) {
		for (const entry of slideComments(deck, ref)?.entries ?? []) {
			const legacy = entry.legacy

			if (legacy !== undefined) out.set(legacy.authorId, Math.max(out.get(legacy.authorId) ?? 0, legacy.idx))
		}
	}

	return out
}

// --- The hook ---

export async function spliceComments(input: ReviewSpliceInput): Promise<Refused | undefined> {
	const { deck, changes } = input
	const changedParts = new Set<string>()

	for (const [part, change] of changes.parts) if (change.slide !== undefined || change.change === "added") changedParts.add(partKey(part))

	let legacyWritten = false
	let modernWritten = false

	for (const ref of deck.slides) {
		const node = deck.nodes.get(ref)
		const held = slideComments(deck, ref)
		const slidePart = input.slidePart(ref)

		if (node === undefined || held === undefined || slidePart === undefined || !changedParts.has(partKey(node.part))) continue

		for (const [spec, form] of [
			[MODERN, "modern"],
			[LEGACY, "legacy"]
		] as const) {
			const entries = held.entries.filter(entry => entry.format === form)
			const refusal = await writeForm(input, spec, node, slidePart, held, entries)

			if (refusal !== undefined) return refusal
			if (entries.length > 0 && form === "legacy") legacyWritten = true
			if (entries.length > 0 && form === "modern") modernWritten = true
		}
	}

	const authorsTouched = changes.presentation.has("authors")

	if (authorsTouched || modernWritten) {
		const refusal = await spliceAuthors(input, false)

		if (refusal !== undefined) return refusal
	}

	if (authorsTouched || legacyWritten) return spliceAuthors(input, true)

	return undefined
}
