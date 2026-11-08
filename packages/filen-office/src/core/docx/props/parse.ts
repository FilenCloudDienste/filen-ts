import type { PropsReader } from "./reader"
import type {
	BorderProps,
	CellBordersProps,
	CellMarginsProps,
	ColorProps,
	Column,
	ColumnsProps,
	ConditionalFlags,
	DocGrid,
	EastAsianLayoutProps,
	FontsProps,
	FrameProps,
	HeaderFooterRef,
	HeaderFooterType,
	IndentProps,
	LanguageProps,
	LineNumbering,
	NotePositionProps,
	NumberingRef,
	PageBorders,
	PageMargins,
	PageNumbering,
	PageSize,
	ParagraphBordersProps,
	ParagraphProps,
	PropertyChange,
	RevisionKind,
	RevisionMark,
	RowHeight,
	RunProps,
	SectionProps,
	ShadingProps,
	SpacingProps,
	TabStop,
	TableBordersProps,
	TableCellProps,
	TableLook,
	TablePositionProps,
	TableProps,
	TableRowProps,
	ThemeColorName,
	ThemeFontRef,
	UnderlineProps,
	WidthProps,
	WidthType
} from "./types"

// Parsers for the property containers. Unknown children (w14:*, future elements) are skipped: the XML
// keeps them, and these objects only describe what rendering needs.

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const TWIPS = 20
const HALF_POINTS = 2
const EIGHTHS = 8

const THEME_COLORS = new Set<string>([
	"dark1",
	"light1",
	"dark2",
	"light2",
	"accent1",
	"accent2",
	"accent3",
	"accent4",
	"accent5",
	"accent6",
	"hyperlink",
	"followedHyperlink",
	"background1",
	"text1",
	"background2",
	"text2",
	"none"
])

const THEME_FONTS = new Set<string>([
	"majorAscii",
	"majorHAnsi",
	"majorEastAsia",
	"majorBidi",
	"minorAscii",
	"minorHAnsi",
	"minorEastAsia",
	"minorBidi"
])

function themeColorName(value: string | undefined): ThemeColorName | undefined {
	return value !== undefined && THEME_COLORS.has(value) ? (value as ThemeColorName) : undefined
}

function themeFont(value: string | undefined): ThemeFontRef | undefined {
	return value !== undefined && THEME_FONTS.has(value) ? (value as ThemeFontRef) : undefined
}

function isEmpty(value: object): boolean {
	for (const _ in value) return false

	return true
}

// Colour attributes under arbitrary names (w:color/w:themeColor, w:fill/w:themeFill...).
function colorAttributes(r: PropsReader, node: number, val: string, theme: string, tint: string, shade: string): ColorProps | undefined {
	const out: Mutable<ColorProps> = {}
	const value = r.hexColor(node, val)
	const themeColor = themeColorName(r.string(node, theme))
	const themeTint = r.hexByte(node, tint)
	const themeShade = r.hexByte(node, shade)

	if (value !== undefined) out.val = value
	if (themeColor !== undefined) out.themeColor = themeColor
	if (themeTint !== undefined) out.themeTint = themeTint
	if (themeShade !== undefined) out.themeShade = themeShade

	return isEmpty(out) ? undefined : out
}

export function parseColor(r: PropsReader, node: number): ColorProps | undefined {
	return colorAttributes(r, node, "val", "themeColor", "themeTint", "themeShade")
}

export function parseBorder(r: PropsReader, node: number): BorderProps {
	const out: Mutable<BorderProps> = { style: r.string(node, "val") ?? "none" }
	const color = parseColorOf(r, node)
	const size = r.measure(node, "sz", EIGHTHS)
	// A fraction is kept: an ODT translation carries its padding to the twip (whole points are all ST_PointMeasure holds).
	const fraction = r.number(node, "space")
	const space = fraction !== undefined && !Number.isInteger(fraction) ? fraction : r.measure(node, "space", 1)
	const shadow = r.optionalOnOff(node, "shadow")
	const frame = r.optionalOnOff(node, "frame")

	if (color !== undefined) Object.assign(out, color)
	if (size !== undefined) out.size = size
	if (space !== undefined) out.space = space
	if (shadow !== undefined) out.shadow = shadow
	if (frame !== undefined) out.frame = frame

	return out
}

function parseColorOf(r: PropsReader, node: number): ColorProps | undefined {
	return colorAttributes(r, node, "color", "themeColor", "themeTint", "themeShade")
}

export function parseShading(r: PropsReader, node: number): ShadingProps {
	const out: Mutable<ShadingProps> = { pattern: r.string(node, "val") ?? "clear" }
	const color = parseColorOf(r, node)
	const fill = colorAttributes(r, node, "fill", "themeFill", "themeFillTint", "themeFillShade")

	if (color !== undefined) out.color = color
	if (fill !== undefined) out.fill = fill

	return out
}

function percentOrFiftieths(r: PropsReader, node: number, local: string): number | undefined {
	const plain = r.number(node, local)

	if (plain !== undefined) return Math.round(plain)

	const text = r.string(node, local)
	const match = text === undefined ? null : /^\s*(-?[0-9]*\.?[0-9]+)\s*%\s*$/.exec(text)

	return match === null ? undefined : Math.round(Number.parseFloat(match[1] ?? "0") * 50)
}

// CT_TblWidth: w:w with w:type; Strict writes percentages as "50%" and lengths with units.
export function parseWidth(r: PropsReader, node: number): WidthProps {
	const typeText = r.string(node, "type")
	const raw = r.string(node, "w")
	let type: WidthType = typeText === "nil" || typeText === "pct" || typeText === "auto" ? typeText : "dxa"

	if (raw !== undefined && raw.trim().endsWith("%")) type = "pct"

	let value = 0

	if (type === "pct") {
		value = percentOrFiftieths(r, node, "w") ?? 0
	} else if (type === "dxa") {
		value = r.measure(node, "w", TWIPS) ?? 0
	} else {
		value = r.integer(node, "w") ?? 0
	}

	return { value, type }
}

function parseRevision(r: PropsReader, node: number, kind: RevisionKind): RevisionMark {
	const out: Mutable<RevisionMark> = { kind }
	const id = r.integer(node, "id")
	const author = r.string(node, "author")
	const date = r.string(node, "date")

	if (id !== undefined) out.id = id
	if (author !== undefined) out.author = author
	if (date !== undefined) out.date = date

	return out
}

function parseChange<T>(
	r: PropsReader,
	node: number,
	inner: string,
	parse: (r: PropsReader, node: number) => T,
	empty: T
): PropertyChange<T> {
	const previousNode = r.child(node, inner)
	const out: Mutable<PropertyChange<T>> = { previous: previousNode >= 0 ? parse(r, previousNode) : empty }
	const id = r.integer(node, "id")
	const author = r.string(node, "author")
	const date = r.string(node, "date")

	if (id !== undefined) out.id = id
	if (author !== undefined) out.author = author
	if (date !== undefined) out.date = date

	return out
}

function parseFonts(r: PropsReader, node: number): FontsProps {
	const out: Mutable<FontsProps> = {}
	const ascii = r.string(node, "ascii")
	const hAnsi = r.string(node, "hAnsi")
	const eastAsia = r.string(node, "eastAsia")
	const cs = r.string(node, "cs")
	const asciiTheme = themeFont(r.string(node, "asciiTheme"))
	const hAnsiTheme = themeFont(r.string(node, "hAnsiTheme"))
	const eastAsiaTheme = themeFont(r.string(node, "eastAsiaTheme"))
	const csTheme = themeFont(r.string(node, "cstheme"))
	const hint = r.string(node, "hint")

	if (ascii !== undefined) out.ascii = ascii
	if (hAnsi !== undefined) out.hAnsi = hAnsi
	if (eastAsia !== undefined) out.eastAsia = eastAsia
	if (cs !== undefined) out.cs = cs
	if (asciiTheme !== undefined) out.asciiTheme = asciiTheme
	if (hAnsiTheme !== undefined) out.hAnsiTheme = hAnsiTheme
	if (eastAsiaTheme !== undefined) out.eastAsiaTheme = eastAsiaTheme
	if (csTheme !== undefined) out.csTheme = csTheme
	if (hint === "default" || hint === "eastAsia" || hint === "cs") out.hint = hint

	return out
}

function parseUnderline(r: PropsReader, node: number): UnderlineProps {
	const out: Mutable<UnderlineProps> = { style: r.string(node, "val") ?? "single" }
	const color = parseColorOf(r, node)

	if (color !== undefined) Object.assign(out, color)

	return out
}

function parseLanguage(r: PropsReader, node: number): LanguageProps {
	const out: Mutable<LanguageProps> = {}
	const latin = r.string(node, "val")
	const eastAsia = r.string(node, "eastAsia")
	const bidi = r.string(node, "bidi")

	if (latin !== undefined) out.latin = latin
	if (eastAsia !== undefined) out.eastAsia = eastAsia
	if (bidi !== undefined) out.bidi = bidi

	return out
}

function parseEastAsianLayout(r: PropsReader, node: number): EastAsianLayoutProps {
	const out: Mutable<EastAsianLayoutProps> = {}
	const id = r.integer(node, "id")
	const combine = r.optionalOnOff(node, "combine")
	const combineBrackets = r.string(node, "combineBrackets")
	const vertical = r.optionalOnOff(node, "vert")
	const verticalCompress = r.optionalOnOff(node, "vertCompress")

	if (id !== undefined) out.id = id
	if (combine !== undefined) out.combine = combine
	if (combineBrackets !== undefined) out.combineBrackets = combineBrackets
	if (vertical !== undefined) out.vertical = vertical
	if (verticalCompress !== undefined) out.verticalCompress = verticalCompress

	return out
}

export const EMPTY_RUN: RunProps = Object.freeze({})
export const EMPTY_PARAGRAPH: ParagraphProps = Object.freeze({})
export const EMPTY_TABLE: TableProps = Object.freeze({})
export const EMPTY_ROW: TableRowProps = Object.freeze({})
export const EMPTY_CELL: TableCellProps = Object.freeze({})
export const EMPTY_SECTION: SectionProps = Object.freeze({})

// w:rPr (§17.3.2.28), also w:rPr inside w:pPr, styles, numbering levels and w:rPrChange.
export function parseRunProps(r: PropsReader, node: number): RunProps {
	const document = r.document
	const out: Mutable<RunProps> = {}
	let revisions: RevisionMark[] | undefined

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		switch (r.local(c)) {
			case "rStyle": {
				const value = r.string(c, "val")

				if (value !== undefined) out.styleId = value

				break
			}
			case "rFonts":
				out.fonts = parseFonts(r, c)
				break
			case "b":
				out.bold = r.toggle(c)
				break
			case "bCs":
				out.boldCs = r.toggle(c)
				break
			case "i":
				out.italic = r.toggle(c)
				break
			case "iCs":
				out.italicCs = r.toggle(c)
				break
			case "caps":
				out.caps = r.toggle(c)
				break
			case "smallCaps":
				out.smallCaps = r.toggle(c)
				break
			case "strike":
				out.strike = r.toggle(c)
				break
			case "dstrike":
				out.doubleStrike = r.toggle(c)
				break
			case "outline":
				out.outline = r.toggle(c)
				break
			case "shadow":
				out.shadow = r.toggle(c)
				break
			case "emboss":
				out.emboss = r.toggle(c)
				break
			case "imprint":
				out.imprint = r.toggle(c)
				break
			case "noProof":
				out.noProof = r.toggle(c)
				break
			case "snapToGrid":
				out.snapToGrid = r.toggle(c)
				break
			case "vanish":
				out.vanish = r.toggle(c)
				break
			case "webHidden":
				out.webHidden = r.toggle(c)
				break
			case "specVanish":
				out.specVanish = r.toggle(c)
				break
			case "rtl":
				out.rtl = r.toggle(c)
				break
			case "cs":
				out.cs = r.toggle(c)
				break
			case "oMath":
				out.oMath = r.toggle(c)
				break
			case "color": {
				const color = parseColor(r, c)

				if (color !== undefined) out.color = color

				break
			}
			case "spacing": {
				const value = r.measure(c, "val", TWIPS)

				if (value !== undefined) out.spacing = value

				break
			}
			case "w": {
				const value = percentOrFiftieths(r, c, "val")
				const text = value === undefined ? undefined : r.string(c, "val")

				// Strict writes "150%"; percentOrFiftieths returned fiftieths for that form.
				if (value !== undefined) out.scale = text !== undefined && text.includes("%") ? Math.round(value / 50) : value

				break
			}
			case "kern": {
				const value = r.measure(c, "val", HALF_POINTS)

				if (value !== undefined) out.kern = value

				break
			}
			case "position": {
				const value = r.measure(c, "val", HALF_POINTS)

				if (value !== undefined) out.position = value

				break
			}
			case "sz": {
				const value = r.measure(c, "val", HALF_POINTS)

				if (value !== undefined && value > 0) out.size = value

				break
			}
			case "szCs": {
				const value = r.measure(c, "val", HALF_POINTS)

				if (value !== undefined && value > 0) out.sizeCs = value

				break
			}
			case "highlight": {
				const value = r.string(c, "val")

				if (value !== undefined) out.highlight = value

				break
			}
			case "u":
				out.underline = parseUnderline(r, c)
				break
			case "effect": {
				const value = r.string(c, "val")

				if (value !== undefined) out.effect = value

				break
			}
			case "bdr":
				out.border = parseBorder(r, c)
				break
			case "shd":
				out.shading = parseShading(r, c)
				break
			case "fitText": {
				const width = r.measure(c, "val", TWIPS)
				const id = r.integer(c, "id")

				if (width !== undefined) out.fitText = id === undefined ? { width } : { width, id }

				break
			}
			case "vertAlign": {
				const value = r.string(c, "val")

				if (value === "baseline" || value === "superscript" || value === "subscript") out.vertAlign = value

				break
			}
			case "em": {
				const value = r.string(c, "val")

				if (value !== undefined) out.emphasis = value

				break
			}
			case "lang":
				out.lang = parseLanguage(r, c)
				break
			case "eastAsianLayout":
				out.eastAsianLayout = parseEastAsianLayout(r, c)
				break
			case "ins":
			case "del":
			case "moveFrom":
			case "moveTo":
				revisions ??= []
				revisions.push(parseRevision(r, c, r.local(c) as RevisionKind))
				break
			case "rPrChange":
				out.change = parseChange(r, c, "rPr", parseRunProps, EMPTY_RUN)
				break
		}
	}

	if (revisions !== undefined) out.revisions = revisions

	return out
}

function parseFrame(r: PropsReader, node: number): FrameProps {
	const out: Mutable<FrameProps> = {}
	const dropCap = r.string(node, "dropCap")
	const hRule = r.string(node, "hRule")
	const numbers: readonly (readonly [keyof FrameProps, string, number])[] = [
		["lines", "lines", 0],
		["width", "w", TWIPS],
		["height", "h", TWIPS],
		["vSpace", "vSpace", TWIPS],
		["hSpace", "hSpace", TWIPS],
		["x", "x", TWIPS],
		["y", "y", TWIPS]
	]

	for (const [key, local, perPoint] of numbers) {
		const value = perPoint === 0 ? r.integer(node, local) : r.measure(node, local, perPoint)

		if (value !== undefined) (out as Record<string, unknown>)[key] = value
	}

	for (const local of ["wrap", "hAnchor", "vAnchor", "xAlign", "yAlign"] as const) {
		const value = r.string(node, local)

		if (value !== undefined) out[local] = value
	}

	if (dropCap === "none" || dropCap === "drop" || dropCap === "margin") out.dropCap = dropCap
	if (hRule === "auto" || hRule === "exact" || hRule === "atLeast") out.hRule = hRule

	const anchorLock = r.optionalOnOff(node, "anchorLock")

	if (anchorLock !== undefined) out.anchorLock = anchorLock

	return out
}

function parseNumberingRef(r: PropsReader, node: number): NumberingRef {
	const out: Mutable<NumberingRef> = {}
	const ilvlNode = r.child(node, "ilvl")
	const numIdNode = r.child(node, "numId")
	const ilvl = ilvlNode < 0 ? undefined : r.integer(ilvlNode, "val")
	const numId = numIdNode < 0 ? undefined : r.integer(numIdNode, "val")

	if (ilvl !== undefined) out.ilvl = ilvl
	if (numId !== undefined) out.numId = numId

	return out
}

// Children named left/start and right/end land on the logical sides.
function sideOf(local: string): string {
	if (local === "left") return "start"
	if (local === "right") return "end"

	return local
}

function parseBorders<T extends object>(r: PropsReader, node: number, sides: ReadonlySet<string>): T {
	const document = r.document
	const out: Record<string, BorderProps> = {}

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		const side = sideOf(r.local(c))

		if (sides.has(side)) out[side] = parseBorder(r, c)
	}

	return out as T
}

const PARAGRAPH_SIDES = new Set(["top", "start", "bottom", "end", "between", "bar"])
const TABLE_SIDES = new Set(["top", "start", "bottom", "end", "insideH", "insideV"])
const CELL_SIDES = new Set(["top", "start", "bottom", "end", "insideH", "insideV", "tl2br", "tr2bl"])
const MARGIN_SIDES = new Set(["top", "start", "bottom", "end"])

function parseCellMargins(r: PropsReader, node: number): CellMarginsProps {
	const document = r.document
	const out: Record<string, WidthProps> = {}

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		const side = sideOf(r.local(c))

		if (MARGIN_SIDES.has(side)) out[side] = parseWidth(r, c)
	}

	return out
}

function parseTabs(r: PropsReader, node: number): TabStop[] {
	const document = r.document
	const out: TabStop[] = []

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		if (r.local(c) !== "tab") continue

		const position = r.measure(c, "pos", TWIPS)

		if (position === undefined) continue

		const leader = r.string(c, "leader")
		const alignment = r.string(c, "val") ?? "start"

		out.push(leader === undefined ? { alignment, position } : { alignment, position, leader })
	}

	return out
}

function parseSpacing(r: PropsReader, node: number): SpacingProps {
	const out: Mutable<SpacingProps> = {}
	const before = r.measure(node, "before", TWIPS)
	const beforeLines = r.integer(node, "beforeLines")
	const beforeAutospacing = r.optionalOnOff(node, "beforeAutospacing")
	const after = r.measure(node, "after", TWIPS)
	const afterLines = r.integer(node, "afterLines")
	const afterAutospacing = r.optionalOnOff(node, "afterAutospacing")
	const line = r.measure(node, "line", TWIPS)
	const lineRule = r.string(node, "lineRule")

	if (before !== undefined) out.before = before
	if (beforeLines !== undefined) out.beforeLines = beforeLines
	if (beforeAutospacing !== undefined) out.beforeAutospacing = beforeAutospacing
	if (after !== undefined) out.after = after
	if (afterLines !== undefined) out.afterLines = afterLines
	if (afterAutospacing !== undefined) out.afterAutospacing = afterAutospacing
	if (line !== undefined) out.line = line
	if (lineRule === "auto" || lineRule === "exact" || lineRule === "atLeast") out.lineRule = lineRule

	return out
}

function parseIndent(r: PropsReader, node: number): IndentProps {
	const out: Mutable<IndentProps> = {}
	const start = r.measure(node, "start", TWIPS) ?? r.measure(node, "left", TWIPS)
	const startChars = r.integer(node, "startChars") ?? r.integer(node, "leftChars")
	const end = r.measure(node, "end", TWIPS) ?? r.measure(node, "right", TWIPS)
	const endChars = r.integer(node, "endChars") ?? r.integer(node, "rightChars")
	const hanging = r.measure(node, "hanging", TWIPS)
	const hangingChars = r.integer(node, "hangingChars")
	const firstLine = r.measure(node, "firstLine", TWIPS)
	const firstLineChars = r.integer(node, "firstLineChars")

	if (start !== undefined) out.start = start
	if (startChars !== undefined) out.startChars = startChars
	if (end !== undefined) out.end = end
	if (endChars !== undefined) out.endChars = endChars
	if (hanging !== undefined) out.hanging = hanging
	if (hangingChars !== undefined) out.hangingChars = hangingChars
	// Mutually exclusive: when both are given, firstLine is ignored (ECMA-376 17.3.1.12).
	if (firstLine !== undefined && hanging === undefined) out.firstLine = firstLine
	if (firstLineChars !== undefined && hangingChars === undefined) out.firstLineChars = firstLineChars

	return out
}

const CONDITIONAL_KEYS: readonly (keyof ConditionalFlags)[] = [
	"firstRow",
	"lastRow",
	"firstColumn",
	"lastColumn",
	"oddVBand",
	"evenVBand",
	"oddHBand",
	"evenHBand",
	"firstRowFirstColumn",
	"firstRowLastColumn",
	"lastRowFirstColumn",
	"lastRowLastColumn"
]

// w:cnfStyle: one attribute per flag, or a 12-digit bit string in w:val (in CONDITIONAL_KEYS order).
function parseConditional(r: PropsReader, node: number): ConditionalFlags {
	const out: Mutable<ConditionalFlags> = {}
	const bits = r.string(node, "val")

	for (let k = 0; k < CONDITIONAL_KEYS.length; k++) {
		const key = CONDITIONAL_KEYS[k]

		if (key === undefined) continue

		// A flag's own attribute wins over its bit in w:val (MS-OI29500, Part 1 §17.3.1.8).
		const flag = r.optionalOnOff(node, key) ?? (bits !== undefined && bits.charCodeAt(k) === 49)

		if (flag) out[key] = true
	}

	return out
}

// w:pPr (§17.3.1.26), also inside styles, numbering levels and w:pPrChange.
export function parseParagraphProps(r: PropsReader, node: number): ParagraphProps {
	const document = r.document
	const out: Mutable<ParagraphProps> = {}

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		const local = r.local(c)

		switch (local) {
			case "pStyle": {
				const value = r.string(c, "val")

				if (value !== undefined) out.styleId = value

				break
			}
			case "keepNext":
			case "keepLines":
			case "pageBreakBefore":
			case "widowControl":
			case "suppressLineNumbers":
			case "suppressAutoHyphens":
			case "kinsoku":
			case "wordWrap":
			case "overflowPunct":
			case "topLinePunct":
			case "autoSpaceDE":
			case "autoSpaceDN":
			case "bidi":
			case "adjustRightInd":
			case "snapToGrid":
			case "contextualSpacing":
			case "mirrorIndents":
			case "suppressOverlap":
				out[local] = r.toggle(c)
				break
			case "framePr":
				out.frame = parseFrame(r, c)
				break
			case "numPr":
				out.numbering = parseNumberingRef(r, c)
				break
			case "pBdr":
				out.borders = parseBorders<ParagraphBordersProps>(r, c, PARAGRAPH_SIDES)
				break
			case "shd":
				out.shading = parseShading(r, c)
				break
			case "tabs":
				out.tabs = parseTabs(r, c)
				break
			case "spacing":
				out.spacing = parseSpacing(r, c)
				break
			case "ind":
				out.indent = parseIndent(r, c)
				break
			case "jc": {
				const value = r.string(c, "val")

				if (value !== undefined) out.alignment = value

				break
			}
			case "textDirection":
			case "textAlignment":
			case "textboxTightWrap": {
				const value = r.string(c, "val")

				if (value !== undefined) out[local] = value

				break
			}
			case "outlineLvl": {
				const value = r.integer(c, "val")

				if (value !== undefined && value >= 0 && value <= 9) out.outlineLevel = value

				break
			}
			case "divId": {
				const value = r.integer(c, "val")

				if (value !== undefined) out.divId = value

				break
			}
			case "cnfStyle":
				out.conditional = parseConditional(r, c)
				break
			case "rPr":
				out.markRun = parseRunProps(r, c)
				break
			case "sectPr":
				out.hasSection = true
				break
			case "pPrChange":
				out.change = parseChange(r, c, "pPr", parseParagraphProps, EMPTY_PARAGRAPH)
				break
		}
	}

	return out
}

function parseTablePosition(r: PropsReader, node: number): TablePositionProps {
	const out: Mutable<TablePositionProps> = {}

	for (const local of ["leftFromText", "rightFromText", "topFromText", "bottomFromText", "x", "y"] as const) {
		const value = r.measure(node, local === "x" ? "tblpX" : local === "y" ? "tblpY" : local, TWIPS)

		if (value !== undefined) out[local] = value
	}

	const vertAnchor = r.string(node, "vertAnchor")
	const horzAnchor = r.string(node, "horzAnchor")
	const xSpec = r.string(node, "tblpXSpec")
	const ySpec = r.string(node, "tblpYSpec")

	if (vertAnchor === "text" || vertAnchor === "margin" || vertAnchor === "page") out.vertAnchor = vertAnchor
	if (horzAnchor === "text" || horzAnchor === "margin" || horzAnchor === "page") out.horzAnchor = horzAnchor
	if (xSpec !== undefined) out.xSpec = xSpec
	if (ySpec !== undefined) out.ySpec = ySpec

	return out
}

const LOOK_BITS: readonly (readonly [keyof TableLook, number])[] = [
	["firstRow", 0x0020],
	["lastRow", 0x0040],
	["firstColumn", 0x0080],
	["lastColumn", 0x0100],
	["noHBand", 0x0200],
	["noVBand", 0x0400]
]

// w:tblLook (§17.4.56): one attribute per flag, or the legacy hex mask in w:val, which Word reads only when
// no attribute is present (MS-OI29500 §2.1.160). A missing attribute takes the §17.4.55 default: edge
// regions off, banding on. A table without w:tblLook gets Word's 0x04A0 in the resolver.
function parseLook(r: PropsReader, node: number): TableLook {
	const attributes = LOOK_BITS.map(([key]) => r.optionalOnOff(node, key))
	const text = r.string(node, "val")
	const mask = text !== undefined && /^[0-9a-fA-F]{1,4}$/.test(text) ? Number.parseInt(text, 16) : 0
	const explicit = attributes.some(value => value !== undefined)
	const out: Mutable<TableLook> = {
		firstRow: false,
		lastRow: false,
		firstColumn: false,
		lastColumn: false,
		noHBand: false,
		noVBand: false
	}

	LOOK_BITS.forEach(([key, bit], k) => {
		out[key] = explicit ? (attributes[k] ?? false) : (mask & bit) !== 0
	})

	return out
}

// w:tblPr (§17.4.60), w:tblPrEx (§17.4.61) and the w:tblPr of table style conditions.
export function parseTableProps(r: PropsReader, node: number): TableProps {
	const document = r.document
	const out: Mutable<TableProps> = {}

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		switch (r.local(c)) {
			case "tblStyle": {
				const value = r.string(c, "val")

				if (value !== undefined) out.styleId = value

				break
			}
			case "tblpPr":
				out.position = parseTablePosition(r, c)
				break
			case "tblOverlap": {
				const value = r.string(c, "val")

				if (value === "never" || value === "overlap") out.overlap = value

				break
			}
			case "bidiVisual":
				out.bidiVisual = r.toggle(c)
				break
			case "tblStyleRowBandSize": {
				const value = r.integer(c, "val")

				if (value !== undefined && value > 0) out.rowBandSize = value

				break
			}
			case "tblStyleColBandSize": {
				const value = r.integer(c, "val")

				if (value !== undefined && value > 0) out.colBandSize = value

				break
			}
			case "tblW":
				out.width = parseWidth(r, c)
				break
			case "jc": {
				const value = r.string(c, "val")

				if (value !== undefined) out.alignment = value

				break
			}
			case "tblCellSpacing":
				out.cellSpacing = parseWidth(r, c)
				break
			case "tblInd":
				out.indent = parseWidth(r, c)
				break
			case "tblBorders":
				out.borders = parseBorders<TableBordersProps>(r, c, TABLE_SIDES)
				break
			case "shd":
				out.shading = parseShading(r, c)
				break
			case "tblLayout": {
				const value = r.string(c, "type")

				out.layout = value === "fixed" ? "fixed" : "autofit"

				break
			}
			case "tblCellMar":
				out.cellMargins = parseCellMargins(r, c)
				break
			case "tblLook":
				out.look = parseLook(r, c)
				break
			case "tblCaption": {
				const value = r.string(c, "val")

				if (value !== undefined) out.caption = value

				break
			}
			case "tblDescription": {
				const value = r.string(c, "val")

				if (value !== undefined) out.description = value

				break
			}
			case "tblPrChange":
				out.change = parseChange(r, c, "tblPr", parseTableProps, EMPTY_TABLE)
				break
			case "tblPrExChange":
				out.change = parseChange(r, c, "tblPrEx", parseTableProps, EMPTY_TABLE)
				break
		}
	}

	return out
}

// w:trPr (§17.4.82).
export function parseTableRowProps(r: PropsReader, node: number): TableRowProps {
	const document = r.document
	const out: Mutable<TableRowProps> = {}
	let revisions: RevisionMark[] | undefined

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		const local = r.local(c)

		switch (local) {
			case "cnfStyle":
				out.conditional = parseConditional(r, c)
				break
			case "divId": {
				const value = r.integer(c, "val")

				if (value !== undefined) out.divId = value

				break
			}
			case "gridBefore":
			case "gridAfter": {
				const value = r.integer(c, "val")

				if (value !== undefined && value >= 0) out[local] = value

				break
			}
			case "wBefore":
				out.widthBefore = parseWidth(r, c)
				break
			case "wAfter":
				out.widthAfter = parseWidth(r, c)
				break
			case "cantSplit":
				out.cantSplit = r.toggle(c)
				break
			case "trHeight": {
				const value = r.measure(c, "val", TWIPS) ?? 0
				const rule = r.string(c, "hRule")
				const height: RowHeight = { value, rule: rule === "exact" || rule === "auto" ? rule : "atLeast" }

				out.height = height

				break
			}
			case "tblHeader":
				out.header = r.toggle(c)
				break
			case "tblCellSpacing":
				out.cellSpacing = parseWidth(r, c)
				break
			case "jc": {
				const value = r.string(c, "val")

				if (value !== undefined) out.alignment = value

				break
			}
			case "hidden":
				out.hidden = r.toggle(c)
				break
			case "ins":
			case "del":
				revisions ??= []
				revisions.push(parseRevision(r, c, local))
				break
			case "trPrChange":
				out.change = parseChange(r, c, "trPr", parseTableRowProps, EMPTY_ROW)
				break
		}
	}

	if (revisions !== undefined) out.revisions = revisions

	return out
}

// w:tcPr (§17.4.70).
export function parseTableCellProps(r: PropsReader, node: number): TableCellProps {
	const document = r.document
	const out: Mutable<TableCellProps> = {}
	let revisions: RevisionMark[] | undefined

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		const local = r.local(c)

		switch (local) {
			case "cnfStyle":
				out.conditional = parseConditional(r, c)
				break
			case "tcW":
				out.width = parseWidth(r, c)
				break
			case "gridSpan": {
				const value = r.integer(c, "val")

				if (value !== undefined && value > 0) out.gridSpan = value

				break
			}
			case "hMerge":
			case "vMerge":
				// An absent w:val means "continue" (§17.4.85).
				out[local] = r.string(c, "val") === "restart" ? "restart" : "continue"
				break
			case "tcBorders":
				out.borders = parseBorders<CellBordersProps>(r, c, CELL_SIDES)
				break
			case "shd":
				out.shading = parseShading(r, c)
				break
			case "noWrap":
				out.noWrap = r.toggle(c)
				break
			case "tcMar":
				out.margins = parseCellMargins(r, c)
				break
			case "textDirection": {
				const value = r.string(c, "val")

				if (value !== undefined) out.textDirection = value

				break
			}
			case "tcFitText":
				out.fitText = r.toggle(c)
				break
			case "vAlign": {
				const value = r.string(c, "val")

				if (value === "top" || value === "center" || value === "bottom" || value === "both") out.vAlign = value

				break
			}
			case "hideMark":
				out.hideMark = r.toggle(c)
				break
			case "cellIns":
			case "cellDel":
			case "cellMerge":
				revisions ??= []
				revisions.push(parseRevision(r, c, local === "cellIns" ? "ins" : local === "cellDel" ? "del" : "merge"))
				break
			case "tcPrChange":
				out.change = parseChange(r, c, "tcPr", parseTableCellProps, EMPTY_CELL)
				break
		}
	}

	if (revisions !== undefined) out.revisions = revisions

	return out
}

function parseHeaderFooterRef(r: PropsReader, node: number): HeaderFooterRef | undefined {
	const relationshipId = r.relationshipId(node)
	const typeText = r.string(node, "type")
	const type: HeaderFooterType = typeText === "first" || typeText === "even" ? typeText : "default"

	return relationshipId === undefined ? undefined : { type, relationshipId }
}

function parseNotePosition(r: PropsReader, node: number): NotePositionProps {
	const document = r.document
	const out: Mutable<NotePositionProps> = {}

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		switch (r.local(c)) {
			case "pos": {
				const value = r.string(c, "val")

				if (value !== undefined) out.position = value

				break
			}
			case "numFmt": {
				const value = r.string(c, "val")

				if (value !== undefined) out.numFormat = value

				break
			}
			case "numStart": {
				const value = r.integer(c, "val")

				if (value !== undefined) out.numStart = value

				break
			}
			case "numRestart": {
				const value = r.string(c, "val")

				if (value !== undefined) out.numRestart = value

				break
			}
		}
	}

	return out
}

function parsePageSize(r: PropsReader, node: number): PageSize {
	const out: Mutable<PageSize> = {}
	const width = r.measure(node, "w", TWIPS)
	const height = r.measure(node, "h", TWIPS)
	const orient = r.string(node, "orient")
	const code = r.integer(node, "code")

	if (width !== undefined) out.width = width
	if (height !== undefined) out.height = height
	if (orient === "portrait" || orient === "landscape") out.orient = orient
	if (code !== undefined) out.code = code

	return out
}

function parsePageMargins(r: PropsReader, node: number): PageMargins {
	const out: Mutable<PageMargins> = {}

	for (const local of ["top", "right", "bottom", "left", "header", "footer", "gutter"] as const) {
		const value = r.measure(node, local, TWIPS)

		if (value !== undefined) out[local] = value
	}

	return out
}

function parsePageBorders(r: PropsReader, node: number): PageBorders {
	const document = r.document
	const out: Mutable<PageBorders> = {}
	const zOrder = r.string(node, "zOrder")
	const display = r.string(node, "display")
	const offsetFrom = r.string(node, "offsetFrom")

	if (zOrder === "front" || zOrder === "back") out.zOrder = zOrder
	if (display === "allPages" || display === "firstPage" || display === "notFirstPage") out.display = display
	if (offsetFrom === "page" || offsetFrom === "text") out.offsetFrom = offsetFrom

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		const local = r.local(c)

		if (local === "top" || local === "left" || local === "bottom" || local === "right") out[local] = parseBorder(r, c)
	}

	return out
}

function parseLineNumbering(r: PropsReader, node: number): LineNumbering {
	const out: Mutable<LineNumbering> = {}
	const countBy = r.integer(node, "countBy")
	const start = r.integer(node, "start")
	const distance = r.measure(node, "distance", TWIPS)
	const restart = r.string(node, "restart")

	if (countBy !== undefined) out.countBy = countBy
	if (start !== undefined) out.start = start
	if (distance !== undefined) out.distance = distance
	if (restart === "newPage" || restart === "newSection" || restart === "continuous") out.restart = restart

	return out
}

function parsePageNumbering(r: PropsReader, node: number): PageNumbering {
	const out: Mutable<PageNumbering> = {}
	const format = r.string(node, "fmt")
	const start = r.integer(node, "start")
	const chapterStyle = r.integer(node, "chapStyle")
	const chapterSeparator = r.string(node, "chapSep")

	if (format !== undefined) out.format = format
	if (start !== undefined) out.start = start
	if (chapterStyle !== undefined) out.chapterStyle = chapterStyle
	if (chapterSeparator !== undefined) out.chapterSeparator = chapterSeparator

	return out
}

function parseColumns(r: PropsReader, node: number): ColumnsProps {
	const document = r.document
	const out: Mutable<ColumnsProps> = {}
	const count = r.integer(node, "num")
	const space = r.measure(node, "space", TWIPS)
	const equalWidth = r.optionalOnOff(node, "equalWidth")
	const separator = r.optionalOnOff(node, "sep")
	const columns: Column[] = []

	if (count !== undefined && count > 0) out.count = count
	if (space !== undefined) out.space = space
	if (equalWidth !== undefined) out.equalWidth = equalWidth
	if (separator !== undefined) out.separator = separator

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		if (r.local(c) !== "col") continue

		const column: Mutable<Column> = {}
		const width = r.measure(c, "w", TWIPS)
		const columnSpace = r.measure(c, "space", TWIPS)

		if (width !== undefined) column.width = width
		if (columnSpace !== undefined) column.space = columnSpace

		columns.push(column)
	}

	if (columns.length > 0) out.columns = columns

	return out
}

function parseDocGrid(r: PropsReader, node: number): DocGrid {
	const out: Mutable<DocGrid> = {}
	const type = r.string(node, "type")
	const linePitch = r.measure(node, "linePitch", TWIPS)
	const charSpace = r.integer(node, "charSpace")

	if (type !== undefined) out.type = type
	if (linePitch !== undefined) out.linePitch = linePitch
	if (charSpace !== undefined) out.charSpace = charSpace

	return out
}

// w:sectPr (§17.6.17).
export function parseSectionProps(r: PropsReader, node: number): SectionProps {
	const document = r.document
	const out: Mutable<SectionProps> = {}
	const headers: HeaderFooterRef[] = []
	const footers: HeaderFooterRef[] = []

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		const local = r.local(c)

		switch (local) {
			case "headerReference":
			case "footerReference": {
				const ref = parseHeaderFooterRef(r, c)

				if (ref !== undefined) (local === "headerReference" ? headers : footers).push(ref)

				break
			}
			case "footnotePr":
				out.footnotes = parseNotePosition(r, c)
				break
			case "endnotePr":
				out.endnotes = parseNotePosition(r, c)
				break
			case "type": {
				const value = r.string(c, "val")

				if (value !== undefined) out.type = value

				break
			}
			case "pgSz":
				out.pageSize = parsePageSize(r, c)
				break
			case "pgMar":
				out.pageMargins = parsePageMargins(r, c)
				break
			case "pgBorders":
				out.pageBorders = parsePageBorders(r, c)
				break
			case "lnNumType":
				out.lineNumbering = parseLineNumbering(r, c)
				break
			case "pgNumType":
				out.pageNumbering = parsePageNumbering(r, c)
				break
			case "cols":
				out.columns = parseColumns(r, c)
				break
			case "formProt":
				out.formProtection = r.toggle(c)
				break
			case "vAlign": {
				const value = r.string(c, "val")

				if (value === "top" || value === "center" || value === "both" || value === "bottom") out.vAlign = value

				break
			}
			case "noEndnote":
				out.noEndnote = r.toggle(c)
				break
			case "titlePg":
				out.titlePage = r.toggle(c)
				break
			case "textDirection": {
				const value = r.string(c, "val")

				if (value !== undefined) out.textDirection = value

				break
			}
			case "bidi":
				out.bidi = r.toggle(c)
				break
			case "rtlGutter":
				out.rtlGutter = r.toggle(c)
				break
			case "docGrid":
				out.docGrid = parseDocGrid(r, c)
				break
			case "printerSettings": {
				const id = r.relationshipId(c)

				if (id !== undefined) out.printerSettings = id

				break
			}
			case "sectPrChange":
				out.change = parseChange(r, c, "sectPr", parseSectionProps, EMPTY_SECTION)
				break
		}
	}

	if (headers.length > 0) out.headers = headers
	if (footers.length > 0) out.footers = footers

	return out
}

export const CHANGE_ELEMENTS: ReadonlySet<string> = new Set([
	"rPrChange",
	"pPrChange",
	"tblPrChange",
	"tblPrExChange",
	"trPrChange",
	"tcPrChange",
	"sectPrChange"
])

// The tracked-change element (w:rPrChange...) inside a property container, for the writer; -1 if none.
export function propertyChangeNode(r: PropsReader, node: number): number {
	const document = r.document

	for (let c = document.firstChildElement(node); c >= 0; c = document.nextSiblingElement(c)) {
		if (CHANGE_ELEMENTS.has(r.local(c))) return c
	}

	return -1
}
