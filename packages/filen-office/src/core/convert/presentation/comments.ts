import { OdfNs } from "../../odf/index"
import { ANNOTATION, readAnnotations } from "../../odp/read/annotations"
import type { OdpParts } from "../../odp/read/document"
import { odpWriteSource } from "../../odp/write/source"
import {
	eachSlideCommentsPart,
	LEGACY_POS_EMU,
	readLegacyComments,
	readModernComments,
	slideCommentSource,
	type CommentSourceParts
} from "../../pptx/read/comments"
import {
	authorOf,
	commentTime,
	initialsOf,
	MAX_SLIDE_COMMENT_CHARACTERS,
	odfParagraphs,
	slideComments,
	threadOrder,
	type CommentEntry
} from "../../presentation/comments"
import type { Deck, ShapeNode, SlideNode, SlideRef } from "../../presentation/model"
import type { Slicing } from "../../slicing"
import { escapeAttribute, escapeText } from "../../xml/index"
import type { ConversionReport } from "./report"

// A deck's comments on their way to the other format. Each slide's are the session's when it holds them (edits
// included), else read from the source (a PresentationML slide's comment parts, an ODF page's annotations) under the
// readers' bounds; a slide whose comments refuse to read refuses the conversion (never dropped). PresentationML
// comments become officeooo:annotation (LibreOffice's annotation of a draw:page): a reply is an annotation of its own
// at its thread's place, and a resolved or closed state is left out, each counted. ODF annotations become legacy
// PresentationML comments (ECMA-376 Part 1 §19.4), every one of them carried.

export type SlideCommentsOf = ReadonlyMap<SlideRef, readonly CommentEntry[]>

const EMU_PER_CM = 360_000
// What an annotation names beyond the content stream's own namespaces (svg, text).
const ANNOTATION_NAMESPACES = `xmlns:officeooo="${OdfNs.officeooo}" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="${OdfNs.meta}"`

// Every slide's comments, in thread order.
export async function deckComments(
	deck: Deck,
	source: { readonly format: "pptx" | "ppt"; readonly parts: CommentSourceParts } | { readonly format: "odp"; readonly parts: OdpParts },
	slicing: Slicing | undefined
): Promise<SlideCommentsOf> {
	const out = new Map<SlideRef, readonly CommentEntry[]>()

	for (const ref of deck.slides) {
		const held = slideComments(deck, ref)
		let entries: readonly CommentEntry[]

		if (held !== undefined) entries = held.entries
		else if (source.format === "odp") entries = odpPageEntries(deck, source.parts, ref)
		else {
			const read: CommentEntry[] = []

			await eachSlideCommentsPart(source.parts, slideCommentSource(source.parts, deck, ref), slicing, (document, modern) => {
				const part = (modern ? readModernComments : readLegacyComments)(document, read.length, MAX_SLIDE_COMMENT_CHARACTERS)

				for (const entry of part.entries) read.push(entry)
			})
			entries = read
		}

		if (entries.length > 0) out.set(ref, threadOrder(entries))
	}

	return out
}

function odpPageEntries(deck: Deck, parts: OdpParts, ref: SlideRef): readonly CommentEntry[] {
	const src = deck.nodes.get(ref)?.src

	if (src?.format !== "odp") return []

	const fragment = odpWriteSource(parts).fragmentOf(src)

	return fragment === undefined ? [] : readAnnotations(fragment, src.node).entries
}

function cm(emu: number): string {
	return `${String(Math.round((emu / EMU_PER_CM) * 1000) / 1000)}cm`
}

function findShape(shapes: readonly ShapeNode[], id: number): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.id === id) return shape

		const inner = shape.children === undefined ? undefined : findShape(shape.children, id)

		if (inner !== undefined) return inner
	}

	return undefined
}

// Where a comment is placed (EMU): its own place, else the top left of the shape it is anchored to, else its
// thread's, else the slide's top left.
function placeOf(
	entry: CommentEntry,
	slide: SlideNode,
	places: ReadonlyMap<string, { readonly x: number; readonly y: number }>
): {
	readonly x: number
	readonly y: number
} {
	const anchor = entry.anchor

	if (anchor?.x !== undefined && anchor.y !== undefined) return { x: anchor.x, y: anchor.y }

	const shape = anchor?.shape === undefined ? undefined : findShape(slide.shapes, anchor.shape)?.xfrm

	if (shape !== undefined) return { x: shape.x, y: shape.y }

	return (entry.parent === undefined ? undefined : places.get(entry.parent)) ?? { x: 0, y: 0 }
}

// A PresentationML slide's comments as the annotations of its draw:page (officeooo, dc and meta
// declared on each), each counted where it carries less.
export function odpAnnotations(deck: Deck, slide: SlideNode, entries: readonly CommentEntry[], report: ConversionReport): string {
	const places = new Map<string, { readonly x: number; readonly y: number }>()
	const slideNumber = deck.slides.indexOf(slide.ref) + 1
	let out = ""

	for (const entry of entries) {
		const place = placeOf(entry, slide, places)
		const author = authorOf(deck, entry)
		const name = entry.format === "odf" ? entry.author : (author?.name ?? "")
		const initials = entry.format === "odf" ? "" : (author?.initials ?? initialsOf(name))
		const created = commentTime(entry.created)

		places.set(entry.id, place)

		if (entry.parent !== undefined) report.note("commentReply", 1, [slideNumber])
		if (entry.resolved || entry.status !== undefined) report.note("commentState", 1, [slideNumber])
		if (!entry.plain) report.note("text", 1, [slideNumber])

		out +=
			`<${ANNOTATION} ${ANNOTATION_NAMESPACES} svg:x="${cm(place.x)}" svg:y="${cm(place.y)}">` +
			`<dc:creator>${escapeText(name)}</dc:creator>` +
			(created === "" ? "" : `<dc:date>${escapeText(created)}</dc:date>`) +
			(initials === "" ? "" : `<meta:creator-initials>${escapeText(initials)}</meta:creator-initials>`) +
			`${odfParagraphs(entry.text)}</${ANNOTATION}>`
	}

	return out
}

// ODF annotations as legacy PresentationML comments: per slide its p:cmLst, and the deck's p:cmAuthorLst (an author
// per name, its initials made from it).
export interface LegacyComments {
	readonly slides: ReadonlyMap<SlideRef, string>
	readonly authors: string | undefined
}

const P_NAMESPACE = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

export function legacyComments(deck: Deck, comments: SlideCommentsOf, report: ConversionReport): LegacyComments {
	const authors = new Map<string, { readonly id: number; lastIdx: number }>()
	const slides = new Map<SlideRef, string>()

	for (const [ref, entries] of comments) {
		const slideNumber = deck.slides.indexOf(ref) + 1
		let list = ""

		for (const entry of entries) {
			const name = entry.format === "odf" ? entry.author : (authorOf(deck, entry)?.name ?? "")
			let author = authors.get(name)

			if (author === undefined) {
				author = { id: authors.size, lastIdx: 0 }
				authors.set(name, author)
			}

			author.lastIdx++

			if (!entry.plain) report.note("text", 1, [slideNumber])

			const created = commentTime(entry.created)
			const x = Math.round((entry.anchor?.x ?? 0) / LEGACY_POS_EMU)
			const y = Math.round((entry.anchor?.y ?? 0) / LEGACY_POS_EMU)

			list +=
				`<p:cm authorId="${String(author.id)}"${created === "" ? "" : ` dt="${created}"`} idx="${String(author.lastIdx)}">` +
				`<p:pos x="${String(x)}" y="${String(y)}"/><p:text>${escapeText(entry.text)}</p:text></p:cm>`
		}

		slides.set(ref, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:cmLst ${P_NAMESPACE}>${list}</p:cmLst>`)
	}

	const list = [...authors]
		.map(
			([name, author]) =>
				`<p:cmAuthor id="${String(author.id)}" name="${escapeAttribute(name)}" initials="${escapeAttribute(initialsOf(name))}" lastIdx="${String(author.lastIdx)}" clrIdx="${String(author.id % 8)}"/>`
		)
		.join("")

	return {
		slides,
		authors:
			authors.size === 0
				? undefined
				: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:cmAuthorLst ${P_NAMESPACE}>${list}</p:cmAuthorLst>`
	}
}
