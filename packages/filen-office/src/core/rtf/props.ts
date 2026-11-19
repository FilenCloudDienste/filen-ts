import { languageIdentifier, lcidHex, lcidTag } from "../docx/forms/dates"
import { escapeAttribute } from "../xml/index"

// Character, paragraph, section, row and cell properties as RTF states them (Microsoft RTF Specification
// 1.9.1), and their WordprocessingML (ECMA-376 Part 1 §17.3, §17.4, §17.6) in schema order. Only what the
// source said is written: a property RTF left unset stays unset, so styles apply as LibreOffice applies them.
// Units match: twips are twentieths of a point (dxa), \fsN half-points.

// Tri-state toggles: -1 unset, 0 off, 1 on.
export type Toggle = -1 | 0 | 1

export interface Border {
	style: string
	// Twips (\brdrwN); written as eighths of a point.
	width: number
	// Twips (\brspN); written as points.
	space: number
	color: number
}

export function newBorder(): Border {
	return { style: "single", width: -1, space: 0, color: -1 }
}

export interface Shading {
	fill: number
	pattern: number
	// Hundredths of a percent (\shadingN).
	percent: number
	// The ST_Shd a pattern word names (\bghoriz...), when one is in force.
	texture: string | undefined
}

export function newShading(): Shading {
	return { fill: -1, pattern: -1, percent: 0, texture: undefined }
}

// The shading pattern words (\bghoriz, \chbghoriz, \clbghoriz, \trbghoriz...) as ST_Shd (ECMA-376 Part 1
// §17.18.78), by what follows their prefix. RTF 1.9.1 names twelve patterns, six of them "dark"; they are MS-DOC's
// Ipat 14 to 25 (§2.9.124), the light ones ST_Shd's thin patterns. The forward diagonal is drawn \\\\ (top left to
// bottom right), ST_Shd's reverse diagonal stripe. Cells and rows spell the dark horizontal one "dkhor".
export const SHADING_TEXTURES: ReadonlyMap<string, string> = new Map([
	["horiz", "thinHorzStripe"],
	["vert", "thinVertStripe"],
	["fdiag", "thinReverseDiagStripe"],
	["bdiag", "thinDiagStripe"],
	["cross", "thinHorzCross"],
	["dcross", "thinDiagCross"],
	["dkhoriz", "horzStripe"],
	["dkhor", "horzStripe"],
	["dkvert", "vertStripe"],
	["dkfdiag", "reverseDiagStripe"],
	["dkbdiag", "diagStripe"],
	["dkcross", "horzCross"],
	["dkdcross", "diagCross"]
])

// The ST_Shd a pattern word sets, by the word's prefix ("bg", "chbg", "clbg", "trbg"); undefined for other words.
export function shadingTexture(name: string, prefix: string): string | undefined {
	if (!name.startsWith(prefix)) return undefined

	const suffix = name.slice(prefix.length)
	// \bgdkhoriz and \chbgdkhoriz, but \clbgdkhor and \trbgdkhor.
	const spelled = prefix === "clbg" || prefix === "trbg" ? suffix !== "dkhoriz" : suffix !== "dkhor"

	return spelled ? SHADING_TEXTURES.get(suffix) : undefined
}

// A pattern's word for `prefix`, the inverse of shadingTexture.
export function textureWord(texture: string, prefix: string): string | undefined {
	for (const [suffix, value] of SHADING_TEXTURES) {
		if (value === texture && shadingTexture(prefix + suffix, prefix) === value) return prefix + suffix
	}

	return undefined
}

// A pattern word with a percentage beside it: ST_Shd holds one of the two.
export function shadingConflict(shading: Shading | undefined): boolean {
	return shading !== undefined && shading.texture !== undefined && shading.percent !== 0
}

// What property values refer to: fonts, colours, styles and revision authors by their table index.
export interface PropsContext {
	fontName(index: number): string | undefined
	// "RRGGBB", "auto" or undefined for a missing entry.
	color(index: number): string | undefined
	charStyleId(index: number): string | undefined
	paraStyleId(index: number): string | undefined
	tableStyleId(index: number): string | undefined
	author(index: number): string
	// A cell's tracked insertion or deletion (w:cellIns, w:cellDel; ECMA-376 Part 1 §17.13.5.4, .5).
	cellRevision(revision: { kind: "cellIns" | "cellDel"; author: number; date: number }): string
	// The opening tag of a tracked property change (w:rPrChange...) with an id of its own, its author and date.
	change(name: string, author: number, date: number): string
	nextId(): number
	// The one string kept for markup equal to `xml`: runs and paragraphs with equal properties share it.
	intern(xml: string): string
}

// The properties before a tracked formatting change (RTF 1.9.1 "Old Properties"), with its author (\\crauthN...)
// and date (DTTM).
export interface OldProps<T> {
	readonly props: T
	readonly author: number
	readonly date: number
}

// A border style word → ST_Border, per the specification's descriptions.
export const BORDER_STYLES: ReadonlyMap<string, string> = new Map([
	["brdrs", "single"],
	["brdrth", "thick"],
	["brdrsh", "single"],
	["brdrdb", "double"],
	["brdrdot", "dotted"],
	["brdrdash", "dashed"],
	["brdrhair", "single"],
	["brdrinset", "inset"],
	["brdrdashsm", "dashSmallGap"],
	["brdrdashd", "dotDash"],
	["brdrdashdd", "dotDotDash"],
	["brdrdashdot", "dotDash"],
	["brdrdashdotdot", "dotDotDash"],
	["brdroutset", "outset"],
	["brdrtriple", "triple"],
	["brdrtnthsg", "thickThinSmallGap"],
	["brdrthtnsg", "thinThickSmallGap"],
	["brdrtnthtnsg", "thinThickThinSmallGap"],
	["brdrtnthmg", "thickThinMediumGap"],
	["brdrthtnmg", "thinThickMediumGap"],
	["brdrtnthtnmg", "thinThickThinMediumGap"],
	["brdrtnthlg", "thickThinLargeGap"],
	["brdrthtnlg", "thinThickLargeGap"],
	["brdrtnthtnlg", "thinThickThinLargeGap"],
	["brdrwavy", "wave"],
	["brdrwavydb", "doubleWave"],
	["brdrdashdotstr", "dashDotStroked"],
	["brdremboss", "threeDEmboss"],
	["brdrengrave", "threeDEngrave"],
	["brdrframe", "single"],
	["brdrnone", "none"],
	["brdrnil", "nil"],
	["brdrtbl", "nil"]
])

export const UNDERLINES: ReadonlyMap<string, string> = new Map([
	["ul", "single"],
	["uld", "dotted"],
	["uldash", "dash"],
	["uldashd", "dotDash"],
	["uldashdd", "dotDotDash"],
	["uldb", "double"],
	["ulhwave", "wavyHeavy"],
	["ulldash", "dashLong"],
	["ulth", "thick"],
	["ulthd", "dottedHeavy"],
	["ulthdash", "dashedHeavy"],
	["ulthdashd", "dashDotHeavy"],
	["ulthdashdd", "dashDotDotHeavy"],
	["ulthldash", "dashLongHeavy"],
	["ululdbwave", "wavyDouble"],
	["ulw", "words"],
	["ulwave", "wave"],
	["ulnone", "none"]
])

export const MAX_NESTING = 64

export class CharProps {
	font = -1
	csFont = -1
	eastAsiaFont = -1
	hAnsiFont = -1
	size = -1
	csSize = -1
	bold: Toggle = -1
	boldCs: Toggle = -1
	italic: Toggle = -1
	italicCs: Toggle = -1
	caps: Toggle = -1
	smallCaps: Toggle = -1
	strike: Toggle = -1
	dstrike: Toggle = -1
	outline: Toggle = -1
	shadow: Toggle = -1
	emboss: Toggle = -1
	imprint: Toggle = -1
	hidden: Toggle = -1
	webHidden: Toggle = -1
	noProof: Toggle = -1
	rtl: Toggle = -1
	underline: string | undefined = undefined
	underlineColor = -1
	color = -1
	highlight = -1
	background = -1
	shading: Shading | undefined = undefined
	vertAlign: string | undefined = undefined
	position: number | undefined = undefined
	spacing: number | undefined = undefined
	kern: number | undefined = undefined
	scale: number | undefined = undefined
	style = -1
	border: Border | undefined = undefined
	// Windows language identifiers (\\langN, \\langfeN, \\alangN), -1 when unset.
	lang = -1
	langEastAsia = -1
	langBidi = -1
	// ST_Em (\\accdot...) and ST_TextEffect (\\animtextN).
	emphasis: string | undefined = undefined
	effect: string | undefined = undefined
	// Words in force the translation cannot hold, space-separated: a paragraph showing text with them is locked.
	unread = ""
	inserted = false
	insertAuthor = -1
	insertDate = 0
	deleted = false
	deleteAuthor = -1
	deleteDate = 0
	// The slot \afN sets: "cs" (after \rtlch/\ltrch or by default), "ascii" (\loch), "hAnsi" (\hich), "eastAsia" (\dbch).
	slot: "cs" | "ascii" | "hAnsi" | "eastAsia" = "cs"
	old: OldProps<CharProps> | undefined = undefined
	// The serialized w:rPr, cached until the next change.
	cached: string | undefined = undefined

	clone(): CharProps {
		const copy = Object.assign(new CharProps(), this)

		if (this.shading !== undefined) copy.shading = { ...this.shading }
		if (this.border !== undefined) copy.border = { ...this.border }

		return copy
	}

	xml(context: PropsContext): string {
		if (this.cached !== undefined) return this.cached

		let out = ""
		const style = this.style >= 0 ? context.charStyleId(this.style) : undefined

		if (style !== undefined) out += `<w:rStyle w:val="${escapeAttribute(style)}"/>`

		const ascii = this.font >= 0 ? context.fontName(this.font) : undefined
		const hAnsi = this.hAnsiFont >= 0 ? context.fontName(this.hAnsiFont) : ascii
		const eastAsia = this.eastAsiaFont >= 0 ? context.fontName(this.eastAsiaFont) : undefined
		const cs = this.csFont >= 0 ? context.fontName(this.csFont) : undefined

		if (ascii !== undefined || hAnsi !== undefined || eastAsia !== undefined || cs !== undefined) {
			out += "<w:rFonts"

			if (ascii !== undefined) out += ` w:ascii="${escapeAttribute(ascii)}"`
			if (hAnsi !== undefined) out += ` w:hAnsi="${escapeAttribute(hAnsi)}"`
			if (eastAsia !== undefined) out += ` w:eastAsia="${escapeAttribute(eastAsia)}"`
			if (cs !== undefined) out += ` w:cs="${escapeAttribute(cs)}"`

			out += "/>"
		}

		out += toggle("b", this.bold)
		out += toggle("bCs", this.boldCs)
		out += toggle("i", this.italic)
		out += toggle("iCs", this.italicCs)
		out += toggle("caps", this.caps)
		out += toggle("smallCaps", this.smallCaps)
		out += toggle("strike", this.strike)
		out += toggle("dstrike", this.dstrike)
		out += toggle("outline", this.outline)
		out += toggle("shadow", this.shadow)
		out += toggle("emboss", this.emboss)
		out += toggle("imprint", this.imprint)
		out += toggle("noProof", this.noProof)
		out += toggle("vanish", this.hidden)
		out += toggle("webHidden", this.webHidden)

		const color = this.color >= 0 ? context.color(this.color) : undefined

		if (color !== undefined) out += `<w:color w:val="${color}"/>`
		if (this.spacing !== undefined) out += `<w:spacing w:val="${this.spacing}"/>`
		if (this.scale !== undefined) out += `<w:w w:val="${clamp(this.scale, 1, 600)}"/>`
		if (this.kern !== undefined) out += `<w:kern w:val="${clamp(this.kern, 0, 3277)}"/>`
		if (this.position !== undefined) out += `<w:position w:val="${this.position}"/>`
		if (this.size >= 0) out += `<w:sz w:val="${clamp(this.size, 2, 3276)}"/>`
		if (this.csSize >= 0) out += `<w:szCs w:val="${clamp(this.csSize, 2, 3276)}"/>`

		const highlight = this.highlight > 0 ? context.color(this.highlight) : undefined

		if (highlight !== undefined && highlight !== "auto") out += `<w:highlight w:val="${highlightName(highlight)}"/>`
		else if (this.highlight === 0) out += '<w:highlight w:val="none"/>'

		if (this.underline !== undefined) {
			const underlineColor = this.underlineColor >= 0 ? context.color(this.underlineColor) : undefined

			out += `<w:u w:val="${this.underline}"${underlineColor === undefined ? "" : ` w:color="${underlineColor}"`}/>`
		}

		if (this.effect !== undefined) out += `<w:effect w:val="${this.effect}"/>`
		if (this.border !== undefined) out += borderXml("bdr", this.border, context)

		if (this.shading !== undefined) out += shadingXml(this.shading, context)
		else if (this.background > 0) {
			const fill = context.color(this.background)

			if (fill !== undefined && fill !== "auto") out += `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`
		}

		if (this.vertAlign !== undefined) out += `<w:vertAlign w:val="${this.vertAlign}"/>`

		out += toggle("rtl", this.rtl)

		if (this.emphasis !== undefined) out += `<w:em w:val="${this.emphasis}"/>`

		if (this.lang >= 0 || this.langEastAsia >= 0 || this.langBidi >= 0) {
			out += "<w:lang"
			if (this.lang >= 0) out += ` w:val="${lcidCode(this.lang)}"`
			if (this.langEastAsia >= 0) out += ` w:eastAsia="${lcidCode(this.langEastAsia)}"`
			if (this.langBidi >= 0) out += ` w:bidi="${lcidCode(this.langBidi)}"`
			out += "/>"
		}

		if (this.old !== undefined) {
			const old = this.old.props.xml(context)

			out += `${context.change("rPrChange", this.old.author, this.old.date)}${old === "" ? "<w:rPr/>" : old}</w:rPrChange>`
		}

		// A tracked change carries an id of its own: never equal to another.
		this.cached = out === "" ? "" : this.old === undefined ? context.intern(`<w:rPr>${out}</w:rPr>`) : `<w:rPr>${out}</w:rPr>`

		return this.cached
	}
}

export interface TabStop {
	readonly position: number
	readonly kind: string
	readonly leader: string | undefined
}

// A positioned paragraph (spec, "Positioned Objects and Frames"): w:framePr.
export interface Frame {
	width: number
	height: number
	x: number
	y: number
	xAlign: string | undefined
	yAlign: string | undefined
	hAnchor: string
	vAnchor: string
	wrap: string
	hSpace: number
	vSpace: number
	dropCap: string | undefined
	lines: number
}

export function newFrame(): Frame {
	return {
		width: 0,
		height: 0,
		x: 0,
		y: 0,
		xAlign: undefined,
		yAlign: undefined,
		hAnchor: "text",
		vAnchor: "margin",
		wrap: "auto",
		hSpace: 0,
		vSpace: 0,
		dropCap: undefined,
		lines: 0
	}
}

export class ParaProps {
	style = -1
	jc: string | undefined = undefined
	left: number | undefined = undefined
	right: number | undefined = undefined
	firstLine: number | undefined = undefined
	before: number | undefined = undefined
	after: number | undefined = undefined
	beforeAuto: Toggle = -1
	afterAuto: Toggle = -1
	line: number | undefined = undefined
	lineMultiple = false
	keepLines: Toggle = -1
	keepNext: Toggle = -1
	pageBreakBefore: Toggle = -1
	widowControl: Toggle = -1
	contextualSpacing: Toggle = -1
	suppressAutoHyphens: Toggle = -1
	suppressLineNumbers: Toggle = -1
	snapToGrid: Toggle = -1
	bidi: Toggle = -1
	overflowPunct: Toggle = -1
	autoSpaceDE: Toggle = -1
	autoSpaceDN: Toggle = -1
	adjustRightInd: Toggle = -1
	// ST_TextAlignment (\\faauto...).
	textAlignment: string | undefined = undefined
	// As CharProps.unread.
	unread = ""
	tabs: TabStop[] = []
	// The alignment and leader the next \txN takes.
	tabKind = "left"
	tabLeader: string | undefined = undefined
	borders: Partial<Record<"top" | "left" | "bottom" | "right" | "between" | "bar", Border>> = {}
	shading: Shading | undefined = undefined
	inTable = false
	// \itapN, -1 when unset (then \intbl means depth 1).
	nesting = -1
	list = -1
	level = -1
	outline = -1
	frame: Frame | undefined = undefined
	// A wrapping word read before any frame word.
	pendingWrap = "auto"
	old: OldProps<ParaProps> | undefined = undefined
	cached: string | undefined = undefined

	clone(): ParaProps {
		const copy = Object.assign(new ParaProps(), this)

		copy.tabs = this.tabs.slice()
		copy.borders = { ...this.borders }
		if (this.shading !== undefined) copy.shading = { ...this.shading }
		if (this.frame !== undefined) copy.frame = { ...this.frame }

		return copy
	}

	// Table nesting depth: \itapN when it is at least 1, else 1 inside a table (\intbl), else 0. Deeper
	// nesting than MAX_NESTING stays at that depth (every level is an open table).
	depth(): number {
		return this.nesting >= 1 ? Math.min(this.nesting, MAX_NESTING) : this.inTable ? 1 : 0
	}

	// The w:pPr children before w:rPr (paragraph mark properties and sectPr are added by the caller).
	// `withStyle`: false for a list level, whose linked style is w:lvl/w:pStyle, not in its w:pPr.
	xml(context: PropsContext, numId: (list: number) => number | undefined, withStyle = true): string {
		if (this.cached !== undefined) return this.cached

		let out = ""
		const style = withStyle && this.style > 0 ? context.paraStyleId(this.style) : undefined

		if (style !== undefined) out += `<w:pStyle w:val="${escapeAttribute(style)}"/>`

		out += toggle("keepNext", this.keepNext)
		out += toggle("keepLines", this.keepLines)
		out += toggle("pageBreakBefore", this.pageBreakBefore)

		const frame = this.frame

		if (frame !== undefined) {
			out += "<w:framePr"
			if (frame.dropCap !== undefined) out += ` w:dropCap="${frame.dropCap}" w:lines="${clamp(frame.lines || 1, 1, 10)}"`
			if (frame.width > 0) out += ` w:w="${frame.width}"`
			if (frame.height !== 0) out += ` w:h="${Math.abs(frame.height)}" w:hRule="${frame.height < 0 ? "exact" : "atLeast"}"`
			if (frame.hSpace > 0) out += ` w:hSpace="${frame.hSpace}"`
			if (frame.vSpace > 0) out += ` w:vSpace="${frame.vSpace}"`
			out += ` w:wrap="${frame.wrap}" w:hAnchor="${frame.hAnchor}" w:vAnchor="${frame.vAnchor}"`
			out += frame.xAlign === undefined ? ` w:x="${frame.x}"` : ` w:xAlign="${frame.xAlign}"`
			out += frame.yAlign === undefined ? ` w:y="${frame.y}"` : ` w:yAlign="${frame.yAlign}"`
			out += "/>"
		}
		out += toggle("widowControl", this.widowControl)

		const num = this.list >= 0 ? numId(this.list) : undefined

		if (num !== undefined || this.list === 0) {
			out += `<w:numPr><w:ilvl w:val="${clamp(Math.max(this.level, 0), 0, 8)}"/><w:numId w:val="${num ?? 0}"/></w:numPr>`
		}

		out += toggle("suppressLineNumbers", this.suppressLineNumbers)

		const borders = ["top", "left", "bottom", "right", "between", "bar"] as const
		let pBdr = ""

		for (const side of borders) {
			const border = this.borders[side]

			if (border !== undefined) pBdr += borderXml(side, border, context)
		}

		if (pBdr !== "") out += `<w:pBdr>${pBdr}</w:pBdr>`
		if (this.shading !== undefined) out += shadingXml(this.shading, context)

		if (this.tabs.length > 0) {
			out += "<w:tabs>"

			for (const tab of this.tabs) {
				out += `<w:tab w:val="${tab.kind}"${tab.leader === undefined ? "" : ` w:leader="${tab.leader}"`} w:pos="${tab.position}"/>`
			}

			out += "</w:tabs>"
		}

		out += toggle("suppressAutoHyphens", this.suppressAutoHyphens)
		out += toggle("overflowPunct", this.overflowPunct)
		out += toggle("autoSpaceDE", this.autoSpaceDE)
		out += toggle("autoSpaceDN", this.autoSpaceDN)
		out += toggle("bidi", this.bidi)
		out += toggle("adjustRightInd", this.adjustRightInd)
		out += toggle("snapToGrid", this.snapToGrid)

		if (
			this.before !== undefined ||
			this.after !== undefined ||
			this.line !== undefined ||
			this.beforeAuto !== -1 ||
			this.afterAuto !== -1
		) {
			out += "<w:spacing"

			if (this.before !== undefined) out += ` w:before="${this.before}"`
			if (this.beforeAuto !== -1) out += ` w:beforeAutospacing="${this.beforeAuto}"`
			if (this.after !== undefined) out += ` w:after="${this.after}"`
			if (this.afterAuto !== -1) out += ` w:afterAutospacing="${this.afterAuto}"`

			if (this.line !== undefined) {
				// \slN: 0 is single (auto), negative exact, positive "at least" unless \slmult1 makes it a multiple.
				if (this.line === 0) out += ' w:line="240" w:lineRule="auto"'
				else if (this.line < 0) out += ` w:line="${-this.line}" w:lineRule="exact"`
				else out += ` w:line="${this.line}" w:lineRule="${this.lineMultiple ? "auto" : "atLeast"}"`
			}

			out += "/>"
		}

		if (this.left !== undefined || this.right !== undefined || this.firstLine !== undefined) {
			out += "<w:ind"

			if (this.left !== undefined) out += ` w:left="${this.left}"`
			if (this.right !== undefined) out += ` w:right="${this.right}"`

			if (this.firstLine !== undefined) {
				out += this.firstLine < 0 ? ` w:hanging="${-this.firstLine}"` : ` w:firstLine="${this.firstLine}"`
			}

			out += "/>"
		}

		out += toggle("contextualSpacing", this.contextualSpacing)

		if (this.jc !== undefined) out += `<w:jc w:val="${this.jc}"/>`
		if (this.textAlignment !== undefined) out += `<w:textAlignment w:val="${this.textAlignment}"/>`
		if (this.outline >= 0 && this.outline <= 9) out += `<w:outlineLvl w:val="${this.outline}"/>`

		this.cached = context.intern(out)

		return this.cached
	}
}

export class SectProps {
	width = 12240
	height = 15840
	left = 1800
	right = 1800
	top = 1440
	bottom = 1440
	gutter = 0
	header = 720
	footer = 720
	landscape = false
	columns = 1
	columnSpace = 720
	columnLine = false
	columnWidths: { width: number; space: number }[] = []
	breakType = "nextPage"
	titlePage = false
	pageStart = -1
	pageFormat: string | undefined = undefined
	vAlign: string | undefined = undefined
	bidi = false
	// Line numbering is on once \\linemodN gives a step (Word writes \\linex0 in every section).
	lineNumbers = { countBy: 0, distance: 360, start: 1, restart: "newPage" }
	old: OldProps<SectProps> | undefined = undefined

	clone(): SectProps {
		const copy = Object.assign(new SectProps(), this)

		copy.columnWidths = this.columnWidths.map(column => ({ ...column }))
		copy.lineNumbers = { ...this.lineNumbers }

		return copy
	}

	// w:sectPr children after the header and footer references.
	xml(): string {
		let out = ""

		if (this.breakType !== "nextPage") out += `<w:type w:val="${this.breakType}"/>`

		const width = clamp(this.width, 1440, 31680)
		const height = clamp(this.height, 1440, 31680)
		// Margins that leave less than an inch of text area shrink to leave it (broken files, never Word's).
		const [top, bottom] = fit(this.top, this.bottom, height)
		const [left, right] = fit(Math.max(0, this.left), Math.max(0, this.right), width)

		out += `<w:pgSz w:w="${width}" w:h="${height}"${this.landscape ? ' w:orient="landscape"' : ""}/>`
		out += `<w:pgMar w:top="${top}" w:right="${right}" w:bottom="${bottom}" w:left="${left}" w:header="${Math.max(0, this.header)}" w:footer="${Math.max(0, this.footer)}" w:gutter="${Math.max(0, this.gutter)}"/>`

		if (this.lineNumbers.countBy >= 1) {
			const numbers = this.lineNumbers

			out += `<w:lnNumType w:countBy="${numbers.countBy}" w:distance="${Math.max(0, numbers.distance)}" w:start="${Math.max(0, numbers.start - 1)}" w:restart="${numbers.restart}"/>`
		}

		if (this.pageStart >= 0 || this.pageFormat !== undefined) {
			out += "<w:pgNumType"

			if (this.pageFormat !== undefined) out += ` w:fmt="${this.pageFormat}"`
			if (this.pageStart >= 0) out += ` w:start="${this.pageStart}"`

			out += "/>"
		}

		const columns = clamp(this.columns, 1, 45)

		if (columns > 1) {
			const explicit = this.columnWidths.length === columns && this.columnWidths.every(column => column.width > 0)

			out += `<w:cols w:num="${columns}" w:space="${Math.max(0, this.columnSpace)}"${this.columnLine ? ' w:sep="1"' : ""}${explicit ? ' w:equalWidth="0"' : ""}>`

			if (explicit)
				for (const column of this.columnWidths) out += `<w:col w:w="${column.width}" w:space="${Math.max(0, column.space)}"/>`

			out += "</w:cols>"
		}

		if (this.vAlign !== undefined) out += `<w:vAlign w:val="${this.vAlign}"/>`
		if (this.titlePage) out += "<w:titlePg/>"
		if (this.bidi) out += "<w:bidi/>"

		return out
	}
}

export interface CellDef {
	right: number
	borders: Partial<Record<"top" | "left" | "bottom" | "right", Border>>
	shading: Shading | undefined
	vAlign: string | undefined
	mergeFirst: boolean
	merged: boolean
	vMergeFirst: boolean
	vMerged: boolean
	width: number
	widthType: number
	noWrap: boolean
	textDirection: string | undefined
	padding: Partial<Record<"top" | "left" | "bottom" | "right", number>>
	// \\clins or \\cldel with their author (\\clinsauthN...) and date (DTTM).
	revision: { kind: "cellIns" | "cellDel"; author: number; date: number } | undefined
}

export function newCell(): CellDef {
	return {
		right: 0,
		borders: {},
		shading: undefined,
		vAlign: undefined,
		mergeFirst: false,
		merged: false,
		vMergeFirst: false,
		vMerged: false,
		width: -1,
		widthType: -1,
		noWrap: false,
		textDirection: undefined,
		padding: {},
		revision: undefined
	}
}

export interface RowDef {
	left: number
	gap: number
	height: number
	header: boolean
	cantSplit: boolean
	jc: string | undefined
	borders: Partial<Record<"top" | "left" | "bottom" | "right" | "insideH" | "insideV", Border>>
	padding: Partial<Record<"top" | "left" | "bottom" | "right", number>>
	width: number
	widthType: number
	// The invisible cells before and after the row (\trwWidthBN, \trftsWidthBN; \trwWidthAN, \trftsWidthAN).
	widthBefore: number
	widthBeforeType: number
	widthAfter: number
	widthAfterType: number
	style: number
	// \tblindN and \tblindtypeN as the source states them (undefined, -1: unset). The indent itself is the row's left
	// edge and margin (w:tblInd); what \tblindN measures depends on the version that wrote it, so the writer
	// states it again as the source did (SourceRow.indent).
	indent: number | undefined
	indentType: number
	// The row's shading (\trcbpatN, \trcfpatN, \trshdngN, \trbghoriz...).
	shading: Shading | undefined
	// Words in its definition the translation cannot hold, space-separated: its table is locked.
	unread: string
	bidi: boolean
	autofit: boolean
	cells: CellDef[]
	old: OldProps<RowDef> | undefined
}

export function newRow(): RowDef {
	return {
		left: 0,
		gap: 0,
		height: 0,
		header: false,
		cantSplit: false,
		jc: undefined,
		borders: {},
		padding: {},
		width: -1,
		widthType: -1,
		widthBefore: -1,
		widthBeforeType: -1,
		widthAfter: -1,
		widthAfterType: -1,
		style: -1,
		indent: undefined,
		indentType: -1,
		shading: undefined,
		unread: "",
		bidi: false,
		autofit: false,
		cells: [],
		old: undefined
	}
}

// Two opposite margins scaled down so `size` keeps an inch between them; negative top and bottom margins
// (text may run under a header) keep their sign.
function fit(start: number, end: number, size: number): [number, number] {
	const room = size - 1440
	const total = Math.abs(start) + Math.abs(end)

	if (total <= room) return [start, end]

	const scale = Math.max(0, room) / total

	return [Math.trunc(start * scale), Math.trunc(end * scale)]
}

// A language identifier as w:lang gives it: its BCP 47 tag (ST_Lang, ECMA-376 Part 1 §22.9.2.6) where that tag
// names this identifier and no other, else the identifier as four hex digits (the legacy form readers know).
export function lcidCode(lcid: number): string {
	const tag = lcidTag(lcid)

	return tag !== undefined && languageIdentifier(tag) === lcid ? tag : lcidHex(lcid)
}

export function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : Math.round(value)
}

function toggle(name: string, value: Toggle): string {
	return value === -1 ? "" : value === 1 ? `<w:${name}/>` : `<w:${name} w:val="0"/>`
}

export function borderXml(name: string, border: Border, context: PropsContext): string {
	const color = border.color >= 0 ? context.color(border.color) : undefined
	// \brdrwN is twips; w:sz eighths of a point (2..96). A width-less border is Word's hairline, 1/4 pt.
	const size = border.width < 0 ? 2 : clamp(Math.round((border.width * 8) / 20), 2, 96)
	const space = clamp(Math.round(border.space / 20), 0, 31)

	if (border.style === "none" || border.style === "nil") return `<w:${name} w:val="${border.style}"/>`

	return `<w:${name} w:val="${border.style}" w:sz="${size}" w:space="${space}" w:color="${color ?? "auto"}"/>`
}

export function shadingXml(shading: Shading, context: PropsContext): string {
	const fill = shading.fill >= 0 ? (context.color(shading.fill) ?? "auto") : "auto"
	const pattern = shading.pattern >= 0 ? (context.color(shading.pattern) ?? "auto") : "auto"
	const percent = clamp(shading.percent, 0, 10000)
	// ST_Shd has pct5..pct95 in fixed steps and pct12/pct37/pct62/pct87; the nearest is taken.
	const value = shading.texture ?? (percent === 0 ? "clear" : percent >= 10000 ? "solid" : `pct${nearestPercent(percent / 100)}`)

	return `<w:shd w:val="${value}" w:color="${pattern}" w:fill="${fill}"/>`
}

const PERCENTS = [5, 10, 12, 15, 20, 25, 30, 35, 37, 40, 45, 50, 55, 60, 62, 65, 70, 75, 80, 85, 87, 90, 95]

function nearestPercent(percent: number): number {
	let best = 5

	for (const candidate of PERCENTS) if (Math.abs(candidate - percent) < Math.abs(best - percent)) best = candidate

	return best
}

// ST_HighlightColor names and their colours (ECMA-376 Part 1 §17.18.40).
const HIGHLIGHTS: readonly (readonly [string, number])[] = [
	["black", 0x000000],
	["blue", 0x0000ff],
	["cyan", 0x00ffff],
	["green", 0x00ff00],
	["magenta", 0xff00ff],
	["red", 0xff0000],
	["yellow", 0xffff00],
	["white", 0xffffff],
	["darkBlue", 0x000080],
	["darkCyan", 0x008080],
	["darkGreen", 0x008000],
	["darkMagenta", 0x800080],
	["darkRed", 0x800000],
	["darkYellow", 0x808000],
	["darkGray", 0x808080],
	["lightGray", 0xc0c0c0]
]

// \highlightN names a colour-table entry; WordprocessingML has sixteen named highlights, the nearest is taken.
export function highlightName(hex: string): string {
	const value = parseInt(hex, 16)
	const r = (value >> 16) & 0xff
	const g = (value >> 8) & 0xff
	const b = value & 0xff
	let best = "yellow"
	let distance = Infinity

	for (const [name, color] of HIGHLIGHTS) {
		const d = (r - ((color >> 16) & 0xff)) ** 2 + (g - ((color >> 8) & 0xff)) ** 2 + (b - (color & 0xff)) ** 2

		if (d < distance) {
			distance = d
			best = name
		}
	}

	return best
}
