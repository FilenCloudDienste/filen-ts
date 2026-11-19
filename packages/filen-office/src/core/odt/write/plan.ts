import { odfPrefixOf } from "../../odf/namespaces"
import { OdfNs, OdfStyleResolver, elementName, readContentPrologue } from "../../odf/index"
import { readContentPrologueSliced } from "../../odf/prologue"
import { OdfStyleSheet } from "../../odf/styles"
import { sliceClock } from "../../slicing"
import { turn, type RtfJob } from "../../rtf/turns"
import { Namespaces, NodeKind, decodeUtf8, encodeUtf8, parseXml, parseXmlSliced, type XmlDocument } from "../../xml/index"
import { StyleMapper } from "../styles"
import { configBoolean } from "../translate"
import type { OdtOrigin, OdtTranslation } from "../types"
import { OdtWriteRefusal } from "./emit"
import { KEPT_FIELDS } from "./sourceText"
import type { OdtSource } from "./source"

// The plan of a save: the source's units (top-level blocks, table rows and cells) and which of them the edit may rewrite.

export interface OdtEdits {
	readonly parts: ReadonlyMap<string, Uint8Array>
	readonly removed?: readonly string[]
}

export const BODY_PART = "word/document.xml"

// Elements a block may hold and still be rewritten: what the translator turns into WordprocessingML a reader can
// tell apart. Atoms (pictures, notes, comments, fields) are copied whole; anything else (index marks, ruby, metadata
// fields...) would be lost by a rewrite, so the block stays as the source has it.
const REWRITABLE = new Set([
	"text:p",
	"text:h",
	"text:span",
	"text:s",
	"text:tab",
	"text:line-break",
	"text:a",
	"text:soft-page-break",
	"text:list",
	"text:list-item",
	"text:list-header",
	"text:page-number",
	"text:page-count",
	"text:bookmark",
	"text:bookmark-start",
	"text:bookmark-end",
	"text:reference-mark",
	"text:reference-mark-start",
	"text:reference-mark-end",
	"office:annotation-end",
	// Inside a paragraph, around a change this paragraph alone holds (OdtPlan.changeOpaque).
	"text:change",
	"text:change-start",
	"text:change-end",
	"table:table",
	"table:table-column",
	"table:table-columns",
	"table:table-header-columns",
	"table:table-column-group",
	"table:table-row",
	"table:table-rows",
	"table:table-header-rows",
	"table:table-row-group",
	"table:table-cell",
	"table:covered-table-cell"
])
export const ATOMS = new Set(["text:note", "office:annotation", ...KEPT_FIELDS])
const NO_NODES: ReadonlySet<number> = new Set()
// Attributes a rewrite keeps or restates, by element; any other keeps the block as it is. Paragraphs keep their start
// tags (or restate these); links keep theirs while their target stays; table elements are kept or copied whole.
const PARAGRAPH_ATTRIBUTES = new Set([
	"text:style-name",
	"text:outline-level",
	"text:is-list-header",
	"text:restart-numbering",
	"text:start-value",
	"xml:id",
	"text:id",
	"text:cond-style-name"
])
const ATTRIBUTES: Readonly<Record<string, ReadonlySet<string> | undefined>> = {
	"text:p": PARAGRAPH_ATTRIBUTES,
	"text:h": PARAGRAPH_ATTRIBUTES,
	"text:span": new Set(["text:style-name"]),
	"text:s": new Set(["text:c"]),
	"text:tab": new Set(["text:tab-ref"]),
	"text:line-break": new Set(),
	"text:soft-page-break": new Set(),
	"text:bookmark": new Set(["text:name", "xml:id"]),
	"text:bookmark-start": new Set(["text:name", "xml:id"]),
	"text:bookmark-end": new Set(["text:name"]),
	"text:reference-mark": new Set(["text:name"]),
	"text:reference-mark-start": new Set(["text:name"]),
	"text:reference-mark-end": new Set(["text:name"]),
	"text:page-number": new Set(["text:select-page"]),
	"text:page-count": new Set(),
	"text:list": new Set(["text:style-name", "text:continue-numbering", "text:continue-list", "xml:id"]),
	"text:list-item": new Set(["text:start-value", "xml:id"]),
	"text:list-header": new Set(["xml:id"]),
	"office:annotation-end": new Set(["office:name"]),
	"text:change": new Set(["text:change-id"]),
	"text:change-start": new Set(["text:change-id"]),
	"text:change-end": new Set(["text:change-id"])
}
const CHANGE_MARKS: ReadonlySet<string> = new Set(["text:change", "text:change-start", "text:change-end"])

// A source element of content.xml parsed on its own (inside the root's start tag, so its prefixes resolve).
export interface UnitTree {
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	readonly node: number
	// Absolute offset of the parsed bytes' start in the stream.
	readonly shift: number
	// The flow blocks the translator made of it, in order: paragraphs and tables, with their elements.
	readonly emitters: readonly number[] | undefined
	// Why it may not be rewritten (an element a rewrite would lose); undefined when it may.
	readonly opaque: string | undefined
	// The same for each block (by emitter), and for the structure around them (a list's attributes...): a block
	// holding what a rewrite would lose stays as it is, the others of its element may change.
	readonly blockOpaque: readonly (string | undefined)[] | undefined
	readonly structuralOpaque: string | undefined
	// A section, an index or a page-anchored frame: the element must stay, only its paragraphs may change.
	readonly structural: boolean
}

// A tracked change's record in the source (OdtPlan.changeRecords).
export interface ChangeRecord {
	readonly kind: "insertion" | "deletion" | "other"
	readonly simple: boolean
	// The text:changed-region's span in content.xml.
	readonly start: number
	readonly end: number
}

// office:text's text:tracked-changes in content.xml: its start tag's span, prefix and other attributes, and where
// its end tag starts (-1: it is empty-element); or, with none, where one goes (after office:text's forms, Part 3
// §3.4).
interface TrackedChanges {
	readonly container: { tagStart: number; tagEnd: number; prefix: string; attributes: string; close: number } | undefined
	readonly insertAt: number
}

export function trackedChangesOf(plan: OdtPlan): TrackedChanges {
	const bytes = plan.contentBytes
	const start = plan.textStart()
	// The start tags are matched in a decoded head; the ends (text:tracked-changes holds every deletion's content,
	// office:forms every form) are found in the bytes, however far.
	const head = (from: number): { readonly text: string; readonly offset: (characters: number) => number } => {
		const text = decodeUtf8(bytes.subarray(from, Math.min(bytes.length, from + 4 * 1024 * 1024)))

		return { text, offset: characters => from + encodeUtf8(text.slice(0, characters)).length }
	}
	let read = head(start)
	let after = start
	const forms = /^\s*<([A-Za-z0-9_.-]+:)?forms\b[^>]*?(\/?)>/u.exec(read.text)

	if (forms !== null) {
		after = read.offset(forms[0].length)

		if (forms[2] !== "/") {
			const end = encodeUtf8(`</${forms[1] ?? ""}forms>`)
			const at = indexOf(bytes, end, after)

			if (at < 0) throw new OdtWriteRefusal("package", "content.xml's forms have no end")

			after = at + end.length
		}

		read = head(after)
	}

	const container = /^\s*(<([A-Za-z0-9_.-]+:)?tracked-changes\b([^>]*?)(\/?)>)/u.exec(read.text)

	if (container === null) return { container: undefined, insertAt: after }

	const prefix = container[2] ?? ""
	const tagStart = read.offset(container.index + container[0].length - (container[1] ?? "").length)
	const tagEnd = read.offset(container.index + container[0].length)
	let close = -1

	if (container[4] !== "/") {
		close = indexOf(bytes, encodeUtf8(`</${prefix}tracked-changes>`), tagEnd)

		if (close < 0) throw new OdtWriteRefusal("package", "content.xml's tracked changes have no end")
	}

	return { container: { tagStart, tagEnd, prefix, attributes: container[3] ?? "", close }, insertAt: tagStart }
}

export interface Unit {
	readonly origin: OdtOrigin
	readonly index: number
	tree?: UnitTree | undefined
}

export interface Region {
	readonly units: Unit[]
	// Edited blocks [from, to) taking their place.
	readonly from: number
	readonly to: number
	// Where an insertion goes when the region has no units of its own.
	readonly at: number
}

export interface Segment {
	readonly id: number
	readonly start: number
	readonly end: number
	readonly kind: "kept" | "written"
	readonly units: readonly Unit[]
	// Edited blocks [from, to) the segment's reading must equal.
	readonly from: number
	readonly to: number
}

// What a plan reads of the source's style streams: held while a write runs, let go while the proof reads.
interface PlanStyles {
	readonly stylesDocument: XmlDocument
	readonly prologueDocument: XmlDocument
	readonly sheet: OdfStyleSheet
	readonly mapper: StyleMapper
}

// Everything one write of an edit needs: the source's streams and translation, the edited parts, and how they meet.
export class OdtPlan {
	readonly source: OdtSource
	readonly translation: OdtTranslation
	readonly edits: OdtEdits
	readonly contentBytes: Uint8Array
	readonly stylesBytes: Uint8Array
	readonly tabsRelativeToIndent: boolean
	readonly translated: Map<string, XmlDocument> = new Map()
	readonly edited: Map<string, XmlDocument> = new Map()
	readonly units: Unit[]
	readonly rootOpen: string
	readonly rootClose: string
	private readonly bodyStart: number
	private styleState: PlanStyles | undefined
	// Per stream and prefix, the numbers N of every double-quoted "<prefix>N" in the stream: the write rounds share it.
	private readonly quoted = new Map<Uint8Array, Map<string, Set<string>>>()

	// Where content.xml's prologue (font faces, automatic styles) ends: office:body.
	get prologueEnd(): number {
		return this.bodyStart < 0 ? this.contentBytes.length : this.bodyStart
	}

	// The digits of every "<prefix><digits>" in `bytes` (attribute values and quoted text alike), read in one scan.
	quotedNumbers(bytes: Uint8Array, prefix: string): ReadonlySet<string> {
		let byPrefix = this.quoted.get(bytes)

		if (byPrefix === undefined) {
			byPrefix = new Map()
			this.quoted.set(bytes, byPrefix)
		}

		let numbers = byPrefix.get(prefix)

		if (numbers !== undefined) return numbers

		numbers = new Set()

		const needle = encodeUtf8(`"${prefix}`)

		for (let at = indexOf(bytes, needle, 0); at >= 0; at = indexOf(bytes, needle, at + needle.length)) {
			const from = at + needle.length
			let end = from

			while ((bytes[end] ?? 0) >= 0x30 && (bytes[end] ?? 0) <= 0x39) end++

			if (end > from && bytes[end] === 0x22) numbers.add(decodeUtf8(bytes.subarray(from, end)))
		}

		byPrefix.set(prefix, numbers)

		return numbers
	}

	private constructor(
		source: OdtSource,
		edits: OdtEdits,
		content: Uint8Array,
		styles: Uint8Array,
		settings: XmlDocument | undefined,
		read: PlanStyles & { readonly bodyStart: number }
	) {
		this.source = source
		this.translation = source.translation
		this.edits = edits
		this.contentBytes = content
		this.stylesBytes = styles
		this.tabsRelativeToIndent = configBoolean(settings, "TabsRelativeToIndent") ?? true
		this.bodyStart = read.bodyStart
		this.styleState = read

		const prologue = read.prologueDocument
		const root = prologue.documentElement()

		this.rootOpen = decodeUtf8(content.subarray(prologue.start(root), prologue.openEnd(root)))
		this.rootClose = `</${prologue.name(root)}>`
		this.units = this.translation.origins
			.filter(origin => origin.part === BODY_PART && origin.stream === "content.xml")
			.sort((a, b) => a.start - b.start)
			.map((origin, index) => ({ origin, index }))
	}

	// styles.xml and content.xml's prologue parsed, and their style sheet (in slices on a job).
	private static async readStyles(
		content: Uint8Array,
		styles: Uint8Array,
		tabsRelativeToIndent: boolean,
		job: RtfJob | undefined
	): Promise<PlanStyles & { readonly bodyStart: number }> {
		const slicing = job?.aborting
		const stylesDocument = slicing === undefined ? parseXml(styles) : await parseXmlSliced(styles, slicing)

		await turn(job)

		const prologue = slicing === undefined ? readContentPrologue(content) : await readContentPrologueSliced(content, slicing)

		await turn(job)

		const sheet =
			slicing === undefined
				? new OdfStyleSheet(stylesDocument, prologue)
				: await OdfStyleSheet.build(stylesDocument, prologue, slicing)
		const mapper = new StyleMapper(sheet, new OdfStyleResolver(sheet), { tabsRelativeToIndent })

		return { stylesDocument, prologueDocument: prologue.document, sheet, mapper, bodyStart: prologue.bodyStart }
	}

	private get styled(): PlanStyles {
		if (this.styleState === undefined) throw new Error("The plan's styles were let go")

		return this.styleState
	}

	get stylesDocument(): XmlDocument {
		return this.styled.stylesDocument
	}

	get prologueDocument(): XmlDocument {
		return this.styled.prologueDocument
	}

	get sheet(): OdfStyleSheet {
		return this.styled.sheet
	}

	get mapper(): StyleMapper {
		return this.styled.mapper
	}

	static async create(source: OdtSource, edits: OdtEdits, job: RtfJob | undefined): Promise<OdtPlan> {
		const read = async (name: string): Promise<Uint8Array | undefined> => {
			const entry = source.archive.get(name)

			if (entry === undefined) return undefined
			if (job === undefined) return source.archive.read(entry)

			// Copied as they arrive: a chunk of stream() is the caller's only until the next one (its size is checked).
			const out = new Uint8Array(entry.uncompressedSize)
			let at = 0

			for await (const chunk of source.archive.stream(entry, sliceClock(job.aborting))) {
				out.set(chunk, at)
				at += chunk.length
			}

			return out
		}
		const content = await read("content.xml")

		await turn(job)

		const styles = (await read("styles.xml")) ?? encodeUtf8(`<office:document-styles xmlns:office="${OdfNs.office}"/>`)
		let settings: XmlDocument | undefined

		try {
			const bytes = await read("settings.xml")

			settings = bytes === undefined ? undefined : parseXml(bytes)
		} catch {
			settings = undefined
		}

		if (content === undefined) throw new OdtWriteRefusal("package", "the package has no content.xml")
		if (!source.translation.originsExact) throw new OdtWriteRefusal("package", "content.xml is not UTF-8")

		const tabs = configBoolean(settings, "TabsRelativeToIndent") ?? true

		return new OdtPlan(source, edits, content, styles, settings, await OdtPlan.readStyles(content, styles, tabs, job))
	}

	// The styles read again after they were let go (a further write round).
	async restyle(job: RtfJob | undefined): Promise<void> {
		this.styleState ??= await OdtPlan.readStyles(this.contentBytes, this.stylesBytes, this.tabsRelativeToIndent, job)
	}

	// The parts the writer reads, parsed in slices ahead of the steps that read them at once.
	async preload(job: RtfJob | undefined): Promise<void> {
		if (job === undefined) return

		for (const name of [
			BODY_PART,
			"word/styles.xml",
			"word/numbering.xml",
			"word/footnotes.xml",
			"word/endnotes.xml",
			"word/comments.xml"
		]) {
			const translated = this.translation.parts.get(name)

			if (translated instanceof Uint8Array && !this.translated.has(name))
				this.translated.set(name, await parseXmlSliced(translated, job.aborting))

			const edited = this.edits.parts.get(name)

			if (edited !== undefined && !this.edited.has(name)) this.edited.set(name, await parseXmlSliced(edited, job.aborting))
		}
	}

	// Lets go of what was parsed for a write (the bodies, the unit trees): parsed again when asked for. `styles`: the
	// style sheet too (read again by restyle).
	release(styles = false): void {
		this.translated.clear()
		this.edited.clear()

		for (const unit of this.units) unit.tree = undefined

		if (styles) this.styleState = undefined
	}

	translatedXml(name: string): XmlDocument | undefined {
		let document = this.translated.get(name)

		if (document === undefined) {
			const part = this.translation.parts.get(name)

			if (!(part instanceof Uint8Array)) return undefined

			document = parseXml(part)
			this.translated.set(name, document)
		}

		return document
	}

	editedXml(name: string): XmlDocument | undefined {
		if (this.edits.removed?.includes(name) === true) return undefined

		let document = this.edited.get(name)

		if (document === undefined) {
			const part = this.edits.parts.get(name)

			if (part === undefined) return this.translatedXml(name)

			document = parseXml(part)
			this.edited.set(name, document)
		}

		return document
	}

	// The unit's source element parsed, with its flow blocks found.
	tree(unit: Unit): UnitTree {
		if (unit.tree !== undefined) return unit.tree

		const { start, end } = unit.origin
		const open = encodeUtf8(this.rootOpen)
		const close = encodeUtf8(this.rootClose)
		const bytes = new Uint8Array(open.length + (end - start) + close.length)

		bytes.set(open)
		bytes.set(this.contentBytes.subarray(start, end), open.length)
		bytes.set(close, open.length + end - start)

		const document = parseXml(bytes)
		const namespaces = new Namespaces(document)
		const node = document.firstChildElement(document.documentElement())
		const emitters: number[] = []
		let opaque: string | undefined
		let structuralOpaque: string | undefined
		let structural = false
		const flow = (at: number): void => {
			const name = elementName(document, namespaces, at)

			switch (name) {
				case "text:p":
				case "text:h":
				case "table:table":
					emitters.push(at)
					break
				case "text:list":
				case "text:list-item":
				case "text:list-header":
				case "text:section":
				case "text:numbered-paragraph":
					if (name === "text:section" || name === "text:numbered-paragraph") structural = true

					for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) flow(child)

					break
				default:
					structural = true
			}
		}
		// Why an element (with what it holds) may not be rewritten; undefined when it may.
		const attributesOpaque = (at: number, name: string): string | undefined => {
			const allowed = ATTRIBUTES[name]

			if (allowed === undefined) return undefined

			for (const attribute of document.attributes(at)) {
				if (attribute.name.startsWith("xmlns")) continue

				const canonical = canonicalAttribute(namespaces, at, attribute.name)

				// A page number of another page than the current one is written back as the current one's.
				if (!allowed.has(canonical) || (canonical === "text:select-page" && attribute.value !== "current"))
					return `${name} ${canonical}`
			}

			return undefined
		}
		// `inParagraph`: `at` is a paragraph or inside one (change marks between blocks stay as they are).
		const scan = (at: number, skip: ReadonlySet<number>, inParagraph: boolean): string | undefined => {
			for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) {
				if (skip.has(child)) continue

				const name = elementName(document, namespaces, child)

				if (name.startsWith("draw:") || name.startsWith("dr3d:") || ATOMS.has(name)) continue
				if (!REWRITABLE.has(name) && name !== "text:section") return name
				if (CHANGE_MARKS.has(name) && !inParagraph) return name

				const paragraph = name === "text:p" || name === "text:h"
				const found =
					attributesOpaque(child, name) ??
					(paragraph ? this.changeOpaque(document, namespaces, child) : undefined) ??
					scan(child, skip, inParagraph || paragraph)

				if (found !== undefined) return found
			}

			return undefined
		}
		let blockOpaque: (string | undefined)[] = []

		if (node >= 0) {
			flow(node)
			// Each block's own, and what the structure around them holds.
			blockOpaque = emitters.map(emitter => {
				const name = elementName(document, namespaces, emitter)
				const paragraph = name === "text:p" || name === "text:h"

				return (
					attributesOpaque(emitter, name) ??
					(paragraph ? this.changeOpaque(document, namespaces, emitter) : undefined) ??
					scan(emitter, NO_NODES, paragraph)
				)
			})
			structuralOpaque = scan(document.documentElement(), new Set(emitters), false)
			opaque = structuralOpaque ?? blockOpaque.find(reason => reason !== undefined)
		}

		unit.tree = {
			document,
			namespaces,
			node,
			shift: start - open.length,
			emitters: emitters.length === unit.origin.count ? emitters : undefined,
			opaque,
			blockOpaque: emitters.length === unit.origin.count ? blockOpaque : undefined,
			structuralOpaque,
			structural
		}

		return unit.tree
	}

	// Why a unit's rewrite would lose what its translation approximates; undefined when it would not. Most of what the
	// translator approximates a rewrite keeps as the source has it: common styles (only named), properties of
	// automatic styles the edit left (patched, not restated), pictures, objects and shapes (copied whole), sections
	// and lists (their elements kept). What it would lose: content past what WordprocessingML holds (columns past 63,
	// repeated rows cut short), indexes, unknown elements, tracked changes (also caught as
	// elements a rewrite cannot write), and text effects of an automatic style a new span style would not restate.
	lossy(unit: Unit): string | undefined {
		const reasons = unit.origin.lossy.filter(reason => LOCKING_REASONS.has(reason))

		if (reasons.length > 0) return reasons.join(", ")
		if (!unit.origin.lossy.some(reason => reason === "textTransform" || reason === "textEffect")) return undefined

		const tree = this.tree(unit)
		const stack = tree.node < 0 ? [] : [tree.node]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			const name = attributeNamed(tree, node, "text:style-name")
			const family = elementName(tree.document, tree.namespaces, node) === "text:span" ? "text" : "paragraph"
			const style = name === undefined ? undefined : this.sheet.style(family, name, "content")
			const text = style?.automatic === true ? style.properties.get("text")?.attributes : undefined

			if (text !== undefined && hasTextEffect(text)) return "a text effect of the block's own style"

			for (let child = tree.document.firstChildElement(node); child >= 0; child = tree.document.nextSiblingElement(child))
				stack.push(child)
		}

		return undefined
	}

	// Why a paragraph's change marks (Part 3 §5.5.7-§5.5.9) may not be rewritten; undefined when they may. A rewrite
	// writes the paragraph's tracked changes as new changes and leaves out the records of those it replaced
	// (OdtWrite.recordChanges): each change the paragraph marks must be one it alone marks (an insertion's start and
	// end, a deletion's one mark), whose record says nothing the translation does not read (OdtPlan.changeRecords).
	changeOpaque(document: XmlDocument, namespaces: Namespaces, paragraph: number): string | undefined {
		const seen = new Map<string, string[]>()
		// Insertions open where the walk is, and those holding something (an empty one would be left out unseen).
		const open = new Set<string>()
		const filled = new Set<string>()
		const fill = (): void => {
			for (const id of open) filled.add(id)
		}
		const walk = (node: number): void => {
			for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
				const kind = document.kind(child)

				if (kind === NodeKind.Text || kind === NodeKind.CData) {
					if (document.text(child) !== "") fill()

					continue
				}

				if (kind !== NodeKind.Element) continue

				const name = elementName(document, namespaces, child)

				if (name.startsWith("draw:") || name.startsWith("dr3d:") || ATOMS.has(name)) {
					fill()

					continue
				}

				if (CHANGE_MARKS.has(name)) {
					const id = attributeOf(document, namespaces, child, "text:change-id") ?? ""
					const marks = seen.get(id)

					if (marks === undefined) seen.set(id, [name])
					else marks.push(name)

					if (name === "text:change-start") open.add(id)
					else if (name === "text:change-end") open.delete(id)
				} else {
					if (name === "text:s" || name === "text:tab" || name === "text:line-break") fill()

					walk(child)
				}
			}
		}

		walk(paragraph)

		if (seen.size === 0) return undefined

		const records = this.changeRecords()

		for (const [id, marks] of seen) {
			const record = records.get(id)
			const shape = marks.join(" ")
			const fits =
				record?.simple === true &&
				(record.kind === "insertion" ? shape === "text:change-start text:change-end" && filled.has(id) : shape === "text:change") &&
				this.changeMarks().get(id)?.length === marks.length

			if (!fits) return marks[0]
		}

		return undefined
	}

	private records: Map<string, ChangeRecord> | undefined

	// The source's tracked-change records by id (text:changed-region in text:tracked-changes, Part 3 §5.5.2), each
	// with its span in content.xml. Simple: one insertion or deletion whose change info is an author and a date and,
	// for a deletion, one paragraph with content holding no change marks (all a rewrite records anew).
	changeRecords(): Map<string, ChangeRecord> {
		if (this.records !== undefined) return this.records

		const records = new Map<string, ChangeRecord>()
		// The body's text:tracked-changes is a unit of its own, holding no blocks.
		const unit = this.units.find(
			item => item.origin.count === 0 && /^<([A-Za-z0-9_.-]+:)?tracked-changes[\s>]/u.test(this.headOf(item))
		)

		this.records = records

		if (unit === undefined) return records

		const { start: tagStart, end } = unit.origin
		const open = encodeUtf8(this.rootOpen)
		const closing = encodeUtf8(this.rootClose)
		const bytes = new Uint8Array(open.length + end - tagStart + closing.length)

		bytes.set(open)
		bytes.set(this.contentBytes.subarray(tagStart, end), open.length)
		bytes.set(closing, open.length + end - tagStart)

		const document = parseXml(bytes)
		const namespaces = new Namespaces(document)
		const container = document.firstChildElement(document.documentElement())
		const shift = tagStart - open.length
		const named = (node: number): string => elementName(document, namespaces, node)

		for (let region = document.firstChildElement(container); region >= 0; region = document.nextSiblingElement(region)) {
			if (named(region) !== "text:changed-region") continue

			const id = attributeOf(document, namespaces, region, "text:id") ?? attributeOf(document, namespaces, region, "xml:id")

			if (id === undefined) continue

			const changes: number[] = []

			for (let child = document.firstChildElement(region); child >= 0; child = document.nextSiblingElement(child)) changes.push(child)

			const change = changes.length === 1 ? (changes[0] ?? -1) : -1
			const kind =
				change < 0
					? "other"
					: named(change) === "text:insertion"
						? "insertion"
						: named(change) === "text:deletion"
							? "deletion"
							: "other"
			let simple =
				kind !== "other" &&
				document.attributes(region).every(attribute => {
					const name = canonicalAttribute(namespaces, region, attribute.name)

					return attribute.name.startsWith("xmlns") || name === "text:id" || name === "xml:id"
				})
			let info = 0
			let paragraphs = 0

			for (
				let child = change < 0 ? -1 : document.firstChildElement(change);
				simple && child >= 0;
				child = document.nextSiblingElement(child)
			) {
				const name = named(child)

				if (name === "office:change-info") {
					info++

					const parts: string[] = []

					for (let item = document.firstChildElement(child); item >= 0; item = document.nextSiblingElement(item))
						parts.push(named(item))

					simple = parts.every((part, k) => (part === "dc:creator" || part === "dc:date") && parts.indexOf(part) === k)
				} else if ((name === "text:p" || name === "text:h") && kind === "deletion") {
					paragraphs++

					const raw = decodeUtf8(document.raw(child))

					// Text to record: a deletion of nothing the translation reads would be left out unseen.
					simple =
						(document.textContent(child).trim() !== "" || /:(?:s|tab|line-break)[\s/>]/u.test(raw)) &&
						!/change-id\s*=/u.test(raw)
				} else simple = false
			}

			records.set(id, {
				kind,
				simple: simple && info === 1 && paragraphs === (kind === "deletion" ? 1 : 0),
				start: document.start(region) + shift,
				end: document.end(region) + shift
			})
		}

		return records
	}

	// The start of a unit's markup (enough for its element's name).
	private headOf(unit: Unit): string {
		const bytes = this.contentBytes
		let at = unit.origin.start

		while (at < unit.origin.end && (bytes[at] === 0x20 || bytes[at] === 0x09 || bytes[at] === 0x0a || bytes[at] === 0x0d)) at++

		return decodeUtf8(bytes.subarray(at, Math.min(unit.origin.end, at + 128)))
	}

	private marks: Map<string, number[]> | undefined

	// Where office:text's change marks are (their start tags' offsets in content.xml), by the change they mark.
	changeMarks(): Map<string, number[]> {
		if (this.marks !== undefined) return this.marks

		const marks = new Map<string, number[]>()
		const bytes = this.contentBytes
		const needle = encodeUtf8('change-id="')

		this.marks = marks

		for (let at = indexOf(bytes, needle, this.prologueEnd); at >= 0; at = indexOf(bytes, needle, at + needle.length)) {
			const tag = bytes.lastIndexOf(0x3c, at)
			const head = decodeUtf8(bytes.subarray(tag + 1, at))

			if (!/^([A-Za-z0-9_.-]+:)?change(?:-start|-end)?\s(?:[^>]*\s)?(?:[A-Za-z0-9_.-]+:)?$/u.test(head)) continue

			const valueEnd = bytes.indexOf(0x22, at + needle.length)
			const id = decodeUtf8(bytes.subarray(at + needle.length, valueEnd < 0 ? at + needle.length : valueEnd))
			const list = marks.get(id)

			if (list === undefined) marks.set(id, [tag])
			else list.push(tag)
		}

		return marks
	}

	// Where an insertion into an empty body goes: the start of office:text's content.
	textStart(): number {
		const bytes = this.contentBytes

		for (let at = this.bodyStart; at >= 0 && at < bytes.length; at = bytes.indexOf(0x3c, at + 1)) {
			const end = bytes.indexOf(0x3e, at)
			const tag = decodeUtf8(bytes.subarray(at, end + 1))

			if (/^<([A-Za-z0-9_.-]+:)?text[\s>/]/u.test(tag)) return end + 1
		}

		throw new OdtWriteRefusal("package", "content.xml has no office:text")
	}
}

// Approximations a rewrite would lose (see OdtPlan.lossy).
export const LOCKING_REASONS: ReadonlySet<string> = new Set(["tableLimit", "index", "unknownElement", "trackedChange", "bookmark"])

function hasTextEffect(text: ReadonlyMap<string, string>): boolean {
	const transform = text.get("fo:text-transform")

	return (
		transform === "lowercase" ||
		transform === "capitalize" ||
		(text.get("style:text-rotation-angle") ?? "0") !== "0" ||
		(text.get("style:text-combine") ?? "none") !== "none" ||
		text.get("style:text-blinking") === "true"
	)
}

export function canonicalAttribute(namespaces: Namespaces, node: number, name: string): string {
	const colon = name.indexOf(":")

	if (colon < 0) return name

	const prefix = name.slice(0, colon)

	if (prefix === "xml") return name

	const uri = namespaces.uri(node, prefix)
	const known = uri === undefined ? undefined : odfPrefixOf(uri)

	return known === undefined ? `{${uri ?? ""}}${name.slice(colon + 1)}` : `${known}:${name.slice(colon + 1)}`
}

export function attributeNamed(tree: UnitTree, node: number, canonical: string): string | undefined {
	for (const attribute of tree.document.attributes(node)) {
		if (canonicalAttribute(tree.namespaces, node, attribute.name) === canonical) return attribute.value
	}

	return undefined
}

export function attributeOf(document: XmlDocument, namespaces: Namespaces, node: number, canonical: string): string | undefined {
	for (const attribute of document.attributes(node)) {
		if (canonicalAttribute(namespaces, node, attribute.name) === canonical) return attribute.value
	}

	return undefined
}

export function indexOf(bytes: Uint8Array, needle: Uint8Array, from: number): number {
	for (let at = bytes.indexOf(needle[0] ?? 0, from); at >= 0; at = bytes.indexOf(needle[0] ?? 0, at + 1)) {
		let k = 1

		while (k < needle.length && bytes[at + k] === needle[k]) k++

		if (k === needle.length) return at
	}

	return -1
}

export function unescape(value: string): string {
	return value.replace(
		/&(lt|gt|amp|quot|apos);/gu,
		(_entity, name: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[name] ?? ""
	)
}
