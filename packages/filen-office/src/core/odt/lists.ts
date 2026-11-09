import { parseLength, type OdfListLevel, type OdfListStyle, type OdfStyleResolver, type OdfStyleSheet, type StyleScope } from "../odf/index"
import { fontFamily, runProperties, type Attributes, type PropsSink } from "./props"
import { esc, REL, twips } from "./wml"

// ODF list styles (Part 3 §16.32) as WordprocessingML abstract numbering, and list instances as w:num:
// text:list starts a new list unless it continues one (text:continue-numbering, text:continue-list), and a
// list item's text:start-value restarts the count through a level override. Every w:num of one w:abstractNum
// shares its counters unless a w:startOverride restarts a level (ECMA-376 Part 1 §17.9.27), so a style's later
// lists override each level with its start value.

const FORMATS: Readonly<Record<string, string>> = {
	"1": "decimal",
	a: "lowerLetter",
	A: "upperLetter",
	i: "lowerRoman",
	I: "upperRoman",
	"": "none",
	"1st": "ordinal",
	"١, ٢, ٣, ...": "arabicAlpha",
	"一, 二, 三, ...": "chineseCounting",
	"①, ②, ③, ...": "decimalEnclosedCircle",
	"Ⅰ, Ⅱ, Ⅲ, ...": "upperRoman",
	"ⅰ, ⅱ, ⅲ, ...": "lowerRoman"
}

// Where a level puts its label and text (§20.431 text:list-level-position-and-space-mode).
export interface LevelGeometry {
	readonly mode: "label-alignment" | "label-width-and-position"
	// label-alignment: absolute text indent and first-line offset (negative: hanging).
	readonly marginLeft: number
	readonly textIndent: number
	// label-width-and-position: offsets from the paragraph's own left margin.
	readonly spaceBefore: number
	readonly minLabelWidth: number
}

export function levelGeometry(level: OdfListLevel | undefined): LevelGeometry {
	const properties = level?.properties.attributes
	const mode =
		properties?.get("text:list-level-position-and-space-mode") === "label-alignment" ? "label-alignment" : "label-width-and-position"
	const alignment = level?.labelAlignment

	return {
		mode,
		marginLeft: parseLength(alignment?.get("fo:margin-left")) ?? 0,
		textIndent: parseLength(alignment?.get("fo:text-indent")) ?? 0,
		spaceBefore: parseLength(properties?.get("text:space-before")) ?? 0,
		minLabelWidth: parseLength(properties?.get("text:min-label-width")) ?? 0
	}
}

// A list paragraph's indents where its own do not win: absolute left and first-line offset.
export function listIndent(geometry: LevelGeometry, paragraphLeft: number): { readonly left: number; readonly firstLine: number } {
	if (geometry.mode === "label-alignment") return { left: geometry.marginLeft, firstLine: geometry.textIndent }

	return { left: paragraphLeft + geometry.spaceBefore + geometry.minLabelWidth, firstLine: -geometry.minLabelWidth }
}

const ALL_LEVELS = 0x1ff

interface ListInstance {
	readonly style: string
	readonly scope: StyleScope
	readonly abstract: number
	num: number
	// A bit per level (ilvl) whose restart at its start value no paragraph of this instance has numbered yet.
	pending: number
}

// A level's text:start-value, a whole number of at least 0 (default 1).
function levelStart(level: OdfListLevel | undefined): number {
	const start = Number(level?.attributes.get("text:start-value") ?? "1")

	return Number.isFinite(start) && start >= 0 ? Math.floor(start) : 1
}

export class Lists {
	private readonly sheet: OdfStyleSheet
	private readonly abstracts: string[] = []
	private readonly nums: string[] = []
	private readonly abstractIds = new Map<string, number>()
	// Each w:abstractNum's level start values, by ilvl.
	private readonly starts: number[][] = []
	// Each w:num's list style (the outline style's name is "\u0000outline").
	readonly numStyles = new Map<number, { readonly style: string; readonly scope: StyleScope }>()
	// The last list opened, by its style (text:continue-numbering), and instances by xml:id (text:continue-list).
	private last: { readonly key: string; readonly instance: ListInstance } | undefined
	private readonly byId = new Map<string, ListInstance>()
	private outlineInstance: ListInstance | undefined
	private readonly resolver: OdfStyleResolver
	// A package picture's word/-relative media part (Frames.mediaPart), shared with the document's pictures.
	private readonly media: (href: string) => string | undefined
	// w:numPicBullet elements by picture and size, and numbering.xml's image relationships by media part.
	private readonly pictureBullets: string[] = []
	private readonly pictureBulletIds = new Map<string, number>()
	private readonly relationships: string[] = []
	private readonly relationshipIds = new Map<string, string>()

	constructor(sheet: OdfStyleSheet, resolver: OdfStyleResolver, media: (href: string) => string | undefined) {
		this.sheet = sheet
		this.resolver = resolver
		this.media = media
	}

	get empty(): boolean {
		return this.nums.length === 0
	}

	listStyle(name: string, scope: StyleScope): OdfListStyle | undefined {
		return this.sheet.listStyle(name, scope)
	}

	// A text:list starting at the top: a new list instance, or the one it continues.
	open(
		style: string,
		scope: StyleScope,
		continueNumbering: boolean,
		continueList: string | undefined,
		xmlId: string | undefined,
		sink: PropsSink
	): ListInstance | undefined {
		const list = this.sheet.listStyle(style, scope)

		if (list === undefined) return undefined

		const key = `${scope}\u0000${style}`
		let instance = continueList === undefined ? undefined : this.byId.get(continueList)

		// text:continue-numbering continues the preceding list, and only one of the same list style (ODF 1.3 Part 3
		// §19.786); text:continue-list, when present, wins (§19.785).
		if (instance === undefined && continueList === undefined && continueNumbering && this.last?.key === key)
			instance = this.last.instance
		if (instance === undefined) instance = this.newInstance(list, style, scope, sink)

		this.last = { key, instance }

		if (xmlId !== undefined) this.byId.set(xmlId, instance)

		return instance
	}

	// Headings numbered by the outline style (text:outline-style), when it numbers `level`.
	outline(level: number, sink: PropsSink): ListInstance | undefined {
		const outline = this.sheet.outlineStyle
		const levelStyle = outline?.levels.get(level)

		if (outline === undefined || levelStyle === undefined) return undefined

		const format = levelStyle.attributes.get("style:num-format") ?? ""
		const prefix = levelStyle.attributes.get("style:num-prefix") ?? ""
		const suffix = levelStyle.attributes.get("style:num-suffix") ?? ""

		if (format === "" && prefix === "" && suffix === "") return undefined

		this.outlineInstance ??= this.newInstance(outline, "\u0000outline", "styles", sink)

		return this.outlineInstance
	}

	// The instance restarted at `start` on `level` (a list item's text:start-value). The new w:num keeps the
	// restarts of the levels not numbered yet.
	restart(instance: ListInstance, ilvl: number, start: number): void {
		instance.pending &= ~(1 << ilvl)
		instance.num = this.addNum(
			instance.abstract,
			`${this.overrides(instance.abstract, instance.pending & ((1 << ilvl) - 1))}<w:lvlOverride w:ilvl="${ilvl}"><w:startOverride w:val="${start}"/></w:lvlOverride>${this.overrides(instance.abstract, instance.pending & ~((2 << ilvl) - 1))}`
		)
		this.numStyles.set(instance.num, { style: instance.style, scope: instance.scope })
	}

	// A numbered paragraph's w:numPr at `ilvl` of the instance.
	numPr(instance: ListInstance, ilvl: number): string {
		instance.pending &= ~(1 << ilvl)

		return `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${instance.num}"/></w:numPr>`
	}

	level(instance: ListInstance, level: number): OdfListLevel | undefined {
		const list = instance.style === "\u0000outline" ? this.sheet.outlineStyle : this.sheet.listStyle(instance.style, instance.scope)

		return list?.levels.get(level)
	}

	numberingXml(): string {
		return `${this.pictureBullets.join("")}${this.abstracts.join("")}${this.nums.join("")}`
	}

	// word/_rels/numbering.xml.rels's relationships (picture bullets' images); empty when there are none.
	numberingRelationships(): readonly string[] {
		return this.relationships
	}

	private newInstance(list: OdfListStyle, style: string, scope: StyleScope, sink: PropsSink): ListInstance {
		const key = `${scope}\u0000${style}`
		const known = this.abstractIds.get(key)
		const abstract = known ?? this.abstracts.length

		if (known === undefined) {
			this.abstractIds.set(key, abstract)
			this.abstracts.push(this.abstractXml(list, abstract, scope, sink))
		}

		// The first list of a style counts from fresh counters; a later one restarts every level.
		const pending = known === undefined ? 0 : ALL_LEVELS
		const num = this.addNum(abstract, this.overrides(abstract, pending))

		this.numStyles.set(num, { style, scope })

		return { style, scope, abstract, num, pending }
	}

	// Start overrides of the levels in `mask` at their start values.
	private overrides(abstract: number, mask: number): string {
		const starts = this.starts[abstract]
		let out = ""

		if (starts === undefined) return out

		for (let ilvl = 0; ilvl < 9; ilvl++)
			if ((mask & (1 << ilvl)) !== 0)
				out += `<w:lvlOverride w:ilvl="${ilvl}"><w:startOverride w:val="${starts[ilvl] ?? 1}"/></w:lvlOverride>`

		return out
	}

	private addNum(abstract: number, overrides: string): number {
		const id = this.nums.length + 1

		this.nums.push(`<w:num w:numId="${id}"><w:abstractNumId w:val="${abstract}"/>${overrides}</w:num>`)

		return id
	}

	private abstractXml(list: OdfListStyle, id: number, scope: StyleScope, sink: PropsSink): string {
		let out = `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="multilevel"/>`
		const starts: number[] = []

		for (const level of list.levels.keys()) if (level > 9) sink.lossy("listLevel")

		for (let level = 1; level <= 9; level++) {
			const style = list.levels.get(level)

			starts.push(levelStart(style))
			out += this.levelXml(style, level, scope, sink)
		}

		this.starts[id] = starts

		return `${out}</w:abstractNum>`
	}

	private levelXml(level: OdfListLevel | undefined, number: number, scope: StyleScope, sink: PropsSink): string {
		let format = "none"
		let text = ""
		let font = ""
		let bulletFont = false
		let picture = ""

		if (level?.kind === "bullet") {
			format = "bullet"
			text = level.attributes.get("text:bullet-char") ?? "•"

			const family = level.textProperties === undefined ? undefined : fontFamily(this.sheet, level.textProperties.attributes, "")

			bulletFont = family !== undefined

			if (family !== undefined) font = `<w:rFonts w:ascii="${esc(family)}" w:hAnsi="${esc(family)}" w:cs="${esc(family)}"/>`
		} else if (level?.kind === "image") {
			// A picture bullet (text:list-level-style-image) as w:numPicBullet; "•" is what a reader without picture
			// bullets shows. Embedded office:binary-data and pictures the translation does not carry stay "•".
			const id = this.pictureBullet(level)

			format = "bullet"
			text = "•"

			if (id === undefined) sink.lossy("listLevel")
			else picture = `<w:lvlPicBulletId w:val="${id}"/>`
		} else if (level !== undefined) {
			const numFormat = level.attributes.get("style:num-format") ?? "1"

			format = FORMATS[numFormat] ?? "decimal"

			if (FORMATS[numFormat] === undefined) sink.lossy("listLevel")

			const display = Math.max(1, Math.min(number, Number(level.attributes.get("text:display-levels") ?? "1") || 1))
			const parts: string[] = []

			// Levels shown before this one use their own formats (w:isLgl is not needed).
			for (let k = number - display + 1; k <= number; k++) parts.push(k === number && format === "none" ? "" : `%${k}`)

			text = `${level.attributes.get("style:num-prefix") ?? ""}${parts.filter(part => part !== "").join(".")}${level.attributes.get("style:num-suffix") ?? ""}`
		}

		const geometry = levelGeometry(level)
		let indent: string
		let suffix = ""
		let tab = ""

		if (geometry.mode === "label-alignment") {
			const follow = level?.labelAlignment?.get("text:label-followed-by") ?? "listtab"

			indent = `<w:ind w:left="${twips(geometry.marginLeft)}" ${geometry.textIndent < 0 ? `w:hanging="${twips(-geometry.textIndent)}"` : `w:firstLine="${twips(geometry.textIndent)}"`}/>`

			if (follow === "space") suffix = '<w:suff w:val="space"/>'
			else if (follow === "nothing" || follow === "newline") suffix = '<w:suff w:val="nothing"/>'

			if (follow === "newline") sink.lossy("listLevel")

			const stop = parseLength(level?.labelAlignment?.get("text:list-tab-stop-position"))

			if (follow === "listtab" && stop !== undefined) tab = `<w:tabs><w:tab w:val="num" w:pos="${twips(stop)}"/></w:tabs>`
		} else {
			indent = `<w:ind w:left="${twips(geometry.spaceBefore + geometry.minLabelWidth)}" w:hanging="${twips(geometry.minLabelWidth)}"/>`
		}

		const align = level?.properties.attributes.get("fo:text-align")
		const jc = align === "center" ? "center" : align === "end" || align === "right" ? "right" : "left"
		const fontSize = level?.textProperties?.attributes.get("fo:font-size")
		const size = parseLength(fontSize)
		const relative = level?.attributes.get("text:bullet-relative-size")
		// The label's character style (text:style-name, §19.874) under the level's own font and size.
		const label = level?.kind === "image" ? NO_ATTRIBUTES : this.labelAttributes(level?.attributes.get("text:style-name"), scope)
		const rPr =
			label.size === 0
				? `${font}${size === undefined ? "" : `<w:sz w:val="${Math.round(size * 2)}"/>`}`
				: runProperties(this.sheet, labelWithLevel(label, bulletFont ? level?.textProperties?.attributes : undefined, size), sink)

		// A label size relative to the paragraph's font (text:bullet-relative-size, Part 3 §19.762; a percent fo:font-size) has no w:lvl counterpart: w:sz is absolute.
		if ((relative !== undefined && relative !== "100%") || (fontSize?.endsWith("%") === true && fontSize !== "100%"))
			sink.lossy("listLevel")

		return `<w:lvl w:ilvl="${number - 1}"><w:start w:val="${levelStart(level)}"/><w:numFmt w:val="${format}"/>${suffix}<w:lvlText w:val="${esc(text)}"/>${picture}<w:lvlJc w:val="${jc}"/><w:pPr>${tab}${indent}</w:pPr>${rPr === "" ? "" : `<w:rPr>${rPr}</w:rPr>`}</w:lvl>`
	}

	// A character style's text properties with inheritance; none for a name no text style has.
	private labelAttributes(name: string | undefined, scope: StyleScope): Attributes {
		if (name === undefined || name === "" || this.sheet.style("text", name, scope) === undefined) return NO_ATTRIBUTES

		return this.resolver.resolve("text", name, scope).properties("text").attributes
	}

	// The w:numPicBullet id of an image level's picture (xlink:href), one per picture and size.
	private pictureBullet(level: OdfListLevel): number | undefined {
		const href = level.attributes.get("xlink:href")
		const part = href === undefined ? undefined : this.media(href)

		if (part === undefined) return undefined

		const properties = level.properties.attributes
		const width = parseLength(properties.get("fo:width"))
		const height = parseLength(properties.get("fo:height"))
		// Word scales a picture bullet to the text; the shape's size is what a reader without that uses.
		const w = Math.round((width ?? height ?? DEFAULT_PICTURE_BULLET) * 100) / 100
		const h = Math.round((height ?? width ?? DEFAULT_PICTURE_BULLET) * 100) / 100
		const key = `${part}\u0000${w}\u0000${h}`
		const known = this.pictureBulletIds.get(key)

		if (known !== undefined) return known

		let rId = this.relationshipIds.get(part)

		if (rId === undefined) {
			rId = `rId${this.relationships.length + 1}`
			this.relationshipIds.set(part, rId)
			this.relationships.push(`<Relationship Id="${rId}" Type="${REL}image" Target="${esc(part)}"/>`)
		}

		const id = this.pictureBullets.length

		this.pictureBulletIds.set(key, id)
		this.pictureBullets.push(
			`<w:numPicBullet w:numPicBulletId="${id}"><w:pict><v:shape xmlns:v="${NS_V}" xmlns:o="${NS_O}" style="width:${w}pt;height:${h}pt" o:bullet="t"><v:imagedata r:id="${rId}" o:title=""/></v:shape></w:pict></w:numPicBullet>`
		)

		return id
	}
}

const NO_ATTRIBUTES: Attributes = new Map()
const NS_V = "urn:schemas-microsoft-com:vml"
const NS_O = "urn:schemas-microsoft-com:office:office"
// Points: Word's own picture bullets' shape size.
const DEFAULT_PICTURE_BULLET = 9

// A label's character style attributes with what the level sets itself winning: its bullet font (`font`, the
// level's text properties) and absolute size.
function labelWithLevel(label: Attributes, font: Attributes | undefined, size: number | undefined): Attributes {
	const out = new Map(label)

	if (font !== undefined) {
		for (const name of ["style:font-name", "fo:font-family", "style:font-name-complex", "style:font-family-complex"]) out.delete(name)

		const name = font.get("style:font-name")
		const family = font.get("fo:font-family")

		// The bullet font for complex script too, as without a character style.
		if (name !== undefined) {
			out.set("style:font-name", name)
			out.set("style:font-name-complex", name)
		} else if (family !== undefined) {
			out.set("fo:font-family", family)
			out.set("style:font-family-complex", family)
		}
	}

	if (size !== undefined) out.set("fo:font-size", `${size}pt`)

	return out
}
