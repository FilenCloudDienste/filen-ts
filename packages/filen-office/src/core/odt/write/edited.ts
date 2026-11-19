import { type PartBytes } from "../../opc/index"
import { parseXml, type XmlDocument } from "../../xml/index"
import { OdtWriteRefusal } from "./emit"
import { canonicalElement } from "./meaning"
import { BODY_PART, OdtPlan, type Segment } from "./plan"

// The edited WordprocessingML package as the docx writer wrote it, read against the translation it was made from.

export const RELS_PART = "word/_rels/document.xml.rels"

// Parts the writer reads nothing from: the package's bookkeeping, and document properties the translation has none of.
export const IGNORED_PARTS = new Set([
	"[Content_Types].xml",
	"_rels/.rels",
	"docProps/core.xml",
	"docProps/app.xml",
	"docProps/custom.xml",
	"word/fontTable.xml",
	"word/webSettings.xml"
])
// Header and footer parts: written into styles.xml's master pages (OdtWrite.writeStories).
const STORY_PART = /^word\/(header|footer)\d+\.xml$|^word\/_rels\/(header|footer)\d+\.xml\.rels$/u
const NOTE_PARTS = new Set(["word/footnotes.xml", "word/endnotes.xml", "word/comments.xml"])

export function fnv(bytes: Uint8Array): number {
	let hash = 0x811c9dc5

	for (let k = 0; k < bytes.length; k++) hash = Math.imul(hash ^ (bytes[k] ?? 0), 0x01000193)

	return hash >>> 0
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

export function bodyOf(document: XmlDocument): number {
	const root = document.documentElement()

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === "body") return child
	}

	return -1
}

function blocksOf(document: XmlDocument, container: number): { blocks: number[]; section: number } {
	const blocks: number[] = []
	let section = -1

	for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		// Bookmark ends left between blocks (a paragraph that held a start was deleted) mark nothing: no block.
		if (local === "sectPr") section = child
		else if (local !== "bookmarkStart" && local !== "bookmarkEnd" && local !== "proofErr") blocks.push(child)
	}

	return { blocks, section }
}

export function relationshipsOf(bytes: Uint8Array | undefined): Map<string, { target: string; external: boolean; type: string }> {
	const out = new Map<string, { target: string; external: boolean; type: string }>()

	if (bytes === undefined) return out

	const document = parseXml(bytes)
	const root = document.documentElement()

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		out.set(document.attribute(child, "Id") ?? "", {
			target: document.attribute(child, "Target") ?? "",
			external: document.attribute(child, "TargetMode") === "External",
			type: document.attribute(child, "Type") ?? ""
		})
	}

	return out
}

// Notes, comments and others by w:id, as the bytes of their elements.
function byId(document: XmlDocument | undefined): Map<string, { node: number; bytes: Uint8Array }> {
	const out = new Map<string, { node: number; bytes: Uint8Array }>()

	if (document === undefined) return out

	const root = document.documentElement()

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		out.set(document.attribute(child, "w:id") ?? "", { node: child, bytes: document.raw(child) })
	}

	return out
}

export interface WriteMode {
	// Gate 1: every block that may be rewritten is, each on its own; failures lock instead of refusing.
	readonly prove: boolean
	// Units rewritten though their blocks are unchanged (a reading that differed).
	readonly forced: ReadonlySet<number>
}

export interface WriteResult {
	// content.xml as written, and styles.xml where it changed.
	readonly content: PartBytes
	readonly styles: PartBytes | undefined
	readonly segments: readonly Segment[]
	readonly written: number
	// Units that could not be written (Gate 1 only), with why; single blocks likewise.
	readonly failed: Map<number, string>
	readonly failedBlocks: Map<number, string>
	readonly pictures: ReadonlyMap<string, Uint8Array>
	readonly pictureParts: ReadonlyMap<string, string>
	readonly contentChanged: boolean
}

// What the writer writes from: the edited body and stories, and what changed besides.
export class EditedDocument {
	readonly plan: OdtPlan
	readonly tBody: XmlDocument
	readonly eBody: XmlDocument
	readonly tBlocks: number[]
	readonly eBlocks: number[]
	readonly tSection: number
	readonly eSection: number
	readonly tRels: Map<string, { target: string; external: boolean; type: string }>
	readonly eRels: Map<string, { target: string; external: boolean; type: string }>
	readonly dirtyNotes = new Set<string>()
	readonly dirtyComments = new Set<string>()
	readonly eNotes: Record<"footnote" | "endnote", Map<string, { node: number; bytes: Uint8Array }>>
	readonly eComments: Map<string, { node: number; bytes: Uint8Array }>
	readonly newStyles = new Map<string, number>()
	// Definitions the edit changed (w:abstractNumId -> before and after), and styles (w:styleId -> before and after).
	readonly changedLists = new Map<string, { before: number; after: number }>()
	readonly changedStyles = new Map<string, { before: number; after: number }>()
	// Edited blocks written though their bytes are as they were (a paragraph a section now starts at).
	readonly forced = new Set<number>()
	// Edited paragraphs that start a page style (a new section): the master page to name, "" for none.
	readonly masters = new Map<number, string>()
	// The meaning of the edited body (verify's, kept across writes).
	expected: { blocks: string[]; sections: string[] } | undefined
	// The edit switched tracking changes on (or off); undefined when it left it.
	tracking: boolean | undefined
	private eIndexes: Map<number, number> | undefined
	private tIndexes: Map<number, number> | undefined

	// A block's place among the edited (translated) body's blocks, -1 for none: indexed when first asked.
	eIndex(block: number): number {
		this.eIndexes ??= new Map(this.eBlocks.map((node, k) => [node, k]))

		return this.eIndexes.get(block) ?? -1
	}

	tIndex(block: number): number {
		this.tIndexes ??= new Map(this.tBlocks.map((node, k) => [node, k]))

		return this.tIndexes.get(block) ?? -1
	}

	constructor(plan: OdtPlan) {
		this.plan = plan

		const tBody = plan.translatedXml(BODY_PART)
		const eBody = plan.editedXml(BODY_PART)

		if (tBody === undefined || eBody === undefined) throw new OdtWriteRefusal("part", "the edit has no document body")

		this.tBody = tBody
		this.eBody = eBody

		const t = blocksOf(tBody, bodyOf(tBody))
		const e = blocksOf(eBody, bodyOf(eBody))

		this.tBlocks = t.blocks
		this.eBlocks = e.blocks
		this.tSection = t.section
		this.eSection = e.section
		// A bookmark started between blocks (the paragraph holding its start was deleted) starts at the next block,
		// which is written with it.
		let started = false

		for (let child = eBody.firstChildElement(bodyOf(eBody)); child >= 0; child = eBody.nextSiblingElement(child)) {
			const local = eBody.localName(child)

			if (local === "bookmarkStart") started = true
			else if (local === "p" || local === "tbl") {
				if (started) this.forced.add(child)

				started = false
			}
		}

		this.tRels = relationshipsOf(plan.translation.parts.get(RELS_PART) as Uint8Array | undefined)
		this.eRels = relationshipsOf(plan.edits.parts.get(RELS_PART) ?? (plan.translation.parts.get(RELS_PART) as Uint8Array | undefined))
		this.checkParts()

		for (const kind of ["footnote", "endnote"] as const) {
			const name = `word/${kind}s.xml`
			const before = byId(plan.translatedXml(name))
			const after = byId(plan.editedXml(name))

			for (const [id, note] of after) {
				const was = before.get(id)

				if (was === undefined || !equalBytes(was.bytes, note.bytes)) this.dirtyNotes.add(`${kind}:${id}`)
			}
		}

		this.eNotes = { footnote: byId(plan.editedXml("word/footnotes.xml")), endnote: byId(plan.editedXml("word/endnotes.xml")) }

		const comments = byId(plan.translatedXml("word/comments.xml"))

		this.eComments = byId(plan.editedXml("word/comments.xml"))

		for (const [id, comment] of this.eComments) {
			const was = comments.get(id)

			if (was === undefined || !equalBytes(was.bytes, comment.bytes)) this.dirtyComments.add(id)
		}
	}

	// Parts besides the body: what the writer can write of their changes, and refusals for the rest.
	private checkParts(): void {
		const plan = this.plan

		for (const name of plan.edits.removed ?? []) {
			if (!NOTE_PARTS.has(name)) throw new OdtWriteRefusal("part", `the edit removed ${name}`)
		}

		for (const [name, bytes] of plan.edits.parts) {
			if (name === BODY_PART || name === RELS_PART || IGNORED_PARTS.has(name) || NOTE_PARTS.has(name)) continue

			const before = plan.translation.parts.get(name)

			if (before instanceof Uint8Array && equalBytes(before, bytes)) continue

			if (STORY_PART.test(name) || name.startsWith("word/media/")) continue
			if (name === "word/styles.xml") this.checkStyles()
			else if (name === "word/numbering.xml") this.checkNumbering()
			else if (name === "word/settings.xml") this.checkSettings()
			else if (name === "word/commentsExtended.xml") this.checkCommentsExtended(bytes)
			// Comments' durable ids and UTC dates: an annotation has its own date (Part 3 §14.1).
			else if (name === "word/commentsIds.xml" || name === "word/commentsExtensible.xml") continue
			else throw new OdtWriteRefusal("part", `the edit changed ${name}`)
		}
	}

	// A comment's thread and state (w15:commentEx): a reply or a resolved comment has no form in ODF 1.3's
	// office:annotation (Part 3 §14.1), a comment of its own (done 0, no parent) is just that.
	private checkCommentsExtended(bytes: Uint8Array): void {
		const document = parseXml(bytes)
		const root = document.documentElement()

		for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) !== "commentEx") continue

			for (const attribute of document.attributes(child)) {
				const local = attribute.name.slice(attribute.name.indexOf(":") + 1)

				if ((local === "done" && attribute.value !== "0" && attribute.value !== "false") || local === "paraIdParent")
					throw new OdtWriteRefusal("comment", "a reply or a resolved comment (ODF 1.3 annotations record neither)")
			}
		}
	}

	// Styles: new ones are written to styles.xml; a changed paragraph or character style is written in place, any
	// other change is refused.
	private checkStyles(): void {
		const before = this.plan.translatedXml("word/styles.xml")
		const after = this.plan.editedXml("word/styles.xml")

		if (before === undefined || after === undefined) throw new OdtWriteRefusal("styles", "the edit removed the styles")

		const known = new Map<string, number>()
		const rootBefore = before.documentElement()

		for (let child = before.firstChildElement(rootBefore); child >= 0; child = before.nextSiblingElement(child)) {
			known.set(styleKey(before, child), child)
		}

		const root = after.documentElement()

		for (let child = after.firstChildElement(root); child >= 0; child = after.nextSiblingElement(child)) {
			const key = styleKey(after, child)
			const was = known.get(key)

			if (was === undefined) {
				if (after.localName(child) !== "style")
					throw new OdtWriteRefusal("styles", `the edit added ${after.localName(child)} to the styles`)

				this.newStyles.set(after.attribute(child, "w:styleId") ?? "", child)
			} else if (canonicalElement(before, was) !== canonicalElement(after, child)) {
				const type = after.attribute(child, "w:type")

				// A paragraph or character style is written where it is (its name kept); the rest are refused.
				if (after.localName(child) !== "style" || (type !== "paragraph" && type !== "character")) {
					throw new OdtWriteRefusal("styles", `the edit changed the style ${key}`)
				}

				this.changedStyles.set(after.attribute(child, "w:styleId") ?? "", { before: was, after: child })
			}
		}
	}

	// Numbering: new w:num and w:abstractNum are written as lists; a changed w:abstractNum is written in place, any
	// other change is refused.
	private checkNumbering(): void {
		const before = this.plan.translatedXml("word/numbering.xml")
		const after = this.plan.editedXml("word/numbering.xml")

		if (after === undefined) throw new OdtWriteRefusal("numbering", "the edit removed the numbering")

		const known = new Map<string, number>()

		if (before !== undefined) {
			const root = before.documentElement()

			for (let child = before.firstChildElement(root); child >= 0; child = before.nextSiblingElement(child)) {
				known.set(numberingKey(before, child), child)
			}
		}

		const root = after.documentElement()

		for (let child = after.firstChildElement(root); child >= 0; child = after.nextSiblingElement(child)) {
			const key = numberingKey(after, child)
			const was = known.get(key)

			if (before === undefined || was === undefined || canonicalElement(before, was) === canonicalElement(after, child)) continue

			// A definition's levels are its list style's (kept by name, Part 3 §16.32); a w:num's overrides have no
			// form of their own there (a list restarts with text:continue-numbering or a start value of its own).
			if (after.localName(child) !== "abstractNum")
				throw new OdtWriteRefusal("numbering", `the edit changed the list definition ${key}`)

			this.changedLists.set(after.attribute(child, "w:abstractNumId") ?? "", { before: was, after: child })
		}
	}

	private checkSettings(): void {
		const before = this.plan.translatedXml("word/settings.xml")
		const after = this.plan.editedXml("word/settings.xml")

		if (before === undefined || after === undefined) throw new OdtWriteRefusal("settings", "the edit removed the settings")

		const read = (document: XmlDocument): { tracking: boolean; rest: string } => {
			const rest: string[] = []
			let tracking = false
			const root = document.documentElement()

			for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
				const local = document.localName(child)

				if (local === "trackRevisions") tracking = !["0", "false", "off"].includes(document.attribute(child, "w:val") ?? "true")
				else if (local !== "rsids" && local !== "proofState") rest.push(canonicalElement(document, child))
			}

			return { tracking, rest: rest.sort().join("") }
		}
		const was = read(before)
		const now = read(after)

		if (now.tracking !== was.tracking) this.tracking = now.tracking
		if (was.rest !== now.rest) throw new OdtWriteRefusal("settings", "the edit changed the document settings")
	}

	// A block's key for matching: its bytes, or a key of its own where a note or comment it holds changed.
	keys(document: XmlDocument, blocks: readonly number[], edited: boolean): string[] {
		return blocks.map((block, index) => {
			const bytes = document.raw(block)

			if (edited && (this.touchesDirty(document, block) || this.forced.has(block))) return `dirty${index}`

			return `${fnv(bytes)}:${bytes.length}`
		})
	}

	private touchesDirty(document: XmlDocument, block: number): boolean {
		if (this.dirtyNotes.size === 0 && this.dirtyComments.size === 0) return false

		const stack = [block]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				const local = document.localName(child)

				if (local === "footnoteReference" && this.dirtyNotes.has(`footnote:${document.attribute(child, "w:id") ?? ""}`)) return true
				if (local === "endnoteReference" && this.dirtyNotes.has(`endnote:${document.attribute(child, "w:id") ?? ""}`)) return true
				if (local === "commentRangeStart" && this.dirtyComments.has(document.attribute(child, "w:id") ?? "")) return true

				stack.push(child)
			}
		}

		return false
	}
}

function styleKey(document: XmlDocument, node: number): string {
	const local = document.localName(node)

	return local === "style" ? `style:${document.attribute(node, "w:type") ?? ""}:${document.attribute(node, "w:styleId") ?? ""}` : local
}

function numberingKey(document: XmlDocument, node: number): string {
	const local = document.localName(node)

	return local === "num"
		? `num:${document.attribute(node, "w:numId") ?? ""}`
		: local === "abstractNum"
			? `abstract:${document.attribute(node, "w:abstractNumId") ?? ""}`
			: `${local}:${canonicalElement(document, node)}`
}
