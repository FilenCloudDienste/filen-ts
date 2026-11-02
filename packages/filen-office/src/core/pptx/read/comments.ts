import { inheritedDeclarations } from "../../presentation/edit/canonical"
import {
	commentTextTooLarge,
	MAX_COMMENT_CHARACTERS,
	MAX_COMMENTS_PER_SLIDE,
	MAX_SLIDE_COMMENT_CHARACTERS,
	type CommentEntry,
	type SlideComments
} from "../../presentation/comments"
import { PresentationError } from "../../presentation/model"
import type { XmlDocument } from "../../xml/index"
import { G, partReader, type PartReader } from "./xml"

// A slide's comment parts read into the session's entries (core/presentation/comments.ts): legacy p:cmLst (ECMA-376
// Part 1 §19.4) and modern p188:cmLst (MS-PPTX §2.16). Each entry keeps its element's bytes, so an untouched comment
// is written back as the file had it.

// Legacy p:pos is in eighths of a point as PowerPoint reads it (MS-OI29500 §2.1.1137(b)): 12,700 / 8 EMU each.
export const LEGACY_POS_EMU = 1587.5

export const MODERN_COMMENTS_RELATIONSHIP = "http://schemas.microsoft.com/office/2018/10/relationships/comments"
export const MODERN_AUTHORS_RELATIONSHIP = "http://schemas.microsoft.com/office/2018/10/relationships/authors"
export const MODERN_COMMENTS_TYPE = "application/vnd.ms-powerpoint.comments+xml"
export const MODERN_AUTHORS_TYPE = "application/vnd.ms-powerpoint.authors+xml"
export const P188 = "http://schemas.microsoft.com/office/powerpoint/2018/8/main"
export const PC = "http://schemas.microsoft.com/office/powerpoint/2013/main/command"
export const P15 = "http://schemas.microsoft.com/office/powerpoint/2012/main"
// The p:cm extension holding p15:threadingInfo (MS-PPTX §2.2.10).
export const THREADING_EXT = "{C676402C-5697-4E1C-873F-D02D1690AC5C}"
// The p:sld extension holding p188:commentRel (MS-PPTX §2.2.10).
export const COMMENT_REL_EXT = "{6950BFC3-D8DA-4A85-94F7-54DA5524770B}"

export function legacyCommentId(authorId: number, idx: number): string {
	return `legacy:${String(authorId)}:${String(idx)}`
}

function bounded(count: number): void {
	if (count > MAX_COMMENTS_PER_SLIDE) throw new PresentationError("tooLarge", `${String(count)} comments on one slide`)
}

function boundedText(length: number, limit = MAX_COMMENT_CHARACTERS): void {
	if (length > limit) commentTextTooLarge(limit)
}

// The characters the next comment may hold: its own bound, or what is left of the read's (`room`, `used`).
function textRoom(room: number, used: number): number {
	return Math.min(MAX_COMMENT_CHARACTERS, room - used)
}

function scopeOf(document: XmlDocument): ReadonlyMap<string, string> {
	const root = document.documentElement()
	const first = document.firstChildElement(root)

	return first < 0 ? new Map() : inheritedDeclarations(document, first)
}

// What a part's comments come to without their entries (the deck's comment tally counts slides it does not hold).
export interface CommentCount {
	readonly comments: number
	// The characters their entries' texts would hold.
	readonly characters: number
}

// The comments of a legacy comments part, in document order; `before`: the slide's comments read from its other
// parts, which count toward its bound; `room`: the characters all its comments may hold.
export function readLegacyComments(document: XmlDocument, before = 0, room = MAX_SLIDE_COMMENT_CHARACTERS): SlideComments {
	const entries: CommentEntry[] = []

	legacyComments(document, before, room, entries)

	return { entries, scope: scopeOf(document) }
}

// A legacy part's comments counted, bounded and refused as readLegacyComments reads them, no entry made.
export function countLegacyComments(document: XmlDocument, before = 0, room = MAX_SLIDE_COMMENT_CHARACTERS): CommentCount {
	return legacyComments(document, before, room, undefined)
}

// The one walk of a legacy part: its bounds, its count, and its entries when `entries` takes them.
function legacyComments(document: XmlDocument, before: number, room: number, entries: CommentEntry[] | undefined): CommentCount {
	const r = partReader(document)
	let comments = 0
	let characters = 0
	let used = 0

	for (const cm of r.children(document.documentElement(), G.P, "cm")) {
		bounded(before + comments + 1)
		comments++

		const raw = r.text(r.child(cm, G.P, "text"))

		boundedText(raw.length, textRoom(room, used))
		used += raw.length

		const text = raw.includes("\r") ? raw.replace(/\r\n?/gu, "\n") : raw

		characters += text.length

		if (entries === undefined) continue

		const authorId = r.int(cm, "authorId") ?? 0
		const idx = r.int(cm, "idx") ?? 0
		const pos = r.child(cm, G.P, "pos")
		const x = r.int(pos, "x")
		const y = r.int(pos, "y")
		const parent = legacyParent(r, cm)
		const created = r.attr(cm, "dt") ?? ""

		entries.push({
			id: legacyCommentId(authorId, idx),
			format: "legacy",
			...(parent === undefined ? {} : { parent: legacyCommentId(parent.authorId, parent.idx) }),
			author: String(authorId),
			text,
			created,
			resolved: false,
			...(x === undefined || y === undefined ? {} : { anchor: { x: x * LEGACY_POS_EMU, y: y * LEGACY_POS_EMU } }),
			source: document.raw(cm).slice(),
			changed: false,
			plain: !raw.includes("\r"),
			legacy: { authorId, idx, ...(parent === undefined ? {} : { parent }) }
		})
	}

	return { comments, characters }
}

function legacyParent(r: PartReader, cm: number): { readonly authorId: number; readonly idx: number } | undefined {
	for (const ext of r.children(r.child(cm, G.P, "extLst"), G.P, "ext")) {
		const parent = r.child(r.child(ext, G.P15, "threadingInfo"), G.P15, "parentCm")
		const authorId = r.int(parent, "authorId")
		const idx = r.int(parent, "idx")

		if (authorId !== undefined && idx !== undefined) return { authorId, idx }
	}

	return undefined
}

// The comments of a modern Comment part: each root followed by its replies; `before` and `room` as for legacy parts.
export function readModernComments(document: XmlDocument, before = 0, room = MAX_SLIDE_COMMENT_CHARACTERS): SlideComments {
	const entries: CommentEntry[] = []

	modernComments(document, before, room, entries)

	return { entries, scope: scopeOf(document) }
}

// A modern part's comments counted, bounded and refused as readModernComments reads them, no entry made.
export function countModernComments(document: XmlDocument, before = 0, room = MAX_SLIDE_COMMENT_CHARACTERS): CommentCount {
	return modernComments(document, before, room, undefined)
}

function modernComments(document: XmlDocument, before: number, room: number, entries: CommentEntry[] | undefined): CommentCount {
	const r = partReader(document)
	let comments = 0
	let used = 0

	for (const cm of r.children(document.documentElement(), G.P188, "cm")) {
		const replies = r.children(r.child(cm, G.P188, "replyLst"), G.P188, "reply")

		bounded(before + comments + 1 + replies.length)
		comments += 1 + replies.length

		const body = bodyText(r, r.child(cm, G.P188, "txBody"), textRoom(room, used))

		used += body.text.length

		if (entries === undefined) {
			for (const reply of replies) used += bodyText(r, r.child(reply, G.P188, "txBody"), textRoom(room, used)).text.length

			continue
		}

		const id = r.attr(cm, "id") ?? ""

		const status = r.attr(cm, "status")
		const pos = r.child(cm, G.P188, "pos")
		const x = r.emu(pos, "x")
		const y = r.emu(pos, "y")
		const shape = anchoredShape(r, cm)
		const anchor = {
			...(shape === undefined ? {} : { shape }),
			...(x === undefined || y === undefined ? {} : { x, y })
		}
		const replyIds = replies.map(reply => r.attr(reply, "id") ?? "")

		entries.push({
			id,
			format: "modern",
			author: r.attr(cm, "authorId") ?? "",
			text: body.text,
			created: r.attr(cm, "created") ?? "",
			resolved: status === "resolved",
			...(Object.keys(anchor).length === 0 ? {} : { anchor }),
			source: document.raw(cm).slice(),
			changed: false,
			plain: body.plain,
			...(status === undefined || status === "active" || status === "resolved" ? {} : { status }),
			sourceReplies: replyIds
		})

		for (const [index, reply] of replies.entries()) {
			const replyStatus = r.attr(reply, "status")
			const replyBody = bodyText(r, r.child(reply, G.P188, "txBody"), textRoom(room, used))

			used += replyBody.text.length

			entries.push({
				id: replyIds[index] ?? "",
				format: "modern",
				parent: id,
				author: r.attr(reply, "authorId") ?? "",
				text: replyBody.text,
				created: r.attr(reply, "created") ?? "",
				resolved: replyStatus === "resolved",
				source: document.raw(reply).slice(),
				changed: false,
				plain: replyBody.plain,
				...(replyStatus === undefined || replyStatus === "active" || replyStatus === "resolved" ? {} : { status: replyStatus })
			})
		}
	}

	return { comments, characters: used }
}

// The cNvPr id of the shape a comment is anchored to (the last drawing-element moniker of ac:deMkLst names it).
function anchoredShape(r: PartReader, cm: number): number | undefined {
	let id: number | undefined

	for (let child = r.first(cm); child >= 0; child = r.next(child)) {
		if (r.local(child) !== "deMkLst") continue

		for (let moniker = r.first(child); moniker >= 0; moniker = r.next(moniker)) {
			const local = r.local(moniker)

			if (local !== "docMk" && local !== "sldMk") id = r.int(moniker, "id") ?? id
		}
	}

	return id
}

const PLAIN_BODY: ReadonlySet<string> = new Set(["bodyPr", "lstStyle", "p"])
const PLAIN_PARAGRAPH: ReadonlySet<string> = new Set(["pPr", "r", "br", "endParaRPr"])
const PLAIN_RUN: ReadonlySet<string> = new Set(["rPr", "t"])

// A modern comment's p188:txBody as the reader takes it: its text, and whether that is all it holds.
export function modernBodyText(document: XmlDocument, body: number): { readonly text: string; readonly plain: boolean } {
	return bodyText(partReader(document), body)
}

// A comment body's text, a paragraph per line, and whether the text is all it holds (only bodyPr, lstStyle and
// paragraphs of plain runs: no field, no mention, nothing an edit as text would lose). Refused past a comment's
// characters (or `limit`) as it grows.
function bodyText(r: PartReader, body: number, limit = MAX_COMMENT_CHARACTERS): { readonly text: string; readonly plain: boolean } {
	if (body < 0) return { text: "", plain: true }

	const lines: string[] = []
	// Line breaks between paragraphs included.
	let length = -1
	let plain = true

	for (let child = r.first(body); child >= 0; child = r.next(child)) {
		if (!r.is(child, G.A, r.local(child)) || !PLAIN_BODY.has(r.local(child))) plain = false
		if (r.local(child) !== "p") continue

		let line = ""

		for (let part = r.first(child); part >= 0; part = r.next(part)) {
			const local = r.local(part)

			if (!PLAIN_PARAGRAPH.has(local)) plain = false

			if (local === "br") line += "\n"
			else if (local === "fld") line += r.text(r.child(part, G.A, "t"))
			else if (local === "r") {
				for (let inner = r.first(part); inner >= 0; inner = r.next(inner)) if (!PLAIN_RUN.has(r.local(inner))) plain = false

				// rPr formatting beyond a language is lost to a plain-text edit.
				const rPr = r.child(part, G.A, "rPr")

				if (rPr >= 0 && (r.first(rPr) >= 0 || hasFormatting(r, rPr))) plain = false

				line += r.text(r.child(part, G.A, "t"))
			}

			boundedText(length + 1 + line.length, limit)
		}

		length += line.length + 1
		boundedText(length, limit)
		lines.push(line)
	}

	return { text: lines.join("\n"), plain }
}

function hasFormatting(r: PartReader, rPr: number): boolean {
	for (const attribute of r.document.attributes(rPr)) if (attribute.name !== "lang" && attribute.name !== "dirty") return true

	return false
}
