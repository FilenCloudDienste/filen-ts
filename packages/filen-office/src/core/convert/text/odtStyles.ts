import { appendAll } from "../../arrays"
import { paragraphAttributes, runAttributes } from "../../odt/write/inverse"
import { readProps, type PropertyValue, type Props } from "../../odt/write/meaning"
import { levelStyle } from "../../odt/write/writer"
import { symbolTable, symbolText } from "../../fonts/symbols"
import type { ListTarget } from "../../odt/write/emit"
import type { XmlDocument } from "../../xml/index"
import type { LossyCounts } from "./report"

// WordprocessingML styles, numbering and section page setup as ODF 1.3 styles: paragraph and character
// styles as common styles (style:style) named after their ids and showing their names; the document
// defaults as the paragraph default style with what Word assumes where the document says nothing
// (10 pt Times New Roman, no spacing); each abstract numbering (and each w:num overriding levels) as a common list
// style; each section as a page layout and a master page.

export function esc(text: string): string {
	return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;")
}

function round(value: number): string {
	return String(Math.round(value * 10_000) / 10_000)
}

export function pt(twips: number): string {
	return `${round(twips / 20)}pt`
}

// Font faces by family, named after the family.
export class FontFaces {
	private readonly faces = new Map<string, string>()
	private readonly names = new Set<string>()

	face(family: string): string {
		let name = this.faces.get(family)

		if (name === undefined) {
			name = family

			for (let n = 2; this.names.has(name); n++) name = `${family} ${String(n)}`

			this.names.add(name)
			this.faces.set(family, name)
		}

		return name
	}

	markup(): string {
		let out = "<office:font-face-decls>"

		for (const [family, name] of this.faces) {
			const quoted = /[\s,]/u.test(family) ? `'${family.replace(/'/gu, "")}'` : family

			out += `<style:font-face style:name="${esc(name)}" svg:font-family="${esc(quoted)}"/>`
		}

		return `${out}</office:font-face-decls>`
	}
}

const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/u

// Unique style names (NCNames) for ids.
export class StyleNames {
	private readonly taken: Set<string>

	constructor(taken: Set<string>) {
		this.taken = taken
	}

	name(id: string): string {
		let base = id.replace(/[^A-Za-z0-9_.-]/gu, "_")

		if (!NCNAME.test(base)) base = `_${base}`

		let name = base

		for (let n = 2; this.taken.has(name); n++) name = `${base}_${String(n)}`

		this.taken.add(name)

		return name
	}
}

function child(document: XmlDocument, node: number, local: string): number {
	for (let at = document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at))
		if (document.localName(at) === local) return at

	return -1
}

function props(document: XmlDocument, container: number, skip?: ReadonlySet<string>): Props {
	const out: Props = new Map()

	if (container >= 0) readProps(document, container, out, skip)

	return out
}

const PARAGRAPH_SKIPPED = new Set(["rPr", "sectPr", "pPrChange", "pStyle", "numPr", "outlineLvl", "cnfStyle", "divId"])
const RUN_SKIPPED = new Set(["rStyle", "rPrChange", "noProof", "webHidden", "specVanish"])

// The paragraph properties markup of `pPr` (its tab stops as style:tab-stops), and the text properties of `rPr`,
// each property without an ODF form counted once.
export function propertiesMarkup(
	paragraph: Props,
	run: Props,
	fonts: FontFaces,
	fontSize: number,
	lossy: LossyCounts,
	extra: { paragraph?: readonly (readonly [string, string])[]; text?: readonly (readonly [string, string])[] } = {}
): string {
	const pAttributes = new Map<string, string>(extra.paragraph ?? [])
	let tabs: string | undefined
	const paragraphText: (readonly [string, string])[] = []

	for (const [local, value] of paragraph) {
		if (PARAGRAPH_SKIPPED.has(local)) continue

		const marginLeft = Number(value.attributes.get("left") ?? "0") / 20
		const written = paragraphAttributes(local, value, { tabsRelativeToIndent: false, marginLeft })

		if (written === undefined) {
			lossy.add("styleDefinition")

			continue
		}

		for (const [name, item] of written.attributes) {
			if (!wellFormed(item)) lossy.add("styleDefinition")
			else pAttributes.set(name, item)
		}

		appendAll(paragraphText, written.text ?? [])

		if (written.tabs !== undefined) tabs = written.tabs
	}

	const tAttributes = new Map<string, string>(extra.text ?? [])

	for (const [local, value] of run) {
		if (RUN_SKIPPED.has(local)) continue

		const written = runAttributes(local, value, fonts, fontSize)

		if (written === undefined) {
			lossy.add("styleDefinition")

			continue
		}

		for (const [name, item] of written) {
			if (wellFormed(item)) tAttributes.set(name, item)
			else lossy.add("styleDefinition")
		}
	}

	// The paragraph properties that are text properties in ODF (hyphenation).
	for (const [name, item] of paragraphText) tAttributes.set(name, item)

	const attributeList = (map: ReadonlyMap<string, string>): string =>
		[...map]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([name, item]) => ` ${name}="${esc(item)}"`)
			.join("")
	let out = ""

	if (pAttributes.size > 0 || tabs !== undefined)
		out += `<style:paragraph-properties${attributeList(pAttributes)}${tabs === undefined || tabs === "" ? "/>" : `><style:tab-stops>${tabs}</style:tab-stops></style:paragraph-properties>`}`
	if (tAttributes.size > 0) out += `<style:text-properties${attributeList(tAttributes)}/>`

	return out
}

// A written value from a property whose source value was not a number (NaN, an empty size) is no ODF value.
function wellFormed(value: string): boolean {
	return value !== "" && !value.includes("NaN") && !value.includes("Infinity")
}

function fontSizeOf(run: Props, fallback: number): number {
	const size = Number(run.get("sz")?.attributes.get("val") ?? "NaN") / 2

	return Number.isFinite(size) && size > 0 ? size : fallback
}

export interface ConvertedStyles {
	// office:styles content: the default styles and the common styles.
	readonly markup: string
	// ODF style names by WordprocessingML style id.
	readonly paragraph: ReadonlyMap<string, string>
	readonly character: ReadonlyMap<string, string>
}

interface StyleEntry {
	readonly id: string
	readonly type: string
	readonly node: number
	readonly basedOn: string | undefined
}

// `defaultTab`: settings' w:defaultTabStop in twips.
export function convertStyles(
	document: XmlDocument | undefined,
	fonts: FontFaces,
	names: StyleNames,
	lossy: LossyCounts,
	defaultTab: number
): ConvertedStyles {
	const paragraph = new Map<string, string>()
	const character = new Map<string, string>()
	const entries: StyleEntry[] = []
	let defaultsP: Props = new Map()
	let defaultsR: Props = new Map()
	let defaultParagraph: string | undefined

	if (document !== undefined) {
		const root = document.documentElement()

		for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
			const local = document.localName(node)

			if (local === "docDefaults") {
				defaultsP = props(document, child(document, child(document, node, "pPrDefault"), "pPr"), PARAGRAPH_SKIPPED)
				defaultsR = props(document, child(document, child(document, node, "rPrDefault"), "rPr"))
			} else if (local === "style") {
				const id = document.attribute(node, "w:styleId") ?? ""
				const type = document.attribute(node, "w:type") ?? "paragraph"

				if (id === "" || entries.some(entry => entry.id === id && entry.type === type)) continue

				const basedOn = document.attribute(child(document, node, "basedOn"), "w:val")

				entries.push({ id, type, node, basedOn })

				if (type === "paragraph" && document.attribute(node, "w:default") === "1" && defaultParagraph === undefined)
					defaultParagraph = id
			}
		}
	}

	// Names first (styles name their parents and followers).
	names.name("Standard")

	for (const entry of entries) {
		if (entry.type === "paragraph") paragraph.set(entry.id, entry.id === defaultParagraph ? "Standard" : names.name(entry.id))
		else if (entry.type === "character") character.set(entry.id, names.name(entry.id))
	}

	// Word's own defaults where the document's are silent (10 pt).
	const defaultSize = fontSizeOf(defaultsR, 10)
	const defaultRun: Props = new Map(defaultsR)

	if (!defaultRun.has("sz")) defaultRun.set("sz", { attributes: new Map([["val", "20"]]), children: "" })
	if (!defaultRun.has("rFonts"))
		defaultRun.set("rFonts", {
			attributes: new Map([
				["ascii", "Times New Roman"],
				["hAnsi", "Times New Roman"],
				["cs", "Times New Roman"]
			]),
			children: ""
		})

	const defaultParagraphProps: Props = new Map(defaultsP)

	if (!defaultParagraphProps.has("spacing"))
		defaultParagraphProps.set("spacing", {
			attributes: new Map([
				["after", "0"],
				["line", "240"],
				["lineRule", "auto"]
			]),
			children: ""
		})

	let out = `<style:default-style style:family="paragraph">${propertiesMarkup(defaultParagraphProps, defaultRun, fonts, defaultSize, lossy, { paragraph: [["style:tab-stop-distance", pt(defaultTab)]] })}</style:default-style>`

	for (const entry of entries) {
		const name = entry.type === "paragraph" ? paragraph.get(entry.id) : entry.type === "character" ? character.get(entry.id) : undefined

		if (name === undefined || document === undefined) continue

		const display = document.attribute(child(document, entry.node, "name"), "w:val") ?? entry.id
		const family = entry.type === "paragraph" ? "paragraph" : "text"
		const map = entry.type === "paragraph" ? paragraph : character
		const parent = entry.basedOn === undefined ? undefined : map.get(entry.basedOn)
		const next =
			entry.type === "paragraph" ? paragraph.get(document.attribute(child(document, entry.node, "next"), "w:val") ?? "") : undefined
		const pPr = props(document, child(document, entry.node, "pPr"), PARAGRAPH_SKIPPED)
		const rPr = props(document, child(document, entry.node, "rPr"))
		const outline = props(document, child(document, entry.node, "pPr"))
			.get("outlineLvl")
			?.attributes.get("val")
		const level = outline === undefined ? Number.NaN : Number(outline) + 1
		let attributes = ` style:name="${esc(name)}"${display === name ? "" : ` style:display-name="${esc(name === "Standard" ? "Normal" : display)}"`} style:family="${family}"`

		if (parent !== undefined && parent !== name) attributes += ` style:parent-style-name="${esc(parent)}"`
		if (next !== undefined) attributes += ` style:next-style-name="${esc(next)}"`
		if (Number.isInteger(level) && level >= 1 && level <= 9) attributes += ` style:default-outline-level="${String(level)}"`

		const properties = propertiesMarkup(entry.type === "paragraph" ? pPr : new Map(), rPr, fonts, fontSizeOf(rPr, defaultSize), lossy)

		out += `<style:style${attributes}${properties === "" ? "/>" : `>${properties}</style:style>`}`
	}

	return { markup: out, paragraph, character }
}

// --- Numbering ---

// Word's letter numbering repeats the letter past z (aa, bb, cc: lowerLetter): ODF's is that with
// style:num-letter-sync (ODF 1.3 schema: style-num-letter-sync-attlist).
function letterSync(markup: string): string {
	return markup.replace(/ style:num-format="([aA])"/u, ' style:num-format="$1" style:num-letter-sync="true"')
}

// A bullet in a symbol font (Symbol, Wingdings: Word writes its code in the private use area) as the Unicode
// character the font draws there, without the font.
function symbolBullet(markup: string): string {
	const font = /<style:text-properties style:font-name="([^"]*)"\/>/u.exec(markup)
	const table = font === null ? undefined : symbolTable(unescape(font[1] ?? ""))

	if (font === null || table === undefined) return markup

	return markup
		.replace(
			/ text:bullet-char="([^"]*)"/u,
			(_attribute, char: string) => ` text:bullet-char="${esc(symbolText(table, unescape(char)))}"`
		)
		.replace(font[0], "")
}

function unescape(text: string): string {
	return text
		.replace(/&quot;/gu, '"')
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">")
		.replace(/&amp;/gu, "&")
}

export interface ConvertedLists {
	// office:styles content: the list styles.
	readonly markup: string
	target(numId: string): ListTarget | undefined
	indent(numId: string, ilvl: number): PropertyValue | undefined
	start(numId: string, ilvl: number): number | undefined
	has(numId: string): boolean
}

export function convertLists(document: XmlDocument | undefined, fonts: FontFaces, names: StyleNames, lossy: LossyCounts): ConvertedLists {
	const abstracts = new Map<string, number>()
	const nums = new Map<string, { abstract: string; node: number }>()

	if (document !== undefined) {
		const root = document.documentElement()

		for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
			const local = document.localName(node)

			if (local === "abstractNum") abstracts.set(document.attribute(node, "w:abstractNumId") ?? "", node)
			else if (local === "num")
				nums.set(document.attribute(node, "w:numId") ?? "", {
					abstract: document.attribute(child(document, node, "abstractNumId"), "w:val") ?? "",
					node
				})
		}
	}

	// An abstract numbering that links to a numbering style (w:numStyleLink) takes that style's definition.
	const definition = (abstractId: string, depth = 0): number => {
		const node = abstracts.get(abstractId) ?? -1

		if (node < 0 || document === undefined || depth > 4) return node

		const link = document.attribute(child(document, node, "numStyleLink"), "w:val")

		if (link === undefined) return node

		for (const [id, other] of abstracts)
			if (document.attribute(child(document, other, "styleLink"), "w:val") === link && id !== abstractId)
				return definition(id, depth + 1)

		return node
	}
	const styleOf = new Map<string, string>()
	let out = ""
	const levelsOf = (abstract: number, overrides: ReadonlyMap<number, number>): string => {
		if (document === undefined) return ""

		const levels = new Map<number, number>()

		for (let level = document.firstChildElement(abstract); level >= 0; level = document.nextSiblingElement(level))
			if (document.localName(level) === "lvl") levels.set(Number(document.attribute(level, "w:ilvl") ?? "0"), level)

		for (const [ilvl, level] of overrides) levels.set(ilvl, level)

		let markup = ""
		const texts = [...levels.values()].map(level => document.attribute(child(document, level, "lvlText"), "w:val") ?? "")

		for (const ilvl of [...levels.keys()].sort((a, b) => a - b)) {
			const level = levels.get(ilvl) ?? -1

			if (ilvl < 0 || ilvl > 8) {
				lossy.add("listFormat")

				continue
			}

			let written = levelStyle(document, level, fonts, "text:list-level-style")

			if (written === undefined) {
				// A number format or label ODF has no form for: numbered in decimal with its separators.
				lossy.add("listFormat")
				written = `<text:list-level-style-number text:level="${String(ilvl + 1)}" style:num-format="1"${ilvl > 0 ? "" : ' style:num-suffix="."'}><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab"/></style:list-level-properties></text:list-level-style-number>`
			}

			// A label without a number (a w:lvlText holding no %n): its text alone (style:num-format "" numbers nothing).
			// Where a deeper level shows this level's number (%n in its text), ODF shows it in this level's label too
			// (text:display-levels takes each level's own format): the number stays, counted.
			const text = document.attribute(child(document, level, "lvlText"), "w:val") ?? ""
			const format = document.attribute(child(document, level, "numFmt"), "w:val") ?? "decimal"

			if (format !== "bullet" && !/%\d/u.test(text)) {
				if (texts.some(other => other.includes(`%${String(ilvl + 1)}`))) lossy.add("listFormat")
				else written = written.replace(/ style:num-format="[^"]*"/u, ' style:num-format=""')
			}

			// A level numbered from 0 or less: ODF's level styles start at 1 at least (positiveInteger, Part 3 §19.874.4).
			// A list's first item starts where Word does (ConvertedLists.start); a level past the first restarts at 1, counted.
			written = written.replace(/ text:start-value="(-?\d+)"/u, (attribute, value: string) => {
				if (Number(value) >= 1) return attribute

				if (ilvl > 0 || Number(value) < 0) lossy.add("listFormat")

				return ""
			})
			markup += symbolBullet(letterSync(written))
		}

		return markup
	}

	for (const [numId, num] of nums) {
		if (document === undefined) break

		const abstract = definition(num.abstract)

		if (abstract < 0) continue

		const overrides = new Map<number, number>()

		for (let override = document.firstChildElement(num.node); override >= 0; override = document.nextSiblingElement(override)) {
			if (document.localName(override) !== "lvlOverride") continue

			const level = child(document, override, "lvl")

			if (level >= 0) overrides.set(Number(document.attribute(override, "w:ilvl") ?? "0"), level)
		}

		const key = overrides.size === 0 ? `a:${num.abstract}` : `n:${numId}`
		let style = styleOf.get(key)

		if (style === undefined) {
			style = names.name(overrides.size === 0 ? `WWNum${num.abstract}` : `WWNum${num.abstract}_${numId}`)
			styleOf.set(key, style)

			const levels = levelsOf(abstract, overrides)

			out += `<text:list-style style:name="${esc(style)}">${levels}</text:list-style>`
		}

		styleOf.set(`num:${numId}`, style)
	}

	const levelNode = (numId: string, ilvl: number): number => {
		const num = nums.get(numId)

		if (num === undefined || document === undefined) return -1

		for (let override = document.firstChildElement(num.node); override >= 0; override = document.nextSiblingElement(override)) {
			if (document.localName(override) === "lvlOverride" && Number(document.attribute(override, "w:ilvl") ?? "-1") === ilvl) {
				const level = child(document, override, "lvl")

				if (level >= 0) return level
			}
		}

		const abstract = definition(num.abstract)

		for (let level = abstract < 0 ? -1 : document.firstChildElement(abstract); level >= 0; level = document.nextSiblingElement(level))
			if (document.localName(level) === "lvl" && Number(document.attribute(level, "w:ilvl") ?? "0") === ilvl) return level

		return -1
	}

	return {
		markup: out,
		has: numId => styleOf.has(`num:${numId}`),
		target: numId => {
			const style = styleOf.get(`num:${numId}`)

			return style === undefined ? undefined : { style, outline: false }
		},
		indent: (numId, ilvl) => {
			const level = levelNode(numId, ilvl)

			return level < 0 || document === undefined ? undefined : props(document, child(document, level, "pPr")).get("ind")
		},
		start: (numId, ilvl) => {
			const num = nums.get(numId)

			if (num === undefined || document === undefined) return undefined

			for (let override = document.firstChildElement(num.node); override >= 0; override = document.nextSiblingElement(override)) {
				if (document.localName(override) !== "lvlOverride" || Number(document.attribute(override, "w:ilvl") ?? "-1") !== ilvl)
					continue

				const start = document.attribute(child(document, override, "startOverride"), "w:val")

				if (start !== undefined) return Number(start)
			}

			// A level numbered from 0, which its level style cannot say.
			const own = Number(document.attribute(child(document, levelNode(numId, ilvl), "start"), "w:val") ?? "1")

			return own < 1 ? 0 : undefined
		}
	}
}
