import { maxOf } from "../../arrays"
import type { XmlDocument } from "../../xml/index"
import type { RtfContainer, RtfFacts, RtfTableName } from "../document"
import { RtfTokenizer, Token } from "../tokenizer"
import { encodeText } from "./encode"
import type { EmitContext, NoteKind } from "./emit"
import { RtfOut, RtfWriteRefusal, joinChunks } from "./out"
import type { RtfSource } from "./writer"

// One run of the writer over the source (Plan): where each changed block is spliced in, and the table entries added.

// A colour as the colour table is keyed: "auto" or six upper-case hex digits.
function colorKey(value: string): string {
	const upper = value.toUpperCase()

	return upper === "AUTO" ? "auto" : upper
}

export function key(part: string, id: string): string {
	return id === "" ? part : `${part}#${id}`
}

interface Splice {
	readonly start: number
	readonly end: number
	readonly order: number
	readonly write: (out: RtfOut) => void
	applied: boolean
}

// Writes comments where their references are (RtfWriter.commentReference).
interface CommentWriter {
	reference(id: string, plan: Plan, out: RtfOut): void
	tag(id: string): string
}

const NO_COMMENTS: CommentWriter = {
	reference: () => {
		throw new RtfWriteRefusal("comment", "no comments")
	},
	tag: () => {
		throw new RtfWriteRefusal("comment", "no comments")
	}
}

// One run of the writer over the source: the splices of every changed block, and the table entries they add.
export class Plan implements EmitContext {
	readonly codepage: number
	readonly splices: Splice[] = []
	written = 0
	private order = 0
	private readonly facts: RtfFacts
	private readonly fonts = new Map<string, number>()
	private nextFont: number
	private readonly addedFonts: string[] = []
	private readonly colors = new Map<string, number>()
	private readonly addedColors: string[] = []
	private readonly authors = new Map<string, number>()
	private readonly addedAuthors: string[] = []
	private readonly lists: Map<number, number>
	readonly listsAdded: number[] = []
	readonly stylesAdded: string[] = []
	private readonly newStyles: ReadonlyMap<string, number>
	private readonly links: (document: XmlDocument, id: string) => string
	private readonly styleEntry: (id: string, out: RtfOut) => void

	private readonly source: RtfSource
	private readonly notes: ReadonlyMap<string, RtfContainer>
	private readonly pictures: (document: XmlDocument, drawing: number) => Uint8Array
	private readonly newLists: ReadonlyMap<number, (out: RtfOut, listId: number) => void>
	private readonly listOverride: (out: RtfOut, listId: number, ls: number) => void
	private readonly comments: CommentWriter

	constructor(
		source: RtfSource,
		notes: ReadonlyMap<string, RtfContainer>,
		pictures: (document: XmlDocument, drawing: number) => Uint8Array,
		newStyles: ReadonlyMap<string, number>,
		styleEntry: (id: string, out: RtfOut) => void,
		newLists: ReadonlyMap<number, (out: RtfOut, listId: number) => void>,
		listOverride: (out: RtfOut, listId: number, ls: number) => void,
		links: (document: XmlDocument, id: string) => string = () => {
			throw new RtfWriteRefusal("hyperlink", "no relationships")
		},
		comments: CommentWriter = NO_COMMENTS
	) {
		this.links = links
		this.comments = comments
		this.source = source
		this.notes = notes
		this.pictures = pictures
		this.newStyles = newStyles
		this.styleEntry = styleEntry
		this.newLists = newLists
		this.listOverride = listOverride
		const facts = source.read.facts

		this.facts = facts
		this.codepage = facts.codepage

		for (const font of facts.fonts) if (font.name !== "" && !this.fonts.has(font.name)) this.fonts.set(font.name, font.index)

		this.nextFont = facts.fonts.reduce((max, font) => Math.max(max, font.index + 1), 0)

		// Without a colour table \\cf0 is automatic, and the table written for added colours starts with that entry.
		if (facts.tables.colortbl === undefined) this.colors.set("auto", 0)

		facts.colors.forEach((color, index) => {
			if (color === undefined) return

			const key = colorKey(color)

			if (!this.colors.has(key)) this.colors.set(key, index)
		})
		facts.authors.forEach((author, index) => {
			if (author !== "" && !this.authors.has(author)) this.authors.set(author, index)
		})
		this.lists = new Map(facts.overrides.map(ls => [ls, ls]))
	}

	splice(start: number, end: number, write: (out: RtfOut) => void): void {
		this.splices.push({ start, end, order: this.order++, write, applied: false })
	}

	// ---- EmitContext

	font(name: string): number {
		const known = this.fonts.get(name.trim())

		if (known !== undefined) return known

		const index = this.nextFont++

		this.fonts.set(name.trim(), index)
		this.addedFonts.push(name.trim())

		return index
	}

	color(value: string): number {
		const upper = colorKey(value)

		if (upper !== "auto" && !/^[0-9A-F]{6}$/u.test(upper)) throw new RtfWriteRefusal("color", value)

		const known = this.colors.get(upper)

		if (known !== undefined) return known

		const index = (this.source.read.facts.tables.colortbl === undefined ? 1 : this.facts.colors.length) + this.addedColors.length

		this.colors.set(upper, index)
		this.addedColors.push(upper)

		return index
	}

	style(id: string, type: "paragraph" | "character" | "table"): number {
		const style = this.facts.styles.get(id)

		if (style !== undefined && style.type === type) return style.number

		// The translation's "Normal" is RTF's \\s0 whether or not the style sheet has it.
		if (id === "Normal" && type === "paragraph" && !this.newStyles.has(id)) return 0

		const added = this.newStyles.get(id)

		if (added === undefined) throw new RtfWriteRefusal("style", `${type} style ${id} is not in the style sheet`)

		if (!this.stylesAdded.includes(id)) this.stylesAdded.push(id)

		return added
	}

	list(numId: number): number {
		const known = this.lists.get(numId)

		if (known !== undefined) return known

		if (!this.newLists.has(numId)) throw new RtfWriteRefusal("numbering", `list ${numId}`)

		this.lists.set(numId, numId)
		this.listsAdded.push(numId)

		return numId
	}

	author(name: string): number {
		const known = this.authors.get(name)

		if (known !== undefined) return known

		const authors = this.facts.authors
		const base = this.source.read.facts.tables.revtbl === undefined ? 1 : authors.at(-1) === "" ? authors.length - 1 : authors.length
		const index = base + this.addedAuthors.length

		this.authors.set(name, index)
		this.addedAuthors.push(name)

		return index
	}

	note(kind: NoteKind, id: string, out: RtfOut): void {
		const container = this.notes.get(key(`word/${kind}s.xml`, id))

		if (container?.group === undefined) throw new RtfWriteRefusal("note", `a new ${kind}`)

		this.copy(container.group.start, container.group.end, out)
	}

	comment(id: string, out: RtfOut): void {
		this.comments.reference(id, this, out)
	}

	commentTag(id: string): string {
		return this.comments.tag(id)
	}

	picture(document: XmlDocument, drawing: number): Uint8Array {
		return this.pictures(document, drawing)
	}

	hyperlink(document: XmlDocument, id: string): string {
		return this.links(document, id)
	}

	// ---- output

	// Source bytes [from, to) with the splices inside them (a splice inside one already applied is that one's).
	copy(from: number, to: number, out: RtfOut): void {
		this.copyOn({ next: 0, at: from }, to, out, undefined)
	}

	// copy() on from where `run` stopped: false when it stops at `due` (called again to go on), true once done.
	private copyOn(run: { next: number; at: number }, to: number, out: RtfOut, due: (() => boolean) | undefined): boolean {
		const bytes = this.source.bytes
		const splices = this.splices

		while (run.next < splices.length) {
			const splice = splices[run.next]

			run.next++

			if (splice === undefined || splice.applied || splice.start < run.at || splice.start >= to) continue
			if (splice.end > to) throw new RtfWriteRefusal("overlap", `an edit runs past ${to}`)

			out.bytes(bytes.subarray(run.at, splice.start))
			splice.applied = true
			splice.write(out)
			run.at = splice.end

			if (due?.() === true) return false
		}

		out.bytes(bytes.subarray(run.at, to))

		return true
	}

	// The whole file; the table entries added go before each table's closing brace (or in a new table).
	// The blocks are written once to learn the table entries they need (the tables come first in the file), then
	// again with the entries in place. Steps at `due`: a long file is written in slices.
	*finish(due: (() => boolean) | undefined): Generator<void, Uint8Array> {
		const sort = (): void => {
			this.splices.sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order)
		}
		const size = this.source.bytes.length

		sort()

		let first: RtfOut | undefined = new RtfOut()
		const firstRun = { next: 0, at: 0 }

		while (!this.copyOn(firstRun, size, first, due)) yield

		for (const splice of this.splices) {
			if (!splice.applied) throw new RtfWriteRefusal("lostEdit", `an edit at ${splice.start} has no place`)

			splice.applied = false
		}

		const written = this.written
		const count = this.splices.length

		this.written = 0
		this.tableEntries()

		// No entry added: the second writing would be the first.
		if (this.splices.length === count) {
			this.written = written

			return joinChunks(first.finish())
		}

		// The first writing's chunks go before the second's are made.
		first = undefined
		sort()

		const out = new RtfOut()
		const run = { next: 0, at: 0 }

		while (!this.copyOn(run, size, out, due)) yield

		return joinChunks(out.finish())
	}

	private tableEntries(): void {
		const tables = this.source.read.facts.tables
		const anchor = this.headerAnchor()
		const append = (name: RtfTableName, entries: string, wrap: string): void => {
			if (entries === "") return

			const group = tables[name]

			if (group !== undefined) this.splice(group.end - 1, group.end - 1, out => out.rtf(entries))
			else this.splice(this.after(name, anchor), this.after(name, anchor), out => out.rtf(wrap.replace("$", entries)))
		}
		const asString = (bytes: Uint8Array): string => {
			let text = ""

			for (const byte of bytes) text += String.fromCharCode(byte)

			return text
		}

		// Styles and lists first: they may name fonts, colours (and styles) of their own.
		if (this.stylesAdded.length > 0) {
			const entries = new RtfOut()

			for (let k = 0; k < this.stylesAdded.length; k++) this.styleEntry(this.stylesAdded[k] ?? "", entries)

			append("stylesheet", asString(joinChunks(entries.finish())), "{\\stylesheet$}")
		}

		if (this.listsAdded.length > 0) {
			let ids = Math.max(0, maxOf(this.facts.listIds)) + 1
			const lists = new RtfOut()
			const overrides = new RtfOut()

			for (const numId of this.listsAdded) {
				const listId = ids++

				this.newLists.get(numId)?.(lists, listId)
				this.listOverride(overrides, listId, numId)
			}

			append("listtable", asString(joinChunks(lists.finish())), "{\\*\\listtable$}")
			append("listoverridetable", asString(joinChunks(overrides.finish())), "{\\*\\listoverridetable$}")
		}

		let fonts = ""

		this.addedFonts.forEach((name, k) => {
			const index = this.nextFont - this.addedFonts.length + k
			const encoded = encodeText(name, this.codepage)

			fonts += `{\\f${index}\\fnil\\fcharset0${encoded.unicode ? "\\uc1" : ""} ${encoded.rtf};}`
		})
		append("fonttbl", fonts, "{\\fonttbl$}")

		let colors = ""

		for (const color of this.addedColors) {
			colors +=
				color === "auto"
					? ";"
					: `\\red${parseInt(color.slice(0, 2), 16)}\\green${parseInt(color.slice(2, 4), 16)}\\blue${parseInt(color.slice(4, 6), 16)};`
		}

		append("colortbl", colors, "{\\colortbl;$}")

		let authors = ""
		const known = this.facts.authors

		if (this.addedAuthors.length > 0) {
			if (tables.revtbl === undefined) authors = "{Unknown;}"
			else if (known.at(-1) !== "" && known.length > 0) authors = "{;}"
		}

		for (const author of this.addedAuthors) {
			const encoded = encodeText(author, this.codepage)

			authors += `{${encoded.unicode ? "\\uc1 " : ""}${encoded.rtf};}`
		}

		if (this.addedAuthors.length > 0) append("revtbl", authors, "{\\*\\revtbl $}")
	}

	// \revisions (RTF 1.9.1, Document Formatting Properties: "Turn on revision marking"): added after the
	// header's tables, or every one removed.
	trackRevisions(on: boolean): void {
		const words = this.facts.revisions

		if (on && words.length === 0) {
			const at = this.after("info", this.headerAnchor())

			this.splice(at, at, out => out.word("revisions"))
		}

		if (!on) for (const word of words) this.splice(word.start, word.end, () => undefined)
	}

	// Just after \rtf1 (and its delimiter): where a missing table goes when none before it exists.
	private headerAnchor(): number {
		const tokens = new RtfTokenizer(this.source.bytes)

		for (let count = 0; count < 4; count++) {
			const kind = tokens.next()

			if (kind === Token.Word && tokens.name === "rtf") return tokens.end
			if (kind === Token.End) break
		}

		throw new RtfWriteRefusal("header", "no \\rtf1")
	}

	// Where a missing table goes: after the last of the tables the specification puts before it.
	private after(name: RtfTableName, anchor: number): number {
		const order: RtfTableName[] = ["fonttbl", "colortbl", "stylesheet", "listtable", "listoverridetable", "revtbl", "info"]
		const tables = this.source.read.facts.tables
		let at = anchor

		for (const table of order.slice(0, order.indexOf(name))) {
			const group = tables[table]

			if (group !== undefined) at = Math.max(at, group.end)
		}

		return at
	}
}
