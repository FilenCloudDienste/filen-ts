import { NodeKind, type XmlDocument } from "../../xml/index"
import { OFF, TEXT, descendant, preserves } from "./wml"

// What a block of WordprocessingML means, as a string two blocks share exactly when a reader shows and edits them
// alike: properties in a canonical form (attributes sorted, toggles and synonyms normalized, revision-session ids
// dropped), text joined across runs with the same properties, and ids that only number things (revisions,
// drawings, bookmarks, notes, relationships) replaced by what they name. The RTF writer compares the blocks it
// wrote, read back, with the blocks the docx writer wrote: the proof that nothing was lost.

const TOGGLES = new Set([
	"b",
	"bCs",
	"i",
	"iCs",
	"caps",
	"smallCaps",
	"strike",
	"dstrike",
	"outline",
	"shadow",
	"emboss",
	"imprint",
	"noProof",
	"vanish",
	"rtl",
	"keepNext",
	"keepLines",
	"pageBreakBefore",
	"widowControl",
	"suppressLineNumbers",
	"suppressAutoHyphens",
	"bidi",
	"snapToGrid",
	"contextualSpacing",
	"cantSplit",
	"tblHeader",
	"noWrap",
	"titlePg",
	"bidiVisual"
])
const THEME_REFERENCES = new Set([
	"w:themeColor",
	"w:themeShade",
	"w:themeTint",
	"w:themeFill",
	"w:themeFillShade",
	"w:themeFillTint",
	"w:asciiTheme",
	"w:hAnsiTheme",
	"w:eastAsiaTheme",
	"w:cstheme"
])
const SKIPPED = new Set(["proofErr", "lastRenderedPageBreak"])
const WRAPPERS = new Set(["ins", "del", "moveFrom", "moveTo", "hyperlink", "smartTag", "customXml", "fldSimple", "dir", "bdo"])
// Attributes that number or date an editing session, never meaning.
const DROPPED = /^(w:rsid|w14:|w:id$|w15:)/u

// What the ids of a part name: relationship targets (media by their bytes), styles by their names.
export interface DigestContext {
	target(relationshipId: string): string
	style?(id: string): string
}

// The style names and relationship targets of the digest being made (set by blockDigests, which runs synchronously).
let styleNames: ((id: string) => string) | undefined
let targets: ((id: string) => string) | undefined

function attributes(document: XmlDocument, node: number, toggle: boolean): string {
	const out: string[] = []

	for (const attribute of document.attributes(node)) {
		const name = attribute.name

		if (name.startsWith("xmlns") || name === "xml:space" || DROPPED.test(name)) continue
		if (name === "w:hint" && attribute.value === "default") continue
		// Theme references: an RTF document's translation has no theme; colours are their values, fonts the faces given
		// beside them or inherited (emit.ts, rFonts).
		if (THEME_REFERENCES.has(name)) continue

		if (toggle && name === "w:val") {
			if (!OFF.has(attribute.value)) continue

			out.push("off")

			continue
		}

		out.push(`${name}=${JSON.stringify(attribute.value)}`)
	}

	return out.sort().join(" ")
}

// An element in canonical form: its name, its attributes sorted, its element children each canonical and sorted
// (property containers name each child once, so order carries nothing), its text.
export function canonical(document: XmlDocument, node: number): string {
	const local = document.localName(node)
	let name = document.name(node)
	let attrs = attributes(document, node, TOGGLES.has(local))

	if ((local === "headerReference" || local === "footerReference") && targets !== undefined) {
		// A section's header or footer as what it holds (a copy written for the section names another part).
		attrs = `type=${JSON.stringify(document.attribute(node, "w:type") ?? "default")} story=${JSON.stringify(targets(document.attribute(node, "r:id") ?? ""))}`
	} else if ((local === "pStyle" || local === "rStyle" || local === "tblStyle") && styleNames !== undefined) {
		attrs = `style=${JSON.stringify(styleNames(document.attribute(node, "w:val") ?? ""))}`
	} else if (local === "ind") {
		// start/end are left/right; hanging is a negative first line.
		attrs = attrs
			.replace(/w:start=/gu, "w:left=")
			.replace(/w:end=/gu, "w:right=")
			.split(" ")
			.sort()
			.join(" ")
	} else if (local === "jc") {
		attrs = attrs.replace('"start"', '"left"').replace('"end"', '"right"')
	}

	const children: string[] = []
	let text = ""

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		const kind = document.kind(child)

		if (kind === NodeKind.Element) {
			const form = canonical(document, child)

			// An element left with nothing (w:rFonts naming theme fonts only) says nothing; nor does one column's
			// spacing (w:space is the gap between columns, ECMA-376 Part 1 §17.6.4).
			if (form !== "<rFonts>" && !singleColumn(document, child)) children.push(form)
		} else if (kind === NodeKind.Text || kind === NodeKind.CData) text += document.text(child)
	}

	if (children.length > 0) text = text.trim()

	if (name.startsWith("w:")) name = local

	return `<${name}${attrs === "" ? "" : ` ${attrs}`}>${children.sort().join("")}${text}`
}

function emptyRunProperties(form: string): string {
	return form === "<rPr>" ? "" : form
}

function singleColumn(document: XmlDocument, node: number): boolean {
	if (document.localName(node) !== "cols" || document.firstChildElement(node) >= 0) return false

	const count = document.attribute(node, "w:num")

	return count === undefined || Number(count) <= 1
}

// A text element's text as Word reads it: edge whitespace only under xml:space="preserve".
function readText(document: XmlDocument, node: number): string {
	const text = document.textContent(node)

	return preserves(document, node) ? text : text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "")
}

class ParagraphDigest {
	private readonly parts: string[] = []
	private lastKey = ""
	private bookmarks = new Map<string, string>()

	private readonly document: XmlDocument
	private readonly context: DigestContext

	constructor(document: XmlDocument, context: DigestContext, bookmarks: Map<string, string>) {
		this.document = document
		this.context = context
		this.bookmarks = bookmarks
	}

	digest(paragraph: number): string {
		const document = this.document
		let properties = ""
		let mark = ""
		let section = ""

		for (let child = document.firstChildElement(paragraph); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) !== "pPr") continue

			const kept: string[] = []

			for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
				const local = document.localName(property)

				// An empty rPr says what an absent one does (the editor leaves one behind when it removes the last property).
				if (local === "rPr") mark = emptyRunProperties(canonical(document, property))
				else if (local === "sectPr") section = canonical(document, property)
				else kept.push(canonical(document, property))
			}

			properties = kept.sort().join("")
		}

		this.content(paragraph, "")

		return `P${properties}|M${mark}|S${section}|${this.parts.join("\u0001")}`
	}

	private push(key: string, item: string, text: boolean): void {
		if (text && this.lastKey === key && this.parts.length > 0) {
			this.parts[this.parts.length - 1] += item

			return
		}

		this.parts.push(text ? `${key}#${item}` : `${key}@${item}`)
		this.lastKey = text ? key : ""
	}

	private content(node: number, wrapper: string): void {
		const document = this.document

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "pPr" || SKIPPED.has(local)) continue

			if (local === "r") {
				this.run(child, wrapper)

				continue
			}

			if (local === "hyperlink") {
				// Read back as a HYPERLINK field (which is what RTF has).
				const id = document.attribute(child, "r:id")
				const anchor = document.attribute(child, "w:anchor")
				const frame = document.attribute(child, "w:tgtFrame")
				let instruction = "HYPERLINK"

				if (id !== undefined) instruction += ` "${this.context.target(id).replace(/^external:/u, "")}"`
				if (anchor !== undefined) instruction += ` \\l "${anchor}"`
				if (frame !== undefined) instruction += ` \\t "${frame}"`

				const key = `${wrapper}[]`

				this.push(key, '<fldChar w:fldCharType="begin">', false)
				this.push(`${key}instrText`, instruction, true)
				this.push(key, '<fldChar w:fldCharType="separate">', false)
				this.content(child, wrapper)
				this.push(key, '<fldChar w:fldCharType="end">', false)

				continue
			}

			if (WRAPPERS.has(local)) {
				const id = document.attribute(child, "r:id")
				const key = `${local}(${attributes(document, child, false)}${id === undefined ? "" : `>${this.context.target(id)}`})`

				this.content(child, wrapper === "" ? key : `${wrapper}/${key}`)

				continue
			}

			if (local === "bookmarkStart") {
				const name = document.attribute(child, "w:name") ?? ""
				const id = document.attribute(child, "w:id")

				if (id !== undefined) this.bookmarks.set(id, name)

				this.push(wrapper, `bookmarkStart:${name}`, false)

				continue
			}

			if (local === "bookmarkEnd") {
				const id = document.attribute(child, "w:id") ?? ""

				this.push(wrapper, `bookmarkEnd:${this.bookmarks.get(id) ?? "?"}`, false)

				continue
			}

			if (local === "commentRangeStart" || local === "commentRangeEnd") {
				this.push(wrapper, local, false)

				continue
			}

			this.push(wrapper, canonical(document, child), false)
		}
	}

	private run(run: number, wrapper: string): void {
		const document = this.document
		let rPr = ""

		for (let child = document.firstChildElement(run); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) === "rPr") rPr = emptyRunProperties(canonical(document, child))
		}

		const key = `${wrapper}[${rPr}]`

		for (let child = document.firstChildElement(run); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "rPr" || SKIPPED.has(local)) continue

			if (TEXT.has(local)) {
				const text = readText(document, child)

				if (text !== "") this.push(`${key}${local}`, text, true)

				continue
			}

			switch (local) {
				case "footnoteReference":
				case "endnoteReference":
					this.push(key, `${local}${document.attribute(child, "w:customMarkFollows") === "1" ? ":custom" : ""}`, false)
					break
				case "commentReference":
					this.push(key, local, false)
					break
				case "drawing":
					this.push(key, this.drawing(child), false)
					break
				case "softHyphen":
					this.push(`${key}t`, "\u00ad", true)
					break
				case "noBreakHyphen":
					this.push(`${key}t`, "\u2011", true)
					break
				default:
					this.push(key, canonical(document, child), false)
			}
		}
	}

	// A drawing as what it shows: an inline picture as its size, picture (by its bytes), crop, alternative text and
	// whatever its shape properties add besides place and plain geometry; anything else its markup without ids.
	private drawing(node: number): string {
		const document = this.document
		const picture = inlinePicture(document, node, this.context)

		if (picture !== undefined) return picture

		const walk = (at: number): string => {
			const local = document.localName(at)
			const out: string[] = []

			for (const attribute of document.attributes(at)) {
				const name = attribute.name

				if (name.startsWith("xmlns")) continue
				if ((local === "docPr" || local === "cNvPr") && (name === "id" || name === "name")) continue
				// Stacking order, numbered by the reader in the order drawings come: what counts is that order.
				if (local === "anchor" && name === "relativeHeight") continue

				out.push(
					name === "r:embed" || name === "r:link" || name === "r:id"
						? `${name}=${this.context.target(attribute.value)}`
						: `${name}=${attribute.value}`
				)
			}

			let children = ""

			for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) children += walk(child)

			return `<${local} ${out.sort().join(" ")}>${children}`
		}

		return walk(node)
	}
}

function inlinePicture(document: XmlDocument, drawing: number, context: DigestContext): string | undefined {
	const inline = descendant(document, drawing, "inline")
	const data = inline < 0 ? -1 : descendant(document, inline, "graphicData")

	if (data < 0 || document.attribute(data, "uri") !== "http://schemas.openxmlformats.org/drawingml/2006/picture") return undefined

	const extent = descendant(document, inline, "extent")
	const docPr = descendant(document, inline, "docPr")
	const blip = descendant(document, data, "blip")
	const crop = descendant(document, data, "srcRect")
	const spPr = descendant(document, data, "spPr")
	const shape: string[] = []

	for (let child = spPr < 0 ? -1 : document.firstChildElement(spPr); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "xfrm") {
			for (const name of ["rot", "flipH", "flipV"])
				if ((document.attribute(child, name) ?? "0") !== "0") shape.push(`${name}=${document.attribute(child, name)}`)
		} else if (!(local === "prstGeom" && document.attribute(child, "prst") === "rect")) {
			shape.push(canonical(document, child))
		}
	}

	return `picture ${JSON.stringify([
		document.attribute(extent, "cx"),
		document.attribute(extent, "cy"),
		blip < 0 ? null : context.target(document.attribute(blip, "r:embed") ?? ""),
		crop < 0 ? null : canonical(document, crop),
		docPr < 0 ? "" : (document.attribute(docPr, "descr") ?? ""),
		docPr < 0 ? "" : (document.attribute(docPr, "title") ?? ""),
		shape
	])}`
}

// The digest of each block (w:p, w:tbl; the body's w:sectPr as "sect") of a container, in order.
export function blockDigests(document: XmlDocument, container: number, context: DigestContext): string[] {
	return blockDigestsExcept(document, container, context, NONE) as string[]
}

const NONE = (): boolean => false

// The children of a container that blockDigests gives digests for, in order.
export function digestedBlocks(document: XmlDocument, container: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local !== "proofErr" && local !== "bookmarkStart" && local !== "bookmarkEnd") out.push(child)
	}

	return out
}

// As blockDigests, with undefined for the blocks `skip` names (by index): those a caller compares another way.
// Their bookmarks still name the ends later blocks hold.
export function blockDigestsExcept(
	document: XmlDocument,
	container: number,
	context: DigestContext,
	skip: (index: number) => boolean
): (string | undefined)[] {
	styleNames = context.style === undefined ? undefined : id => context.style?.(id) ?? id
	targets = id => context.target(id)

	try {
		return digests(document, container, context, skip)
	} finally {
		styleNames = undefined
		targets = undefined
	}
}

// The digest of one block of a container as blockDigests gives it, where no block before it starts a bookmark.
export function blockDigest(document: XmlDocument, block: number, context: DigestContext): string {
	styleNames = context.style === undefined ? undefined : id => context.style?.(id) ?? id
	targets = id => context.target(id)

	try {
		return digestOf(document, block, context, new Map())
	} finally {
		styleNames = undefined
		targets = undefined
	}
}

function digestOf(document: XmlDocument, block: number, context: DigestContext, bookmarks: Map<string, string>): string {
	const local = document.localName(block)

	if (local === "p") return new ParagraphDigest(document, context, bookmarks).digest(block)
	if (local === "tbl") return tableDigest(document, block, context, bookmarks)
	if (local === "sectPr") return `sect${canonical(document, block)}`

	return canonical(document, block)
}

function digests(
	document: XmlDocument,
	container: number,
	context: DigestContext,
	skip: (index: number) => boolean
): (string | undefined)[] {
	const bookmarks = new Map<string, string>()
	const out: (string | undefined)[] = []

	for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "proofErr" || local === "bookmarkStart" || local === "bookmarkEnd") continue

		if (skip(out.length)) {
			bookmarkNames(document, child, bookmarks)
			out.push(undefined)
		} else out.push(digestOf(document, child, context, bookmarks))
	}

	return out
}

// The bookmarks a block starts, by id (as ParagraphDigest records them).
function bookmarkNames(document: XmlDocument, block: number, bookmarks: Map<string, string>): void {
	const stack = [block]

	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) === "bookmarkStart") {
				const id = document.attribute(child, "w:id")

				if (id !== undefined) bookmarks.set(id, document.attribute(child, "w:name") ?? "")
			} else stack.push(child)
		}
	}
}

function tableDigest(document: XmlDocument, table: number, context: DigestContext, bookmarks: Map<string, string>): string {
	let out = "T"

	for (let child = document.firstChildElement(table); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "tr") out += `|${rowDigest(document, child, context, bookmarks)}`
		else if (local === "tblPr") out += tableProperties(document, child)
		else out += canonical(document, child)
	}

	return out
}

// A table's properties with what a table without a style takes when they are absent written out (ISO/IEC 29500-1
// §17.4: no indent; cell margins 115 twips leading and trailing, none above and below), start and end as left and
// right, and w:tblLook left out: the table styles of an RTF document's translation hold none of these.
function tableProperties(document: XmlDocument, tblPr: number): string {
	const entries = new Map<string, string>()
	let aligned = false
	const margins: Record<string, number> = { left: 115, right: 115, top: 0, bottom: 0 }

	for (let child = document.firstChildElement(tblPr); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "jc" && !["left", "start"].includes(document.attribute(child, "w:val") ?? "")) aligned = true

		if (local === "tblCellMar") {
			for (let side = document.firstChildElement(child); side >= 0; side = document.nextSiblingElement(side)) {
				const name = document.localName(side)
				const key = name === "start" ? "left" : name === "end" ? "right" : name

				margins[key] =
					document.attribute(side, "w:type") === "dxa" || document.attribute(side, "w:type") === undefined
						? Number(document.attribute(side, "w:w") ?? 0)
						: 0
			}

			continue
		}

		entries.set(local, canonical(document, child))
	}

	// An RTF document's table styles hold no conditional formats (nor margins or an indent): w:tblLook selects nothing.
	entries.delete("tblLook")
	if (aligned) entries.delete("tblInd")
	else if (!entries.has("tblInd")) entries.set("tblInd", '<tblInd w:type="dxa" w:w="0">')
	if (entries.get("jc") === '<jc w:val="left">') entries.delete("jc")

	return `<tblPr>${[...entries.values()].sort().join("")}${JSON.stringify(margins)}`
}

function rowDigest(document: XmlDocument, row: number, context: DigestContext, bookmarks = new Map<string, string>()): string {
	let out = "R"

	for (let child = document.firstChildElement(row); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "tc") {
			out += "C"

			for (let inner = document.firstChildElement(child); inner >= 0; inner = document.nextSiblingElement(inner)) {
				const name = document.localName(inner)

				if (name === "tcPr") out += canonical(document, inner)
				else if (name === "p") out += `{${new ParagraphDigest(document, context, bookmarks).digest(inner)}}`
				else if (name === "tbl") out += `{${tableDigest(document, inner, context, bookmarks)}}`
				else out += canonical(document, inner)
			}
		} else {
			out += canonical(document, child)
		}
	}

	return out
}
