import { fromCharCodes } from "../../arrays"
import { OdfNs } from "../../odf/index"
import { parseXml, type XmlDocument } from "../../xml/index"
import { PageCommentBounds, type CommentBounds, type ParagraphBounds } from "./annotations"
import type { ContentPages, PageSpan } from "./scan"
import { spaceCount } from "./text"

// The characters a page's comments hold, counted by one pass over the page's bytes: no parse, no entries, no strings
// of their text. What it counts and refuses is what readAnnotations reads and refuses (the same PageCommentBounds,
// checked in the same order): annotations among the page's children, their text:p (text:s, text:tab and
// text:line-break expanded, other inline elements walked, comments and processing instructions skipped) and text:list
// (its character data), character data with references and line ends as the XML parser decodes them.
//
// It answers undefined, and the caller reads the page, wherever its counting could differ from the reader's: a page
// that declares namespaces of its own (or has ancestors' declarations injected), a root binding the namespaces it
// names (office, officeooo, text) to other prefixes, a DOCTYPE, an attribute value with a reference, a reference the
// parser would refuse, or markup it cannot follow (mismatched or unterminated tags).

const LT = 0x3c
const GT = 0x3e
const SLASH = 0x2f
const BANG = 0x21
const QUESTION = 0x3f
const AMP = 0x26
const SEMICOLON = 0x3b
const CR = 0x0d
const LF = 0x0a
const HASH = 0x23
const QUOTE = 0x22
const APOSTROPHE = 0x27
const EQUALS = 0x3d

const bytesOf = (text: string): Uint8Array => Uint8Array.from(text, character => character.charCodeAt(0))

const ANNOTATIONS = [bytesOf("officeooo:annotation"), bytesOf("office:annotation")]
const PARAGRAPH = bytesOf("text:p")
const LIST = bytesOf("text:list")
const SPACE = bytesOf("text:s")
const TAB = bytesOf("text:tab")
const LINE_BREAK = bytesOf("text:line-break")
const SPACE_COUNT = bytesOf("text:c")
const XMLNS = bytesOf("xmlns")
const CDATA = bytesOf("[CDATA[")
const NAMED: readonly (readonly [string, string])[] = [
	["office", OdfNs.office],
	["officeooo", OdfNs.officeooo],
	["text", OdfNs.text]
]

class Unsure extends Error {}

const unsure = (): never => {
	throw new Unsure()
}

// Whether the root binds the namespaces the count names only to their own prefixes (so "text:p" in a page's bytes is
// text:p, as the reader names it), once per content stream.
const plainRoots = new WeakMap<ContentPages, boolean>()

function plainRoot(content: ContentPages): boolean {
	const held = plainRoots.get(content)

	if (held !== undefined) return held

	let plain = true

	try {
		const document: XmlDocument = parseXml(new Uint8Array([...content.rootOpen, ...content.rootClose]))

		for (const { name, value } of document.attributes(document.documentElement())) {
			if (name !== "xmlns" && !name.startsWith("xmlns:")) continue

			const prefix = name === "xmlns" ? "" : name.slice(6)

			for (const [own, uri] of NAMED) if ((value === uri) !== (prefix === own)) plain = false
		}
	} catch {
		plain = false
	}

	plainRoots.set(content, plain)

	return plain
}

function equals(bytes: Uint8Array, start: number, end: number, name: Uint8Array): boolean {
	if (end - start !== name.length) return false

	for (let k = 0; k < name.length; k++) if (bytes[start + k] !== name[k]) return false

	return true
}

function contains(bytes: Uint8Array, start: number, end: number, needle: Uint8Array): boolean {
	const first = needle[0] ?? 0

	for (let at = bytes.indexOf(first, start); at >= 0 && at + needle.length <= end; at = bytes.indexOf(first, at + 1))
		if (equals(bytes, at, at + needle.length, needle)) return true

	return false
}

function isSpace(byte: number | undefined): boolean {
	return byte === 0x20 || byte === 0x09 || byte === LF || byte === CR
}

// UTF-16 units of character data [start, end) as the parser decodes it: references resolved (a supplementary code
// point is two units), CRLF and CR read as one line end.
function characters(bytes: Uint8Array, start: number, end: number, references: boolean): number {
	let count = 0

	for (let at = start; at < end; at++) {
		const byte = bytes[at] as number

		if (byte === AMP && references) {
			let semicolon = at + 1

			while (semicolon < end && bytes[semicolon] !== SEMICOLON) semicolon++

			if (semicolon >= end) unsure()

			count += reference(bytes, at + 1, semicolon)
			at = semicolon
		} else if (byte === CR) {
			count++

			if (bytes[at + 1] === LF) at++
		} else if (byte < 0x80) {
			count++
		} else {
			const units = sequence(bytes, at, end)

			count += units
			at += units === 2 ? 3 : (bytes[at] as number) >= 0xe0 ? 2 : 1
		}
	}

	return count
}

// A well-formed UTF-8 sequence at `at` (RFC 3629 §4): its UTF-16 units. Anything else the decoder reads as U+FFFD per
// byte; such text is left to the reader.
function sequence(bytes: Uint8Array, at: number, end: number): number {
	const lead = bytes[at] as number
	const continuation = (offset: number, low = 0x80, high = 0xbf): boolean => {
		const byte = at + offset < end ? (bytes[at + offset] as number) : -1

		return byte >= low && byte <= high
	}

	if (lead >= 0xc2 && lead <= 0xdf) return continuation(1) ? 1 : unsure()
	if (lead >= 0xe0 && lead <= 0xef) {
		const second = lead === 0xe0 ? continuation(1, 0xa0) : lead === 0xed ? continuation(1, 0x80, 0x9f) : continuation(1)

		return second && continuation(2) ? 1 : unsure()
	}
	if (lead >= 0xf0 && lead <= 0xf4) {
		const second = lead === 0xf0 ? continuation(1, 0x90) : lead === 0xf4 ? continuation(1, 0x80, 0x8f) : continuation(1)

		return second && continuation(2) && continuation(3) ? 2 : unsure()
	}

	return unsure()
}

function reference(bytes: Uint8Array, start: number, end: number): number {
	if (bytes[start] === HASH) {
		const hex = bytes[start + 1] === 0x78
		let code = 0

		if (end - start < (hex ? 3 : 2)) unsure()

		for (let at = start + (hex ? 2 : 1); at < end; at++) {
			const digit = parseInt(String.fromCharCode(bytes[at] as number), hex ? 16 : 10)

			if (Number.isNaN(digit)) unsure()

			code = code * (hex ? 16 : 10) + digit

			if (code > 0x10ffff) unsure()
		}

		// Code points XML 1.0 refuses (§2.2) refuse the parse: the reader's page would not read.
		if (
			(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
			(code >= 0xd800 && code <= 0xdfff) ||
			code === 0xfffe ||
			code === 0xffff
		)
			unsure()

		return code > 0xffff ? 2 : 1
	}

	const name = fromCharCodes(bytes.subarray(start, end))

	return name === "lt" || name === "gt" || name === "amp" || name === "quot" || name === "apos" ? 1 : unsure()
}

const Role = { Other: 0, Page: 1, Annotation: 2, Paragraph: 3, List: 4 } as const

type Role = (typeof Role)[keyof typeof Role]

interface Frame {
	readonly nameStart: number
	readonly nameEnd: number
	readonly role: Role
	// Paragraph: its walk depth.
	readonly depth: number
}

// The characters of a page's comments, refused as readAnnotations refuses them; undefined: read the page instead.
export function countPageAnnotations(content: ContentPages, span: PageSpan, room: number): number | undefined {
	const bytes = content.bytes

	if (span.inject !== undefined || !plainRoot(content) || contains(bytes, span.start, span.end, XMLNS)) return undefined

	try {
		return count(bytes, span.start, span.end, room)
	} catch (error) {
		if (error instanceof Unsure) return undefined

		throw error
	}
}

function count(bytes: Uint8Array, start: number, end: number, room: number): number {
	const page = new PageCommentBounds(room)
	const stack: Frame[] = []
	let comment: CommentBounds | undefined
	let paragraph: ParagraphBounds | undefined
	let list = 0
	let at = start

	while (at < end) {
		if (bytes[at] !== LT) {
			let next = bytes.indexOf(LT, at)

			if (next < 0 || next > end) next = end

			const role = stack[stack.length - 1]?.role

			if (role === Role.Paragraph) paragraph?.add(characters(bytes, at, next, true))
			else if (role === Role.List) list += characters(bytes, at, next, true)

			at = next
			continue
		}

		const marker = bytes[at + 1]

		if (marker === BANG) {
			if (bytes[at + 2] === 0x2d && bytes[at + 3] === 0x2d) {
				const close = findSequence(bytes, at + 4, end, [0x2d, 0x2d, GT])

				at = close + 3
			} else if (equals(bytes, at + 2, at + 2 + CDATA.length, CDATA)) {
				const from = at + 2 + CDATA.length
				const close = findSequence(bytes, from, end, [0x5d, 0x5d, GT])
				const role = stack[stack.length - 1]?.role

				if (role === Role.Paragraph) paragraph?.add(characters(bytes, from, close, false))
				else if (role === Role.List) list += characters(bytes, from, close, false)

				at = close + 3
			} else unsure()

			continue
		}

		if (marker === QUESTION) {
			at = findSequence(bytes, at + 2, end, [QUESTION, GT]) + 2
			continue
		}

		if (marker === SLASH) {
			let nameEnd = at + 2

			while (nameEnd < end && !isSpace(bytes[nameEnd]) && bytes[nameEnd] !== GT) nameEnd++

			let gt = nameEnd

			while (gt < end && isSpace(bytes[gt])) gt++

			const frame = stack.pop()

			if (bytes[gt] !== GT || frame === undefined || !sameName(bytes, frame, at + 2, nameEnd)) unsure()

			close(frame as Frame)
			at = gt + 1
			continue
		}

		// A start tag: its name, its attributes (quotes respected), "/>" or ">".
		const nameStart = at + 1
		let nameEnd = nameStart

		while (nameEnd < end && !isSpace(bytes[nameEnd]) && bytes[nameEnd] !== GT && bytes[nameEnd] !== SLASH) nameEnd++

		if (nameEnd === nameStart) unsure()

		let cursor = nameEnd
		let spaces: { start: number; end: number } | undefined
		let selfClosing = false

		for (;;) {
			while (cursor < end && isSpace(bytes[cursor])) cursor++

			const byte = bytes[cursor]

			if (byte === GT) break
			if (byte === SLASH) {
				if (bytes[cursor + 1] !== GT) unsure()

				selfClosing = true
				cursor++
				break
			}

			const attributeStart = cursor

			while (cursor < end && bytes[cursor] !== EQUALS && !isSpace(bytes[cursor]) && bytes[cursor] !== GT) cursor++

			const attributeEnd = cursor

			while (cursor < end && isSpace(bytes[cursor])) cursor++

			if (bytes[cursor] !== EQUALS) unsure()

			cursor++

			while (cursor < end && isSpace(bytes[cursor])) cursor++

			const quote = bytes[cursor]

			if (quote !== QUOTE && quote !== APOSTROPHE) unsure()

			const valueEnd = bytes.indexOf(quote as number, cursor + 1)

			if (valueEnd < 0 || valueEnd >= end) unsure()

			if (equals(bytes, attributeStart, attributeEnd, SPACE_COUNT)) spaces = { start: cursor + 1, end: valueEnd }
			if (bytes.subarray(cursor + 1, valueEnd).includes(AMP) || bytes.subarray(cursor + 1, valueEnd).includes(LT)) unsure()

			cursor = valueEnd + 1
		}

		if (cursor >= end) unsure()

		const parent = stack[stack.length - 1]
		const role = open(bytes, nameStart, nameEnd, parent, spaces)
		const frame: Frame = { nameStart, nameEnd, role: role.role, depth: role.depth }

		if (selfClosing) close(frame)
		else stack.push(frame)

		at = cursor + 1
	}

	if (stack.length > 0) unsure()

	return page.characters

	// What an element is to the count, as the reader takes it where it opens; the bounds checked as the reader checks
	// them on its way in.
	function open(
		data: Uint8Array,
		from: number,
		to: number,
		parent: Frame | undefined,
		spaces: { start: number; end: number } | undefined
	): { role: Role; depth: number } {
		if (parent === undefined) return { role: Role.Page, depth: 0 }

		switch (parent.role) {
			case Role.Page:
				if (ANNOTATIONS.some(name => equals(data, from, to, name))) {
					comment = page.comment()

					return { role: Role.Annotation, depth: 0 }
				}

				return { role: Role.Other, depth: 0 }
			case Role.Annotation:
				if (equals(data, from, to, PARAGRAPH)) {
					paragraph = (comment as CommentBounds).paragraph()
					paragraph.enter(0)

					return { role: Role.Paragraph, depth: 0 }
				}

				if (equals(data, from, to, LIST)) {
					list = 0

					return { role: Role.List, depth: 0 }
				}

				return { role: Role.Other, depth: 0 }
			case Role.Paragraph: {
				const bounds = paragraph as ParagraphBounds

				if (equals(data, from, to, SPACE)) {
					bounds.add(spaceCount(spaces === undefined ? undefined : fromCharCodes(data.subarray(spaces.start, spaces.end))))

					return { role: Role.Other, depth: 0 }
				}

				if (equals(data, from, to, TAB) || equals(data, from, to, LINE_BREAK)) {
					bounds.add(1)

					return { role: Role.Other, depth: 0 }
				}

				bounds.enter(parent.depth + 1)

				return { role: Role.Paragraph, depth: parent.depth + 1 }
			}
			case Role.List:
				return { role: Role.List, depth: 0 }
			case Role.Other:
				return { role: Role.Other, depth: 0 }
		}
	}

	// The reader's step when an element ends: a paragraph or list adds its line, an annotation its characters.
	function close(frame: Frame): void {
		if (frame.role === Role.Paragraph && frame.depth === 0 && stack[stack.length - 1]?.role === Role.Annotation)
			(comment as CommentBounds).line((paragraph as ParagraphBounds).characters)
		else if (frame.role === Role.List && stack[stack.length - 1]?.role === Role.Annotation) (comment as CommentBounds).line(list)
		else if (frame.role === Role.Annotation) page.done(comment as CommentBounds)
	}
}

function sameName(bytes: Uint8Array, frame: Frame, start: number, end: number): boolean {
	if (end - start !== frame.nameEnd - frame.nameStart) return false

	for (let k = 0; k < end - start; k++) if (bytes[start + k] !== bytes[frame.nameStart + k]) return false

	return true
}

function findSequence(bytes: Uint8Array, start: number, end: number, sequence: readonly number[]): number {
	for (
		let at = bytes.indexOf(sequence[0] as number, start);
		at >= 0 && at + sequence.length <= end;
		at = bytes.indexOf(sequence[0] as number, at + 1)
	) {
		let k = 1

		while (k < sequence.length && bytes[at + k] === sequence[k]) k++

		if (k === sequence.length) return at
	}

	return unsure()
}
