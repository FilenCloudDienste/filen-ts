import type { TextAlign, TextUnderline } from "../../drawingml/index"
import { parseLength, parsePercent, type OdfElement, type OdfListLevel, type OdfListStyle, type OdfProperties } from "../../odf/index"
import { classifyHref } from "../../presentation/actions"
import { tooDeep, tooLarge } from "../../presentation/refusal"
import type { Action, Bullet, FontRef, ListStyle, Paragraph, ParaProps, Run, RunProps, TextBody } from "../../presentation/model"
import { NodeKind } from "../../xml/index"
import { EMU_PER_PT, packagePart, srgb } from "./fills"
import type { Fragment, OdpContext } from "./context"

// Text of shapes (ODF 1.3 Part 3 §5 paragraphs, §5.3 lists, §6 paragraph content, §7 fields) as the model's text
// bodies. The shape's own styles (its graphic and presentation styles over the graphic default style) give every
// level's defaults (the body's list style, so the text chain finds them first); outline objects take each level's
// paragraph and text properties from their master's outline styles "<master>-outline1"…"-outline9" (§16.4, as
// LibreOffice names them); a paragraph's own automatic style and its spans' styles are written on the paragraph and
// its runs. Lists give levels and bullets: the list style named on the list, else the one the presentation style
// carries (style:graphic-properties/text:list-style). A paragraph outside a list, or after the first in a list
// item, has no bullet. Whitespace collapses as §6.1.2 says.

const PX_PER_PT = 96 / 72

const ALIGNS: Readonly<Record<string, TextAlign>> = {
	start: "l",
	left: "l",
	center: "ctr",
	end: "r",
	right: "r",
	justify: "just"
}

function hundredths(points: number): number {
	return Math.round(points * 100)
}

function emu(points: number): number {
	return Math.round(points * EMU_PER_PT)
}

function weight(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined
	if (value === "bold") return true
	if (value === "normal") return false

	const number = Number(value)

	return Number.isFinite(number) ? number >= 600 : undefined
}

function underline(attributes: ReadonlyMap<string, string>): TextUnderline | undefined {
	const style = attributes.get("style:text-underline-style")

	if (style === undefined) return undefined
	if (style === "none") return "none"

	const double = attributes.get("style:text-underline-type") === "double"
	const heavy = attributes.get("style:text-underline-width") === "bold"

	switch (style) {
		case "dotted":
			return heavy ? "dottedHeavy" : "dotted"
		case "dash":
			return heavy ? "dashHeavy" : "dash"
		case "long-dash":
			return heavy ? "dashLongHeavy" : "dashLong"
		case "dot-dash":
			return heavy ? "dotDashHeavy" : "dotDash"
		case "dot-dot-dash":
			return heavy ? "dotDotDashHeavy" : "dotDotDash"
		case "wave":
			return double ? "wavyDbl" : heavy ? "wavyHeavy" : "wavy"
		default:
			return double ? "dbl" : heavy ? "heavy" : "sng"
	}
}

// The font a font-name names (§20.172 style:font-name → style:font-face svg:font-family), else fo:font-family.
function font(context: OdpContext, attributes: ReadonlyMap<string, string>, suffix: "" | "-asian" | "-complex"): FontRef | undefined {
	const name = attributes.get(`style:font-name${suffix}`)
	const face = name === undefined ? undefined : context.sheet.fontFaces.get(name)
	const family = face?.family ?? attributes.get(suffix === "" ? "fo:font-family" : `style:font-family${suffix}`) ?? name

	if (family === undefined || family.trim() === "") return undefined

	return { typeface: family.replace(/^['"]|['"]$/gu, "").trim() }
}

// style:text-properties (§16.27.28) as a:rPr.
export function runPropsOf(context: OdpContext, properties: OdfProperties | undefined): RunProps {
	if (properties === undefined || properties.attributes.size === 0) return {}

	const attributes = properties.attributes
	const size = parseLength(attributes.get("fo:font-size"))
	const position = attributes.get("style:text-position")
	const strike = attributes.get("style:text-line-through-style")
	const transform = attributes.get("fo:text-transform")
	const variant = attributes.get("fo:font-variant")
	const spacing = attributes.get("fo:letter-spacing")
	const language = attributes.get("fo:language")
	const country = attributes.get("fo:country")
	const color = attributes.get("style:use-window-font-color") === "true" ? undefined : srgb(attributes.get("fo:color"))
	const highlight = attributes.get("fo:background-color")
	const italic = attributes.get("fo:font-style")
	const out: { -readonly [K in keyof RunProps]: RunProps[K] } = {}
	const latin = font(context, attributes, "")
	const ea = font(context, attributes, "-asian")
	const cs = font(context, attributes, "-complex")
	const u = underline(attributes)
	const b = weight(attributes.get("fo:font-weight"))

	if (size !== undefined && size > 0) out.sz = hundredths(size)
	if (b !== undefined) out.b = b
	if (italic !== undefined) out.i = italic === "italic" || italic === "oblique"
	if (u !== undefined) out.u = u
	if (strike !== undefined)
		out.strike =
			strike === "none" ? "noStrike" : attributes.get("style:text-line-through-type") === "double" ? "dblStrike" : "sngStrike"
	if (position !== undefined) {
		const first = position.trim().split(/\s+/u)[0] ?? "0%"
		const percent = first === "super" ? 33 : first === "sub" ? -33 : (parsePercent(first) ?? 0)

		out.baseline = Math.round(percent * 1000)
	}

	if (transform === "uppercase") out.cap = "all"
	else if (variant === "small-caps") out.cap = "small"
	else if (transform === "none" || variant === "normal") out.cap = "none"

	const spacingPoints = spacing === "normal" ? 0 : parseLength(spacing)

	if (spacingPoints !== undefined) out.spc = hundredths(spacingPoints)
	if (language !== undefined && language !== "none")
		out.lang = country === undefined || country === "none" ? language : `${language}-${country}`
	if (latin !== undefined) out.latin = latin
	if (ea !== undefined) out.ea = ea
	if (cs !== undefined) out.cs = cs
	if (color !== undefined) out.fill = { kind: "solid", color }
	if (highlight !== undefined && highlight !== "transparent") {
		const value = srgb(highlight)

		if (value !== undefined) out.highlight = value
	}

	return out
}

// style:paragraph-properties (§17.6) as a:pPr (without bullets).
export function paraPropsOf(properties: OdfProperties | undefined): { -readonly [K in keyof ParaProps]: ParaProps[K] } {
	const out: { -readonly [K in keyof ParaProps]: ParaProps[K] } = {}

	if (properties === undefined) return out

	const attributes = properties.attributes
	const align = ALIGNS[attributes.get("fo:text-align") ?? ""]
	const left = parseLength(attributes.get("fo:margin-left"))
	const right = parseLength(attributes.get("fo:margin-right"))
	const indent = parseLength(attributes.get("fo:text-indent"))
	const lineHeight = attributes.get("fo:line-height")
	const atLeast = parseLength(attributes.get("style:line-height-at-least"))
	const before = parseLength(attributes.get("fo:margin-top"))
	const after = parseLength(attributes.get("fo:margin-bottom"))
	const writing = attributes.get("style:writing-mode")
	const tabDistance = parseLength(attributes.get("style:tab-stop-distance"))
	const stops = properties.children.find(child => child.name === "style:tab-stops")

	if (align !== undefined) out.algn = align
	if (left !== undefined) out.marL = emu(left)
	if (right !== undefined) out.marR = emu(right)
	if (indent !== undefined) out.indent = emu(indent)

	if (lineHeight !== undefined) {
		const percent = parsePercent(lineHeight)
		const points = parseLength(lineHeight)

		if (percent !== undefined) out.lnSpc = { pct: Math.round(percent * 1000) }
		else if (points !== undefined) out.lnSpc = { pts: Math.round(points * 100) }
		else if (lineHeight === "normal") out.lnSpc = { pct: 100_000 }
	} else if (atLeast !== undefined) {
		out.lnSpc = { pts: Math.round(atLeast * 100) }
	}

	if (before !== undefined) out.spcBef = { pts: Math.round(before * 100) }
	if (after !== undefined) out.spcAft = { pts: Math.round(after * 100) }
	if (writing === "rl-tb" || writing === "rl") out.rtl = true
	else if (writing === "lr-tb" || writing === "lr") out.rtl = false
	if (tabDistance !== undefined && tabDistance > 0) out.defTabSz = emu(tabDistance)
	// Written only when off: absent and true are the font-independent line (§20.297).
	if (attributes.get("style:font-independent-line-spacing") === "false") out.fontIndependentLineSpacing = false

	if (stops !== undefined) {
		const tabs: { pos: number; algn: "l" | "ctr" | "r" | "dec" }[] = []

		for (const stop of stops.children) {
			const position = parseLength(stop.attributes.get("style:position"))

			if (position === undefined || tabs.length >= 64) continue

			const type = stop.attributes.get("style:type")

			tabs.push({
				pos: Math.round((position + (left ?? 0)) * EMU_PER_PT),
				algn: type === "center" ? "ctr" : type === "right" ? "r" : type === "char" ? "dec" : "l"
			})
		}

		if (tabs.length > 0) out.tabs = tabs
	}

	return out
}

// A text:list-style element held in a style's properties (the outline styles keep theirs in graphic properties) as
// list levels, read as the style sheet reads the common ones.
export function embeddedListStyle(element: OdfElement | undefined): OdfListStyle | undefined {
	if (element === undefined) return undefined

	const levels = new Map<number, OdfListLevel>()

	for (const child of element.children) {
		const kind =
			child.name === "text:list-level-style-bullet"
				? "bullet"
				: child.name === "text:list-level-style-number"
					? "number"
					: child.name === "text:list-level-style-image"
						? "image"
						: undefined
		const level = Number(child.attributes.get("text:level") ?? "NaN")

		if (kind === undefined || !Number.isInteger(level) || level < 1 || level > 10 || levels.has(level)) continue

		const properties = child.children.find(part => part.name === "style:list-level-properties")
		const text = child.children.find(part => part.name === "style:text-properties")

		levels.set(level, {
			level,
			kind,
			attributes: child.attributes,
			properties:
				properties === undefined
					? { attributes: new Map(), children: [] }
					: { attributes: properties.attributes, children: properties.children },
			labelAlignment: properties?.children.find(item => item.name === "style:list-level-label-alignment")?.attributes,
			textProperties: text === undefined ? undefined : { attributes: text.attributes, children: text.children }
		})
	}

	return {
		name: element.attributes.get("style:name") ?? "",
		displayName: undefined,
		automatic: true,
		origin: "content",
		outline: false,
		consecutiveNumbering: false,
		levels
	}
}

const NUMBER_STEMS: Readonly<Record<string, string>> = { "1": "arabic", a: "alphaLc", A: "alphaUc", i: "romanLc", I: "romanUc" }

// style:num-format with its prefix and suffix as ST_TextAutonumberScheme; undefined for none ("") or a format
// DrawingML has no scheme for (shown as Arabic numbers).
function autonumberScheme(attributes: ReadonlyMap<string, string>): string | undefined {
	const format = attributes.get("style:num-format") ?? ""

	if (format === "") return undefined

	const stem = NUMBER_STEMS[format] ?? "arabic"
	const prefix = attributes.get("style:num-prefix") ?? ""
	const suffix = attributes.get("style:num-suffix") ?? ""

	if (suffix.startsWith(")")) return `${stem}${prefix.startsWith("(") ? "ParenBoth" : "ParenR"}`
	if (suffix.startsWith(".")) return `${stem}Period`

	return stem === "arabic" ? "arabicPlain" : `${stem}Period`
}

// The bullet, its colour, size and font, and the indents a list level gives a paragraph (§16.32–§16.34, §17.19).
export function levelProps(context: OdpContext, level: OdfListLevel | undefined, start: number | undefined): Partial<ParaProps> {
	if (level === undefined) return { bullet: { kind: "none" } }

	const out: { -readonly [K in keyof ParaProps]: ParaProps[K] } = {}
	const attributes = level.attributes
	const properties = level.properties.attributes
	const align = level.labelAlignment
	const spaceBefore = parseLength(properties.get("text:space-before"))
	const labelWidth = parseLength(properties.get("text:min-label-width"))
	const alignLeft = parseLength(align?.get("fo:margin-left"))
	const alignIndent = parseLength(align?.get("fo:text-indent"))

	if (alignLeft !== undefined || alignIndent !== undefined) {
		out.marL = emu(alignLeft ?? 0)
		out.indent = emu(alignIndent ?? 0)
	} else if (spaceBefore !== undefined || labelWidth !== undefined) {
		out.marL = emu((spaceBefore ?? 0) + (labelWidth ?? 0))
		out.indent = emu(-(labelWidth ?? 0))
	}

	let bullet: Bullet = { kind: "none" }

	if (level.kind === "bullet") {
		const char = attributes.get("text:bullet-char") ?? ""

		bullet = char === "" ? { kind: "none" } : { kind: "char", char: [...char][0] ?? char }
	} else if (level.kind === "number") {
		const scheme = autonumberScheme(attributes)
		const value = start ?? Number(attributes.get("text:start-value") ?? "1")

		bullet =
			scheme === undefined
				? { kind: "none" }
				: { kind: "autoNum", scheme, ...(Number.isInteger(value) && value > 1 ? { startAt: value } : {}) }
	} else {
		const part = packagePart(attributes.get("xlink:href"))

		bullet = part === undefined ? { kind: "none" } : { kind: "blip", part }
	}

	out.bullet = bullet

	if (bullet.kind === "none") return out

	const text = level.textProperties?.attributes
	const relative = parsePercent(attributes.get("text:bullet-relative-size") ?? text?.get("fo:font-size"))
	const color = text?.get("style:use-window-font-color") === "true" ? undefined : srgb(text?.get("fo:color"))
	const typeface = font(context, text ?? new Map<string, string>(), "")

	out.buSz = relative === undefined ? "text" : { pct: Math.round(relative * 1000) }
	out.buClr = color ?? "text"
	if (bullet.kind === "char") out.buFont = typeface ?? "text"

	return out
}

// Each of the nine levels as a:lstStyle sees it: a paragraph and its default run properties.
export function levelStyle(paragraph: OdfProperties | undefined, text: OdfProperties | undefined, context: OdpContext): ParaProps {
	const own = paraPropsOf(paragraph)
	const rPr = runPropsOf(context, text)

	return Object.keys(rPr).length === 0 ? own : { ...own, defRPr: rPr }
}

export function listStyleOf(levels: readonly ParaProps[]): ListStyle {
	return { levels: Array.from({ length: 9 }, (_, at) => levels[Math.min(at, levels.length - 1)]) }
}

// What a text body is read with: the fragment, the list style the shape's style carries, the action a hyperlink
// names, and the substitutions of presentation fields (§7.9 presentation:header/footer/date-time) on this slide.
export interface TextScope {
	readonly fragment: Fragment
	readonly listStyle: OdfListStyle | undefined
	// The shape's East Asian text size (style:font-size-asian, hundredths of a point), when its style writes one.
	readonly asianSize?: number
	readonly fields?: {
		readonly header?: string
		readonly footer?: string
		readonly dateTime?: { readonly text?: string; readonly fixed: boolean }
	}
}

interface Cursor {
	readonly runs: Run[]
	// The last character written was a space (whitespace collapses across elements, §6.1.2).
	space: boolean
	// Characters this body added.
	characters: number
	// The East Asian size in effect (style:font-size-asian, §20.284), hundredths of a point; DrawingML has one size per
	// run, so text in an East Asian script takes it (as LibreOffice sizes it).
	asian: number | undefined
	readonly asianRuns: Map<RunProps, RunProps>
}

// Han, kana, Hangul and full-width forms: text LibreOffice sets in the Asian font and size.
const EAST_ASIAN = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u

// The East Asian size a text style sets, hundredths of a point.
export function asianSizeOf(properties: OdfProperties | undefined): number | undefined {
	const points = parseLength(properties?.attributes.get("style:font-size-asian"))

	return points === undefined || points <= 0 ? undefined : hundredths(points)
}

const WHITESPACE = /[ \t\r\n]+/gu

function appendText(cursor: Cursor, text: string, rPr: RunProps): void {
	let collapsed = text.replace(WHITESPACE, " ")

	if (cursor.space && collapsed.startsWith(" ")) collapsed = collapsed.slice(1)
	if (collapsed === "") return

	cursor.space = collapsed.endsWith(" ")

	let props = rPr

	if (cursor.asian !== undefined && rPr.sz !== cursor.asian && EAST_ASIAN.test(collapsed)) {
		const sized = cursor.asianRuns.get(rPr) ?? { ...rPr, sz: cursor.asian }

		cursor.asianRuns.set(rPr, sized)
		props = sized
	}

	pushRun(cursor, { kind: "r", text: collapsed, rPr: props })
}

function pushRun(cursor: Cursor, run: Run): void {
	const last = cursor.runs[cursor.runs.length - 1]

	if (run.kind !== "r") cursor.space = false
	else cursor.characters += run.text.length

	// Adjacent runs of one style are one run (§6.1.2 collapses across them too).
	if (run.kind === "r" && last?.kind === "r" && last.rPr === run.rPr) {
		cursor.runs[cursor.runs.length - 1] = { kind: "r", text: last.text + run.text, rPr: run.rPr }

		return
	}

	cursor.runs.push(run)
}

function merged(base: RunProps, own: RunProps): RunProps {
	return Object.keys(own).length === 0 ? base : Object.keys(base).length === 0 ? own : { ...base, ...own }
}

// A text:a's target: a jump to a named page ("#page3") or a link classified as the deck's links are.
function linkAction(context: OdpContext, href: string | undefined): Action | undefined {
	if (href === undefined || href.trim() === "") return undefined

	const trimmed = href.trim()

	if (trimmed.startsWith("#")) {
		const slide = context.pageNamed(decodeName(trimmed.slice(1)))

		return slide === undefined ? undefined : { kind: "slide", slide }
	}

	return classifyHref(trimmed)
}

function decodeName(name: string): string {
	try {
		return decodeURIComponent(name)
	} catch {
		return name
	}
}

// Nesting past these is refused, never read in part (the annotation reader shares the span bound).
export const MAX_SPAN_DEPTH = 64
const MAX_LIST_DEPTH = 32

// A text:s's spaces (ODF 1.3 §6.1.3), at most 1000: a hostile text:c never amplifies a small file.
export function spaceCount(value: string | undefined): number {
	return Math.min(1000, Math.max(1, Number(value ?? "1") || 1))
}

function readRuns(context: OdpContext, scope: TextScope, node: number, rPr: RunProps, cursor: Cursor, depth: number): void {
	const fragment = scope.fragment
	const document = fragment.document

	if (depth > MAX_SPAN_DEPTH) tooDeep("text span nesting", MAX_SPAN_DEPTH)

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		const kind = document.kind(child)

		if (kind === NodeKind.Text || kind === NodeKind.CData) {
			appendText(cursor, document.text(child), rPr)

			continue
		}

		if (kind !== NodeKind.Element) continue

		const name = fragment.name(child)

		switch (name) {
			case "text:span": {
				const style = fragment.attributes(child).get("text:style-name")
				const properties = style === undefined ? undefined : context.ownProperties("text", style, fragment.scope, "text")
				const own = runPropsOf(context, properties)
				const asian = cursor.asian

				cursor.asian = asianSizeOf(properties) ?? asian
				readRuns(context, scope, child, merged(rPr, own), cursor, depth + 1)
				cursor.asian = asian
				break
			}
			case "text:a": {
				const action = linkAction(context, fragment.attributes(child).get("xlink:href"))

				readRuns(context, scope, child, action === undefined ? rPr : { ...rPr, hlinkClick: action }, cursor, depth + 1)
				break
			}
			case "text:s": {
				const count = spaceCount(fragment.attributes(child).get("text:c"))

				pushRun(cursor, { kind: "r", text: " ".repeat(count), rPr })
				cursor.space = false
				break
			}
			case "text:tab":
				pushRun(cursor, { kind: "r", text: "\t", rPr })
				cursor.space = false
				break
			case "text:line-break":
				pushRun(cursor, { kind: "br", rPr })
				break
			case "text:page-number":
				pushRun(cursor, {
					kind: "fld",
					type: "slidenum",
					id: context.fieldId(),
					text: document.textContent(child) || "<number>",
					rPr
				})
				break
			case "text:page-count":
				// Shown as the deck's slide count (a field, so a slide added or removed changes it).
				pushRun(cursor, { kind: "fld", type: "odf:page-count", id: context.fieldId(), text: String(context.pageCount), rPr })
				break
			case "text:date":
			case "text:time":
			case "presentation:date-time": {
				const fixedField = fragment.attributes(child).get("text:fixed") === "true"
				const declared = name === "presentation:date-time" ? scope.fields?.dateTime : undefined

				if (declared !== undefined && declared.fixed) pushRun(cursor, { kind: "r", text: declared.text ?? "", rPr })
				else if (fixedField) appendText(cursor, document.textContent(child), rPr)
				else
					pushRun(cursor, {
						kind: "fld",
						type: name === "text:time" ? "datetime10" : "datetime1",
						id: context.fieldId(),
						text: document.textContent(child),
						rPr
					})
				break
			}
			case "presentation:footer":
				if (scope.fields?.footer !== undefined) appendText(cursor, scope.fields.footer, rPr)
				break
			case "presentation:header":
				if (scope.fields?.header !== undefined) appendText(cursor, scope.fields.header, rPr)
				break
			case "text:bookmark":
			case "text:bookmark-start":
			case "text:bookmark-end":
			case "text:soft-page-break":
			case "office:annotation":
			case "office:annotation-end":
			case "text:reference-mark":
			case "text:reference-mark-start":
			case "text:reference-mark-end":
				break
			default:
				// Any other field (title, file name, author…) shows the text the file stores, kept a field.
				if (DOCUMENT_FIELDS.has(name)) {
					const text = document.textContent(child)

					if (text !== "")
						pushRun(cursor, { kind: "fld", type: `odf:${name.slice(name.indexOf(":") + 1)}`, id: context.fieldId(), text, rPr })
				} else {
					readRuns(context, scope, child, rPr, cursor, depth + 1)
				}
		}
	}
}

// Document and variable fields (§7.3–§7.6) whose value the file stores as it was last shown.
const DOCUMENT_FIELDS: ReadonlySet<string> = new Set([
	"text:file-name",
	"text:title",
	"text:subject",
	"text:description",
	"text:keywords",
	"text:author-name",
	"text:author-initials",
	"text:creator",
	"text:initial-creator",
	"text:creation-date",
	"text:creation-time",
	"text:modification-date",
	"text:modification-time",
	"text:print-date",
	"text:print-time",
	"text:editing-cycles",
	"text:editing-duration",
	"text:template-name",
	"text:user-defined",
	"text:variable-get",
	"text:user-field-get",
	"text:sequence",
	"text:sender-firstname",
	"text:sender-lastname",
	"text:sender-company",
	"text:sender-email"
])

interface ListFrame {
	readonly level: number
	readonly style: OdfListStyle | undefined
}

// One text body from a shape element (its text:p, text:h and text:list children); undefined when it has none.
export function readTextBody(
	context: OdpContext,
	scope: TextScope,
	container: number,
	lstStyle: ListStyle | undefined
): TextBody | undefined {
	const fragment = scope.fragment
	const document = fragment.document
	const paragraphs: Paragraph[] = []
	const cursorBase = { characters: 0 }
	let found = false

	const paragraph = (node: number, list: ListFrame | undefined, bulleted: boolean, start: number | undefined): void => {
		const attributes = fragment.attributes(node)
		const styleName = attributes.get("text:style-name")
		const style = styleName === undefined ? undefined : context.ownStyle("paragraph", styleName, fragment.scope)
		const pPr = paraPropsOf(style?.paragraph)
		const rPr = runPropsOf(context, style?.text)

		if (list !== undefined) {
			const level = Math.min(9, list.level)
			const listLevel = list.style?.levels.get(list.level)
			const fromLevel = levelProps(context, listLevel, start)
			// The list level's indents add to the paragraph's own left margin (LibreOffice 7.5, measured: a paragraph
			// whose style writes margin-left 0 and a level of min-label-width 0.952 cm starts its text 0.952 cm in,
			// its bullet at the margin); a paragraph without a margin takes its level's from the body's list style.
			const margin = pPr.marL ?? lstStyle?.levels[level - 1]?.marL ?? 0

			pPr.lvl = level - 1

			if (fromLevel.marL !== undefined) {
				pPr.marL = margin + fromLevel.marL
				pPr.indent = bulleted ? (fromLevel.indent ?? 0) : 0
			}

			if (bulleted) {
				for (const [key, value] of Object.entries(fromLevel))
					if (key !== "marL" && key !== "indent") (pPr as Record<string, unknown>)[key] = value
			} else {
				pPr.bullet = { kind: "none" }
			}
		} else {
			pPr.bullet = { kind: "none" }
		}

		// A paragraph style that turns the rule back on over a shape whose text has it off says so (true is written
		// only here, where the level below would otherwise give false).
		if (
			style?.paragraph.attributes.get("style:font-independent-line-spacing") === "true" &&
			lstStyle?.levels[pPr.lvl ?? 0]?.fontIndependentLineSpacing === false
		)
			pPr.fontIndependentLineSpacing = true

		const cursor: Cursor = {
			runs: [],
			space: true,
			characters: 0,
			asian: asianSizeOf(style?.text) ?? scope.asianSize,
			asianRuns: new Map()
		}

		readRuns(context, scope, node, rPr, cursor, 0)

		// A trailing collapsed space ends no line (§6.1.2 leaves the paragraph's end as written: LibreOffice drops it).
		const last = cursor.runs[cursor.runs.length - 1]

		if (last?.kind === "r" && last.text.endsWith(" ") && cursor.space && last.text.length > 0) {
			const trimmed = last.text.slice(0, -1)

			if (trimmed === "") cursor.runs.pop()
			else cursor.runs[cursor.runs.length - 1] = { kind: "r", text: trimmed, rPr: last.rPr }
			cursor.characters--
		}

		cursorBase.characters += cursor.characters
		context.countRuns(cursor.runs.length, cursor.characters)

		if (cursor.runs.length > context.budgets.runsPerBody) tooLarge("runs in a text body", context.budgets.runsPerBody)

		paragraphs.push({
			pPr,
			runs: cursor.runs,
			...(Object.keys(rPr).length === 0 ? {} : { endRPr: rPr }),
			src: fragment.src(node)
		})
		found = true
	}

	const list = (node: number, parent: ListFrame | undefined, depth: number): void => {
		if (depth > MAX_LIST_DEPTH) tooDeep("list nesting", MAX_LIST_DEPTH)

		const named = fragment.attributes(node).get("text:style-name")
		const style =
			named === undefined
				? (parent?.style ?? scope.listStyle)
				: (context.sheet.listStyle(named, fragment.scope) ?? parent?.style ?? scope.listStyle)
		const frame: ListFrame = { level: (parent?.level ?? 0) + 1, style }

		for (let item = document.firstChildElement(node); item >= 0; item = document.nextSiblingElement(item)) {
			const itemName = fragment.name(item)

			if (itemName !== "text:list-item" && itemName !== "text:list-header") continue

			const startValue = Number(fragment.attributes(item).get("text:start-value") ?? "NaN")
			let first = itemName === "text:list-item"

			for (let child = document.firstChildElement(item); child >= 0; child = document.nextSiblingElement(child)) {
				const childName = fragment.name(child)

				if (childName === "text:p" || childName === "text:h") {
					paragraph(child, frame, first, Number.isInteger(startValue) ? startValue : undefined)
					first = false
				} else if (childName === "text:list") {
					list(child, frame, depth + 1)
					first = false
				}
			}
		}
	}

	for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
		const name = fragment.name(child)

		if (name === "text:p" || name === "text:h") paragraph(child, undefined, false, undefined)
		else if (name === "text:list") list(child, undefined, 0)
	}

	if (!found) return undefined

	return { bodyPr: {}, ...(lstStyle === undefined ? {} : { lstStyle }), paragraphs }
}

export function insetsPx(points: number): number {
	return points * PX_PER_PT
}
