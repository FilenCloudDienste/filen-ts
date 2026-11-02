import type { OpcPackage, Slicing } from "../../../core/opc/index"
import { readAnnotations } from "../../../core/odp/read/annotations"
import { countPageAnnotations } from "../../../core/odp/read/annotationCount"
import { Fragment } from "../../../core/odp/read/context"
import { pageFragment } from "../../../core/odp/read/scan"
import { odpWriteSource } from "../../../core/odp/write/source"
import {
	MODERN_COMMENTS_RELATIONSHIP,
	MODERN_COMMENTS_TYPE,
	countLegacyComments,
	countModernComments,
	readLegacyComments,
	readModernComments
} from "../../../core/pptx/read/comments"
import { G, partReader } from "../../../core/pptx/read/xml"
import { Namespaces, XmlError, encodeUtf8, type XmlDocument } from "../../../core/xml/index"
import {
	canOf,
	commentCharacterRoom,
	commentCharacters,
	commentViews,
	copiedCommentCharacters,
	countUnheldComments,
	markUnreadableComments,
	unreadableComments,
	reviewFacts,
	setReviewFacts,
	setSlideComments,
	slideComments,
	type CommentEntry,
	type DeckReviewFacts,
	type SlideComments,
	type SlideReview
} from "../../../core/presentation/comments"
import type { DeckOp } from "../../../core/presentation/edit/ops"
import { PresentationError, type Deck, type SlideNode, type SlideRef } from "../../../core/presentation/model"
import { EMU_PER_PX } from "../../../core/drawingml/index"
import { resolveShape } from "../../../core/presentation/inherit"
import { notesTarget, notesText } from "../../../core/presentation/notes"
import type { CallContext, EngineSession } from "../engine"
import { dormantNotes } from "./dormantNotes"
import { odpParts } from "./open/odp"
import { pptxParts } from "./open/pptx"

// The review capability: a slide's notes and comments for the page's panes (review()), and what a notes or comment op
// needs read before it applies (prepareReview): the deck's comment facts (the form new comments take, legacy authors'
// last indices, the package's part names) and the slide's comments. Comments are read per slide, once, when first
// asked for (the Comments pane or a comment op; never for the notes pane alone); the session keeps them
// (core/presentation/comments.ts) across saves.

const LEGACY_COMMENTS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
const LEGACY_AUTHORS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors"
const LEGACY_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.comments+xml"

const NO_FACTS_ODP: DeckReviewFacts = { format: "odf", takenParts: new Set(), legacyLastIdx: new Map(), commented: true }

async function deckFacts(session: EngineSession, slicing: Slicing | undefined): Promise<DeckReviewFacts> {
	const deck = session.deck
	const held = reviewFacts(deck)

	if (held !== undefined) return held

	if (deck.format === "odp") {
		setReviewFacts(deck, NO_FACTS_ODP)

		return NO_FACTS_ODP
	}

	const parts = pptxParts(deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "comments of this deck")

	const opc = parts.opc
	const types = await opc.contentTypes()
	const takenParts = new Set<string>()
	let modern = false
	let legacy = false

	for (const entry of opc.entries()) {
		const name = entry.name.toLowerCase()

		takenParts.add(name)

		const type = types.typeOf(entry.name)

		if (type === MODERN_COMMENTS_TYPE) modern = true
		else if (type === LEGACY_TYPE) legacy = true
	}

	const legacyLastIdx = new Map<number, number>()
	const main = (await opc.relationships("")).all.find(
		relationship => !relationship.external && relationship.type.endsWith("/officeDocument")
	)

	for (const relationship of main?.partName === undefined ? [] : (await opc.relationships(main.partName)).all) {
		if (relationship.type !== LEGACY_AUTHORS || relationship.partName === undefined || !opc.has(relationship.partName)) continue

		checkSize(parts.budgets.xmlPartBytes, opc.entry(relationship.partName)?.uncompressedSize ?? 0, relationship.partName)

		const document = await opc.xml(relationship.partName, slicing)
		const r = partReader(document)

		for (const author of r.children(document.documentElement(), G.P, "cmAuthor")) {
			const id = r.int(author, "id")
			const last = r.int(author, "lastIdx")

			if (id !== undefined && last !== undefined) legacyLastIdx.set(id, last)
		}
	}

	const facts: DeckReviewFacts = {
		format: legacy && !modern ? "legacy" : "modern",
		takenParts,
		legacyLastIdx,
		commented: legacy || modern
	}

	setReviewFacts(deck, facts)

	return facts
}

function checkSize(budget: number, size: number, part: string): void {
	if (size > budget) throw new PresentationError("tooLarge", `XML part ${part}`)
}

// A pptx slide's comments: its legacy and modern comment parts (a new slide's are its source slide's, which a save
// copies with it).
async function pptxSlideComments(session: EngineSession, node: SlideNode, slicing: Slicing | undefined): Promise<SlideComments> {
	return pptxPartComments(session, node.ref, pptxSource(session, node.ref), slicing)
}

// A comments part parsed; markup that is no XML refuses as malformed (typed, as every other refusal of the review).
async function commentsDocument(opc: OpcPackage, name: string, slicing: Slicing | undefined): Promise<XmlDocument> {
	try {
		return await opc.xml(name, slicing)
	} catch (error) {
		if (error instanceof XmlError) throw new PresentationError("malformed", `comments part ${name}: ${error.message}`)

		throw error
	}
}

// The part a pptx slide's comments are related from: its own when the package has it, else (a copy not written yet)
// its source slide's; for a slide not parsed, its part.
function pptxSource(session: EngineSession, ref: SlideRef): string | undefined {
	const parts = pptxParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "comments of this deck")

	const node = session.deck.nodes.get(ref)

	if (node === undefined) return parts.partOf(ref)?.replace(/^\//u, "")

	const own = node.part.replace(/^\//u, "")

	return parts.opc.has(own)
		? own
		: node.src?.format === "pptx" && node.src.epoch === parts.epoch
			? node.src.part.replace(/^\//u, "")
			: undefined
}

// Each comments part slide part `source` relates, read once however many times it is related (its entries would
// repeat), in relationship order.
async function eachCommentsPart(
	session: EngineSession,
	source: string | undefined,
	slicing: Slicing | undefined,
	visit: (document: XmlDocument, modern: boolean) => void
): Promise<void> {
	const parts = pptxParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "comments of this deck")

	const opc = parts.opc

	if (source === undefined || !opc.has(source)) return

	const read = new Set<string>()

	for (const relationship of (await opc.relationships(source)).all) {
		const modern = relationship.type === MODERN_COMMENTS_RELATIONSHIP
		const name = relationship.partName

		if ((!modern && relationship.type !== LEGACY_COMMENTS) || name === undefined || read.has(name) || !opc.has(name)) continue

		read.add(name)
		checkSize(parts.budgets.xmlPartBytes, opc.entry(name)?.uncompressedSize ?? 0, name)
		visit(await commentsDocument(opc, name, slicing), modern)
	}
}

// The comments of slide `ref` as its slide part `source` relates them (none without one); the slide's bounds span all
// its parts, its characters within what the slide may hold (its bound, or what is left of the deck's).
async function pptxPartComments(
	session: EngineSession,
	ref: SlideRef,
	source: string | undefined,
	slicing: Slicing | undefined
): Promise<SlideComments> {
	const entries: CommentEntry[] = []
	let scope: ReadonlyMap<string, string> = new Map()
	const room = commentCharacterRoom(session.deck, ref)
	let used = 0

	await eachCommentsPart(session, source, slicing, (document, modern) => {
		const part = (modern ? readModernComments : readLegacyComments)(document, entries.length, room - used)

		for (const entry of part.entries) {
			entries.push(entry)
			used += entry.text.length
		}

		if (part.entries.length > 0) scope = new Map([...scope, ...part.scope])
	})

	return { entries, scope }
}

// What pptxPartComments' entries' texts come to, counted under the same bounds with no entry made.
async function pptxPartCharacters(
	session: EngineSession,
	ref: SlideRef,
	source: string | undefined,
	slicing: Slicing | undefined
): Promise<number> {
	const room = commentCharacterRoom(session.deck, ref)
	let comments = 0
	let characters = 0

	await eachCommentsPart(session, source, slicing, (document, modern) => {
		const part = (modern ? countModernComments : countLegacyComments)(document, comments, room - characters)

		comments += part.comments
		characters += part.characters
	})

	return characters
}

async function odpSlideComments(session: EngineSession, node: SlideNode): Promise<SlideComments> {
	const parts = odpParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "comments of this deck")

	const src = node.src

	if (src?.format !== "odp") return { entries: [], scope: new Map() }

	const fragment = odpWriteSource(parts).fragmentOf(src)

	return fragment === undefined
		? { entries: [], scope: new Map() }
		: readAnnotations(fragment, src.node, commentCharacterRoom(session.deck, node.ref))
}

async function parsedSlide(session: EngineSession, slide: SlideRef, slicing: Slicing | undefined): Promise<SlideNode> {
	const deck = session.deck
	const held = deck.nodes.get(slide)

	if (held !== undefined) return held
	if (!deck.slides.includes(slide)) throw new PresentationError("notFound", `slide ${String(slide)}`)

	const parts = deck.format === "odp" ? odpParts(deck) : pptxParts(deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "review of this deck")

	return parts.slide(slide, slicing)
}

// The slide's comments, read once.
async function loadComments(session: EngineSession, node: SlideNode, slicing: Slicing | undefined): Promise<SlideComments> {
	const deck: Deck = session.deck
	const held = slideComments(deck, node.ref)

	if (held !== undefined) return held

	const read = deck.format === "odp" ? await odpSlideComments(session, node) : await pptxSlideComments(session, node, slicing)

	setSlideComments(deck, node.ref, read)

	return read
}

// What a notes or comment op reads before it applies (dom/presentation/engine/edit.ts prepare).
// An unparsed ODP page's comments, read from its span without parsing the page (a page whose bytes name no annotation
// is not parsed at all), the fragment dropped after.
// An unparsed ODP page's comment characters, counted from its span without parsing the page (a page whose bytes name
// no annotation is not looked at further); a page the count leaves to the reader (annotationCount.ts) is read, its
// fragment dropped after.
function odpPageCharacters(session: EngineSession, ref: SlideRef): number {
	const parts = odpParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "comments of this deck")

	const span = parts.span(ref)

	if (span === undefined || !includesBytes(parts.content.bytes, span.start, span.end, ANNOTATION_BYTES)) return 0

	const room = commentCharacterRoom(session.deck, ref)
	const counted = countPageAnnotations(parts.content, span, room)

	if (counted !== undefined) return counted

	let document: XmlDocument

	try {
		document = pageFragment(parts.content, span)
	} catch (error) {
		if (error instanceof XmlError) throw new PresentationError("malformed", `page ${String(ref)}: ${error.message}`)

		throw error
	}

	const fragment = new Fragment(document, new Namespaces(document, { lenient: true }), "content.xml", span.start, "content", parts.epoch)

	return commentCharacters(readAnnotations(fragment, document.firstChildElement(document.documentElement()), room))
}

// "annotation": both officeooo:annotation and office:annotation name it.
const ANNOTATION_BYTES = encodeUtf8("annotation")

function includesBytes(bytes: Uint8Array, from: number, to: number, needle: Uint8Array): boolean {
	const first = needle[0] ?? 0

	for (let at = bytes.indexOf(first, from); at >= 0 && at + needle.length <= to; at = bytes.indexOf(first, at + 1)) {
		let k = 1

		while (k < needle.length && bytes[at + k] === needle[k]) k++

		if (k === needle.length) return true
	}

	return false
}

// Every listed slide's comment characters, for those neither read nor counted yet: each read only to be counted
// (holding nothing, no slide parsed for it), within the slide's bound and what is left of the deck's, so a duplicate
// is held to the bound of the whole deck as a reopen reads it, not of the slides visited so far. Once per slide and
// session (counts are kept).
async function countDeckComments(session: EngineSession, source: SlideRef, slicing: Slicing | undefined): Promise<void> {
	const deck = session.deck
	// A package without a comments part has none to count (the session's own are held, so counted).
	const commented = deck.format !== "pptx" || (await deckFacts(session, slicing)).commented
	const count = async (ref: SlideRef): Promise<void> => {
		const node = deck.nodes.get(ref)
		let characters: number

		if (deck.format === "odp")
			characters = node === undefined ? odpPageCharacters(session, ref) : commentCharacters(await odpSlideComments(session, node))
		else characters = commented ? await pptxPartCharacters(session, ref, pptxSource(session, ref), slicing) : 0

		countUnheldComments(deck, ref, characters)
	}
	const counted = (ref: SlideRef): boolean => slideComments(deck, ref) !== undefined || copiedCommentCharacters(deck, ref) !== undefined

	// The source's own refusal refuses its duplicate: the copy would carry comments no reader takes (read again, so the
	// refusal is the one the deck's state gives now).
	if (!counted(source)) await count(source)

	for (const ref of deck.slides) {
		if (counted(ref) || unreadableComments(deck, ref)) continue

		try {
			await count(ref)
		} catch (error) {
			// Another slide's comments that refuse to read count 0, as a reopen holds them (its review refuses that
			// slide alone): they never refuse an unrelated duplicate.
			if (!(error instanceof PresentationError)) throw error

			markUnreadableComments(deck, ref)
		}
	}
}

export async function prepareReview(session: EngineSession, op: DeckOp, slicing: Slicing | undefined): Promise<void> {
	if (op.family === "batch") {
		for (const each of op.ops) await prepareReview(session, each, slicing)

		return
	}

	const deck = session.deck

	// A duplicate brings its source's comments: the deck's are counted first (read, not held: no slide's model changes), so
	// the copy is counted against the deck's bound when it applies (apply/slide.ts).
	if (op.family === "slide" && op.kind === "duplicate") {
		if (deck.format !== "ppt") await countDeckComments(session, op.slide, slicing)

		return
	}

	if (op.family !== "comment" && op.family !== "notes") return

	if (deck.format === "ppt") throw new PresentationError("viewOnly", "a ppt deck")

	await deckFacts(session, slicing)

	const node = await parsedSlide(session, op.slide, slicing)

	if (op.family === "comment") await loadComments(session, node, slicing)
}

// `comments: false` (the notes pane): the slide's comments are neither read nor kept, and none are answered.
export async function review(context: CallContext, slide: SlideRef, options?: { readonly comments?: boolean }): Promise<SlideReview> {
	const session = context.session
	const deck = session.deck
	const node = await parsedSlide(session, slide, context.slicing)

	if (node.kind !== "slide") throw new PresentationError("unsupported", "the review of a node that is not a slide")

	const facts = await deckFacts(session, context.slicing)
	const comments = options?.comments === false ? undefined : await loadComments(session, node, context.slicing)
	const format = facts.format
	const made = notesTarget(deck, slide)
	// Notes a save took back while the page's editor may be on them: still answered (empty), made again by its first input.
	const dormant = made === undefined ? dormantNotes(session, slide) : undefined
	const notes = made ?? dormant?.notes
	const box = made === undefined ? dormant?.box : notesBoxOf(deck, made)

	return {
		slide,
		format,
		comments: commentViews(deck, comments),
		...(notes === undefined ? {} : { notes }),
		...(box === undefined ? {} : { notesBox: box }),
		notesText: notesText(deck, node),
		can: canOf(format)
	}
}

// The notes body's box on its notes page (px), inherited from the notes master where the notes slide writes none.
export function notesBoxOf(deck: Deck, notes: { readonly slide: SlideRef; readonly id: number }): SlideReview["notesBox"] {
	const shape = deck.nodes.get(notes.slide)?.shapes.find(each => each.id === notes.id)
	const xfrm = shape === undefined ? undefined : resolveShape(deck, notes.slide, shape).xfrm

	return xfrm === undefined
		? undefined
		: { x: xfrm.x / EMU_PER_PX, y: xfrm.y / EMU_PER_PX, width: xfrm.cx / EMU_PER_PX, height: xfrm.cy / EMU_PER_PX }
}

export const reviewCapability = { review }
