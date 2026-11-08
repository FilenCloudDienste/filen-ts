import {
	Alignment,
	LineRule,
	TabAlignment,
	TabLeader,
	TabStops,
	type Exclusions,
	type ParagraphGeometry,
	type TabStop
} from "../../text/index"
import type { LineSpacingRule } from "../../fonts/index"
import type { DocxSettings } from "../model/settings"
import type { ResolvedBorder, ResolvedParagraphProps, ResolvedSectionProps } from "../props/types"
import { borderWidth } from "./styles"
import { points, twips } from "./units"

// Paragraph and page geometry in px from resolved properties.

// A reusable ParagraphGeometry.
export class Geometry implements ParagraphGeometry {
	left = 0
	width = 0
	startIndent = 0
	endIndent = 0
	firstLineIndent = 0
	rtl = false
	alignment: Alignment = Alignment.START
	tabs: TabStops | null = null
	defaultTabStop = 48
	lineRule: LineRule = LineRule.AUTO
	lineSpacing = 1
	expandLineBreaks = true
	hangingIndentTab = true
	exclusions: Exclusions | null = null
	decimalSeparator = 0x2e
	markSizesObjectLines = true
	libreOfficeSpacing = false
	gridPitch = 0
}

export interface LayoutCompat {
	readonly defaultTabStop: number
	readonly expandLineBreaks: boolean
	readonly hangingIndentTab: boolean
	readonly decimalSeparator: number
	readonly compatibilityMode: number
	// w:doNotUseHTMLParagraphAutoSpacing is not set.
	readonly htmlSpacing: boolean
	// w:suppressSpBfAfterPgBrk: no space before at the top of a page after a page or column break.
	readonly suppressSpaceAfterBreak: boolean
	// w:suppressTopSpacing: the first line of a page ignores exact and at-least line heights.
	readonly suppressTopSpacing: boolean
	readonly mirrorMargins: boolean
	readonly gutterAtTop: boolean
	readonly evenAndOddHeaders: boolean
	// w:noColumnBalance: a continuous section break leaves the columns above it unbalanced.
	readonly noColumnBalance: boolean
	// Floats stay on the page their anchor is on (ODF 1.3 Part 3 §20.267 style:flow-with-text false), asked for by
	// a document translated from OpenDocument: WordprocessingML lets them run off it.
	readonly floatsOnAnchorPage: boolean
	// The paragraph mark's font sizes a last line holding only inline objects (Word); false, asked for by a document
	// translated from OpenDocument: such a line is as tall as its objects (LibreOffice, measured).
	readonly markSizesObjectLines: boolean
	// Paragraph borders as LibreOffice lays them out, asked for by a document translated from OpenDocument
	// (ODF_PADDING): inside the indents, and joined: neighbours whose lines (not the spacing above and below them) and
	// text edges agree share one box, and so do paragraphs without borders (measured).
	readonly joinsBoxes: boolean
	// Lines measured and spaced, and table borders given room in their rows, as LibreOffice does, asked for by a
	// document translated from OpenDocument (ODF_LINE_GAP).
	readonly libreOfficeSpacing: boolean
}

// The compatibility settings an OpenDocument translation writes: style:flow-with-text, how tall a line of only
// as-char objects is (ODF_OBJECT_LINES), and padding beside no line as borders that draw nothing (ODF_PADDING, see
// StyleSettings.paddingBorders) joined as LibreOffice joins borders, and how a line's height is measured
// (ODF_LINE_GAP: "below" or "none", see lineSpacingRule).
export const ODF_STYLE_NS = "urn:oasis:names:tc:opendocument:xmlns:style:1.0"
export const ODF_OBJECT_LINES = "object-line-height"
export const ODF_PADDING = "paragraph-padding"
export const ODF_LINE_GAP = "line-gap"

// How the layout measures a font's line: Word's way, or LibreOffice's for a translation that asks (ODF_LINE_GAP).
export function lineSpacingRule(settings: DocxSettings): LineSpacingRule {
	const gap = settings.compatSettings.find(setting => setting.name === ODF_LINE_GAP && setting.uri === ODF_STYLE_NS)?.value

	return gap === "below" ? "hheaGapBelow" : gap === "none" ? "hhea" : "gdi"
}

// Whether the document is a translation from OpenDocument, which always says how its lines are measured
// (ODF_LINE_GAP): laid out, and edited, as LibreOffice does.
export function openDocumentTranslation(settings: DocxSettings): boolean {
	return lineSpacingRule(settings) !== "gdi"
}

export function layoutCompat(settings: DocxSettings): LayoutCompat {
	const legacy = new Set(settings.legacyCompat)

	return {
		defaultTabStop: twips(settings.defaultTabStop ?? 720) || 48,
		expandLineBreaks: !legacy.has("doNotExpandShiftReturn"),
		hangingIndentTab: !legacy.has("doNotUseIndentAsNumberingTabStop"),
		decimalSeparator: (settings.decimalSymbol ?? ".").charCodeAt(0) || 0x2e,
		compatibilityMode: settings.compatibilityMode ?? 11,
		htmlSpacing: !legacy.has("doNotUseHTMLParagraphAutoSpacing"),
		suppressSpaceAfterBreak: legacy.has("suppressSpBfAfterPgBrk"),
		suppressTopSpacing: legacy.has("suppressTopSpacing"),
		mirrorMargins: settings.mirrorMargins,
		gutterAtTop: settings.gutterAtTop,
		evenAndOddHeaders: settings.evenAndOddHeaders,
		noColumnBalance: legacy.has("noColumnBalance"),
		floatsOnAnchorPage: settings.compatSettings.some(
			setting => setting.name === "flow-with-text" && setting.uri === ODF_STYLE_NS && setting.value === "false"
		),
		markSizesObjectLines: !settings.compatSettings.some(
			setting => setting.name === ODF_OBJECT_LINES && setting.uri === ODF_STYLE_NS && setting.value === "objects"
		),
		joinsBoxes: odfPadding(settings),
		libreOfficeSpacing: openDocumentTranslation(settings)
	}
}

// How far a start or end border sets the text in from the indent under LayoutCompat.joinsBoxes, which draws it inside
// the indents (LibreOffice) where Word draws it outside: its width and spacing, in px.
export function borderInset(border: ResolvedBorder | undefined): number {
	return border === undefined ? 0 : borderWidth(border) + points(border.space)
}

// Whether a translation from OpenDocument asks for its padding borders (ODF_PADDING).
export function odfPadding(settings: DocxSettings): boolean {
	return settings.compatSettings.some(
		setting => setting.name === ODF_PADDING && setting.uri === ODF_STYLE_NS && setting.value === "borders"
	)
}

const TAB_ALIGNMENTS: Readonly<Record<string, TabAlignment>> = {
	start: TabAlignment.START,
	center: TabAlignment.CENTER,
	end: TabAlignment.END,
	decimal: TabAlignment.DECIMAL,
	bar: TabAlignment.BAR,
	num: TabAlignment.START
}

const TAB_LEADERS: Readonly<Record<string, TabLeader>> = {
	dot: TabLeader.DOT,
	hyphen: TabLeader.HYPHEN,
	underscore: TabLeader.UNDERSCORE,
	heavy: TabLeader.HEAVY,
	middleDot: TabLeader.MIDDLE_DOT
}

const tabCache = new WeakMap<ResolvedParagraphProps, { readonly end: number; readonly stops: TabStops | null }>()

// A paragraph's tab stops for a line ending at `end` (px from the column's start). A right, centre or
// decimal stop past the end aligns there: Word keeps the text after it on the line, running into the margin
// rather than wrapping (tables of contents set their page number stop a hair past the margin).
function tabStops(props: ResolvedParagraphProps, end: number): TabStops | null {
	const cached = tabCache.get(props)

	if (cached !== undefined && cached.end === end) return cached.stops

	const stops =
		props.tabs.length === 0
			? null
			: new TabStops(
					props.tabs.map((tab): TabStop => {
						const alignment = TAB_ALIGNMENTS[tab.alignment] ?? TabAlignment.START
						const position = twips(tab.position)

						return {
							position: alignment !== TabAlignment.START && alignment !== TabAlignment.BAR && position > end ? end : position,
							alignment,
							leader: TAB_LEADERS[tab.leader] ?? TabLeader.NONE
						}
					})
				)

	tabCache.set(props, { end, stops })

	return stops
}

function alignmentOf(props: ResolvedParagraphProps): Alignment {
	switch (props.alignment) {
		case "center":
			return Alignment.CENTER
		case "end":
		case "right":
			return Alignment.END
		case "both":
		case "mediumKashida":
		case "highKashida":
		case "lowKashida":
		case "thaiDistribute":
			return Alignment.BOTH
		case "distribute":
			return Alignment.DISTRIBUTE
		default:
			return Alignment.START
	}
}

// Fills `g` for a paragraph in a column [left, left + width). `gridPitch` > 0 snaps auto-spaced lines to
// the document grid: whole rows, at least the spacing multiple of one.
export function paragraphGeometry(
	g: Geometry,
	props: ResolvedParagraphProps,
	left: number,
	width: number,
	compat: LayoutCompat,
	gridPitch: number
): Geometry {
	const indent = props.indent
	const spacing = props.spacing

	g.left = left
	g.width = width
	g.startIndent = twips(indent.start) + (compat.joinsBoxes ? borderInset(props.borders?.start) : 0)
	g.endIndent = twips(indent.end) + (compat.joinsBoxes ? borderInset(props.borders?.end) : 0)
	g.firstLineIndent = twips(indent.firstLine)
	g.rtl = props.bidi
	g.alignment = alignmentOf(props)
	g.tabs = tabStops(props, width - twips(indent.end))
	g.defaultTabStop = compat.defaultTabStop
	g.expandLineBreaks = compat.expandLineBreaks
	g.hangingIndentTab = compat.hangingIndentTab
	g.decimalSeparator = compat.decimalSeparator
	g.markSizesObjectLines = compat.markSizesObjectLines
	g.libreOfficeSpacing = compat.libreOfficeSpacing
	g.exclusions = null
	g.gridPitch = gridPitch

	if (spacing.lineRule === "exact") {
		g.lineRule = LineRule.EXACT
		g.lineSpacing = twips(Math.abs(spacing.line))
	} else if (spacing.lineRule === "atLeast") {
		g.lineRule = LineRule.AT_LEAST
		g.lineSpacing = twips(spacing.line)
	} else {
		const multiple = spacing.line > 0 ? spacing.line / 240 : 1

		if (gridPitch > 0 && props.snapToGrid) {
			g.lineRule = LineRule.GRID
			g.lineSpacing = gridPitch * multiple
		} else {
			g.lineRule = LineRule.AUTO
			g.lineSpacing = multiple
		}
	}

	return g
}

// Auto spacing (w:beforeAutospacing / w:afterAutospacing), before and after in px: under
// w:doNotUseHTMLParagraphAutoSpacing a fixed 5 pt before and 10 pt after (ECMA-376 Part 4); otherwise
// HTML-style values the layout tuning gives.
export interface AutoSpacing {
	readonly before: number
	readonly after: number
}

export const FIXED_AUTO_SPACING: AutoSpacing = { before: points(5), after: points(10) }

// w:beforeLines / w:afterLines count hundredths of a 12 pt line.
const LINE_UNIT = points(12)

export function spaceBefore(props: ResolvedParagraphProps, auto: AutoSpacing): number {
	const spacing = props.spacing

	if (spacing.beforeAutospacing) return auto.before
	if (spacing.beforeLines !== undefined && spacing.beforeLines > 0) return (spacing.beforeLines / 100) * LINE_UNIT

	return twips(Math.max(0, spacing.before))
}

export function spaceAfter(props: ResolvedParagraphProps, auto: AutoSpacing): number {
	const spacing = props.spacing

	if (spacing.afterAutospacing) return auto.after
	if (spacing.afterLines !== undefined && spacing.afterLines > 0) return (spacing.afterLines / 100) * LINE_UNIT

	return twips(Math.max(0, spacing.after))
}

// A page of a section in px.
export interface PageGeometry {
	readonly width: number
	readonly height: number
	readonly left: number
	readonly right: number
	// Text area top and bottom edges before headers and footers push them.
	readonly top: number
	readonly bottom: number
	// Negative margins fix the edge however tall the header or footer is.
	readonly topFixed: boolean
	readonly bottomFixed: boolean
	readonly header: number
	readonly footer: number
	// Columns: offsets from `left` and widths.
	readonly columnX: readonly number[]
	readonly columnWidths: readonly number[]
	readonly separator: boolean
	readonly gridPitch: number
}

// `odd`: the page number is odd (mirrored margins swap the inside and outside on even pages).
export function pageGeometry(section: ResolvedSectionProps, compat: LayoutCompat, odd: boolean): PageGeometry {
	const width = twips(section.pageWidth)
	const height = twips(section.pageHeight)
	const margins = section.margins
	const gutter = twips(Math.max(0, margins.gutter))
	let left = twips(margins.left)
	let right = twips(margins.right)
	let top = twips(Math.abs(margins.top))
	const bottomMargin = twips(Math.abs(margins.bottom))

	if (compat.mirrorMargins && !odd) [left, right] = [right, left]

	if (compat.gutterAtTop) top += gutter
	else if (section.rtlGutter) right += gutter
	else if (compat.mirrorMargins && !odd) right += gutter
	else left += gutter

	const textWidth = Math.max(1, width - left - right)
	const columns = section.columns
	const count = Math.max(1, Math.min(columns.count, 45))
	const columnX: number[] = []
	const columnWidths: number[] = []

	if (count > 1 && !columns.equalWidth && columns.columns !== undefined && columns.columns.length > 0) {
		let x = 0

		for (const column of columns.columns) {
			const w = twips(column.width ?? 0)

			columnX.push(x)
			columnWidths.push(Math.max(1, w))
			x += w + twips(column.space ?? 0)
		}
	} else {
		const space = count > 1 ? twips(columns.space) : 0
		const w = Math.max(1, (textWidth - space * (count - 1)) / count)

		for (let c = 0; c < count; c++) {
			columnX.push(c * (w + space))
			columnWidths.push(w)
		}
	}

	if (section.bidi) {
		for (let c = 0; c < columnX.length; c++) columnX[c] = textWidth - (columnX[c] ?? 0) - (columnWidths[c] ?? 0)
	}

	const grid = section.docGrid

	return {
		width,
		height,
		left,
		right,
		top,
		bottom: height - bottomMargin,
		topFixed: margins.top < 0,
		bottomFixed: margins.bottom < 0,
		header: twips(margins.header),
		footer: twips(margins.footer),
		columnX,
		columnWidths,
		separator: columns.separator && count > 1,
		gridPitch:
			(grid.type === "lines" || grid.type === "linesAndChars") && grid.linePitch !== undefined && grid.linePitch > 0
				? twips(grid.linePitch)
				: 0
	}
}
