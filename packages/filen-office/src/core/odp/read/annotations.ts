import { parseLength } from "../../odf/index"
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
import { tooDeep } from "../../presentation/refusal"
import { NodeKind } from "../../xml/index"
import type { Fragment } from "./context"
import { MAX_SPAN_DEPTH, spaceCount } from "./text"

// The comments of a draw:page: LibreOffice's officeooo:annotation (and office:annotation, which it also reads there),
// each with its place (svg:x, svg:y), author (dc:creator), date (dc:date) and paragraphs. Ids are the session's
// own: the format names none.

export const ANNOTATION = "officeooo:annotation"
const ANNOTATIONS: ReadonlySet<string> = new Set([ANNOTATION, "office:annotation"])

const EMU_PER_POINT = 12_700

let issued = 0

export function newOdfCommentId(): string {
	issued++

	return `odf:${String(issued)}`
}

export function isAnnotation(fragment: Fragment, node: number): boolean {
	return ANNOTATIONS.has(fragment.name(node))
}

// The bounds a page's comments are read under, kept by the reader below and the counting scan (annotationCount.ts)
// alike, so both refuse the same page the same way: comments per page, characters per comment and per page (`room`),
// span nesting, text:s runs.
export class PageCommentBounds {
	private readonly room: number
	private comments = 0
	// The characters of the comments read so far.
	characters = 0

	constructor(room: number) {
		this.room = room
	}

	// The next annotation: refused past the comments a page may hold.
	comment(): CommentBounds {
		if (this.comments >= MAX_COMMENTS_PER_SLIDE) throw new PresentationError("tooLarge", "comments on one page")

		this.comments++

		return new CommentBounds(Math.min(MAX_COMMENT_CHARACTERS, this.room - this.characters))
	}

	done(comment: CommentBounds): void {
		this.characters += Math.max(0, comment.length)
	}
}

// One comment's text: its length so far (line breaks between lines included), refused past its bound (or what is left
// of the page's) before it grows further.
export class CommentBounds {
	readonly limit: number
	length = -1

	constructor(limit: number) {
		this.limit = limit
	}

	paragraph(): ParagraphBounds {
		return new ParagraphBounds(this.limit - this.length - 1, this.limit)
	}

	line(characters: number): void {
		this.length += characters + 1

		if (this.length > this.limit) commentTextTooLarge(this.limit)
	}
}

// One text:p: its characters, refused past the room its comment has left; its spans nested as the text reader allows.
export class ParagraphBounds {
	private readonly room: number
	private readonly limit: number
	characters = 0

	constructor(room: number, limit: number) {
		this.room = room
		this.limit = limit
	}

	add(characters: number): void {
		if (this.characters + characters > this.room) commentTextTooLarge(this.limit)

		this.characters += characters
	}

	enter(depth: number): void {
		if (depth > MAX_SPAN_DEPTH) tooDeep("text span nesting", MAX_SPAN_DEPTH)
	}
}

// `room`: the characters all the page's comments may hold.
export function readAnnotations(fragment: Fragment, page: number, room = MAX_SLIDE_COMMENT_CHARACTERS): SlideComments {
	const document = fragment.document
	const entries: CommentEntry[] = []
	const bounds = new PageCommentBounds(room)
	let scope: ReadonlyMap<string, string> | undefined

	for (let child = document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
		if (!isAnnotation(fragment, child)) continue

		const comment = bounds.comment()

		scope ??= inheritedDeclarations(document, child)

		const attributes = fragment.attributes(child)
		const x = parseLength(attributes.get("svg:x"))
		const y = parseLength(attributes.get("svg:y"))
		let author = ""
		let created = ""
		const lines: string[] = []
		let plain = true
		const add = (line: string): void => {
			comment.line(line.length)
			lines.push(line)
		}

		for (let part = document.firstChildElement(child); part >= 0; part = document.nextSiblingElement(part)) {
			const name = fragment.name(part)

			if (name === "dc:creator") author = document.textContent(part)
			else if (name === "dc:date") created = document.textContent(part).trim()
			else if (name === "text:p") {
				const line = paragraphText(fragment, part, comment.paragraph())

				if (!line.plain) plain = false

				add(line.text)
			} else if (name !== "meta:creator-initials" && name !== "meta:date-string") {
				plain = false

				if (name === "text:list") add(document.textContent(part))
			}
		}

		bounds.done(comment)
		entries.push({
			id: newOdfCommentId(),
			format: "odf",
			author,
			text: lines.join("\n"),
			created,
			resolved: false,
			...(x === undefined || y === undefined
				? {}
				: { anchor: { x: Math.round(x * EMU_PER_POINT), y: Math.round(y * EMU_PER_POINT) } }),
			source: document.raw(child).slice(),
			changed: false,
			plain
		})
	}

	return { entries, scope: scope ?? new Map() }
}

const PLAIN_INLINE: ReadonlySet<string> = new Set(["text:span", "text:s", "text:tab", "text:line-break", "text:soft-page-break"])

// A text:p's characters as they read (text:s, text:tab and text:line-break expanded), and whether it holds nothing an
// edit as text loses (no link, field, note or other inline element; spans may carry styles: those are lost). Refused
// as `bounds` refuses it.
function paragraphText(fragment: Fragment, paragraph: number, bounds: ParagraphBounds): { readonly text: string; readonly plain: boolean } {
	const document = fragment.document
	let text = ""
	let plain = !fragment.attributes(paragraph).has("text:style-name")
	const append = (more: string): void => {
		bounds.add(more.length)
		text += more
	}
	const walk = (node: number, depth: number): void => {
		bounds.enter(depth)

		for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
			const kind = document.kind(child)

			if (kind === NodeKind.Text || kind === NodeKind.CData) {
				append(document.text(child))
				continue
			}

			if (kind !== NodeKind.Element) continue

			const name = fragment.name(child)

			if (!PLAIN_INLINE.has(name) || name === "text:span") plain = false

			if (name === "text:s") append(" ".repeat(spaceCount(fragment.attributes(child).get("text:c"))))
			else if (name === "text:tab") append("\t")
			else if (name === "text:line-break") append("\n")
			else walk(child, depth + 1)
		}
	}

	walk(paragraph, 0)

	return { text, plain }
}
