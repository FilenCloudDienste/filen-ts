import { NodeKind, type XmlDocument } from "../../xml/index"
import { effectiveTable, tableProperties } from "./tables"

// What a translated block of WordprocessingML means, as a string two blocks share exactly when the reader shows them
// alike: paragraph and run properties as they take effect (docDefaults, the style chain and direct formatting
// merged, values that mean "nothing" dropped), text joined across runs of the same effect, ids that only number
// things replaced by what they name (lists by the order they first come in, notes and comments by their content,
// relationships by their targets). The ODT writer compares what the edit made with what its file reads back as.

// On/off properties (ECMA-376 Part 1 §17.7.3): absent means off.
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
	"bidiVisual",
	"webHidden",
	"specVanish"
])
const OFF = new Set(["0", "false", "off"])
// Values that say what an absent property says.
const NEUTRAL = new Set([
	'<color w:val="auto">',
	'<u w:val="none">',
	'<vertAlign w:val="baseline">',
	'<position w:val="0">',
	'<spacing w:val="0">',
	'<w w:val="100">',
	'<highlight w:val="none">',
	'<kern w:val="0">',
	'<em w:val="none">',
	'<textAlignment w:val="auto">'
])
// Attributes merged one by one down the style chain (the rest of a property is replaced whole).
const MERGED = new Set(["ind", "spacing", "rFonts", "lang"])
// Attributes that never carry meaning: revision sessions, Word 2010+ ids, theme references (a translation has no
// theme: the faces and colours beside them, or inherited, are what shows), hints.
const DROPPED =
	/^(w:rsid|w14:|w15:|w:themeColor$|w:themeShade$|w:themeTint$|w:themeFill|w:asciiTheme$|w:hAnsiTheme$|w:eastAsiaTheme$|w:cstheme$|w:hint$)/u
const SKIPPED = new Set(["proofErr", "lastRenderedPageBreak"])
const TEXT = new Set(["t", "delText", "instrText", "delInstrText"])
const HIGHLIGHTS: Readonly<Record<string, string>> = {
	black: "000000",
	blue: "0000FF",
	cyan: "00FFFF",
	green: "00FF00",
	magenta: "FF00FF",
	red: "FF0000",
	yellow: "FFFF00",
	white: "FFFFFF",
	darkBlue: "000080",
	darkCyan: "008080",
	darkGreen: "008000",
	darkMagenta: "800080",
	darkRed: "800000",
	darkYellow: "808000",
	darkGray: "808080",
	lightGray: "C0C0C0"
}

export type Props = Map<string, PropertyValue>

export interface PropertyValue {
	readonly attributes: Map<string, string>
	readonly children: string
}

function attributesOf(document: XmlDocument, node: number): Map<string, string> {
	const out = new Map<string, string>()

	for (const attribute of document.attributes(node)) {
		const name = attribute.name

		if (name.startsWith("xmlns") || name === "xml:space" || DROPPED.test(name)) continue

		out.set(name.startsWith("w:") ? name.slice(2) : name, attribute.value)
	}

	return out
}

// An element as a canonical string: attributes sorted, child elements canonical and sorted, its text.
export function canonicalElement(document: XmlDocument, node: number): string {
	const local = document.localName(node)
	const attributes = attributesOf(document, node)
	const children: string[] = []
	let text = ""

	if (TOGGLES.has(local)) {
		const value = attributes.get("val")

		attributes.delete("val")

		if (value !== undefined && OFF.has(value)) attributes.set("val", "off")
	}

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		const kind = document.kind(child)

		if (kind === NodeKind.Element) children.push(canonicalElement(document, child))
		else if (kind === NodeKind.Text || kind === NodeKind.CData) text += document.text(child)
	}

	return `<${local}${attributeText(attributes)}>${children.sort().join("")}${children.length > 0 ? text.trim() : text}`
}

function attributeText(attributes: ReadonlyMap<string, string>): string {
	if (attributes.size === 0) return ""

	return ` ${[...attributes]
		.map(([name, value]) => `${name}=${JSON.stringify(value)}`)
		.sort()
		.join(" ")}`
}

export function readProps(document: XmlDocument, container: number, into: Props, skip?: ReadonlySet<string>): void {
	for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (skip?.has(local) === true) continue

		const attributes = attributesOf(document, child)
		let children = ""

		for (let inner = document.firstChildElement(child); inner >= 0; inner = document.nextSiblingElement(inner)) {
			children += canonicalElement(document, inner)
		}

		if (TOGGLES.has(local)) {
			const value = attributes.get("val")

			attributes.clear()

			if (value !== undefined && OFF.has(value)) attributes.set("val", "off")
		}

		if (local === "ind") {
			// start/end are left/right; a hanging indent is a negative first line.
			const start = attributes.get("start")
			const end = attributes.get("end")
			const hanging = attributes.get("hanging")

			if (start !== undefined) attributes.set("left", start)
			if (end !== undefined) attributes.set("right", end)
			if (hanging !== undefined) attributes.set("firstLine", String(-Number(hanging)))

			attributes.delete("start")
			attributes.delete("end")
			attributes.delete("hanging")
		} else if (local === "jc") {
			const value = attributes.get("val")

			if (value === "start") attributes.set("val", "left")
			else if (value === "end") attributes.set("val", "right")
		} else if (local === "highlight") {
			// Highlighting shows as shading of its colour (ODF has one background for text).
			const hex = HIGHLIGHTS[attributes.get("val") ?? ""]

			if (hex !== undefined) {
				into.set("shd", {
					attributes: new Map([
						["val", "clear"],
						["color", "auto"],
						["fill", hex]
					]),
					children: ""
				})

				continue
			}
		}

		const known = into.get(local)

		if (known !== undefined && MERGED.has(local) && children === "") {
			const merged = new Map(known.attributes)

			for (const [name, value] of attributes) merged.set(name, value)

			if (local === "ind" && attributes.has("firstLine")) merged.set("firstLine", attributes.get("firstLine") ?? "0")

			into.set(local, { attributes: merged, children: "" })
		} else {
			into.set(local, { attributes, children })
		}
	}
}

// Indent and spacing attributes whose 0 says what their absence does.
const ZERO_DEFAULT = new Set(["left", "right", "firstLine", "before", "after"])

function propsText(props: Props): string {
	const out: string[] = []

	for (const [local, value] of props) {
		if (local === "rStyle" || local === "pStyle") continue

		const form = `<${local}${attributeText(value.attributes)}>${value.children}`

		if (TOGGLES.has(local) && value.attributes.get("val") === "off") continue
		if (NEUTRAL.has(form)) continue
		if (local === "shd" && value.attributes.get("fill") === "auto" && value.attributes.get("val") === "clear") continue
		if (local === "rFonts" && value.attributes.size === 0) continue
		if (local === "ind" && [...value.attributes.values()].every(item => item === "0")) continue
		// A row height of 0 sets none.
		if (local === "trHeight" && Number(value.attributes.get("val") ?? "0") === 0) continue

		// A side of 0 is no indent, absent or given.
		if (local === "ind" || local === "spacing") {
			const kept = new Map([...value.attributes].filter(([name, item]) => item !== "0" || !ZERO_DEFAULT.has(name)))

			if (kept.size === 0) continue

			out.push(`<${local}${attributeText(kept)}>${value.children}`)

			continue
		}

		out.push(form)
	}

	return out.sort().join("")
}

interface StyleEntry {
	readonly type: string
	readonly basedOn: string | undefined
	readonly node: number
}

// Styles as the docx stack resolves them: docDefaults, then the chain from the root style down.
export class StyleChains {
	private readonly document: XmlDocument | undefined
	private readonly entries = new Map<string, StyleEntry>()
	private readonly defaultParagraph: string | undefined
	private readonly defaultTable: string | undefined
	private readonly paragraphCache = new Map<string, { readonly pPr: Props; readonly rPr: Props }>()
	private readonly characterCache = new Map<string, Props>()
	private readonly defaultPPr: Props = new Map()
	private readonly defaultRPr: Props = new Map()

	constructor(document: XmlDocument | undefined) {
		this.document = document

		let defaultParagraph: string | undefined
		let defaultTable: string | undefined

		if (document !== undefined) {
			const root = document.documentElement()

			for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
				const local = document.localName(child)

				if (local === "docDefaults") {
					for (let part = document.firstChildElement(child); part >= 0; part = document.nextSiblingElement(part)) {
						const inner = document.firstChildElement(part)

						if (inner < 0) continue
						if (document.localName(part) === "rPrDefault") readProps(document, inner, this.defaultRPr)
						else if (document.localName(part) === "pPrDefault") readProps(document, inner, this.defaultPPr)
					}
				} else if (local === "style") {
					const id = document.attribute(child, "w:styleId") ?? ""
					const type = document.attribute(child, "w:type") ?? "paragraph"
					let basedOn: string | undefined

					for (let inner = document.firstChildElement(child); inner >= 0; inner = document.nextSiblingElement(inner)) {
						if (document.localName(inner) === "basedOn") basedOn = document.attribute(inner, "w:val")
					}

					if (!this.entries.has(id)) this.entries.set(id, { type, basedOn, node: child })

					const isDefault = document.attribute(child, "w:default")

					if (type === "paragraph" && (isDefault === "1" || isDefault === "true")) defaultParagraph ??= id
					if (type === "table" && (isDefault === "1" || isDefault === "true")) defaultTable ??= id
				}
			}
		}

		this.defaultParagraph = defaultParagraph
		this.defaultTable = defaultTable
	}

	has(id: string): boolean {
		return this.entries.has(id)
	}

	get defaultParagraphStyle(): string | undefined {
		return this.defaultParagraph
	}

	// The effective paragraph and run properties a paragraph of `styleId` starts from.
	paragraph(styleId: string | undefined): { readonly pPr: Props; readonly rPr: Props } {
		const id = styleId !== undefined && this.entries.get(styleId)?.type === "paragraph" ? styleId : this.defaultParagraph
		const key = id ?? ""
		let found = this.paragraphCache.get(key)

		if (found !== undefined) return found

		const pPr: Props = new Map(this.defaultPPr)
		const rPr: Props = new Map(this.defaultRPr)

		for (const node of this.chain(id)) {
			this.read(node, "pPr", pPr)
			this.read(node, "rPr", rPr)
		}

		found = { pPr, rPr }
		this.paragraphCache.set(key, found)

		return found
	}

	// Table properties (tblPr) of a table style's chain, or the default table style's.
	table(styleId: string | undefined): Props {
		const id = styleId !== undefined && this.entries.get(styleId)?.type === "table" ? styleId : this.defaultTable
		const props: Props = new Map()

		for (const node of this.chain(id)) this.read(node, "tblPr", props)

		return props
	}

	// Whether a table style's chain formats parts of a table conditionally (tblStylePr).
	conditional(styleId: string | undefined): boolean {
		const document = this.document
		const id = styleId !== undefined && this.entries.get(styleId)?.type === "table" ? styleId : this.defaultTable

		if (document === undefined) return false

		return this.chain(id).some(node => {
			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				if (document.localName(child) === "tblStylePr") return true
			}

			return false
		})
	}

	// Run properties of a character style's chain.
	character(styleId: string | undefined): Props {
		const key = styleId ?? ""
		let found = this.characterCache.get(key)

		if (found !== undefined) return found

		found = new Map()

		if (styleId !== undefined && this.entries.get(styleId)?.type === "character") {
			for (const node of this.chain(styleId)) this.read(node, "rPr", found)
		}

		this.characterCache.set(key, found)

		return found
	}

	private chain(id: string | undefined): number[] {
		const out: number[] = []
		const seen = new Set<string>()

		for (let at = id; at !== undefined && !seen.has(at);) {
			const entry = this.entries.get(at)

			if (entry === undefined) break

			seen.add(at)
			out.push(entry.node)
			at = entry.basedOn
		}

		return out.reverse()
	}

	private read(style: number, local: string, into: Props): void {
		const document = this.document

		if (document === undefined) return

		for (let child = document.firstChildElement(style); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) === local) readProps(document, child, into, local === "pPr" ? PARAGRAPH_SKIPPED : undefined)
		}
	}
}

export const PARAGRAPH_SKIPPED = new Set(["rPr", "sectPr", "pPrChange"])

export interface MeaningParts {
	readonly styles: XmlDocument | undefined
	readonly numbering: XmlDocument | undefined
	readonly footnotes: XmlDocument | undefined
	readonly endnotes: XmlDocument | undefined
	readonly comments: XmlDocument | undefined
	// Relationship id of the part being read -> what it names (an external target, a media part's content key).
	readonly target: (id: string) => string
	// A header or footer part's relationship id -> the meaning of its blocks.
	readonly story?: (id: string) => string
	// What each block's meaning is kept as (a digest of it: a long document's meanings are compared, not read).
	readonly compact?: (text: string) => string
}

const PAGE_PROPERTIES = new Set(["headerReference", "footerReference", "pgSz", "pgMar", "pgBorders", "pgNumType", "titlePg", "vAlign"])

// A section's properties as what they mean: header and footer references by their content.
function sectionText(document: XmlDocument, node: number, parts: MeaningParts, inherited: Map<string, string>): string {
	const out: string[] = []
	let continuous = false

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "type" && document.attribute(child, "w:val") === "continuous") continuous = true
	}

	// A header or footer a section does not name is the previous section's (ECMA-376 Part 1 §17.10.5).
	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (!continuous && (local === "headerReference" || local === "footerReference")) {
			const id = document.attribute(child, "r:id") ?? ""

			inherited.set(`${local}:${document.attribute(child, "w:type") ?? "default"}`, parts.story?.(id) ?? id)
		}
	}

	const headed = [...inherited.keys()].some(key => key.startsWith("headerReference"))
	const footed = [...inherited.keys()].some(key => key.startsWith("footerReference"))

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		// A section on the page before it (an ODF text:section) shows that page: its page properties are the page's.
		if (continuous && PAGE_PROPERTIES.has(local)) continue

		if (local === "headerReference" || local === "footerReference") continue
		else if (local !== "sectPrChange") {
			const form = canonicalElement(document, child)

			// A section starts on a new page unless it says otherwise (ECMA-376 Part 1 §17.6.22).
			if (form === '<type val="nextPage">') continue

			// Header and footer distances place a header or footer: without one they show nothing.
			// Columns of unequal widths: ODF states them only as shares of the width there is (Part 3 §19.514
			// style:rel-width), so their widths follow the page; their count is what they mean.
			if (local === "cols" && document.attribute(child, "w:equalWidth") === "0") {
				out.push(`<cols equalWidth="0" num="${document.attribute(child, "w:num") ?? ""}">`)
			} else if (local === "pgMar") {
				let margins = form

				if (!headed) margins = margins.replace(/ header="[^"]*"/u, "")
				if (!footed) margins = margins.replace(/ footer="[^"]*"/u, "")

				out.push(margins)
			} else out.push(form)
		}
	}

	if (!continuous) for (const [key, story] of inherited) out.push(`${key}:${story}`)

	return out.sort().join("")
}

// The meanings of a story's blocks, with what numbering and notes they refer to resolved.
export class Meaning {
	private readonly parts: MeaningParts
	private readonly chains: StyleChains
	private readonly abstracts = new Map<string, string>()
	// Each w:num's levels' paragraph properties (indents, tabs), between the style's and the paragraph's own.
	private readonly levelProps = new Map<string, Map<string, Props>>()
	private readonly notes = new Map<string, Map<string, number>>()
	private readonly commentNodes: Map<string, number>
	private readonly bookmarks = new Map<string, string>()
	// Bookmarks started between blocks (the paragraph that held the start was deleted): they start at the next
	// paragraph, as a writer puts them there.
	private readonly pendingStarts: string[] = []

	constructor(parts: MeaningParts) {
		this.parts = parts
		this.chains = new StyleChains(parts.styles)

		for (const kind of ["footnote", "endnote"] as const) {
			const document = kind === "footnote" ? parts.footnotes : parts.endnotes
			const byId = new Map<string, number>()

			if (document !== undefined) {
				const root = document.documentElement()

				for (let note = document.firstChildElement(root); note >= 0; note = document.nextSiblingElement(note)) {
					byId.set(document.attribute(note, "w:id") ?? "", note)
				}
			}

			this.notes.set(kind, byId)
		}

		this.commentNodes = new Map()

		if (parts.comments !== undefined) {
			const document = parts.comments
			const root = document.documentElement()

			for (let comment = document.firstChildElement(root); comment >= 0; comment = document.nextSiblingElement(comment)) {
				this.commentNodes.set(document.attribute(comment, "w:id") ?? "", comment)
			}
		}

		this.readNumbering()
	}

	// The blocks of a container (w:body, w:hdr...) in order, each its meaning, and the sections: the index of the
	// block ending each (-1 for the body's last w:sectPr) with its properties.
	body(document: XmlDocument, container: number): { readonly blocks: string[]; readonly sections: string[] } {
		const blocks: string[] = []
		const sections: string[] = []

		const inherited = new Map<string, string>()

		for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
			this.bodyBlock(document, child, blocks, sections, inherited)
		}

		return { blocks, sections }
	}

	// As body, a turn given between blocks (`turn`, when its slice is up).
	async bodyIn(
		document: XmlDocument,
		container: number,
		turn: (() => Promise<void>) | undefined
	): Promise<{ readonly blocks: string[]; readonly sections: string[] }> {
		if (turn === undefined) return this.body(document, container)

		const blocks: string[] = []
		const sections: string[] = []

		const inherited = new Map<string, string>()

		for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
			await turn()
			this.bodyBlock(document, child, blocks, sections, inherited)
		}

		return { blocks, sections }
	}

	private bodyBlock(document: XmlDocument, child: number, blocks: string[], sections: string[], inherited: Map<string, string>): void {
		const local = document.localName(child)
		const compact = this.parts.compact ?? ((text: string) => text)

		if (local === "p") {
			blocks.push(compact(this.paragraph(document, child)))

			const section = sectionOf(document, child)

			if (section >= 0) sections.push(compact(`${blocks.length - 1}§${sectionText(document, section, this.parts, inherited)}`))
		} else if (local === "tbl") {
			blocks.push(compact(this.table(document, child)))
		} else if (local === "sectPr") {
			sections.push(compact(`-1§${sectionText(document, child, this.parts, inherited)}`))
		} else if (local === "bookmarkStart") {
			const name = document.attribute(child, "w:name") ?? ""

			this.bookmarks.set(document.attribute(child, "w:id") ?? "", name)
			this.pendingStarts.push(name)
		} else if (!SKIPPED.has(local) && local !== "bookmarkEnd") {
			blocks.push(compact(canonicalElement(document, child)))
		}
	}

	// A story's blocks and sections as one list.
	story(document: XmlDocument, container: number): string[] {
		const { blocks, sections } = this.body(document, container)

		return [...blocks, ...sections]
	}

	paragraph(document: XmlDocument, paragraph: number): string {
		const direct: Props = new Map()
		const mark: Props = new Map()
		let styleId: string | undefined
		let numId: string | undefined
		let ilvl = "0"

		for (let child = document.firstChildElement(paragraph); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) !== "pPr") continue

			for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
				const local = document.localName(property)

				if (local === "pStyle") styleId = document.attribute(property, "w:val")
				else if (local === "rPr") readProps(document, property, mark)
			}

			readProps(document, child, direct, PARAGRAPH_SKIPPED)
		}

		const base = this.chains.paragraph(styleId)
		const pPr: Props = new Map(base.pPr)
		const numbered = direct.get("numPr") ?? base.pPr.get("numPr")
		const listed = numbered === undefined ? undefined : /<numId val="([^"]*)">/u.exec(numbered.children)?.[1]
		const listLevel = numbered === undefined ? "0" : (/<ilvl val="([^"]*)">/u.exec(numbered.children)?.[1] ?? "0")
		const levelPPr = listed === undefined ? undefined : this.levelProps.get(listed)?.get(listLevel)

		for (const [local, value] of levelPPr ?? []) {
			const known = pPr.get(local)

			if (known !== undefined && MERGED.has(local) && value.children === "") {
				pPr.set(local, { attributes: new Map([...known.attributes, ...value.attributes]), children: "" })
			} else pPr.set(local, value)
		}

		for (const [local, value] of direct) {
			const known = pPr.get(local)

			if (known !== undefined && MERGED.has(local) && value.children === "") {
				pPr.set(local, { attributes: new Map([...known.attributes, ...value.attributes]), children: "" })
			} else pPr.set(local, value)
		}

		const numPr = pPr.get("numPr")

		pPr.delete("numPr")

		if (numPr !== undefined) {
			const match = /<numId val="([^"]*)">/u.exec(numPr.children)
			const level = /<ilvl val="([^"]*)">/u.exec(numPr.children)

			numId = match?.[1]
			ilvl = level?.[1] ?? "0"
		}

		const markProps = merge(base.rPr, mark)
		const numbering = numId === undefined || numId === "0" ? "" : `#${this.listOf(numId)}:${ilvl}`
		const content: string[] = this.pendingStarts.length === 0 ? [] : this.pendingStarts.splice(0).map(name => `@bookmark:${name}`)

		this.content(document, paragraph, "", base.rPr, content)

		// No style is the default paragraph style.
		return `P${styleId ?? this.chains.defaultParagraphStyle ?? ""}${numbering}|${propsText(pPr)}|M${propsText(markProps)}|${content.join("\u0001")}`
	}

	// A list as what it numbers, its levels interned (a long document's paragraphs would each hold them again).
	private listOf(numId: string): string {
		const known = this.lists.get(numId)

		if (known !== undefined) return known

		const levels = this.abstracts.get(numId) ?? "?"
		// A list that counts nothing (bullets at every level): which list it is, and where it starts, shows nowhere.
		const bullets = /^(\[(bullet|none)\|[^\]]*\])+$/u.test(levels)
		const shown = bullets ? levels.replace(/!-?\d+\]/gu, "]") : levels
		let interned = this.levelTexts.get(shown)

		if (interned === undefined) {
			interned = this.levelTexts.size
			this.levelTexts.set(shown, interned)
		}

		const text = bullets ? `b${interned}` : `${this.counted++}:${interned}`

		this.lists.set(numId, text)

		return text
	}

	private readonly lists = new Map<string, string>()
	private readonly levelTexts = new Map<string, number>()
	// Numbered lists met so far: their order is which list a paragraph counts in.
	private counted = 0

	private content(document: XmlDocument, node: number, wrapper: string, base: Props, out: string[]): void {
		let last = ""

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "pPr" || SKIPPED.has(local)) continue

			if (local === "r") {
				last = this.run(document, child, wrapper, base, out, last)

				continue
			}

			last = ""

			if (local === "hyperlink") {
				const id = document.attribute(child, "r:id")
				const anchor = document.attribute(child, "w:anchor")
				const key = `link(${id === undefined ? "" : this.parts.target(id)}#${anchor ?? ""})`

				this.content(document, child, `${wrapper}/${key}`, base, out)
			} else if (local === "fldSimple") {
				const instruction = (document.attribute(child, "w:instr") ?? "").trim().replace(/\s+/gu, " ")

				this.content(document, child, `${wrapper}/field(${instruction})`, base, out)
			} else if (
				local === "ins" ||
				local === "del" ||
				local === "smartTag" ||
				local === "customXml" ||
				local === "dir" ||
				local === "bdo"
			) {
				this.content(document, child, `${wrapper}/${local}(${document.attribute(child, "w:author") ?? ""})`, base, out)
			} else if (local === "bookmarkStart") {
				const name = document.attribute(child, "w:name") ?? ""

				this.bookmarks.set(document.attribute(child, "w:id") ?? "", name)
				out.push(`${wrapper}@bookmark:${name}`)
			} else if (local === "bookmarkEnd") {
				out.push(`${wrapper}@bookmarkEnd:${this.bookmarks.get(document.attribute(child, "w:id") ?? "") ?? "?"}`)
			} else if (local === "commentRangeStart" || local === "commentRangeEnd") {
				out.push(`${wrapper}@${local}:${this.comment(document.attribute(child, "w:id") ?? "")}`)
			} else {
				out.push(`${wrapper}@${canonicalElement(document, child)}`)
			}
		}
	}

	private run(document: XmlDocument, run: number, wrapper: string, base: Props, out: string[], last: string): string {
		const direct: Props = new Map()
		let styleId: string | undefined

		for (let child = document.firstChildElement(run); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) !== "rPr") continue

			for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
				if (document.localName(property) === "rStyle") styleId = document.attribute(property, "w:val")
			}

			readProps(document, child, direct)
		}

		const effective = merge(merge(base, this.chains.character(styleId)), direct)
		const key = `${wrapper}[${styleId ?? ""}|${propsText(effective)}]`
		let current = last

		for (let child = document.firstChildElement(run); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "rPr" || SKIPPED.has(local)) continue

			let text: string | undefined

			if (TEXT.has(local)) text = document.textContent(child)
			else if (local === "softHyphen") text = "­"
			else if (local === "noBreakHyphen") text = "‑"
			else if (local === "tab") text = "\t"

			if (text !== undefined) {
				if (text === "") continue

				const textKey = `${key}${local === "delText" ? "del" : ""}`

				if (current === textKey && out.length > 0) out[out.length - 1] += text
				else out.push(`${textKey}#${text}`)

				current = textKey

				continue
			}

			current = ""

			switch (local) {
				case "footnoteReference":
				case "endnoteReference": {
					const kind = local === "footnoteReference" ? "footnote" : "endnote"

					out.push(
						`${key}@${kind}${document.attribute(child, "w:customMarkFollows") === "1" ? ":custom" : ""}:${this.note(kind, document.attribute(child, "w:id") ?? "")}`
					)

					break
				}
				// A comment's anchor and its mark in its text: ODF formats neither (an office:annotation and its text, Part 3
				// §14.1), so their run properties mean nothing.
				case "commentReference":
					out.push(`${wrapper}@commentReference`)
					break
				case "annotationRef":
					break
				case "drawing":
					// Without the run's properties: an ODF frame carries none of its own (Part 3 §10.4.2).
					out.push(`${wrapper}[]@${this.drawing(document, child)}`)
					break
				default:
					out.push(`${key}@${canonicalElement(document, child)}`)
			}
		}

		return current
	}

	private note(kind: "footnote" | "endnote", id: string): string {
		const document = kind === "footnote" ? this.parts.footnotes : this.parts.endnotes
		const node = this.notes.get(kind)?.get(id)

		if (document === undefined || node === undefined) return "?"

		return `{${this.story(document, node).join("\u0002")}}`
	}

	private comment(id: string): string {
		const document = this.parts.comments
		const node = this.commentNodes.get(id)

		if (document === undefined || node === undefined) return "?"

		return `{${document.attribute(node, "w:author") ?? ""}|${document.attribute(node, "w:initials") ?? ""}|${(document.attribute(node, "w:date") ?? "").replace(/Z$/u, "")}|${this.story(document, node).join("\u0002")}}`
	}

	// A drawing as its markup without the ids that only number drawings, relationships as their targets.
	private drawing(document: XmlDocument, node: number): string {
		const picture = inlinePicture(document, node, this.parts.target)

		if (picture !== undefined) return picture

		const walk = (at: number): string => {
			const local = document.localName(at)
			const out: string[] = []

			for (const attribute of document.attributes(at)) {
				const name = attribute.name

				if (name.startsWith("xmlns")) continue
				if ((local === "docPr" || local === "cNvPr") && (name === "id" || name === "name")) continue
				if (local === "anchor" && name === "relativeHeight") continue

				out.push(
					name === "r:embed" || name === "r:link" || name === "r:id"
						? `${name}=${this.parts.target(attribute.value)}`
						: `${name}=${attribute.value}`
				)
			}

			let children = ""

			for (let child = document.firstChild(at); child >= 0; child = document.nextSibling(child)) {
				const kind = document.kind(child)

				if (kind === NodeKind.Element) {
					const childLocal = document.localName(child)

					// Text box content is a story of its own.
					children += childLocal === "txbxContent" ? `{${this.story(document, child).join("\u0002")}}` : walk(child)
				} else if (kind === NodeKind.Text) children += document.text(child).trim()
			}

			return `<${local} ${out.sort().join(" ")}>${children}`
		}

		return walk(node)
	}

	private table(document: XmlDocument, table: number): string {
		const effective = effectiveTable(document, table, this.chains)
		let out = `T${tableProperties(effective)}${this.chains.conditional(effective.tblPr.get("tblStyle")?.attributes.get("val")) ? " conditional" : ""}`

		for (const row of effective.rows) {
			out += `|R${propsText(row.trPr)}`

			for (const cell of row.cells) {
				out += `C${propsText(cell.props)}`

				for (let inner = document.firstChildElement(cell.node); inner >= 0; inner = document.nextSiblingElement(inner)) {
					const innerName = document.localName(inner)

					if (innerName === "p") out += `{${this.paragraph(document, inner)}}`
					else if (innerName === "tbl") out += `{${this.table(document, inner)}}`
					else if (innerName !== "tcPr" && !SKIPPED.has(innerName)) out += canonicalElement(document, inner)
				}
			}
		}

		return out
	}

	// Each w:num as what it numbers: its abstract definition's levels (with the num's overrides) as they show.
	private readNumbering(): void {
		const document = this.parts.numbering

		if (document === undefined) return

		const root = document.documentElement()
		const abstracts = new Map<string, Map<string, string>>()
		const abstractProps = new Map<string, Map<string, Props>>()

		for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) !== "abstractNum") continue

			const levels = new Map<string, string>()
			const props = new Map<string, Props>()

			for (let level = document.firstChildElement(child); level >= 0; level = document.nextSiblingElement(level)) {
				if (document.localName(level) !== "lvl") continue

				const ilvl = document.attribute(level, "w:ilvl") ?? "0"

				levels.set(ilvl, levelText(document, level))

				for (let inner = document.firstChildElement(level); inner >= 0; inner = document.nextSiblingElement(inner)) {
					if (document.localName(inner) !== "pPr") continue

					const levelPPr: Props = new Map()

					readProps(document, inner, levelPPr, PARAGRAPH_SKIPPED)
					props.set(ilvl, levelPPr)
				}
			}

			abstracts.set(document.attribute(child, "w:abstractNumId") ?? "", levels)
			abstractProps.set(document.attribute(child, "w:abstractNumId") ?? "", props)
		}

		for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) !== "num") continue

			let abstract: Map<string, string> | undefined
			const overrides = new Map<string, string>()

			for (let inner = document.firstChildElement(child); inner >= 0; inner = document.nextSiblingElement(inner)) {
				const local = document.localName(inner)

				if (local === "abstractNumId") {
					abstract = abstracts.get(document.attribute(inner, "w:val") ?? "")
					this.levelProps.set(
						document.attribute(child, "w:numId") ?? "",
						abstractProps.get(document.attribute(inner, "w:val") ?? "") ?? new Map()
					)
				} else if (local === "lvlOverride") {
					for (let start = document.firstChildElement(inner); start >= 0; start = document.nextSiblingElement(start)) {
						if (document.localName(start) === "startOverride") {
							overrides.set(document.attribute(inner, "w:ilvl") ?? "0", document.attribute(start, "w:val") ?? "")
						}
					}
				}
			}

			let text = ""

			for (let level = 0; level < 9; level++) {
				const key = String(level)
				const shown = abstract?.get(key) ?? ""
				const override = overrides.get(key)
				// Restarting at the level's own start is starting it anew.
				const restart = override === undefined || override === shown.split("|")[2] ? "" : `!${override}`

				text += `[${shown}${restart}]`
			}

			this.abstracts.set(document.attribute(child, "w:numId") ?? "", text)
		}
	}
}

// The first child element of `node` named `local`, or -1.
export function childNamed(document: XmlDocument, node: number, local: string): number {
	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === local) return child
	}

	return -1
}

export function descendant(document: XmlDocument, node: number, local: string): number {
	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === local) return child

		const found = descendant(document, child, local)

		if (found >= 0) return found
	}

	return -1
}

// An inline picture as what it shows: its size, its picture (by the entry it reads), crop, alternative text and what
// its shape properties add to place and plain geometry.
function inlinePicture(document: XmlDocument, drawing: number, target: (id: string) => string): string | undefined {
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
			for (const name of ["rot", "flipH", "flipV"]) {
				if ((document.attribute(child, name) ?? "0") !== "0") shape.push(`${name}=${document.attribute(child, name) ?? ""}`)
			}
		} else if (!(local === "prstGeom" && document.attribute(child, "prst") === "rect")) {
			const element = canonicalElement(document, child)

			// No outline or fill reads as none stated.
			if (element !== "<ln><noFill>" && element !== "<noFill>") shape.push(element)
		}
	}

	const cropped = crop < 0 ? "" : canonicalElement(document, crop)

	return `picture ${JSON.stringify([
		document.attribute(extent, "cx"),
		document.attribute(extent, "cy"),
		blip < 0 ? null : target(document.attribute(blip, "r:embed") ?? ""),
		cropped === "<srcRect>" ? "" : cropped,
		docPr < 0 ? "" : (document.attribute(docPr, "descr") ?? ""),
		shape
	])}`
}

function merge(base: Props, over: Props): Props {
	if (over.size === 0) return base

	const out: Props = new Map(base)

	for (const [local, value] of over) {
		const known = out.get(local)

		if (known !== undefined && MERGED.has(local) && value.children === "") {
			out.set(local, { attributes: new Map([...known.attributes, ...value.attributes]), children: "" })
		} else out.set(local, value)
	}

	return out
}

// A level as it shows: format, text, start, label alignment and following, indents, a bullet's face and size.
function levelText(document: XmlDocument, level: number): string {
	const values = new Map<string, string>()
	let indent = ""
	let tab = ""
	let font = ""
	let size = ""

	for (let child = document.firstChildElement(level); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (
			local === "start" ||
			local === "numFmt" ||
			local === "lvlText" ||
			local === "suff" ||
			local === "lvlJc" ||
			local === "lvlRestart"
		) {
			values.set(local, document.attribute(child, "w:val") ?? "")
		} else if (local === "pPr") {
			const props: Props = new Map()

			readProps(document, child, props)

			const ind = props.get("ind")

			if (ind !== undefined) indent = `${ind.attributes.get("left") ?? "0"}/${ind.attributes.get("firstLine") ?? "0"}`

			const tabs = props.get("tabs")
			const position = tabs === undefined ? undefined : /<tab pos="(-?\d+)" val="num">/u.exec(tabs.children)

			if (position !== undefined && position !== null) tab = position[1] ?? ""
		} else if (local === "rPr") {
			const props: Props = new Map()

			readProps(document, child, props)
			font = props.get("rFonts")?.attributes.get("ascii") ?? ""
			size = props.get("sz")?.attributes.get("val") ?? ""
		}
	}

	const format = values.get("numFmt") ?? "decimal"

	return `${format}|${values.get("lvlText") ?? ""}|${values.get("start") ?? "0"}|${values.get("suff") ?? "tab"}|${values.get("lvlJc") ?? "left"}|${indent}|${tab}|${format === "bullet" ? font : ""}|${size}`
}

function sectionOf(document: XmlDocument, paragraph: number): number {
	for (let child = document.firstChildElement(paragraph); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) !== "pPr") continue

		for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
			if (document.localName(property) === "sectPr") return property
		}
	}

	return -1
}
