import { appendAll } from "../arrays"
import { nativeDeflate, nativeDeflateChunks } from "../docx/write/zip"
import { memorySink, writeZip, type PartBytes, type ZipPlanItem } from "../opc/index"
import type { DeflatedChunks, DeflatedPiece } from "../opc/zipWriter"
import { decodeUtf8, encodeUtf8, escapeAttribute, escapeText } from "../xml/index"
import type { SliceClock } from "../slicing"
import type { Picture } from "./pict"
import { CharProps, ParaProps } from "./props"
import {
	MARK,
	Story,
	XmlStore,
	syntheticParagraph,
	type Block,
	type Paragraph,
	type SourceBlock,
	type StoryContext,
	type XmlBudget,
	type XmlSink
} from "./story"
import { dttm, numberFormat } from "./values"

export { MARK }

// The WordprocessingML package an RTF document becomes: the stories, the style sheet, list definitions,
// fonts, settings, notes, comments, headers and footers and pictures (ECMA-376 Part 1, Part 2). Large entries
// are deflated (level 1): the package is held for as long as the document is open.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
const NAMESPACES = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}"`
const RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml."

export interface FontEntry {
	readonly index: number
	name: string
	named: boolean
	charset: number
	codepage: number
	family: string
	pitch: number
}

export interface StyleDef {
	type: "paragraph" | "character" | "table" | "section"
	number: number
	name: string
	basedOn: number
	next: number
	link: number
	char: CharProps
	para: ParaProps
}

export interface ListLevelDef {
	nfc: number
	nfcN: boolean
	jc: number
	jcN: boolean
	follow: number
	start: number
	legal: boolean
	noRestart: boolean
	text: string
	char: CharProps
	para: ParaProps
}

export interface ListDef {
	id: number
	templateId: number
	name: string
	readonly levels: ListLevelDef[]
}

export interface ListOverrideDef {
	listId: number
	ls: number
	readonly levels: { restart: boolean; start: number; level: ListLevelDef | undefined }[]
}

export type NoteKind = "footnote" | "endnote"

// A source byte range [start, end).
export interface SourceRange {
	readonly start: number
	readonly end: number
}

interface Note {
	readonly index: number
	readonly story: Story
	kind: NoteKind
	// The note's group ({\\footnote ...}).
	group: SourceRange | undefined
}

interface Comment {
	readonly index: number
	readonly story: Story
	readonly author: string
	readonly initials: string
	tag: string
	date: string | undefined
	group: SourceRange | undefined
}

interface HeaderFooter {
	readonly index: number
	readonly footer: boolean
	readonly story: Story
	group: SourceRange | undefined
}

// What the RTF writer needs of the source's tables: where they are and what they hold.
// The header groups, in the order RTF 1.9.1 puts them (\info last).
export type RtfTableName = "fonttbl" | "colortbl" | "stylesheet" | "listtable" | "listoverridetable" | "revtbl" | "info"

export interface RtfFacts {
	// \\ansicpgN (1252 when absent), and \\deffN (-1 when absent).
	readonly codepage: number
	readonly defaultFont: number
	// Each table's group.
	readonly tables: Readonly<Partial<Record<RtfTableName, SourceRange>>>
	// The font table: number, name (trimmed), charset (-1 unset).
	readonly fonts: readonly { readonly index: number; readonly name: string; readonly charset: number }[]
	// The colour table: "RRGGBB", "auto" (an empty entry) or undefined.
	readonly colors: readonly (string | undefined)[]
	// Style ids as the translation names them, to their type and number.
	readonly styles: ReadonlyMap<string, { readonly type: "paragraph" | "character" | "table"; readonly number: number }>
	// \\listidN of every list, and the \\lsN of every override (the translation's w:numId).
	readonly listIds: readonly number[]
	readonly overrides: readonly number[]
	// Revision authors (\\revtbl), by \\revauthN.
	readonly authors: readonly string[]
	// Each \\revisions word (track changes on).
	readonly revisions: readonly SourceRange[]
}

export type RtfContainerKind = "body" | "header" | "footer" | "footnote" | "endnote" | "comment"

// One story of the translation (the body, a header, a note, a comment) and where its blocks came from.
export interface RtfContainer {
	readonly kind: RtfContainerKind
	// The part it is written to, and its id there (w:footnote/@w:id, w:comment/@w:id; "" for the body,
	// headers and footers, a part each).
	readonly part: string
	readonly id: string
	// Its destination group in the source (none for the body).
	readonly group: SourceRange | undefined
	// Where its content ends in the source: the closing brace of its group (the document's for the body).
	readonly end: number
	readonly blocks: readonly SourceBlock[]
	// Each picture's group in the source, by the relationship id its w:drawing names.
	readonly pictures: ReadonlyMap<string, SourceRange>
}

// Blocks of the body written between looks at a slice clock.
const BODY_RUN = 1024

export interface WriteOptions {
	readonly section: string
	readonly colors: readonly (string | undefined)[]
	readonly fonts: ReadonlyMap<number, FontEntry>
	readonly defaultFont: number
	readonly widowControl: boolean
	// Every part stored, none deflated (a package read once and dropped).
	readonly stored?: boolean
	// The body and the package written in slices.
	readonly slicing?: SliceClock
}

export class DocumentParts implements StoryContext {
	readonly xmlBudget: XmlBudget = { raw: 0 }
	readonly body: Story
	readonly styles: StyleDef[] = []
	readonly lists: ListDef[] = []
	readonly overrides: ListOverrideDef[] = []
	readonly info = new Map<string, string>()
	revisionText = ""
	defaultChar: CharProps | undefined = undefined
	defaultPara: ParaProps | undefined = undefined
	defaultTab = 720
	evenAndOdd = false
	mirrorMargins = false
	// \\htmautsp: HTML paragraph auto spacing (RTF 1.9.1, "Document Formatting Properties"); off without it, which
	// w:doNotUseHTMLParagraphAutoSpacing says.
	htmlAutoSpacing = false
	trackRevisions = false
	// Footnote and endnote numbering (\\ftnnar, \\ftnstartN, \\ftnrstpg ... and their \\aftn twins).
	readonly notePr = {
		footnote: { format: "", start: -1, restart: "", position: "" },
		endnote: { format: "", start: -1, restart: "", position: "" }
	}
	currentComment: Comment | undefined = undefined
	private readonly notes: Note[] = []
	private readonly noteByStory = new Map<Story, Note>()
	private readonly comments: Comment[] = []
	private readonly commentStories = new Set<Story>()
	private readonly headers: HeaderFooter[] = []
	private readonly sectionHeaderSet = new Map<string, number>()
	private readonly sectionFooterSet = new Map<string, number>()
	private readonly mediaParts: { name: string; bytes: Uint8Array; extension: string; contentType: string }[] = []
	private readonly bookmarks = new Map<string, number>()
	private styleIds: Map<string, string> | undefined = undefined
	private colorTable: readonly (string | undefined)[] = []
	private fontTable: ReadonlyMap<number, FontEntry> = new Map()
	private authorsList: string[] | undefined = undefined
	private nextIdValue = 1
	// Paragraphs whose source holds words the translation cannot hold (StoryContext.unread).
	readonly unreadRanges: { names: string; start: number; end: number }[] = []
	private drawingId = 1
	private numIds: Map<number, number> | undefined = undefined
	private stylesByKey: Map<string, StyleDef> | undefined = undefined
	private listsById: Map<number, number> | undefined = undefined
	private cycles: Set<StyleDef> | undefined = undefined
	// One string per distinct property markup (PropsContext.intern).
	private readonly interned = new Map<string, string>()

	constructor() {
		this.body = new Story(this)
	}

	unread(names: string, start: number, end: number): void {
		this.unreadRanges.push({ names, start, end })
	}

	nextId(): number {
		return this.nextIdValue++
	}

	// Field begins: each w:fldChar begin's start tag (without its end), and the w:ffData a form field gives it.
	private readonly fieldBegins: { readonly tag: string; ffData: string }[] = []

	fieldBegin(tag: string): number {
		this.fieldBegins.push({ tag, ffData: "" })

		return this.fieldBegins.length - 1
	}

	formField(begin: number, ffData: string): void {
		const entry = this.fieldBegins[begin]

		if (entry !== undefined) entry.ffData = ffData
	}

	nextDrawingId(): number {
		return this.drawingId++
	}

	// ---- PropsContext

	intern(xml: string): string {
		const known = this.interned.get(xml)

		if (known !== undefined) return known

		this.interned.set(xml, xml)

		return xml
	}

	fontName(index: number): string | undefined {
		const font = this.fontTable.get(index)

		return font === undefined || font.name.trim() === "" ? undefined : font.name.trim()
	}

	color(index: number): string | undefined {
		return this.colorTable[index]
	}

	setTables(colors: readonly (string | undefined)[], fonts: ReadonlyMap<number, FontEntry>): void {
		this.colorTable = colors
		this.fontTable = fonts
	}

	charStyleId(index: number): string | undefined {
		return this.ids().get(`c${index}`)
	}

	paraStyleId(index: number): string | undefined {
		return this.ids().get(`p${index}`)
	}

	tableStyleId(index: number): string | undefined {
		return this.ids().get(`t${index}`)
	}

	change(name: string, author: number, date: number): string {
		const when = dttm(date)

		return `<w:${name} w:id="${this.nextId()}" w:author="${escapeAttribute(this.author(author))}"${when === undefined ? "" : ` w:date="${when}"`}>`
	}

	cellRevision(revision: { kind: "cellIns" | "cellDel"; author: number; date: number }): string {
		const when = dttm(revision.date)

		return `<w:${revision.kind} w:id="${this.nextId()}" w:author="${escapeAttribute(this.author(revision.author))}"${when === undefined ? "" : ` w:date="${when}"`}/>`
	}

	author(index: number): string {
		return this.authors()[index] ?? "Unknown"
	}

	authors(): readonly string[] {
		this.authorsList ??= this.revisionText.split(";").map(name => name.trim())

		return this.authorsList
	}

	// Style ids to their type and number (the first definition of each, as written).
	styleNumbers(): Map<string, { type: "paragraph" | "character" | "table"; number: number }> {
		const out = new Map<string, { type: "paragraph" | "character" | "table"; number: number }>()

		for (const [key, id] of this.ids()) {
			const type = key[0] === "p" ? "paragraph" : key[0] === "c" ? "character" : "table"

			out.set(id, { type, number: Number(key.slice(1)) })
		}

		return out
	}

	// Style ids from the style sheet's names (as Word derives them), unique across types; built on first use,
	// after the style sheet (which the specification places before any style reference).
	private ids(): Map<string, string> {
		if (this.styleIds !== undefined) return this.styleIds

		const ids = new Map<string, string>()
		const taken = new Set<string>()

		for (const style of this.styles) {
			if (style.type === "section") continue

			const key = `${style.type[0]}${style.number}`

			if (ids.has(key)) continue

			const normal = style.type === "paragraph" && style.number === 0
			let id = normal ? "Normal" : style.name.replace(/[^A-Za-z0-9]/gu, "")

			// "Normal" is the paragraph style \\s0's whatever the order of the style sheet.
			if (id === "" || taken.has(id.toLowerCase()) || (!normal && id.toLowerCase() === "normal"))
				id = `${style.type[0]}${style.number}`
			if (taken.has(id.toLowerCase())) continue

			taken.add(id.toLowerCase())
			ids.set(key, id)
		}

		this.styleIds = ids

		return ids
	}

	// ---- lists

	newList(): ListDef {
		const list: ListDef = { id: 0, templateId: 0, name: "", levels: [] }

		this.lists.push(list)

		return list
	}

	newLevel(): ListLevelDef {
		return {
			nfc: 0,
			nfcN: false,
			jc: 0,
			jcN: false,
			follow: 0,
			start: 1,
			legal: false,
			noRestart: false,
			text: "",
			char: new CharProps(),
			para: new ParaProps()
		}
	}

	newOverride(): ListOverrideDef {
		const override: ListOverrideDef = { listId: 0, ls: 0, levels: [] }

		this.overrides.push(override)

		return override
	}

	newStyle(): StyleDef {
		const style: StyleDef = {
			type: "paragraph",
			number: 0,
			name: "",
			basedOn: -1,
			next: -1,
			link: -1,
			char: new CharProps(),
			para: new ParaProps()
		}

		this.styles.push(style)
		this.styleIds = undefined

		return style
	}

	// The first definition of each style by type and number (later ones with the same number are not used).
	private styleByKey(): Map<string, StyleDef> {
		if (this.stylesByKey === undefined) {
			const map = new Map<string, StyleDef>()

			for (const style of this.styles) {
				const key = `${style.type[0]}${style.number}`

				if (!map.has(key)) map.set(key, style)
			}

			this.stylesByKey = map
		}

		return this.stylesByKey
	}

	// The list table's index of each \listidN (the first list with that id).
	private listIndex(): Map<number, number> {
		if (this.listsById === undefined) {
			const map = new Map<number, number>()

			this.lists.forEach((list, index) => {
				if (!map.has(list.id)) map.set(list.id, index)
			})

			this.listsById = map
		}

		return this.listsById
	}

	// The w:numId of \lsN: overrides that name a list in the list table.
	numId(ls: number): number | undefined {
		if (this.numIds === undefined) {
			const ids = new Map<number, number>()

			for (const override of this.overrides) {
				if (override.ls > 0 && !ids.has(override.ls) && this.listIndex().has(override.listId)) ids.set(override.ls, override.ls)
			}

			this.numIds = ids
		}

		return this.numIds.get(ls)
	}

	// ---- stories

	newNote(): Note {
		const note: Note = { index: this.notes.length, story: new Story(this), kind: "footnote", group: undefined }

		this.notes.push(note)
		this.noteByStory.set(note.story, note)

		return note
	}

	isNote(story: Story): boolean {
		return this.noteByStory.has(story)
	}

	noteIndex(story: Story): number {
		return this.noteByStory.get(story)?.index ?? -1
	}

	setNoteKind(story: Story, kind: NoteKind): void {
		const note = this.noteByStory.get(story)

		if (note !== undefined) note.kind = kind
	}

	newComment(author: string, initials: string): Comment {
		const comment: Comment = {
			index: this.comments.length,
			story: new Story(this),
			author,
			initials,
			tag: "",
			date: undefined,
			group: undefined
		}

		this.comments.push(comment)
		this.commentStories.add(comment.story)
		this.currentComment = comment

		return comment
	}

	isComment(story: Story): boolean {
		return this.commentStories.has(story)
	}

	newHeaderFooter(footer: boolean): HeaderFooter {
		const entry: HeaderFooter = { index: this.headers.length, footer, story: new Story(this), group: undefined }

		this.headers.push(entry)

		return entry
	}

	// The current section's header (or footer) stories by w:type.
	sectionHeaders(footer: boolean): Map<string, number> {
		return footer ? this.sectionFooterSet : this.sectionHeaderSet
	}

	headerRelationship(index: number): string {
		return `rIdHdr${index}`
	}

	private headerPart(entry: HeaderFooter): string {
		return `${entry.footer ? "footer" : "header"}${entry.index + 1}.xml`
	}

	// A picture as a media part with a relationship from the story's part; `source`: its group.
	media(story: Story, picture: Picture, source?: SourceRange): string {
		const number = this.mediaParts.length + 1
		const name = `media/image${number}.${picture.extension}`
		const id = `rIdImg${number}`

		this.mediaParts.push({ name: `word/${name}`, bytes: picture.bytes, extension: picture.extension, contentType: picture.contentType })
		story.relationships.push({ id, type: `${RELATIONSHIP}image`, target: name, external: false })
		if (source !== undefined) story.pictures.set(id, source)

		return id
	}

	bookmark(start: boolean, name: string): string {
		if (start) {
			const id = this.nextId()

			this.bookmarks.set(name, id)

			return `<w:bookmarkStart w:id="${id}" w:name="${escapeAttribute(name)}"/>`
		}

		const id = this.bookmarks.get(name)

		if (id === undefined) return ""

		this.bookmarks.delete(name)

		return `<w:bookmarkEnd w:id="${id}"/>`
	}

	// The opening tag of a revision wrapper (its w:id is added where it opens).
	revisionMarkup(kind: "ins" | "del", author: number, date: number): string {
		const when = dttm(date)

		return `<w:${kind} w:author="${escapeAttribute(this.author(author))}"${when === undefined ? "" : ` w:date="${when}"`}>`
	}

	// ---- source ranges

	sourceParagraphs(): { story: string; index: number; start: number; end: number }[] {
		const out: { story: string; index: number; start: number; end: number }[] = []
		const walk = (blocks: readonly Block[], story: string, index: number): void => {
			for (const block of blocks) {
				if (block.kind === "p") out.push({ story, index, start: block.start, end: block.end })
				else for (const row of block.rows) for (const cell of row.cells) walk(cell, story, index)
			}
		}

		walk(this.body.blocks, "body", 0)
		for (const entry of this.headers) walk(entry.story.blocks, entry.footer ? "footer" : "header", entry.index)
		for (const note of this.notes) walk(note.story.blocks, note.kind, note.index)
		for (const comment of this.comments) walk(comment.story.blocks, "comment", comment.index)

		return out
	}

	// ---- writing

	// Filled by write(): the containers in the order they are written.
	readonly containers: RtfContainer[] = []
	// Where the document's group closes (the end of the input when it never does).
	bodyEnd = 0

	private container(
		kind: RtfContainerKind,
		part: string,
		id: string,
		group: SourceRange | undefined,
		story: Story,
		blocks: SourceBlock[]
	): void {
		const end = group === undefined ? this.bodyEnd : group.end - 1

		this.containers.push({ kind, part, id, group, end, blocks, pictures: story.pictures })
	}

	async write(options: WriteOptions): Promise<Uint8Array> {
		const parts: { name: string; bytes: PartBytes }[] = []
		const relationships: { id: string; type: string; target: string }[] = []
		const overrides: { name: string; type: string }[] = []
		const resolve = this.markerResolver()
		const markup = new XmlStore(this.xmlBudget)
		const stores = new Set<XmlStore>([markup])
		const pieces = (): PartPieces => new PartPieces(markup, resolve, stores)
		const add = (name: string, xml: string | PartPieces, type: string, relationship?: string): void => {
			parts.push({ name, bytes: typeof xml === "string" ? encodeUtf8(xml) : xml.end() })
			overrides.push({ name, type })

			if (relationship !== undefined)
				relationships.push({ id: `rId${relationships.length + 1}`, type: `${RELATIONSHIP}${relationship}`, target: name.slice(5) })
		}

		const bodyMap: SourceBlock[] = []
		const body = pieces()

		body.text(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NAMESPACES}><w:body>`)

		const slicing = options.slicing

		if (slicing === undefined) this.body.write(body, this.body.blocks, bodyMap)
		else {
			const blocks = this.body.blocks

			for (let from = 0; from < blocks.length; from += BODY_RUN) {
				this.body.write(body, blocks.slice(from, from + BODY_RUN), bodyMap)

				if (slicing.due) await slicing.pause()
			}
		}

		body.text(`${options.section}</w:body></w:document>`)
		this.container("body", "word/document.xml", "", undefined, this.body, bodyMap)
		add("word/document.xml", body, `${WORD}document.main+xml`)
		add("word/styles.xml", this.stylesXml(options), `${WORD}styles+xml`, "styles")
		add("word/settings.xml", this.settingsXml(), `${WORD}settings+xml`, "settings")
		add("word/fontTable.xml", fontTableXml(options.fonts), `${WORD}fontTable+xml`, "fontTable")

		if (this.lists.length > 0 && this.overrides.length > 0)
			add("word/numbering.xml", this.numberingXml(), `${WORD}numbering+xml`, "numbering")

		const notesOf = (kind: NoteKind): Note[] => this.notes.filter(note => note.kind === kind)

		for (const kind of ["footnote", "endnote"] as const) {
			const notes = notesOf(kind)

			if (notes.length === 0) continue

			const tag = kind === "footnote" ? "footnote" : "endnote"
			const xml = pieces()

			xml.text(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${tag}s ${NAMESPACES}><w:${tag} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${tag}><w:${tag} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>`
			)

			notes.forEach((note, k) => {
				const map: SourceBlock[] = []

				xml.text(`<w:${tag} w:id="${k + 1}">`)
				storyContent(note.story, xml, map)
				xml.text(`</w:${tag}>`)
				this.container(kind, `word/${tag}s.xml`, String(k + 1), note.group, note.story, map)
			})

			xml.text(`</w:${tag}s>`)
			add(`word/${tag}s.xml`, xml, `${WORD}${tag}s+xml`, `${tag}s`)
		}

		if (this.comments.length > 0) {
			const xml = pieces()

			xml.text(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${NAMESPACES}>`)

			for (const comment of this.comments) {
				const map: SourceBlock[] = []

				xml.text(
					`<w:comment w:id="${comment.index}" w:author="${escapeAttribute(comment.author || "Unknown")}"${comment.initials === "" ? "" : ` w:initials="${escapeAttribute(comment.initials)}"`}${comment.date === undefined ? "" : ` w:date="${comment.date}"`}>`
				)
				storyContent(comment.story, xml, map)
				xml.text("</w:comment>")
				this.container("comment", "word/comments.xml", String(comment.index), comment.group, comment.story, map)
			}

			xml.text("</w:comments>")
			add("word/comments.xml", xml, `${WORD}comments+xml`, "comments")
		}

		const partRelationships = new Map<string, { id: string; type: string; target: string }[]>()

		for (const entry of this.headers) {
			const tag = entry.footer ? "ftr" : "hdr"
			const name = `word/${this.headerPart(entry)}`
			const map: SourceBlock[] = []
			const xml = pieces()

			xml.text(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${tag} ${NAMESPACES}>`)
			storyContent(entry.story, xml, map)
			xml.text(`</w:${tag}>`)
			parts.push({ name, bytes: xml.end() })
			this.container(entry.footer ? "footer" : "header", name, "", entry.group, entry.story, map)
			overrides.push({ name, type: `${WORD}${entry.footer ? "footer" : "header"}+xml` })
			relationships.push({
				id: this.headerRelationship(entry.index),
				type: `${RELATIONSHIP}${entry.footer ? "footer" : "header"}`,
				target: this.headerPart(entry)
			})

			if (entry.story.relationships.length > 0) partRelationships.set(name, entry.story.relationships)
		}

		appendAll(relationships, this.body.relationships)

		const noteRelationships = (kind: NoteKind) => notesOf(kind).flatMap(note => note.story.relationships)

		for (const kind of ["footnote", "endnote"] as const) {
			const list = noteRelationships(kind)

			if (list.length > 0) partRelationships.set(`word/${kind}s.xml`, list)
		}

		const commentRelationships = this.comments.flatMap(comment => comment.story.relationships)

		if (commentRelationships.length > 0) partRelationships.set("word/comments.xml", commentRelationships)

		const packageRelationships = [{ id: "rId1", type: `${RELATIONSHIP}officeDocument`, target: "word/document.xml" }]

		if (this.info.size > 0) {
			parts.push({ name: "docProps/core.xml", bytes: encodeUtf8(this.coreXml()) })
			overrides.push({ name: "docProps/core.xml", type: "application/vnd.openxmlformats-package.core-properties+xml" })
			packageRelationships.push({
				id: "rId2",
				type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
				target: "docProps/core.xml"
			})
		}

		const extensions = new Map<string, string>()

		for (const media of this.mediaParts) extensions.set(media.extension.toLowerCase(), media.contentType)

		let types =
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'

		for (const [extension, type] of extensions)
			types += `<Default Extension="${escapeAttribute(extension)}" ContentType="${escapeAttribute(type)}"/>`
		for (const override of overrides) types += `<Override PartName="/${override.name}" ContentType="${override.type}"/>`

		types += "</Types>"

		const items: ZipPlanItem[] = []
		const data = (name: string, bytes: PartBytes): void => {
			items.push({ kind: "data", name, bytes, compress: options.stored !== true && bytes.length >= DEFLATED_FROM })
		}

		data("[Content_Types].xml", encodeUtf8(types))
		data("_rels/.rels", encodeUtf8(relationshipsXml(packageRelationships)))
		data("word/_rels/document.xml.rels", encodeUtf8(relationshipsXml(relationships)))

		for (const [name, list] of partRelationships) {
			const slash = name.lastIndexOf("/")

			data(`${name.slice(0, slash)}/_rels/${name.slice(slash + 1)}.rels`, encodeUtf8(relationshipsXml(list)))
		}

		for (const part of parts) data(part.name, part.bytes)
		for (const media of this.mediaParts) data(media.name, media.bytes)

		const sink = memorySink()
		const deflate = nativeDeflate()
		const deflateChunks = nativeDeflateChunks()

		try {
			await writeZip({ items }, null, sink, {
				level: 1,
				...(options.slicing === undefined ? {} : { slicing: options.slicing }),
				...(deflate !== undefined ? { deflate } : {}),
				...(deflateChunks !== undefined ? { deflateChunks } : {})
			})
		} finally {
			for (const store of stores) store.release()
		}

		return sink.bytes()
	}

	// Footnote, endnote and comment references and comment ranges are written as markers while the reader
	// does not know yet what they will be (a note's \ftnalt follows its reference; a comment's range starts
	// before the comment): resolved here, unresolvable ranges dropped.
	private markerResolver(): (xml: string) => string {
		const ids = new Map<number, number>()
		const counters = { footnote: 0, endnote: 0 }

		for (const note of this.notes) ids.set(note.index, ++counters[note.kind])

		const commentByTag = new Map<string, number>()

		for (const comment of this.comments)
			if (comment.tag !== "" && !commentByTag.has(comment.tag)) commentByTag.set(comment.tag, comment.index)

		const resolve = (kind: string, value: string): string => {
			switch (kind) {
				case "N": {
					const custom = value.endsWith("c")
					const index = Number(custom ? value.slice(0, -1) : value)
					const note = this.notes[index]
					const tag = note?.kind === "endnote" ? "endnoteReference" : "footnoteReference"

					return `<w:${tag}${custom ? ' w:customMarkFollows="1"' : ""} w:id="${ids.get(index) ?? 0}"/>`
				}
				case "R":
					return this.notes[Number(value)]?.kind === "endnote" ? "<w:endnoteRef/>" : "<w:footnoteRef/>"
				case "C":
					return `<w:commentReference w:id="${value}"/>`
				case "F": {
					const begin = this.fieldBegins[Number(value)]

					if (begin === undefined) return ""

					return begin.ffData === "" ? `${begin.tag}/>` : `${begin.tag}>${begin.ffData}</w:fldChar>`
				}
				default: {
					const id = commentByTag.get(value)

					if (id === undefined) return ""

					return kind === "S" ? `<w:commentRangeStart w:id="${id}"/>` : `<w:commentRangeEnd w:id="${id}"/>`
				}
			}
		}

		// Markers are NUL, a kind letter, a value and NUL; NUL never reaches text (escaping replaces it).
		return xml => {
			let at = xml.indexOf(MARK)

			if (at < 0) return xml

			let out = ""
			let from = 0

			while (at >= 0) {
				const close = xml.indexOf(MARK, at + 1)

				if (close < 0) break

				out += xml.slice(from, at) + resolve(xml.charAt(at + 1), xml.slice(at + 2, close))
				from = close + 1
				at = xml.indexOf(MARK, from)
			}

			return out + xml.slice(from)
		}
	}

	private stylesXml(options: WriteOptions): string {
		const numId = (list: number): number | undefined => this.numId(list)
		const defaultChar = this.defaultChar ?? new CharProps()
		const defaultFont = options.fonts.get(options.defaultFont)
		let rPr = defaultChar.xml(this)

		// RTF text is 12 pt unless \defchp says otherwise; the default font is \deffN.
		const fonts =
			defaultChar.font < 0 && defaultFont !== undefined && defaultFont.name.trim() !== ""
				? `<w:rFonts w:ascii="${escapeAttribute(defaultFont.name.trim())}" w:hAnsi="${escapeAttribute(defaultFont.name.trim())}" w:eastAsia="${escapeAttribute(defaultFont.name.trim())}" w:cs="${escapeAttribute(defaultFont.name.trim())}"/>`
				: ""
		const size = defaultChar.size < 0 ? '<w:sz w:val="24"/><w:szCs w:val="24"/>' : ""

		rPr =
			rPr === ""
				? `<w:rPr>${fonts}${size}</w:rPr>`
				: rPr.replace("<w:rPr>", `<w:rPr>${defaultChar.style >= 0 ? "" : fonts}`).replace("</w:rPr>", `${size}</w:rPr>`)

		const pPr = this.defaultPara === undefined ? "" : this.defaultPara.xml(this, numId)
		let out = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NAMESPACES}><w:docDefaults><w:rPrDefault>${rPr}</w:rPrDefault><w:pPrDefault>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}</w:pPrDefault></w:docDefaults>`
		const ids = this.ids()
		let normal = false

		for (const style of this.styles) {
			if (style.type === "section") continue

			const prefix = style.type[0] ?? "p"
			const id = ids.get(`${prefix}${style.number}`)

			if (id === undefined) continue
			// Only the first definition of a number is used.
			if (this.styleByKey().get(`${prefix}${style.number}`) !== style) continue

			const isNormal = style.type === "paragraph" && style.number === 0

			normal ||= isNormal

			const basedOn = style.basedOn >= 0 && style.basedOn !== style.number ? ids.get(`${prefix}${style.basedOn}`) : undefined
			const next = style.type === "paragraph" && style.next >= 0 ? ids.get(`p${style.next}`) : undefined
			const link = style.link >= 0 ? ids.get(`${style.type === "paragraph" ? "c" : "p"}${style.link}`) : undefined
			// "heading 3,Numbered paragraph": the name, then aliases (a name holds no comma, §17.7.4.9).
			const [name = "", ...aliases] = (style.name.replace(/;\s*$/u, "").trim() || id).split(",")

			out += `<w:style w:type="${style.type}"${isNormal ? ' w:default="1"' : ""} w:styleId="${escapeAttribute(id)}"><w:name w:val="${escapeAttribute(name.trim() || id)}"/>`
			if (aliases.length > 0) out += `<w:aliases w:val="${escapeAttribute(aliases.map(alias => alias.trim()).join(","))}"/>`
			if (basedOn !== undefined && !this.basedOnCycle(style)) out += `<w:basedOn w:val="${escapeAttribute(basedOn)}"/>`
			if (next !== undefined) out += `<w:next w:val="${escapeAttribute(next)}"/>`
			if (link !== undefined) out += `<w:link w:val="${escapeAttribute(link)}"/>`

			if (style.type === "paragraph") {
				// A paragraph is in a list only by its own \\lsN (spec, "Bullets and Numbering"): styles carry none.
				const paraXml = this.completed(style).para.xml(this, () => undefined)

				if (paraXml !== "") out += `<w:pPr>${paraXml}</w:pPr>`
			}

			// A style holds no highlight (the Open XML SDK refuses w:highlight in style run properties).
			if (style.type !== "table")
				out += this.completed(style)
					.char.xml(this)
					.replace(/<w:highlight [^>]*\/>/u, "")

			out += "</w:style>"
		}

		if (!normal) out += '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'

		return `${out}</w:styles>`
	}

	// A style as RTF defines it, whole (a definition lists every property; \\sbasedonN only names the style it
	// came from): what its base chain sets and it leaves at the RTF default is written as that default, as the
	// docx style inherits from its w:basedOn otherwise (a footer based on a Normal with space after has none).
	private completed(style: StyleDef): { para: ParaProps; char: CharProps } {
		const byKey = this.styleByKey()
		const chain: StyleDef[] = []
		const seen = new Set<StyleDef>([style])

		for (
			let base = style.basedOn >= 0 && style.basedOn !== style.number ? byKey.get(`${style.type[0]}${style.basedOn}`) : undefined;
			base !== undefined && !seen.has(base);
		) {
			chain.push(base)
			seen.add(base)
			base = base.basedOn >= 0 && base.basedOn !== base.number ? byKey.get(`${base.type[0]}${base.basedOn}`) : undefined
		}

		// A character style adds to the text's formatting (\\additive): only paragraph styles are whole.
		if (chain.length === 0 || style.type !== "paragraph") return { para: style.para, char: style.char }

		const para = style.para.clone()
		const char = style.char.clone()
		// The value the base chain gives a property (its nearest definition), when that is not RTF's default.
		const fromBase = <T>(value: (base: StyleDef) => T, unset: T, fallback: T): boolean => {
			for (const base of chain) {
				const found = value(base)

				if (found !== unset) return found !== fallback
			}

			return false
		}

		if (para.before === undefined && fromBase(base => base.para.before, undefined, 0)) para.before = 0
		if (para.after === undefined && fromBase(base => base.para.after, undefined, 0)) para.after = 0
		if (para.line === undefined && fromBase(base => base.para.line, undefined, 0)) para.line = 0
		if (para.left === undefined && fromBase(base => base.para.left, undefined, 0)) para.left = 0
		if (para.right === undefined && fromBase(base => base.para.right, undefined, 0)) para.right = 0
		if (para.firstLine === undefined && fromBase(base => base.para.firstLine, undefined, 0)) para.firstLine = 0
		if (para.jc === undefined && fromBase(base => base.para.jc, undefined, "left")) para.jc = "left"

		for (const key of ["bold", "italic", "caps", "smallCaps", "strike", "dstrike", "hidden"] as const) {
			if (char[key] === -1 && fromBase(base => base.char[key], -1, 0)) char[key] = 0
		}

		if (char.underline === undefined && fromBase(base => base.char.underline, undefined, "none")) char.underline = "none"
		if (char.size === -1 && fromBase(base => base.char.size, -1, 24)) char.size = 24

		para.cached = undefined
		char.cached = undefined

		return { para, char }
	}

	// Whether following \\sbasedonN from `style` returns to it; every chain is walked once.
	private basedOnCycle(style: StyleDef): boolean {
		if (this.cycles === undefined) {
			const cycles = new Set<StyleDef>()
			const state = new Map<StyleDef, number>()
			const byKey = this.styleByKey()

			for (const start of byKey.values()) {
				const path: StyleDef[] = []
				let current: StyleDef | undefined = start

				while (current !== undefined && state.get(current) === undefined) {
					state.set(current, 1)
					path.push(current)
					current = current.basedOn >= 0 ? byKey.get(`${current.type[0]}${current.basedOn}`) : undefined
				}

				if (current !== undefined && state.get(current) === 1) {
					for (let k = path.indexOf(current); k < path.length; k++) cycles.add(path[k] as StyleDef)
				}

				for (const visited of path) state.set(visited, 2)
			}

			this.cycles = cycles
		}

		return this.cycles.has(style)
	}

	private settingsXml(): string {
		let notes = ""

		for (const kind of ["footnote", "endnote"] as const) {
			const pr = this.notePr[kind]
			let inner = ""

			if (pr.position !== "") inner += `<w:pos w:val="${pr.position}"/>`
			if (pr.format !== "") inner += `<w:numFmt w:val="${pr.format}"/>`
			if (pr.start >= 1) inner += `<w:numStart w:val="${pr.start}"/>`
			if (pr.restart !== "") inner += `<w:numRestart w:val="${pr.restart}"/>`
			if (inner !== "") notes += `<w:${kind}Pr>${inner}</w:${kind}Pr>`
		}

		return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${NAMESPACES}>${this.mirrorMargins ? "<w:mirrorMargins/>" : ""}${this.trackRevisions ? "<w:trackRevisions/>" : ""}<w:defaultTabStop w:val="${Math.max(1, this.defaultTab)}"/>${this.evenAndOdd ? "<w:evenAndOddHeaders/>" : ""}${notes}${this.htmlAutoSpacing ? "" : "<w:compat><w:doNotUseHTMLParagraphAutoSpacing/></w:compat>"}</w:settings>`
	}

	private numberingXml(): string {
		const numId = (): number | undefined => undefined
		let out = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NAMESPACES}>`

		this.lists.forEach((list, index) => {
			out += `<w:abstractNum w:abstractNumId="${index}">`

			list.levels.slice(0, 9).forEach((level, k) => {
				out += levelXml(level, k, this, numId)
			})

			out += "</w:abstractNum>"
		})

		const written = new Set<number>()

		for (const override of this.overrides) {
			const id = this.numId(override.ls)

			if (id === undefined || written.has(id)) continue

			written.add(id)

			const abstract = this.listIndex().get(override.listId) ?? -1

			out += `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstract}"/>`

			override.levels.slice(0, 9).forEach((entry, k) => {
				if (!entry.restart && entry.level === undefined) return

				out += `<w:lvlOverride w:ilvl="${k}">`
				if (entry.restart && entry.start >= 0) out += `<w:startOverride w:val="${entry.start}"/>`
				if (entry.level !== undefined) out += levelXml(entry.level, k, this, numId)
				out += "</w:lvlOverride>"
			})

			out += "</w:num>"
		}

		return `${out}</w:numbering>`
	}

	private coreXml(): string {
		const field = (tag: string, key: string): string => {
			const value = this.info.get(key)

			return value === undefined || value === "" ? "" : `<${tag}>${escapeText(value)}</${tag}>`
		}
		const date = (tag: string, key: string): string => {
			const value = this.info.get(key)

			return value === undefined ? "" : `<${tag} xsi:type="dcterms:W3CDTF">${value}</${tag}>`
		}

		return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${field("dc:title", "title")}${field("dc:subject", "subject")}${field("dc:creator", "author")}${field("cp:keywords", "keywords")}${field("dc:description", "doccomm")}${field("cp:lastModifiedBy", "operator")}${field("cp:category", "category")}${date("dcterms:created", "creatim")}${date("dcterms:modified", "revtim")}</cp:coreProperties>`
	}
}

function storyContent(story: Story, out: XmlSink, map: SourceBlock[]): void {
	story.write(out, story.blocks, map)

	// A note, comment, header or footer holds at least one paragraph.
	if (story.blocks.length === 0 || story.blocks.at(-1)?.kind === "tbl") {
		map.push(syntheticParagraph())
		out.text("<w:p/>")
	}
}

// Entries at least this long are deflated.
const DEFLATED_FROM = 64 * 1024
// Generated markup is gathered into the part's store past this many characters.
const TEXT_RUN = 64 * 1024
// Pieces shorter than this are copied together into chunks of GATHER bytes for the zip writer.
const GATHER = 256 * 1024

// A part's content as it is written: generated markup (resolved markers included) put into a store of its own,
// held paragraphs referenced where they are, consecutive ones as one range. Read back as chunks by the zip writer.
class PartPieces implements XmlSink {
	private readonly markup: XmlStore
	private readonly resolve: (xml: string) => string
	private readonly stores: Set<XmlStore>
	private readonly pieceStores: XmlStore[] = []
	private readonly ats: number[] = []
	private readonly sizes: number[] = []
	private pending = ""
	private length = 0

	constructor(markup: XmlStore, resolve: (xml: string) => string, stores: Set<XmlStore>) {
		this.markup = markup
		this.resolve = resolve
		this.stores = stores
	}

	text(xml: string): void {
		this.pending += xml

		if (this.pending.length > TEXT_RUN) this.flush()
	}

	paragraph(paragraph: Paragraph): void {
		if (paragraph.marked) {
			let xml = ""

			for (const bytes of paragraph.store.read(paragraph.at, paragraph.size)) xml += decodeUtf8(bytes)

			this.text(this.resolve(xml))

			return
		}

		this.flush()
		this.push(paragraph.store, paragraph.at, paragraph.size)
	}

	end(): DeflatedChunks {
		this.flush()

		return { length: this.length, chunks: () => this.chunks(), pieces: () => this.pieces() }
	}

	private flush(): void {
		if (this.pending === "") return

		const at = this.markup.put(this.pending)

		this.pending = ""
		this.push(this.markup, at, this.markup.size)
	}

	private push(store: XmlStore, at: number, size: number): void {
		const last = this.ats.length - 1

		this.length += size

		if (last >= 0 && this.pieceStores[last] === store && (this.ats[last] ?? 0) + (this.sizes[last] ?? 0) === at) {
			this.sizes[last] = (this.sizes[last] ?? 0) + size

			return
		}

		this.stores.add(store)
		this.pieceStores.push(store)
		this.ats.push(at)
		this.sizes.push(size)
	}

	private chunks(): AsyncGenerator<Uint8Array> {
		return this.gathered(false) as AsyncGenerator<Uint8Array>
	}

	// Deflated segments held whole in the range pass through still deflated (the zip writer splices them in).
	private pieces(): AsyncGenerator<Uint8Array | DeflatedPiece> {
		return this.gathered(true)
	}

	private async *gathered(deflated: boolean): AsyncGenerator<Uint8Array | DeflatedPiece> {
		let gather = new Uint8Array(GATHER)
		let filled = 0

		for (let k = 0; k < this.ats.length; k++) {
			const store = this.pieceStores[k] as XmlStore
			const at = this.ats[k] ?? 0
			const size = this.sizes[k] ?? 0

			for (const bytes of deflated ? store.pieces(at, size) : store.read(at, size)) {
				if (!(bytes instanceof Uint8Array)) {
					if (filled > 0) {
						yield gather.subarray(0, filled)
						gather = new Uint8Array(GATHER)
						filled = 0
					}

					yield bytes

					continue
				}

				if (filled > 0 && (bytes.length >= GATHER / 2 || filled + bytes.length > GATHER)) {
					yield gather.subarray(0, filled)
					gather = new Uint8Array(GATHER)
					filled = 0
				}

				if (bytes.length >= GATHER / 2) {
					yield bytes

					continue
				}

				gather.set(bytes, filled)
				filled += bytes.length
			}
		}

		if (filled > 0) yield gather.subarray(0, filled)
	}
}

function relationshipsXml(list: readonly { id: string; type: string; target: string }[]): string {
	let out =
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'

	for (const relationship of list) {
		out += `<Relationship Id="${escapeAttribute(relationship.id)}" Type="${escapeAttribute(relationship.type)}" Target="${escapeAttribute(relationship.target)}"/>`
	}

	return `${out}</Relationships>`
}

function fontTableXml(fonts: ReadonlyMap<number, FontEntry>): string {
	let out = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts ${NAMESPACES}>`
	const seen = new Set<string>()

	for (const font of fonts.values()) {
		const name = font.name.trim()

		if (name === "" || seen.has(name)) continue

		seen.add(name)
		out += `<w:font w:name="${escapeAttribute(name)}">`
		if (font.charset >= 0 && font.charset <= 255)
			out += `<w:charset w:val="${font.charset.toString(16).padStart(2, "0").toUpperCase()}"/>`
		out += `<w:family w:val="${font.family}"/>`
		out += `<w:pitch w:val="${font.pitch === 1 ? "fixed" : font.pitch === 2 ? "variable" : "default"}"/>`
		out += "</w:font>"
	}

	return `${out}</w:fonts>`
}

// A w:lvl from a \listlevel: \leveltext's first character is the length of the template, in which the
// characters 0..8 stand for the numbers of levels 1..9 (spec, "List Table").
function levelXml(level: ListLevelDef, index: number, context: DocumentParts, numId: (list: number) => number | undefined): string {
	const raw = level.text
	const length = raw.length > 0 ? raw.charCodeAt(0) : 0
	const template = raw.slice(1, 1 + length)
	let text = ""

	for (let k = 0; k < template.length; k++) {
		const code = template.charCodeAt(k)

		text += code < 9 ? `%${code + 1}` : template[k]
	}

	const format = numberFormat(level.nfc)
	let out = `<w:lvl w:ilvl="${index}"><w:start w:val="${Math.max(0, level.start)}"/><w:numFmt w:val="${format}"/>`

	if (level.noRestart) out += '<w:lvlRestart w:val="0"/>'

	if (level.legal) out += "<w:isLgl/>"
	if (level.follow === 1) out += '<w:suff w:val="space"/>'
	else if (level.follow === 2) out += '<w:suff w:val="nothing"/>'

	out += `<w:lvlText w:val="${escapeAttribute(text)}"/><w:lvlJc w:val="${level.jc === 1 ? "center" : level.jc === 2 ? "right" : "left"}"/>`

	const pPr = level.para.xml(context, numId, false)

	if (pPr !== "") out += `<w:pPr>${pPr}</w:pPr>`

	out += level.char.xml(context)

	return `${out}</w:lvl>`
}
