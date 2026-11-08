// Cascade order and table-style layering informed by SuperDoc 1.46.3 (packages/layout-engine/style-engine/
// src/ooxml/index.ts), copyright Harbour and the SuperDoc contributors, licensed under the GNU Affero General
// Public License v3.0. Rewritten for @filen/office around interned inputs and outputs.

import type { EffectiveLevel, Numbering } from "../numbering/numbering"
import { EMPTY_PARAGRAPH, EMPTY_RUN, EMPTY_TABLE } from "../props/parse"
import type {
	BorderProps,
	ColorProps,
	FontsProps,
	IndentProps,
	ParagraphProps,
	PhysicalAlignment,
	ResolvedBorder,
	ResolvedFonts,
	ResolvedIndent,
	ResolvedParagraphBorders,
	ResolvedParagraphProps,
	ResolvedRunProps,
	ResolvedSectionProps,
	ResolvedShading,
	ResolvedSpacing,
	ResolvedTabStop,
	ResolvedTableBorders,
	ResolvedTableCellProps,
	ResolvedTableProps,
	ResolvedTableRowProps,
	RunProps,
	SectionProps,
	ShadingProps,
	TableBordersProps,
	TableCellProps,
	TableProps,
	TableRowProps,
	WidthProps
} from "../props/types"
import { HIGHLIGHT_COLORS, applyThemeShade, applyThemeTint } from "../theme/color"
import type { Theme } from "../theme/theme"
import { resolveCellMargins } from "./cellMargins"
import { mergeCell, mergeParagraph, mergeRow, mergeRun, mergeTable, type Mutable } from "./merge"
import { DEFAULT_STYLE_SETTINGS, type StyleSettings } from "./settings"
import { eastAsiaUsesAscii } from "../../fonts/slots"
import { DocxStyles, type StyleDef } from "./styles"
import { CONDITION_ORDER, DEFAULT_TABLE_LOOK, ROW_CONDITIONS, cellConditions, type CellPosition } from "./tableStyle"

// Word's font when nothing in the hierarchy names one.
export const DEFAULT_FONT = "Times New Roman"
// Ten points (§17.3.2.38).
export const DEFAULT_SIZE = 20

export interface ResolverParts {
	readonly styles?: DocxStyles | undefined
	readonly numbering?: Numbering | undefined
	readonly theme?: Theme | undefined
	readonly settings?: StyleSettings | undefined
}

// A paragraph's resolved formatting plus what its runs inherit. One object per distinct (pPr, table cell
// context): runs resolve against it.
export interface ParagraphFormat {
	readonly props: ResolvedParagraphProps
	// The effective paragraph style (missing references fall back to the default paragraph style).
	readonly style: StyleDef | undefined
	// The list level the paragraph uses, for NumberingCounters and the marker's formatting.
	readonly level: EffectiveLevel | undefined
	// What runs inherit before their character style and direct formatting.
	readonly runBase: RunProps
	readonly markRun: RunProps
}

export interface TableFormat {
	readonly props: ResolvedTableProps
	readonly style: StyleDef | undefined
}

export interface CellFormat {
	readonly props: ResolvedTableCellProps
	// The table style conditions applying to the cell (bits over CONDITION_ORDER).
	readonly conditions: number
}

export interface RowPosition {
	readonly rowIndex: number
	readonly rowCount: number
}

interface ParagraphFormatInternal extends ParagraphFormat {
	readonly runs: Map<RunProps, ResolvedRunProps>
	mark: ResolvedRunProps | undefined
	marker: ResolvedRunProps | null | undefined
}

interface TableFormatInternal extends TableFormat {
	readonly styleTable: TableProps
	readonly direct: TableProps
	readonly exceptions: TableProps
	readonly cells: Map<number, Map<TableCellProps, CellFormatInternal>>
	readonly rows: Map<number, Map<TableRowProps, ResolvedTableRowProps>>
}

interface CellFormatInternal extends CellFormat {
	// Paragraph caches are keyed by this: the table style and the condition mask.
	readonly contextKey: number
}

// Formatting a table style contributes to cells matching one condition mask.
interface TableContext {
	readonly paragraph: ParagraphProps
	readonly run: RunProps
	readonly cell: TableCellProps
	readonly row: TableRowProps
}

const NO_CONTEXT = -1
const CONDITION_BITS = 1 << 13

// Hash-consing: equal values share one object.
class Interner<T> {
	private readonly map = new Map<string, T>()

	get size(): number {
		return this.map.size
	}

	intern(value: T): T {
		const key = JSON.stringify(value)
		const existing = this.map.get(key)

		if (existing !== undefined) return existing

		this.map.set(key, value)

		return value
	}

	// For objects carrying an id: the key ignores it, and a new value gets the next id.
	internWithId<V extends object>(value: V, make: (id: number) => T): T {
		const key = JSON.stringify(value)
		const existing = this.map.get(key)

		if (existing !== undefined) return existing

		const created = make(this.map.size)

		this.map.set(key, created)

		return created
	}
}

function physicalParagraphAlignment(alignment: string, bidi: boolean): PhysicalAlignment {
	switch (alignment) {
		case "center":
			return "center"
		// Transitional "left"/"right" mean start/end: a right-to-left paragraph mirrors them.
		case "end":
		case "right":
			return bidi ? "left" : "right"
		case "both":
		case "mediumKashida":
		case "highKashida":
		case "lowKashida":
		case "thaiDistribute":
			return "justify"
		case "distribute":
			return "distribute"
		default:
			return bidi ? "right" : "left"
	}
}

function physicalTableAlignment(alignment: string, bidi: boolean): "left" | "center" | "right" {
	if (alignment === "center") return "center"
	if (alignment === "end" || alignment === "right") return bidi ? "left" : "right"

	return bidi ? "right" : "left"
}

function nearColor(a: string, b: string): boolean {
	const x = Number.parseInt(a, 16)
	const y = Number.parseInt(b, 16)

	for (let shift = 0; shift <= 16; shift += 8) {
		if (Math.abs(((x >> shift) & 255) - ((y >> shift) & 255)) > 3) return false
	}

	return true
}

const ZERO_DXA: WidthProps = { value: 0, type: "dxa" }
const AUTO_WIDTH: WidthProps = { value: 0, type: "auto" }

export class PropertyResolver {
	private stylesValue: DocxStyles
	private numberingValue: Numbering | undefined
	readonly theme: Theme | undefined
	readonly settings: StyleSettings
	private defaultParagraphStyle: StyleDef | undefined
	private defaultCharacterStyle: StyleDef | undefined
	private defaultTableStyle: StyleDef | undefined
	// Per style index: the chain's own properties merged root to leaf.
	private readonly flatParagraph: (ParagraphProps | undefined)[] = []
	private readonly flatRun: (RunProps | undefined)[] = []
	private readonly flatTable: (TableProps | undefined)[] = []
	private readonly contexts = new Map<number, TableContext>()
	private readonly paragraphs = new Map<number, Map<ParagraphProps, ParagraphFormatInternal>>()
	private readonly tables = new Map<TableProps, Map<TableProps, TableFormatInternal>>()
	private readonly sections = new Map<SectionProps, ResolvedSectionProps>()
	private readonly runInterner = new Interner<ResolvedRunProps>()
	private readonly paragraphInterner = new Interner<ResolvedParagraphProps>()
	private readonly tableInterner = new Interner<ResolvedTableProps>()
	private readonly rowInterner = new Interner<ResolvedTableRowProps>()
	private readonly cellInterner = new Interner<ResolvedTableCellProps>()
	private readonly borderInterner = new Interner<ResolvedBorder>()
	// Layout groups bordered paragraphs by identity of this set (17.3.1.24), so equal sets must share one object.
	private readonly paragraphBordersInterner = new Interner<ResolvedParagraphBorders>()
	private readonly shadingInterner = new Interner<ResolvedShading>()
	private resolvedRuns = 0
	// Style ids looked up that the styles do not define (they resolve as the defaults until defined).
	private readonly missing = new Set<string>()

	constructor(parts: ResolverParts = {}) {
		this.stylesValue = parts.styles ?? DocxStyles.empty()
		this.numberingValue = parts.numbering
		this.theme = parts.theme
		this.settings = parts.settings ?? DEFAULT_STYLE_SETTINGS
		this.defaultParagraphStyle = this.stylesValue.defaultOf("paragraph")
		this.defaultCharacterStyle = this.stylesValue.defaultOf("character")
		this.defaultTableStyle = this.stylesValue.defaultOf("table")
	}

	get styles(): DocxStyles {
		return this.stylesValue
	}

	get numbering(): Numbering | undefined {
		return this.numberingValue
	}

	// Resolves with other style and numbering definitions from now on (an editor adding the definitions a save
	// will add): what was resolved with the old ones is forgotten. Whether a style looked up before and missing
	// is defined now (what referred to it looks different).
	redefine(styles: DocxStyles, numbering: Numbering | undefined): boolean {
		let defined = false

		for (const id of this.missing) {
			if (styles.byId(id) === undefined) continue

			defined = true
			this.missing.delete(id)
		}

		this.stylesValue = styles
		this.numberingValue = numbering
		this.defaultParagraphStyle = styles.defaultOf("paragraph")
		this.defaultCharacterStyle = styles.defaultOf("character")
		this.defaultTableStyle = styles.defaultOf("table")
		this.flatParagraph.length = 0
		this.flatRun.length = 0
		this.flatTable.length = 0
		this.contexts.clear()
		this.paragraphs.clear()
		this.tables.clear()
		this.sections.clear()

		return defined
	}

	// ---- styles -----------------------------------------------------------------------------------------

	// A missing paragraph style is the default paragraph style; a character style with a linked paragraph
	// style stands for that style.
	paragraphStyle(styleId: string | undefined): StyleDef | undefined {
		if (styleId === undefined) return this.defaultParagraphStyle

		const style = this.styles.byId(styleId)

		if (style === undefined) this.missing.add(styleId)
		if (style?.type === "paragraph") return style

		if (style?.type === "character") {
			const linked = this.styles.linked(style)

			if (linked?.type === "paragraph") return linked
		}

		return this.defaultParagraphStyle
	}

	characterStyle(styleId: string | undefined): StyleDef | undefined {
		if (styleId === undefined) return this.defaultCharacterStyle

		const style = this.styles.byId(styleId)

		if (style === undefined) this.missing.add(styleId)
		if (style?.type === "character") return style

		if (style?.type === "paragraph") {
			const linked = this.styles.linked(style)

			if (linked?.type === "character") return linked
		}

		return undefined
	}

	tableStyle(styleId: string | undefined): StyleDef | undefined {
		if (styleId === undefined) return this.defaultTableStyle

		const style = this.styles.byId(styleId)

		if (style === undefined) this.missing.add(styleId)

		return style?.type === "table" ? style : this.defaultTableStyle
	}

	private styleParagraph(style: StyleDef | undefined): ParagraphProps {
		if (style === undefined) return EMPTY_PARAGRAPH

		let flat = this.flatParagraph[style.index]

		if (flat === undefined) {
			const acc: Mutable<ParagraphProps> = {}

			mergeParagraph(acc, this.styleParagraph(this.styles.parent(style)), true)
			mergeParagraph(acc, style.paragraph, true)
			flat = acc
			this.flatParagraph[style.index] = flat
		}

		return flat
	}

	private styleRun(style: StyleDef | undefined): RunProps {
		if (style === undefined) return EMPTY_RUN

		let flat = this.flatRun[style.index]

		if (flat === undefined) {
			const acc: Mutable<RunProps> = {}

			mergeRun(acc, this.styleRun(this.styles.parent(style)))
			mergeRun(acc, style.run)
			flat = acc
			this.flatRun[style.index] = flat
		}

		return flat
	}

	private styleTable(style: StyleDef | undefined): TableProps {
		if (style === undefined) return EMPTY_TABLE

		let flat = this.flatTable[style.index]

		if (flat === undefined) {
			const acc: Mutable<TableProps> = {}

			mergeTable(acc, this.styleTable(this.styles.parent(style)))
			mergeTable(acc, style.table)
			flat = acc
			this.flatTable[style.index] = flat
		}

		return flat
	}

	// What a table style gives cells matching `conditions`: per style of the chain (root first) its base
	// properties then its wholeTable condition, then each further condition in CONDITION_ORDER.
	private tableContext(style: StyleDef, conditions: number): TableContext {
		const key = style.index * CONDITION_BITS + conditions
		let context = this.contexts.get(key)

		if (context !== undefined) return context

		const chain = this.styles.chain(style)
		const paragraph: Mutable<ParagraphProps> = {}
		const run: Mutable<RunProps> = {}
		const cell: Mutable<TableCellProps> = {}
		const row: Mutable<TableRowProps> = {}

		for (const link of chain) {
			const whole = link.conditions.get("wholeTable")

			mergeParagraph(paragraph, link.paragraph, true)
			mergeRun(run, link.run)
			mergeCell(cell, link.cell)
			mergeRow(row, link.row)

			if (whole !== undefined) {
				mergeParagraph(paragraph, whole.paragraph, true)
				mergeRun(run, whole.run)
				mergeCell(cell, whole.cell)
				mergeRow(row, whole.row)
			}
		}

		for (let bit = 1; bit < CONDITION_ORDER.length; bit++) {
			if ((conditions & (1 << bit)) === 0) continue

			const type = CONDITION_ORDER[bit]

			if (type === undefined) continue

			for (const link of chain) {
				const condition = link.conditions.get(type)

				if (condition === undefined) continue

				mergeParagraph(paragraph, condition.paragraph, true)
				mergeRun(run, condition.run)
				mergeCell(cell, condition.cell)
				mergeRow(row, condition.row)
			}
		}

		context = { paragraph, run, cell, row }
		this.contexts.set(key, context)

		return context
	}

	// ---- colours, borders, fonts -----------------------------------------------------------------------

	color(color: ColorProps | undefined): string | undefined {
		if (color === undefined) return undefined

		if (this.theme !== undefined && color.themeColor !== undefined && color.themeColor !== "none") {
			let base = this.theme.themeColor(color.themeColor, this.settings.colorMapping)

			if (base !== undefined) {
				if (color.themeTint !== undefined) base = applyThemeTint(base, color.themeTint)
				if (color.themeShade !== undefined) base = applyThemeShade(base, color.themeShade)

				// Word stores the value it computed next to the theme reference; ours can differ by a unit per
				// channel, so a value that agrees is taken as is. One that does not is stale (the theme changed).
				return color.val !== undefined && color.val !== "auto" && nearColor(base, color.val) ? color.val : base
			}
		}

		return color.val === undefined || color.val === "auto" ? undefined : color.val
	}

	border(border: BorderProps | undefined): ResolvedBorder | undefined {
		if (border === undefined || border.style === "nil") return undefined
		if (
			border.style === "none" &&
			(this.settings.paddingBorders !== true || ((border.space ?? 0) <= 0 && border.shadow !== true && border.frame !== true))
		)
			return undefined

		return this.borderInterner.intern({
			style: border.style,
			size: border.size ?? 0,
			space: border.space ?? 0,
			color: this.color(border),
			shadow: border.shadow ?? false,
			frame: border.frame ?? false
		})
	}

	shading(shading: ShadingProps | undefined): ResolvedShading | undefined {
		if (shading === undefined || shading.pattern === "nil") return undefined

		const color = this.color(shading.color)
		const fill = this.color(shading.fill)

		if (shading.pattern === "clear" && fill === undefined) return undefined

		return this.shadingInterner.intern({ pattern: shading.pattern, color, fill })
	}

	// Theme references map through w:themeFontLang (§17.15.1.88), never the run's own w:lang. A slot the
	// hierarchy leaves unset is Times New Roman (MS-OI29500, Part 1 §17.3.2.26 note c).
	private fonts(fonts: FontsProps | undefined): ResolvedFonts {
		const theme = this.theme
		const languages = this.settings.themeFontLanguage
		const slot = (concrete: string | undefined, ref: FontsProps["asciiTheme"]): string => {
			const themed = ref !== undefined && theme !== undefined ? theme.font(ref, languages) : undefined

			return themed ?? (concrete === undefined || concrete === "" ? DEFAULT_FONT : concrete)
		}
		const ascii = slot(fonts?.ascii, fonts?.asciiTheme)
		const hAnsi = slot(fonts?.hAnsi, fonts?.hAnsiTheme)
		const eastAsia = slot(fonts?.eastAsia, fonts?.eastAsiaTheme)

		return {
			ascii,
			hAnsi,
			eastAsia,
			cs: slot(fonts?.cs, fonts?.csTheme),
			hint: fonts?.hint ?? "default",
			eastAsiaUsesAscii: eastAsiaUsesAscii(ascii, hAnsi, eastAsia)
		}
	}

	private finishRun(acc: RunProps, styleId: string | undefined): ResolvedRunProps {
		const underline = acc.underline
		const highlight = acc.highlight === undefined || acc.highlight === "none" ? undefined : HIGHLIGHT_COLORS[acc.highlight]
		const value = {
			styleId,
			fonts: this.fonts(acc.fonts),
			size: acc.size ?? DEFAULT_SIZE,
			sizeCs: acc.sizeCs ?? DEFAULT_SIZE,
			bold: acc.bold ?? false,
			boldCs: acc.boldCs ?? false,
			italic: acc.italic ?? false,
			italicCs: acc.italicCs ?? false,
			caps: acc.caps ?? false,
			smallCaps: acc.smallCaps ?? false,
			strike: acc.strike ?? false,
			doubleStrike: acc.doubleStrike ?? false,
			outline: acc.outline ?? false,
			shadow: acc.shadow ?? false,
			emboss: acc.emboss ?? false,
			imprint: acc.imprint ?? false,
			vanish: acc.vanish ?? false,
			specVanish: acc.specVanish ?? false,
			webHidden: acc.webHidden ?? false,
			noProof: acc.noProof ?? false,
			snapToGrid: acc.snapToGrid ?? true,
			rtl: acc.rtl ?? false,
			cs: acc.cs ?? false,
			oMath: acc.oMath ?? false,
			color: this.color(acc.color),
			highlight,
			underline:
				underline === undefined || underline.style === "none"
					? undefined
					: { style: underline.style, color: this.color(underline) },
			vertAlign: acc.vertAlign ?? "baseline",
			position: acc.position ?? 0,
			spacing: acc.spacing ?? 0,
			scale: acc.scale ?? 100,
			kern: acc.kern ?? 0,
			shading: this.shading(acc.shading),
			border: this.border(acc.border),
			effect: acc.effect === "none" ? undefined : acc.effect,
			emphasis: acc.emphasis === "none" ? undefined : acc.emphasis,
			fitText: acc.fitText,
			lang: { latin: acc.lang?.latin, eastAsia: acc.lang?.eastAsia, bidi: acc.lang?.bidi },
			eastAsianLayout: acc.eastAsianLayout
		}

		return this.runInterner.internWithId(value, id => ({ id, ...value }))
	}

	// ---- paragraphs and runs ----------------------------------------------------------------------------

	// Order (§17.7.2): document defaults, table style, numbering level, paragraph style, direct formatting.
	// Word lets a table style override the default paragraph style, so for paragraphs in that style the
	// style comes before the table. A list level's indent beats the paragraph style's when the numbering is
	// direct formatting; numbering inherited from a style loses to that style's own indent.
	paragraph(direct: ParagraphProps, cell?: CellFormat): ParagraphFormat {
		const contextKey = cell === undefined ? NO_CONTEXT : (cell as CellFormatInternal).contextKey
		let byContext = this.paragraphs.get(contextKey)

		if (byContext === undefined) {
			byContext = new Map()
			this.paragraphs.set(contextKey, byContext)
		}

		let format = byContext.get(direct)

		if (format === undefined) {
			format = this.buildParagraph(direct, contextKey)
			byContext.set(direct, format)
		}

		return format
	}

	private contextFor(contextKey: number): TableContext | undefined {
		if (contextKey === NO_CONTEXT) return undefined

		const style = this.styles.styles[Math.floor(contextKey / CONDITION_BITS)]

		return style === undefined ? undefined : this.tableContext(style, contextKey % CONDITION_BITS)
	}

	// Order (§17.7.2): document defaults, table style, numbering level, paragraph style, direct formatting.
	// Unless w:compatSetting overrideTableStyleFontSizeAndJustification is on, the default paragraph style's
	// 11pt or 12pt font size and left justification do not override the table style (MS-DOCX §2.3.1).
	private buildParagraph(direct: ParagraphProps, contextKey: number): ParagraphFormatInternal {
		const style = this.paragraphStyle(direct.styleId)
		const styleProps = this.styleParagraph(style)
		const context = this.contextFor(contextKey)
		const tableParagraph = context?.paragraph ?? EMPTY_PARAGRAPH
		const tableRun = context?.run ?? EMPTY_RUN
		const numberingRef = { ...styleProps.numbering, ...direct.numbering }
		const numId = numberingRef.numId ?? 0
		const level = numId > 0 ? this.numbering?.level(numId, numberingRef.ilvl ?? 0) : undefined
		const yields = context !== undefined && !this.settings.overrideTableStyleFontSizeAndJustification
		let paragraphLevel = styleProps
		let runLevel = this.styleRun(style)

		if (
			yields &&
			tableParagraph.alignment !== undefined &&
			this.fromDefaultStyle(style, link => link.paragraph.alignment !== undefined)
		) {
			const alignment = styleProps.alignment

			if (alignment === "left" || alignment === "start") {
				const copy: Mutable<ParagraphProps> = { ...styleProps }

				delete copy.alignment
				paragraphLevel = copy
			}
		}

		if (
			yields &&
			tableRun.size !== undefined &&
			(runLevel.size === 22 || runLevel.size === 24) &&
			this.fromDefaultStyle(style, link => link.run.size !== undefined)
		) {
			const copy: Mutable<RunProps> = { ...runLevel }

			delete copy.size
			runLevel = copy
		}

		const acc: Mutable<ParagraphProps> = {}

		for (const source of [
			this.styles.defaultParagraph,
			tableParagraph,
			level?.level.paragraph ?? EMPTY_PARAGRAPH,
			paragraphLevel,
			direct
		]) {
			mergeParagraph(acc, source, true)
		}

		const defaults = this.styles.defaultRun
		const runBase: Mutable<RunProps> = {}

		mergeRun(runBase, defaults)
		mergeRun(runBase, tableRun, defaults)
		mergeRun(runBase, runLevel, defaults)

		return {
			props: this.finishParagraph(acc, acc.indent ?? {}, style, level),
			style,
			level,
			runBase,
			markRun: direct.markRun ?? EMPTY_RUN,
			runs: new Map(),
			mark: undefined,
			marker: undefined
		}
	}

	// Whether the nearest style of the chain that sets a property is the default paragraph style or one of
	// its bases (the value the paragraph gets is the default style's own).
	private fromDefaultStyle(style: StyleDef | undefined, sets: (link: StyleDef) => boolean): boolean {
		const defaultStyle = this.defaultParagraphStyle

		if (defaultStyle === undefined) return false

		let reachedDefault = false

		for (let link = style; link !== undefined; link = this.styles.parent(link)) {
			if (link === defaultStyle) reachedDefault = true
			if (sets(link)) return reachedDefault
		}

		return false
	}

	private finishParagraph(
		acc: ParagraphProps,
		indent: IndentProps,
		style: StyleDef | undefined,
		level: EffectiveLevel | undefined
	): ResolvedParagraphProps {
		const bidi = acc.bidi ?? false
		const alignment = acc.alignment ?? "start"
		const spacing = acc.spacing
		const resolvedSpacing: ResolvedSpacing = {
			before: spacing?.before ?? 0,
			beforeLines: spacing?.beforeLines,
			beforeAutospacing: spacing?.beforeAutospacing ?? false,
			after: spacing?.after ?? 0,
			afterLines: spacing?.afterLines,
			afterAutospacing: spacing?.afterAutospacing ?? false,
			line: spacing?.line ?? 240,
			lineRule: spacing?.lineRule ?? "auto"
		}
		const firstLineChars = indent.firstLineChars !== undefined && indent.firstLineChars !== 0 ? indent.firstLineChars : undefined
		const hangingChars = indent.hangingChars !== undefined && indent.hangingChars !== 0 ? -indent.hangingChars : undefined
		const resolvedIndent: ResolvedIndent = {
			start: indent.start ?? 0,
			end: indent.end ?? 0,
			firstLine: indent.firstLine ?? (indent.hanging === undefined ? 0 : -indent.hanging),
			startChars: indent.startChars !== undefined && indent.startChars !== 0 ? indent.startChars : undefined,
			endChars: indent.endChars !== undefined && indent.endChars !== 0 ? indent.endChars : undefined,
			firstLineChars: firstLineChars ?? hangingChars
		}
		const tabs: ResolvedTabStop[] = []

		for (const tab of acc.tabs ?? []) {
			const kind = tab.alignment === "left" ? "start" : tab.alignment === "right" ? "end" : tab.alignment

			if (kind === "start" || kind === "center" || kind === "end" || kind === "decimal" || kind === "bar" || kind === "num") {
				tabs.push({ alignment: kind, position: tab.position, leader: tab.leader ?? "none" })
			}
		}

		tabs.sort((a, b) => a.position - b.position)

		const borders = acc.borders
		let resolvedBorders: ResolvedParagraphBorders | undefined

		if (borders !== undefined) {
			const candidate: ResolvedParagraphBorders = {
				top: this.border(borders.top),
				start: this.border(borders.start),
				bottom: this.border(borders.bottom),
				end: this.border(borders.end),
				between: this.border(borders.between),
				bar: this.border(borders.bar)
			}

			if (candidate.top || candidate.start || candidate.bottom || candidate.end || candidate.between || candidate.bar)
				resolvedBorders = this.paragraphBordersInterner.intern(candidate)
		}

		const value = {
			styleId: style?.id,
			alignment,
			physicalAlignment: physicalParagraphAlignment(alignment, bidi),
			indent: resolvedIndent,
			spacing: resolvedSpacing,
			contextualSpacing: acc.contextualSpacing ?? false,
			keepNext: acc.keepNext ?? false,
			keepLines: acc.keepLines ?? false,
			// Word turns widow control on unless the hierarchy turns it off.
			widowControl: acc.widowControl ?? true,
			pageBreakBefore: acc.pageBreakBefore ?? false,
			tabs,
			numbering: level === undefined ? undefined : { numId: level.numId, ilvl: level.ilvl },
			outlineLevel: acc.outlineLevel === undefined || acc.outlineLevel >= 9 ? undefined : acc.outlineLevel,
			borders: resolvedBorders,
			shading: this.shading(acc.shading),
			frame: acc.frame,
			textDirection: acc.textDirection,
			textAlignment: acc.textAlignment ?? "auto",
			bidi,
			snapToGrid: acc.snapToGrid ?? true,
			suppressAutoHyphens: acc.suppressAutoHyphens ?? false,
			suppressLineNumbers: acc.suppressLineNumbers ?? false,
			suppressOverlap: acc.suppressOverlap ?? false,
			mirrorIndents: acc.mirrorIndents ?? false,
			kinsoku: acc.kinsoku ?? true,
			wordWrap: acc.wordWrap ?? true,
			overflowPunct: acc.overflowPunct ?? true,
			topLinePunct: acc.topLinePunct ?? false,
			autoSpaceDE: acc.autoSpaceDE ?? true,
			autoSpaceDN: acc.autoSpaceDN ?? true,
			adjustRightInd: acc.adjustRightInd ?? true
		}

		return this.paragraphInterner.internWithId(value, id => ({ id, ...value }))
	}

	// A run in `paragraph`: the paragraph's inherited run properties, then the character style (toggles
	// flip), then direct formatting (toggles set).
	run(paragraph: ParagraphFormat, direct: RunProps): ResolvedRunProps {
		const internal = paragraph as ParagraphFormatInternal
		let resolved = internal.runs.get(direct)

		if (resolved === undefined) {
			resolved = this.resolveRun(paragraph.runBase, direct, undefined)
			internal.runs.set(direct, resolved)
		}

		return resolved
	}

	private resolveRun(base: RunProps, direct: RunProps, level: RunProps | undefined): ResolvedRunProps {
		const style = this.characterStyle(direct.styleId)
		const acc: Mutable<RunProps> = { ...base }

		mergeRun(acc, this.styleRun(style), this.styles.defaultRun)
		mergeRun(acc, direct)

		if (level !== undefined) mergeRun(acc, level)

		this.resolvedRuns++

		return this.finishRun(acc, style?.id)
	}

	// The paragraph mark (w:pPr/w:rPr): it sizes empty paragraphs.
	paragraphMark(paragraph: ParagraphFormat): ResolvedRunProps {
		const internal = paragraph as ParagraphFormatInternal

		internal.mark ??= this.resolveRun(paragraph.runBase, paragraph.markRun, undefined)

		return internal.mark
	}

	// The list marker's formatting: the paragraph mark's, without its underline and hiding (which belong to
	// the mark glyph), then the level's w:rPr. Undefined for paragraphs without a list level.
	listMarker(paragraph: ParagraphFormat): ResolvedRunProps | undefined {
		const internal = paragraph as ParagraphFormatInternal

		if (internal.marker !== undefined) return internal.marker ?? undefined

		const level = paragraph.level

		if (level === undefined) {
			internal.marker = null

			return undefined
		}

		const { underline: _underline, vanish: _vanish, specVanish: _specVanish, ...mark } = paragraph.markRun

		internal.marker = this.resolveRun(paragraph.runBase, mark, level.level.run)

		return internal.marker
	}

	// ---- tables -----------------------------------------------------------------------------------------

	// A table: its style's table properties (the default table style when it names none), then w:tblPr,
	// then the w:tblPrEx of a row when given.
	table(direct: TableProps, exceptions: TableProps = EMPTY_TABLE): TableFormat {
		let byExceptions = this.tables.get(direct)

		if (byExceptions === undefined) {
			byExceptions = new Map()
			this.tables.set(direct, byExceptions)
		}

		let format = byExceptions.get(exceptions)

		if (format === undefined) {
			format = this.buildTable(direct, exceptions)
			byExceptions.set(exceptions, format)
		}

		return format
	}

	// A cell's border, keeping an explicit "nil" (ResolvedCellBorders).
	private cellBorder(border: BorderProps | undefined): ResolvedBorder | undefined {
		if (border?.style !== "nil") return this.border(border)

		return this.borderInterner.intern({ style: "nil", size: 0, space: 0, color: undefined, shadow: false, frame: false })
	}

	private tableBorders(borders: TableBordersProps | undefined): ResolvedTableBorders {
		return {
			top: this.border(borders?.top),
			start: this.border(borders?.start),
			bottom: this.border(borders?.bottom),
			end: this.border(borders?.end),
			insideH: this.border(borders?.insideH),
			insideV: this.border(borders?.insideV)
		}
	}

	private buildTable(direct: TableProps, exceptions: TableProps): TableFormatInternal {
		const style = this.tableStyle(direct.styleId)
		const styleTable = this.styleTable(style)
		const acc: Mutable<TableProps> = {}

		mergeTable(acc, styleTable)
		mergeTable(acc, direct)
		mergeTable(acc, exceptions)

		const bidi = acc.bidiVisual ?? false
		const alignment = acc.alignment ?? "start"
		const value = {
			styleId: style?.id,
			width: acc.width ?? AUTO_WIDTH,
			alignment,
			physicalAlignment: physicalTableAlignment(alignment, bidi),
			indent: acc.indent ?? ZERO_DXA,
			cellSpacing: acc.cellSpacing,
			borders: this.tableBorders(acc.borders),
			shading: this.shading(acc.shading),
			layout: acc.layout ?? "autofit",
			cellMargins: resolveCellMargins([acc.cellMargins]),
			look: acc.look ?? DEFAULT_TABLE_LOOK,
			bidiVisual: bidi,
			overlap: acc.overlap ?? "overlap",
			position: acc.position,
			rowBandSize: acc.rowBandSize ?? 1,
			colBandSize: acc.colBandSize ?? 1,
			caption: acc.caption,
			description: acc.description
		}

		return {
			props: this.tableInterner.internWithId(value, id => ({ id, ...value })),
			style,
			styleTable,
			direct,
			exceptions,
			cells: new Map(),
			rows: new Map()
		}
	}

	row(table: TableFormat, direct: TableRowProps, position: RowPosition): ResolvedTableRowProps {
		const internal = table as TableFormatInternal
		const look = table.props.look
		const conditions =
			cellConditions(
				look,
				{
					rowIndex: position.rowIndex,
					rowCount: position.rowCount,
					gridColumn: 0,
					gridSpan: 1,
					gridColumnCount: 0
				},
				table.props.rowBandSize,
				table.props.colBandSize
			) & ROW_CONDITIONS
		let byDirect = internal.rows.get(conditions)

		if (byDirect === undefined) {
			byDirect = new Map()
			internal.rows.set(conditions, byDirect)
		}

		let resolved = byDirect.get(direct)

		if (resolved === undefined) {
			const acc: Mutable<TableRowProps> = {}

			if (table.style !== undefined) mergeRow(acc, this.tableContext(table.style, conditions).row)

			mergeRow(acc, direct)

			const value = {
				gridBefore: acc.gridBefore ?? 0,
				gridAfter: acc.gridAfter ?? 0,
				widthBefore: acc.widthBefore,
				widthAfter: acc.widthAfter,
				cantSplit: acc.cantSplit ?? false,
				height: acc.height,
				header: acc.header ?? false,
				hidden: acc.hidden ?? false,
				cellSpacing: acc.cellSpacing,
				alignment: acc.alignment
			}

			resolved = this.rowInterner.internWithId(value, id => ({ id, ...value }))
			byDirect.set(direct, resolved)
		}

		return resolved
	}

	// A cell: the table style's conditional cell formatting for its position, then w:tcPr. Margins layer
	// the style's, the table's and the row exceptions' defaults under the cell's own.
	cell(table: TableFormat, direct: TableCellProps, position: CellPosition): CellFormat {
		const internal = table as TableFormatInternal
		const conditions = cellConditions(table.props.look, position, table.props.rowBandSize, table.props.colBandSize)
		let byDirect = internal.cells.get(conditions)

		if (byDirect === undefined) {
			byDirect = new Map()
			internal.cells.set(conditions, byDirect)
		}

		let format = byDirect.get(direct)

		if (format === undefined) {
			const style = table.style
			const context = style === undefined ? undefined : this.tableContext(style, conditions)
			const acc: Mutable<TableCellProps> = {}

			if (context !== undefined) mergeCell(acc, context.cell)

			mergeCell(acc, direct)

			const borders = acc.borders
			const value = {
				width: acc.width,
				gridSpan: acc.gridSpan ?? 1,
				hMerge: acc.hMerge,
				vMerge: acc.vMerge,
				borders: {
					top: this.cellBorder(borders?.top),
					start: this.cellBorder(borders?.start),
					bottom: this.cellBorder(borders?.bottom),
					end: this.cellBorder(borders?.end),
					insideH: this.cellBorder(borders?.insideH),
					insideV: this.cellBorder(borders?.insideV),
					tl2br: this.border(borders?.tl2br),
					tr2bl: this.border(borders?.tr2bl)
				},
				shading: this.shading(acc.shading),
				margins: resolveCellMargins([
					internal.styleTable.cellMargins,
					context?.cell.margins,
					internal.direct.cellMargins,
					internal.exceptions.cellMargins,
					direct.margins
				]),
				noWrap: acc.noWrap ?? false,
				textDirection: acc.textDirection,
				fitText: acc.fitText ?? false,
				vAlign: acc.vAlign ?? "top",
				hideMark: acc.hideMark ?? false
			}

			format = {
				props: this.cellInterner.internWithId(value, id => ({ id, ...value })),
				conditions,
				contextKey: style === undefined ? NO_CONTEXT : style.index * CONDITION_BITS + conditions
			}
			byDirect.set(direct, format)
		}

		return format
	}

	// ---- sections ---------------------------------------------------------------------------------------

	section(direct: SectionProps): ResolvedSectionProps {
		let resolved = this.sections.get(direct)

		if (resolved === undefined) {
			resolved = resolveSection(direct)
			this.sections.set(direct, resolved)
		}

		return resolved
	}

	// Distinct objects created so far, and how many run resolutions missed the caches.
	stats(): {
		runs: number
		paragraphs: number
		tables: number
		rows: number
		cells: number
		borders: number
		shadings: number
		runResolutions: number
		tableContexts: number
	} {
		return {
			runs: this.runInterner.size,
			paragraphs: this.paragraphInterner.size,
			tables: this.tableInterner.size,
			rows: this.rowInterner.size,
			cells: this.cellInterner.size,
			borders: this.borderInterner.size,
			shadings: this.shadingInterner.size,
			runResolutions: this.resolvedRuns,
			tableContexts: this.contexts.size
		}
	}
}

// Word's defaults for whatever a w:sectPr leaves out: US Letter portrait, 1" margins, 0.5" header and
// footer distance, one column with 0.5" spacing.
export function resolveSection(direct: SectionProps): ResolvedSectionProps {
	const size = direct.pageSize
	const margins = direct.pageMargins
	const columns = direct.columns
	let width = size?.width ?? 12240
	let height = size?.height ?? 15840
	const orient = size?.orient ?? (width > height ? "landscape" : "portrait")

	// Some producers set orient without swapping the dimensions.
	if (orient === "landscape" && width < height) [width, height] = [height, width]

	return {
		type: direct.type ?? "nextPage",
		pageWidth: width,
		pageHeight: height,
		orient,
		margins: {
			top: margins?.top ?? 1440,
			right: margins?.right ?? 1440,
			bottom: margins?.bottom ?? 1440,
			left: margins?.left ?? 1440,
			header: margins?.header ?? 720,
			footer: margins?.footer ?? 720,
			gutter: margins?.gutter ?? 0
		},
		columns: {
			...columns,
			count: columns?.count ?? (columns?.columns !== undefined && columns.equalWidth === false ? columns.columns.length : 1),
			space: columns?.space ?? 720,
			equalWidth: columns?.equalWidth ?? true,
			separator: columns?.separator ?? false
		},
		titlePage: direct.titlePage ?? false,
		vAlign: direct.vAlign ?? "top",
		pageNumbering: direct.pageNumbering ?? {},
		lineNumbering: direct.lineNumbering,
		pageBorders: direct.pageBorders,
		docGrid: direct.docGrid ?? {},
		textDirection: direct.textDirection,
		bidi: direct.bidi ?? false,
		rtlGutter: direct.rtlGutter ?? false,
		headers: direct.headers ?? [],
		footers: direct.footers ?? [],
		footnotes: direct.footnotes,
		endnotes: direct.endnotes
	}
}
