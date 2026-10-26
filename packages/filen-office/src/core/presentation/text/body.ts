import { DecorationTable } from "../../docx/layout/styles"
import { cssFont, symbolTable, symbolText, verticalMetrics, type FontRequest, type ResolvedFont } from "../../fonts/index"
import { forEachDrawingSlotRun, type DrawingSlot } from "../../fonts/drawingSlots"
import { rgba, rgbaAlpha, rgbaHex, type Paint, type Rgba, type Stroke } from "../../drawingml/index"
import type { DocxLinkTarget, DocxTextStyle } from "../../docx/layout/index"
import {
	Alignment,
	Caps,
	FRAGMENT_INTS,
	LINE_INTS,
	LayoutCursor,
	LayoutStatus,
	MeasureCache,
	ParagraphBuilder,
	ParagraphLayouter,
	StyleTable,
	Strike,
	TabAlignment,
	TabLeader,
	TabStops,
	TextLayout,
	kinsokuLists,
	Kinsoku,
	type ParagraphGeometry,
	type TabStop,
	type TextStyle
} from "../../text/index"
import { PresentationError, type Action, type ParaProps, type RunProps } from "../model"
import type { RenderEffects, TextPage } from "../output"
import { AutonumberCounters, autonumberText } from "./autonum"
import { resolveTextEffects, resolveTextFill, resolveTextLine } from "./color"
import { fieldText, type FieldContext } from "./fields"
import { assemblePage } from "./page"
import type { ResolvedBody, ResolvedParagraph, TextFonts } from "./resolve"
import { lineSpacing, paragraphSpace, PT_PX } from "./spacing"
import { mirrorLines, splitUpright, stackUpright, turnOf } from "./vertical"

// Lays out one DrawingML text body (resolved along its inheritance chain) into a TextPage the docx painters draw:
// paragraphs through core/text's ParagraphBuilder and ParagraphLayouter, runs as TextStyles (the font of each
// character's DrawingML slot, size, bold/italic, the 17 underline kinds, strike, baseline, caps, spacing,
// kerning, highlight), bullets as a synthetic marker plus a hanging tab to marL, columns by resuming the cursor in
// the next column, anchoring, autofit as the file stores it, and vertical text in a turned box.

export interface TextEnvironment {
	// Fonts prepared beforehand (fontRequests): resolve() is synchronous.
	readonly fonts: { resolve(request: FontRequest): ResolvedFont }
	readonly cache: MeasureCache
}

export interface LayoutOptions {
	readonly fields?: FieldContext
	// The theme's hyperlink colour slot drawn for linked runs (PowerPoint draws hyperlinks in hlink, underlined).
	readonly hyperlinks?: boolean
	// "face": lines take the face's own hhea ascent and descent rather than the font-independent single line, as
	// LibreOffice 7.5 lays out table cell text (measured; ECMA and MS-OI29500 are silent).
	readonly lineMetrics?: "fontIndependent" | "face"
}

// Text runs one body may hold (plan §1.12): larger bodies are refused before any layout.
export const MAX_BODY_RUNS = 100_000

export interface BodyLayout {
	readonly page: TextPage
	// The laid-out lines in page px (for hit testing; the page carries copies).
	readonly layout: TextLayout
	readonly styles: StyleTable
	// The height the text needs (spAutoFit grows the shape to it, insets excluded), px.
	readonly height: number
	// Whether the text runs past the box (it is drawn anyway).
	readonly overflow: boolean
	// How the page is turned onto the box (turnOf): 90 (vert, eaVert, mongolianVert), 270 (vert270) or 0. The page's
	// width and height are the turned box's.
	readonly turn: 0 | 90 | 270
	// Per paragraph, the length of the generated marker (bullet or number and its tab) its text starts with.
	readonly prefixes: Int32Array
}

const ALIGNMENT: Readonly<Record<string, number>> = {
	l: Alignment.START,
	ctr: Alignment.CENTER,
	r: Alignment.END,
	just: Alignment.BOTH,
	justLow: Alignment.BOTH,
	dist: Alignment.DISTRIBUTE,
	thaiDist: Alignment.DISTRIBUTE
}

const TAB_ALIGNMENT: Readonly<Record<string, number>> = {
	l: TabAlignment.START,
	ctr: TabAlignment.CENTER,
	r: TabAlignment.END,
	dec: TabAlignment.DECIMAL
}

// DrawingML underline kinds (ST_TextUnderlineType) as the painters name them (ST_Underline, WordprocessingML).
const UNDERLINE_STYLE: Readonly<Record<string, string>> = {
	sng: "single",
	words: "single",
	dbl: "double",
	heavy: "thick",
	dotted: "dotted",
	dottedHeavy: "dottedHeavy",
	dash: "dash",
	dashHeavy: "dashedHeavy",
	dashLong: "dashLong",
	dashLongHeavy: "dashLongHeavy",
	dotDash: "dotDash",
	dotDashHeavy: "dashDotHeavy",
	dotDotDash: "dotDotDash",
	dotDotDashHeavy: "dashDotDotHeavy",
	wavy: "wave",
	wavyHeavy: "wavyHeavy",
	wavyDbl: "wavyDouble"
}

const EMU_PX = 9525
// The face drawn when neither the run, the theme nor the fallbacks name one.
const DEFAULT_TYPEFACE = "Arial"
// a:rPr@sz default (ECMA-376 §21.1.2.3.9): 18 pt.
const DEFAULT_SIZE = 1800
// Superscript and subscript size: LibreOffice's DFLT_ESC_PROP (58%), which it applies to a:rPr@baseline (PowerPoint
// documents none).
const ESCAPEMENT_SIZE = 0.58
// a:pPr@defTabSz default: one inch.
const DEFAULT_TAB = 96
const BLACK = rgba("000000")
const AUTO_KINSOKU = new Map<string, Kinsoku | null>()

// What one run looks like, resolved: the interned TextStyle plus the page table entries it draws with.
interface RunLook {
	readonly style: TextStyle
	readonly text: DocxTextStyle
	readonly slot: DrawingSlot
}

// A single line of DrawingML text depends on the point size only, whatever the face: ECMA-376 §21.1.2.2.5 (lnSpc)
// determines the spacing "by the point size of the largest piece of text within a line". Neither ECMA nor
// MS-OI29500 gives the factor, so it is LibreOffice 7.5's, as measured (the fallback RULES allow where PowerPoint
// documents nothing): its EditEngine lays presentation text out font-independently (ImpEditEngine, FixedCellHeight:
// ImplCalculateFontIndependentLineSpacing) at 1.2 times the size with the baseline at the size, which its PDFs show
// on every corpus face (line pitch 1.200, first baseline 1.000 of the size).
const SINGLE_LINE = verticalMetrics(1000, 1000, -200, 0, 1000, -200, 0, 1000, 200, false)
const lineFonts = new WeakMap<ResolvedFont, Map<number, ResolvedFont>>()

// `lineScale` scales the single line against the drawn size: a paragraph's marker (bullet or number) drawn at
// `factor` times the text's size takes 1 / factor, so its line is the text's. LibreOffice's EditEngine draws the
// marker outside the text's lines, so a larger bullet never makes the first line taller (measured, LibreOffice 7.5;
// ECMA and MS-OI29500 are silent). With `face`, the face's own metrics are kept (scaled the same way).
function withSingleLine(font: ResolvedFont, lineScale: number, face: boolean): ResolvedFont {
	if (face) return lineScale === 1 || font.metrics === null ? font : { ...font, metrics: scaledMetrics(font.metrics, lineScale) }

	let scales = lineFonts.get(font)

	if (scales === undefined) {
		scales = new Map()
		lineFonts.set(font, scales)
	}

	let out = scales.get(lineScale)

	if (out === undefined) {
		const metrics =
			lineScale === 1
				? SINGLE_LINE
				: verticalMetrics(
						1000,
						1000 * lineScale,
						-200 * lineScale,
						0,
						1000 * lineScale,
						-200 * lineScale,
						0,
						1000 * lineScale,
						200 * lineScale,
						false
					)

		// Published metrics of the nominal size ("original"), so a substitute's size correction does not change it.
		out = { ...font, metrics, metricsBasis: "original" }
		scales.set(lineScale, out)
	}

	return out
}

function scaledMetrics(metrics: NonNullable<ResolvedFont["metrics"]>, scale: number): NonNullable<ResolvedFont["metrics"]> {
	return verticalMetrics(
		metrics.unitsPerEm,
		metrics.hheaAscender * scale,
		metrics.hheaDescender * scale,
		metrics.hheaLineGap * scale,
		metrics.typoAscender * scale,
		metrics.typoDescender * scale,
		metrics.typoLineGap * scale,
		metrics.winAscent * scale,
		metrics.winDescent * scale,
		metrics.useTypoMetrics
	)
}

// Per layout call: the style table, the page tables and the interning of both.
class Session {
	readonly styles: StyleTable
	readonly decorations = new DecorationTable()
	readonly docxStyles: DocxTextStyle[] = []
	readonly paints: Paint[] = []
	readonly strokes: Stroke[] = []
	readonly effects: RenderEffects[] = []
	readonly links: DocxLinkTarget[] = []
	readonly linkInts: number[] = []
	// Per style id, the run's font size as drawn before any superscript or subscript reduction (px): percentage
	// paragraph spacing is taken from it.
	readonly sizes: number[] = []
	private readonly looks = new Map<string, number>()
	private readonly paintKeys = new Map<string, number>()
	private readonly strokeKeys = new Map<string, number>()
	private readonly effectKeys = new Map<string, number>()
	private readonly linkKeys = new Map<string, number>()

	readonly env: TextEnvironment
	readonly body: ResolvedBody
	readonly scale: number
	readonly options: LayoutOptions

	constructor(env: TextEnvironment, body: ResolvedBody, scale: number, options: LayoutOptions) {
		this.env = env
		this.body = body
		this.scale = scale
		this.options = options
		this.styles = new StyleTable(env.cache, options.lineMetrics === "face" ? "hhea" : "gdi")
	}

	paint(paint: Paint): number {
		const key = paintKey(paint)
		let index = this.paintKeys.get(key)

		if (index === undefined) {
			index = this.paints.length
			this.paints.push(paint)
			this.paintKeys.set(key, index)
		}

		return index
	}

	stroke(stroke: Stroke): number {
		const key = JSON.stringify({ ...stroke, customDash: stroke.customDash === null ? null : Array.from(stroke.customDash) })
		let index = this.strokeKeys.get(key)

		if (index === undefined) {
			index = this.strokes.length
			this.strokes.push(stroke)
			this.strokeKeys.set(key, index)
		}

		return index
	}

	effect(effects: RenderEffects): number {
		const key = JSON.stringify(effects)
		let index = this.effectKeys.get(key)

		if (index === undefined) {
			index = this.effects.length
			this.effects.push(effects)
			this.effectKeys.set(key, index)
		}

		return index
	}

	link(action: Action): number {
		const target: DocxLinkTarget | undefined = linkTarget(action)

		if (target === undefined) return -1

		const key = target.kind === "external" ? `e${target.href}` : `i${target.anchor}`
		let index = this.linkKeys.get(key)

		if (index === undefined) {
			index = this.links.length
			this.links.push(target)
			this.linkKeys.set(key, index)
		}

		return index
	}

	// The style id of a run's look in `slot`.
	// `marker`: the paragraph's bullet or number, whose size does not set the line's height.
	look(props: RunProps, slot: DrawingSlot, sizeFactor = 1, colorOverride?: Rgba, fontOverride?: string, marker = false): number {
		const key = lookKey(props, slot, sizeFactor, colorOverride, fontOverride, marker)
		const known = this.looks.get(key)

		if (known !== undefined) return known

		const look = this.build(props, slot, sizeFactor, colorOverride, fontOverride, marker)
		const id = this.styles.add(look.style)

		this.looks.set(key, id)
		this.docxStyles[id] = look.text
		this.sizes[id] = ((props.sz ?? DEFAULT_SIZE) / 100) * PT_PX * this.scale * sizeFactor

		return id
	}

	private build(
		props: RunProps,
		slot: DrawingSlot,
		sizeFactor: number,
		colorOverride: Rgba | undefined,
		fontOverride: string | undefined,
		marker: boolean
	): RunLook {
		const fonts = this.body.fonts
		const colorOf = fonts.color
		const baseSize = ((props.sz ?? DEFAULT_SIZE) / 100) * PT_PX * this.scale * sizeFactor
		const escaped = (props.baseline ?? 0) !== 0
		const size = escaped ? baseSize * ESCAPEMENT_SIZE : baseSize
		const shift = ((props.baseline ?? 0) / 100000) * baseSize
		const drawn = this.env.fonts.resolve(fontRequest(props, slot, fonts, fontOverride))
		const font = withSingleLine(drawn, marker && sizeFactor > 0 ? 1 / sizeFactor : 1, this.options.lineMetrics === "face")
		const sizePt = (props.sz ?? DEFAULT_SIZE) / 100
		const kerning = props.kern === undefined || props.kern === 0 || sizePt * 100 >= props.kern
		const letterSpacing = ((props.spc ?? 0) / 100) * PT_PX
		const linked = this.options.hyperlinks !== false && props.hlinkClick !== undefined && linkTarget(props.hlinkClick) !== undefined
		const hlink = linked ? colorOf({ kind: "scheme", slot: "hlink" }) : undefined
		const fill =
			colorOverride !== undefined
				? { kind: "color" as const, color: colorOverride }
				: resolveTextFill(props.fill ?? solidText, colorOf, BLACK)
		const color = hlink ?? (fill.kind === "color" ? fill.color : fill.kind === "paint" ? averagePaint(fill.paint) : BLACK)
		const underline = props.u ?? (linked ? "sng" : "none")
		const underlineColor =
			props.uFill !== undefined && props.uFill !== "text"
				? (() => {
						const resolved = resolveTextFill(props.uFill, colorOf, color)

						return resolved.kind === "color" ? resolved.color : undefined
					})()
				: undefined
		const highlight = props.highlight === undefined ? undefined : colorOf(props.highlight)
		const style: TextStyle = {
			font,
			size,
			kerning,
			letterSpacing,
			...(props.cap === "all" ? { caps: Caps.CAPS } : props.cap === "small" ? { caps: Caps.SMALL_CAPS } : {}),
			...(shift !== 0 ? { baselineShift: shift } : {}),
			...(underline !== "none"
				? { underline: this.decorations.underline(UNDERLINE_STYLE[underline] ?? "single", hexOf(underlineColor)) }
				: {}),
			...(underline === "words" ? { underlineWords: true } : {}),
			...(props.strike === "sngStrike" ? { strike: Strike.SINGLE } : props.strike === "dblStrike" ? { strike: Strike.DOUBLE } : {}),
			...(highlight !== undefined ? { highlight: this.decorations.color(rgbaHex(highlight)) } : {})
		}
		const css = cssFont(drawn, size)
		const extents = this.env.cache.measurer.fontExtents(css)
		const outline =
			props.ln === undefined || props.ln === "none" ? undefined : resolveTextLine(props.ln, colorOf, paint => this.paint(paint))
		const effects = props.effects === undefined ? [] : resolveTextEffects(props.effects, colorOf)
		const alpha = hlink === undefined && fill.kind === "color" ? rgbaAlpha(fill.color) : 1
		const text: DocxTextStyle = {
			font: css,
			smallCapsFont: cssFont(drawn, size * 0.7),
			color: fill.kind === "none" && outline === undefined ? "" : rgbaHex(color),
			kerning,
			letterSpacing,
			scaleX: 1,
			shift,
			ascent: extents.ascent,
			descent: extents.descent,
			revision: 0,
			...(hlink === undefined && fill.kind === "paint" ? { paint: this.paint(fill.paint) } : {}),
			...(fill.kind === "none" ? { alpha: 0 } : alpha < 1 ? { alpha } : {}),
			...(outline === undefined ? {} : { outline: this.stroke(outline) }),
			...(effects.length === 0 ? {} : { effects: this.effect(effects) })
		}

		return { style, text, slot }
	}
}

const solidText = { kind: "solid" as const, color: { kind: "scheme" as const, slot: "tx1" as const } }

function hexOf(color: Rgba | undefined): string | undefined {
	return color === undefined ? undefined : rgbaHex(color)
}

function averagePaint(paint: Paint): Rgba {
	if (paint.kind === "solid") return paint.color
	if (paint.kind === "pattern") return paint.foreground
	if (paint.kind === "linear" || paint.kind === "path" || paint.kind === "gradient") return paint.stops.colors[0] ?? BLACK

	return BLACK
}

function paintKey(paint: Paint): string {
	if (paint.kind === "linear" || paint.kind === "path" || paint.kind === "gradient") {
		return JSON.stringify({ ...paint, stops: { offsets: Array.from(paint.stops.offsets), colors: Array.from(paint.stops.colors) } })
	}

	return JSON.stringify(paint)
}

function linkTarget(action: Action): DocxLinkTarget | undefined {
	switch (action.kind) {
		case "url":
			return { kind: "external", href: action.href, tooltip: undefined }
		case "slide":
			return { kind: "internal", anchor: `slide:${action.slide}`, tooltip: undefined }
		case "internal":
			return { kind: "internal", anchor: `jump:${action.jump}`, tooltip: undefined }
		case "customShow":
			return { kind: "internal", anchor: `show:${action.id}:${action.returnAfter ? 1 : 0}`, tooltip: undefined }
		// Playing the shape's media navigates nowhere: the show runs it on click, the text carries no link.
		case "media":
		case "refused":
			return undefined
	}
}

function lookKey(
	props: RunProps,
	slot: DrawingSlot,
	sizeFactor: number,
	colorOverride: Rgba | undefined,
	fontOverride: string | undefined,
	marker: boolean
): string {
	return JSON.stringify([props, slot, sizeFactor, colorOverride ?? null, fontOverride ?? null, marker], (_key, value: unknown) =>
		value instanceof Float64Array ? Array.from(value) : value
	)
}

// The font a run draws `slot` characters with: the slot's own typeface, theme references resolved, else the latin
// one (PowerPoint falls back to it), else the theme's minor font.
function fontRequest(props: RunProps, slot: DrawingSlot, fonts: TextFonts, fontOverride: string | undefined): FontRequest {
	const lang = slot === "ea" || slot === "cs" ? (props.altLang ?? props.lang) : props.lang
	// An empty typeface, written or resolved through the theme, is no typeface (LibreOffice 7.5 draws such text in
	// its default, Arial-metric face; ECMA and MS-OI29500 are silent).
	const typeface = (value: string | undefined): string | undefined => {
		const resolved = value === undefined || value === "" ? undefined : fonts.typeface(value, lang)

		return resolved === "" ? undefined : resolved
	}
	const own = slot === "ea" ? props.ea : slot === "cs" ? props.cs : slot === "sym" ? props.sym : props.latin
	const family =
		fontOverride ??
		typeface(own?.typeface) ??
		typeface(props.latin?.typeface) ??
		typeface(slot === "ea" ? "+mn-ea" : slot === "cs" ? "+mn-cs" : "+mn-lt") ??
		typeface("+mn-lt") ??
		DEFAULT_TYPEFACE

	return {
		family,
		bold: props.b === true,
		italic: props.i === true,
		slot: slot === "ea" ? "eastAsia" : slot === "cs" ? "cs" : "ascii"
	}
}

// Every font a body draws with, for FontManager.prepare before layoutBody.
export function fontRequests(body: ResolvedBody): FontRequest[] {
	const out = new Map<string, FontRequest>()
	const add = (props: RunProps): void => {
		for (const slot of ["latin", "ea", "cs", "sym"] as const) {
			const request = fontRequest(props, slot, body.fonts, undefined)

			out.set(`${request.family}\u0000${request.bold ? 1 : 0}${request.italic ? 1 : 0}${request.slot}`, request)
		}
	}

	for (const paragraph of body.paragraphs) {
		add(paragraph.endRPr)

		for (const run of paragraph.runs) if (run.kind !== "opaque") add(run.rPr)

		const bullet = paragraph.pPr.buFont

		if (bullet !== undefined && bullet !== "text" && bullet.typeface !== "") {
			out.set(`${bullet.typeface}\u0000000ascii`, {
				family: body.fonts.typeface(bullet.typeface, undefined) ?? bullet.typeface,
				bold: false,
				italic: false,
				slot: "ascii"
			})
		}
	}

	return [...out.values()]
}

function kinsokuFor(lang: string | undefined): Kinsoku | null {
	const key = lang ?? ""
	let kinsoku = AUTO_KINSOKU.get(key)

	if (kinsoku === undefined) {
		const lists = kinsokuLists(lang, false)

		kinsoku = lists === null ? null : new Kinsoku(lists.noStart, lists.noEnd)
		AUTO_KINSOKU.set(key, kinsoku)
	}

	return kinsoku
}

// The first run's properties: the colour and font of the bullet, the first guess of the size spacing is taken from.
function firstRunProps(paragraph: ResolvedParagraph): RunProps {
	for (const run of paragraph.runs) if (run.kind !== "opaque") return run.rPr

	return paragraph.endRPr
}

function hasText(paragraph: ResolvedParagraph): boolean {
	for (const run of paragraph.runs) {
		if (run.kind === "br") return true
		if (run.text.length > 0) return true
	}

	return false
}

// Appends a paragraph's marker (bullet character, number or picture stand-in) and its tab when it leaves room for
// one; returns its length.
function appendBullet(session: Session, builder: ParagraphBuilder, paragraph: ResolvedParagraph, counters: AutonumberCounters): number {
	const pPr = paragraph.pPr
	const bullet = pPr.bullet

	if (bullet === undefined || bullet.kind === "none" || !hasText(paragraph)) {
		if (bullet?.kind !== "autoNum") counters.skip(paragraph.level)

		return 0
	}

	const first = firstRunProps(paragraph)
	let text: string
	let font: string | undefined

	if (bullet.kind === "autoNum") {
		text = autonumberText(bullet.scheme, counters.next(paragraph.level, bullet.scheme, bullet.startAt ?? 1))
	} else {
		counters.skip(paragraph.level)
		// A picture bullet is drawn as a bullet character at the picture's size until pictures reach text pages.
		text = bullet.kind === "char" ? bullet.char : "•"
	}

	if (text.length === 0) return 0

	const buFont = pPr.buFont

	// An empty bullet typeface is none: the bullet takes the text's font.
	if (bullet.kind === "char" && buFont !== undefined && buFont !== "text" && buFont.typeface !== "") {
		const family = session.body.fonts.typeface(buFont.typeface, undefined) ?? buFont.typeface
		const table = symbolTable(family)

		// Symbol fonts draw their characters as the Unicode ones they show, in the text's font.
		if (table === undefined) font = family
		else text = symbolText(table, text)
	}

	const size = pPr.buSz
	const factor = size === undefined || size === "text" ? 1 : "pct" in size ? size.pct / 100000 : size.pts / (first.sz ?? DEFAULT_SIZE)
	const colorModel = pPr.buClr
	const color = colorModel === undefined || colorModel === "text" ? undefined : session.body.fonts.color(colorModel)
	const props: RunProps = {
		...first,
		u: "none",
		strike: "noStrike",
		baseline: 0,
		...(bullet.kind === "autoNum" ? {} : { b: false, i: false })
	}
	const style = session.look(props, "latin", Math.max(0.05, Math.min(4, factor)), color, font, true)
	const before = builder.length

	builder.append(text, style)

	// The marker sits at marL + indent and a hanging tab takes the text to marL. When the marker reaches marL or
	// beyond, the text follows it directly rather than going to the next default tab stop (LibreOffice 7.5, measured;
	// ECMA and MS-OI29500 are silent).
	const room = -(pPr.indent ?? 0) / EMU_PX
	const width = session.env.cache.width(session.styles.fontKey[style] ?? 0, text, 0, text.length)

	if (width < room) builder.tab(style)

	return builder.length - before
}

function appendRuns(session: Session, builder: ParagraphBuilder, paragraph: ResolvedParagraph, source: number, fields: FieldContext): void {
	for (const run of paragraph.runs) {
		if (run.kind === "br") {
			builder.lineBreak(session.look(run.rPr, "latin"))
			continue
		}

		const props = run.kind === "opaque" ? paragraph.defRPr : run.rPr
		const text = run.kind === "fld" ? fieldText(run.type, run.text, fields) : run.text

		if (text.length === 0) continue

		const symbol =
			props.sym === undefined
				? undefined
				: symbolTable(session.body.fonts.typeface(props.sym.typeface, undefined) ?? props.sym.typeface)
		const start = builder.length

		forEachDrawingSlotRun(text, props.sym !== undefined, "latin", (from, to, slot) => {
			let piece = text.slice(from, to)

			if (slot === "sym" && symbol !== undefined) piece = symbolText(symbol, piece)

			builder.append(piece, session.look(props, slot))
		})

		if (run.kind !== "opaque" && props.hlinkClick !== undefined) {
			const link = session.link(props.hlinkClick)

			if (link >= 0) session.linkInts.push(source, start, builder.length, link)
		}
	}
}

function geometryOf(
	paragraph: ResolvedParagraph,
	left: number,
	width: number,
	spacing: ReturnType<typeof lineSpacing>,
	wrap: boolean
): ParagraphGeometry {
	const pPr: ParaProps = paragraph.pPr
	const rtl = pPr.rtl === true
	let alignment = ALIGNMENT[pPr.algn ?? "l"] ?? Alignment.START

	// a:pPr@algn names physical sides; core/text's START is the right edge of a right-to-left paragraph.
	if (rtl && alignment === Alignment.START) alignment = Alignment.END
	else if (rtl && alignment === Alignment.END) alignment = Alignment.START

	const stops: TabStop[] = (pPr.tabs ?? []).map(tab => ({
		position: tab.pos / EMU_PX,
		alignment: (TAB_ALIGNMENT[tab.algn] ?? TabAlignment.START) as TabStop["alignment"],
		leader: TabLeader.NONE
	}))

	return {
		left,
		width: wrap ? width : UNWRAPPED,
		startIndent: (pPr.marL ?? 0) / EMU_PX,
		endIndent: wrap ? (pPr.marR ?? 0) / EMU_PX : 0,
		firstLineIndent: (pPr.indent ?? 0) / EMU_PX,
		rtl,
		alignment: (wrap ? alignment : Alignment.START) as ParagraphGeometry["alignment"],
		tabs: stops.length === 0 ? null : new TabStops(stops),
		defaultTabStop: pPr.defTabSz === undefined || pPr.defTabSz <= 0 ? DEFAULT_TAB : pPr.defTabSz / EMU_PX,
		lineRule: spacing.rule,
		lineSpacing: spacing.value,
		editEngineSpacing: true
	}
}

// The width an unwrapped paragraph (wrap="none") is laid out in: one line per paragraph and line break.
const UNWRAPPED = 1e7

export function layoutBody(
	resolved: ResolvedBody,
	// The text box (px): the text rectangle minus the insets, turned (width and height swapped) when turnOf(vert)
	// turns the body, as the renderer places it.
	box: { readonly width: number; readonly height: number },
	env: TextEnvironment,
	options: LayoutOptions = {}
): BodyLayout {
	let runCount = 0

	for (const paragraph of resolved.paragraphs) runCount += paragraph.runs.length

	if (runCount > MAX_BODY_RUNS) throw new PresentationError("tooLarge", `${runCount} text runs in one body`)

	const bodyPr = resolved.bodyPr
	const vertical = bodyPr.vertical
	const turn = turnOf(vertical)
	const stacked = vertical === "wordArtVert" || vertical === "wordArtVertRtl"
	const sideways = vertical === "eaVert" || vertical === "mongolianVert"
	// Stacked columns are laid out horizontally across the column's length (the box's height) first.
	const frameWidth = Math.max(0, stacked ? box.height : box.width)
	const frameHeight = Math.max(0, stacked ? box.width : box.height)
	const normal = bodyPr.autofit === "normal"
	const scale = normal ? Math.max(0.01, bodyPr.fontScale) : 1
	const reduction = normal ? Math.max(0, bodyPr.lineSpacingReduction) : 0
	const session = new Session(env, resolved, scale, options)
	const layouter = new ParagraphLayouter(session.styles)
	const builder = new ParagraphBuilder()
	const out = new TextLayout()
	const cursor = new LayoutCursor()
	const counters = new AutonumberCounters()
	const fields = options.fields ?? {}
	const texts: string[] = []
	const prefixes = new Int32Array(resolved.paragraphs.length)
	const columns = Math.max(1, Math.min(16, Math.trunc(bodyPr.columns)))
	const gap = Math.max(0, bodyPr.columnSpacing)
	const columnWidth = columns > 1 ? Math.max(1, (frameWidth - (columns - 1) * gap) / columns) : frameWidth
	const wrap = bodyPr.wrap && !stacked
	let column = 0
	let y = 0
	let previousAfter = 0
	let bottom = 0

	resolved.paragraphs.forEach((paragraph, index) => {
		const first = firstRunProps(paragraph)
		const fontPx = ((first.sz ?? DEFAULT_SIZE) / 100) * PT_PX * scale
		const spcBef = index === 0 ? undefined : paragraph.pPr.spcBef
		// The first run's size is the guess; a larger run on the first line lays the paragraph out again.
		let before = paragraphSpace(spcBef, fontPx, scale)
		// LibreOffice's EditEngine leaves proportional spacing (and the autofit reduction) off the very first line of
		// the text when its paragraph is empty (ImpEditEngine::CreateAndInsertEmptyLine, measured; ECMA is silent).
		const lnSpc = paragraph.pPr.lnSpc
		const spacing =
			index === 0 && !hasText(paragraph) && (lnSpc === undefined || "pct" in lnSpc)
				? lineSpacing(undefined, 0, scale)
				: lineSpacing(lnSpc, reduction, scale)
		const markStyle = session.look(paragraph.endRPr, "latin")

		builder.reset(markStyle)
		prefixes[index] = appendBullet(session, builder, paragraph, counters)
		appendRuns(session, builder, paragraph, index, fields)

		const text = builder.finish()

		texts.push(text.text)

		const lang = first.lang
		const prepared = layouter.prepare(text, {
			rtl: paragraph.pPr.rtl === true,
			source: index,
			kinsoku: kinsokuFor(lang),
			wordWrap: paragraph.pPr.eaLnBrk !== false,
			hangingPunctuation: paragraph.pPr.hangingPunct === true
		})

		const startLine = out.lineCount
		const startColumn = column
		const startY = y + previousAfter

		y = startY + before
		cursor.reset()

		for (;;) {
			const left = column * (columnWidth + gap)
			const last = column >= columns - 1
			// Only a column's first line is placed when it does not fit: later ones move to the next column.
			const status = layouter.layout(
				prepared,
				geometryOf(paragraph, left, columnWidth, spacing, wrap),
				out,
				cursor,
				y,
				last ? Infinity : frameHeight,
				last || y <= 0
			)

			y = cursor.y

			if (status === LayoutStatus.OVERFLOW || status === LayoutStatus.NO_ROOM) {
				column++
				y = 0
				continue
			}

			// Done (page and column breaks never occur in DrawingML text).
			if (spcBef === undefined || !("pct" in spcBef) || out.lineCount === startLine) break

			const exact = paragraphSpace(spcBef, largestSize(session, out, startLine, prefixes[index] ?? 0, fontPx), scale)

			if (Math.abs(exact - before) < 0.001) break

			before = exact
			out.truncate(startLine)
			column = startColumn
			y = startY + before
			cursor.reset()
		}

		const lastLine = out.lineCount - 1
		const after = paragraphSpace(
			paragraph.pPr.spcAft,
			lastLine >= startLine ? largestSize(session, out, lastLine, prefixes[index] ?? 0, fontPx) : fontPx,
			scale
		)

		previousAfter = after
		bottom = Math.max(bottom, y)
	})

	const height = bottom
	const overflow = height > frameHeight + 0.5 || column >= columns

	if (!wrap && !stacked) alignUnwrapped(out, resolved, frameWidth)

	anchor(out, bodyPr.anchor, bodyPr.anchorCenter, frameWidth, frameHeight, columns > 1 ? frameHeight : height)

	if (vertical === "mongolianVert") mirrorLines(out, frameHeight)

	const laid = sideways ? splitUpright(out, texts, session) : out
	const page = stacked
		? stackUpright(out, texts, session, frameWidth, frameHeight, vertical === "wordArtVert")
		: assemblePage(laid, texts, session, frameWidth, frameHeight)

	return { page, layout: laid, styles: session.styles, height, overflow, turn, prefixes }
}

export type { Session as BodySession }

// The largest font size of the text on one line (the paragraph's marker excluded), px; `fallback` for a line
// without text (ECMA-376 §21.1.2.2.11: percentage spacing is taken from the largest text on the line).
function largestSize(session: Session, out: TextLayout, line: number, prefix: number, fallback: number): number {
	const first = out.lineInts[line * LINE_INTS] ?? 0
	const count = out.lineInts[line * LINE_INTS + 1] ?? 0
	let size = 0

	for (let k = first; k < first + count; k++) {
		const at = k * FRAGMENT_INTS

		if ((out.fragmentInts[at + 1] ?? 0) <= prefix) continue

		size = Math.max(size, session.sizes[out.fragmentInts[at + 2] ?? -1] ?? 0)
	}

	return size > 0 ? size : fallback
}

// wrap="none": each line placed by its paragraph's alignment against the box (a centred line overhangs both sides).
function alignUnwrapped(out: TextLayout, resolved: ResolvedBody, frameWidth: number): void {
	for (let line = 0; line < out.lineCount; line++) {
		const source = out.lineInts[line * 7 + 5] ?? 0
		const algn = resolved.paragraphs[source]?.pPr.algn ?? "l"
		const width = out.lineFloats[line * 5 + 4] ?? 0
		const x = out.lineFloats[line * 5 + 3] ?? 0
		const dx = algn === "ctr" ? (frameWidth - width) / 2 - x : algn === "r" ? frameWidth - width - x : 0

		if (dx !== 0) shiftLine(out, line, dx)
	}
}

function shiftLine(out: TextLayout, line: number, dx: number): void {
	out.lineFloats[line * 5 + 3] = (out.lineFloats[line * 5 + 3] ?? 0) + dx

	const first = out.lineInts[line * 7] ?? 0
	const count = out.lineInts[line * 7 + 1] ?? 0

	for (let k = first; k < first + count; k++) out.fragmentFloats[k * 4] = (out.fragmentFloats[k * 4] ?? 0) + dx

	const firstDecoration = out.lineInts[line * 7 + 6] ?? 0
	const endDecoration = line + 1 < out.lineCount ? (out.lineInts[(line + 1) * 7 + 6] ?? 0) : out.decorationCount

	for (let d = firstDecoration; d < endDecoration; d++) out.decorationFloats[d * 4] = (out.decorationFloats[d * 4] ?? 0) + dx
}

// a:bodyPr@anchor (t, ctr, b; just and dist as t, as PowerPoint draws horizontal text) and anchorCtr (the text
// block centred horizontally as a whole).
function anchor(out: TextLayout, kind: string, center: boolean, frameWidth: number, frameHeight: number, height: number): void {
	const dy = kind === "ctr" ? (frameHeight - height) / 2 : kind === "b" ? frameHeight - height : 0

	if (dy !== 0 && out.lineCount > 0) out.offset(0, dy)

	if (!center || out.lineCount === 0) return

	let left = Infinity
	let right = -Infinity

	for (let line = 0; line < out.lineCount; line++) {
		const x = out.lineFloats[line * 5 + 3] ?? 0

		left = Math.min(left, x)
		right = Math.max(right, x + (out.lineFloats[line * 5 + 4] ?? 0))
	}

	const dx = (frameWidth - (right - left)) / 2 - left

	if (dx !== 0) for (let line = 0; line < out.lineCount; line++) shiftLine(out, line, dx)
}
