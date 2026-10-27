import { children, i32, u16, utf16Text, type PptRecord, type RecordCounter } from "./records"
import { xmlText } from "./text"

// Comments ([MS-PPT] §2.5.25–§2.5.29 Comment10Container, in a slide's "___PPT10" tag) as PresentationML comments
// (ECMA-376 Part 1 §19.4): the deck's authors in ppt/commentAuthors.xml, each slide's comments in its own comments
// part. A comment keeps its author, initials, text, number, time and position (master units, as p:pos holds them).

export interface PptComment {
	readonly author: string
	readonly initials: string
	readonly text: string
	readonly index: number
	// xsd:dateTime, or undefined when the file's time is not a date.
	readonly dateTime: string | undefined
	readonly x: number
	readonly y: number
}

const RT_CSTRING = 0x0fba
const RT_COMMENT10 = 0x2ee0
const RT_COMMENT10_ATOM = 0x2ee1
// §2.5.26–§2.5.28 bounds on the author, text and initials (bytes).
const MAX_NAME = 104
const MAX_TEXT = 64000

function two(value: number): string {
	return String(value).padStart(2, "0")
}

function daysIn(year: number, month: number): number {
	if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28

	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

// §2.12.4 DateTimeStruct: a SYSTEMTIME (year, month, day of week, day, hour, minute, second, milliseconds); undefined
// for a time that is not a date of the Gregorian calendar (xsd:dateTime).
function dateTime(data: Uint8Array, at: number): string | undefined {
	const year = u16(data, at)
	const month = u16(data, at + 2)
	const day = u16(data, at + 6)
	const hour = u16(data, at + 8)
	const minute = u16(data, at + 10)
	const second = u16(data, at + 12)
	const ms = u16(data, at + 14)

	if (year < 1601 || year > 9999 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || ms > 999) return undefined
	if (day < 1 || day > daysIn(year, month)) return undefined

	return `${String(year).padStart(4, "0")}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}:${two(second)}.${String(ms).padStart(3, "0")}`
}

// The Comment10 records of a slide's "___PPT10" tag (anim.ts pp10Records).
export function slideComments(data: Uint8Array, tag: readonly PptRecord[], counter: RecordCounter): PptComment[] {
	const out: PptComment[] = []

	for (const record of tag) {
		if (record.type !== RT_COMMENT10) continue

		let author = ""
		let initials = ""
		let text = ""
		let atom: PptRecord | undefined

		for (const child of children(data, record.start, record.end, counter)) {
			if (child.type === RT_COMMENT10_ATOM) atom = child
			else if (child.type === RT_CSTRING) {
				const limit = child.instance === 1 ? MAX_TEXT : MAX_NAME
				const value = utf16Text(data, child.start, Math.min(child.end, child.start + limit), true)

				if (child.instance === 0) author = value
				// Line breaks are carriage returns (and vertical tabs) in the file, line feeds in p:text.
				else if (child.instance === 1) text = value.replace(/\r\n?|\v/gu, "\n")
				else if (child.instance === 2) initials = value
			}
		}

		if (atom === undefined || atom.end - atom.start < 28) continue

		out.push({
			author,
			initials,
			text,
			index: Math.max(0, i32(data, atom.start)),
			dateTime: dateTime(data, atom.start + 4),
			x: i32(data, atom.start + 20),
			y: i32(data, atom.start + 24)
		})
	}

	return out
}

// The deck's comment authors (p:cmAuthorLst): one per name and initials, each with the highest comment number it wrote.
export class CommentAuthors {
	private readonly authors = new Map<string, { id: number; name: string; initials: string; last: number }>()

	id(comment: PptComment): number {
		const key = `${comment.author}\u0000${comment.initials}`
		let author = this.authors.get(key)

		if (author === undefined) {
			author = { id: this.authors.size, name: comment.author, initials: comment.initials, last: 0 }
			this.authors.set(key, author)
		}

		author.last = Math.max(author.last, comment.index)

		return author.id
	}

	get size(): number {
		return this.authors.size
	}

	xml(): string {
		const items = [...this.authors.values()].map(
			author =>
				`<p:cmAuthor id="${String(author.id)}" name="${xmlText(author.name)}" initials="${xmlText(author.initials)}" lastIdx="${String(author.last)}" clrIdx="${String(author.id % 8)}"/>`
		)

		return `<p:cmAuthorLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${items.join("")}</p:cmAuthorLst>`
	}
}

// A slide's comments part content (p:cmLst), its authors added to `authors`.
export function commentsXml(comments: readonly PptComment[], authors: CommentAuthors): string {
	const items = comments.map(comment => {
		const id = authors.id(comment)

		return `<p:cm authorId="${String(id)}"${comment.dateTime === undefined ? "" : ` dt="${comment.dateTime}"`} idx="${String(comment.index)}"><p:pos x="${String(comment.x)}" y="${String(comment.y)}"/><p:text>${xmlText(comment.text)}</p:text></p:cm>`
	})

	return `<p:cmLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${items.join("")}</p:cmLst>`
}
