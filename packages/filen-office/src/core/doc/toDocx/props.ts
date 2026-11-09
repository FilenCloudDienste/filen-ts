import { languageTag } from "../../docx/forms/dates"
import type { DocFont } from "../fonts"
import type { DocBorder, DocChar, DocColor, DocPara, DocShading, DocTab } from "../props"
import { attr, clamp, hexColor, onOff, val } from "./xml"

// DocChar / DocPara → rPr / pPr children in schema order (ECMA-376 Part 1 §17.3.2.28 EG_RPrBase, §17.3.1.26
// CT_PPrBase). Each writes what differs from `base` (the formatting the style chain already gives).

// What the writers need besides the properties: font names by index, and a sink for features without a
// WordprocessingML equivalent.
export interface PropsContext {
	readonly fonts: readonly DocFont[]
	note(kind: "artBorder"): void
}

// BrcType (§2.9.17) → ST_Border; 0x40–0xE3 are art borders.
const BORDERS: Readonly<Record<number, string>> = {
	1: "single",
	2: "thick",
	3: "double",
	5: "single",
	6: "dotted",
	7: "dashed",
	8: "dotDash",
	9: "dotDotDash",
	10: "triple",
	11: "thinThickSmallGap",
	12: "thickThinSmallGap",
	13: "thinThickThinSmallGap",
	14: "thinThickMediumGap",
	15: "thickThinMediumGap",
	16: "thinThickThinMediumGap",
	17: "thinThickLargeGap",
	18: "thickThinLargeGap",
	19: "thinThickThinLargeGap",
	20: "wave",
	21: "doubleWave",
	22: "dashSmallGap",
	23: "dashDotStroked",
	24: "threeDEmboss",
	25: "threeDEngrave",
	26: "outset",
	27: "inset"
}

export function border(name: string, value: DocBorder | undefined, context: PropsContext): string {
	if (value === undefined) return ""

	if (value.type === 0 || value.type === 0xff)
		return `<w:${name} w:val="${value.type === 0xff ? "nil" : "none"}" w:sz="0" w:space="0" w:color="auto"/>`

	let kind = BORDERS[value.type]

	if (kind === undefined) {
		// Art borders and undefined values draw as a single line; art borders are reported.
		if (value.type >= 0x40) context.note("artBorder")

		kind = "single"
	}

	// Eighths of a point: 2–96 for line borders (§17.3.4.4 ST_EighthPointMeasure as Word bounds it); hairline is 2.
	const size = value.type === 5 ? 2 : clamp(value.width, 2, 96)

	return (
		`<w:${name}${attr("w:val", kind)}${attr("w:sz", size)}${attr("w:space", clamp(value.space, 0, 31))}${attr(
			"w:color",
			hexColor(value.color)
		)}` +
		(value.shadow ? ' w:shadow="1"' : "") +
		(value.frame ? ' w:frame="1"' : "") +
		"/>"
	)
}

// Ipat (§2.9.124) → ST_Shd; the 2.5 % steps go to the nearest pattern ST_Shd has.
const PATTERNS: Readonly<Record<number, string>> = {
	0: "clear",
	1: "solid",
	2: "pct5",
	3: "pct10",
	4: "pct20",
	5: "pct25",
	6: "pct30",
	7: "pct40",
	8: "pct50",
	9: "pct60",
	10: "pct70",
	11: "pct75",
	12: "pct80",
	13: "pct90",
	14: "horzStripe",
	15: "vertStripe",
	16: "reverseDiagStripe",
	17: "diagStripe",
	18: "horzCross",
	19: "diagCross",
	20: "thinHorzStripe",
	21: "thinVertStripe",
	22: "thinReverseDiagStripe",
	23: "thinDiagStripe",
	24: "thinHorzCross",
	25: "thinDiagCross",
	0x23: "pct5",
	0x24: "pct10",
	0x25: "pct12",
	0x26: "pct15",
	0x27: "pct15",
	0x28: "pct20",
	0x29: "pct25",
	0x2a: "pct30",
	0x2b: "pct35",
	0x2c: "pct37",
	0x2d: "pct40",
	0x2e: "pct45",
	0x2f: "pct50",
	0x30: "pct50",
	0x31: "pct55",
	0x32: "pct60",
	0x33: "pct62",
	0x34: "pct65",
	0x35: "pct70",
	0x36: "pct70",
	0x37: "pct75",
	0x38: "pct80",
	0x39: "pct85",
	0x3a: "pct87",
	0x3b: "pct90",
	0x3c: "pct95",
	0x3d: "pct95",
	0x3e: "pct95"
}

export function shading(value: DocShading | undefined): string {
	if (value === undefined) return ""

	if (value.pattern === 0xffff) return '<w:shd w:val="nil"/>'

	return `<w:shd${attr("w:val", PATTERNS[value.pattern] ?? "clear")}${attr("w:color", hexColor(value.fore))}${attr("w:fill", hexColor(value.back))}/>`
}

// Kul (§2.9.135) → ST_Underline.
const UNDERLINES: Readonly<Record<number, string>> = {
	1: "single",
	2: "words",
	3: "double",
	4: "dotted",
	6: "thick",
	7: "dash",
	9: "dotDash",
	10: "dotDotDash",
	11: "wave",
	20: "dottedHeavy",
	23: "dashedHeavy",
	25: "dashDotHeavy",
	26: "dashDotDotHeavy",
	27: "wavyHeavy",
	39: "dashLong",
	43: "wavyDouble",
	55: "dashLongHeavy"
}

// Ico colours as ST_HighlightColor names.
const HIGHLIGHTS: ReadonlyMap<number, string> = new Map([
	[0x000000, "black"],
	[0x0000ff, "blue"],
	[0x00ffff, "cyan"],
	[0x00ff00, "green"],
	[0xff00ff, "magenta"],
	[0xff0000, "red"],
	[0xffff00, "yellow"],
	[0xffffff, "white"],
	[0x000080, "darkBlue"],
	[0x008080, "darkCyan"],
	[0x008000, "darkGreen"],
	[0x800080, "darkMagenta"],
	[0x800000, "darkRed"],
	[0x808000, "darkYellow"],
	[0x808080, "darkGray"],
	[0xc0c0c0, "lightGray"]
])

const EMPHASIS = ["none", "dot", "comma", "circle", "underDot"]
const EFFECTS = ["none", "blinkBackground", "lights", "antsBlack", "antsRed", "shimmer", "sparkle"]

export function fontName(context: PropsContext, index: number): string | undefined {
	const name = context.fonts[index]?.name

	return name === undefined || name === "" ? undefined : name
}

export function lang(lid: number): string | undefined {
	// 0x0400 is "no proofing language"; 0 and unknown identifiers are left out.
	if (lid === 0 || lid === 0x0400) return undefined

	return languageTag(lid.toString(16).padStart(4, "0"))
}

function same(a: DocColor | undefined, b: DocColor | undefined): boolean {
	return a === b
}

function sameBorder(a: DocBorder | undefined, b: DocBorder | undefined): boolean {
	if (a === b) return true
	if (a === undefined || b === undefined) return false

	return (
		a.type === b.type &&
		a.width === b.width &&
		a.color === b.color &&
		a.space === b.space &&
		a.shadow === b.shadow &&
		a.frame === b.frame
	)
}

function sameShading(a: DocShading | undefined, b: DocShading | undefined): boolean {
	if (a === b) return true
	if (a === undefined || b === undefined) return false

	return a.fore === b.fore && a.back === b.back && a.pattern === b.pattern
}

export interface RunPrOptions {
	// The paragraph style's character properties, for a run with a character style: its toggles are then written
	// as absolute values wherever either style turns one on, as WordprocessingML combines a character style's
	// toggles with the paragraph style's (§17.7.3) where Word binary applies them in order.
	readonly absoluteToggles?: DocChar
	readonly style?: string
}

const TOGGLES: readonly (readonly [keyof DocChar, string])[] = [
	["bold", "b"],
	["boldBi", "bCs"],
	["italic", "i"],
	["italicBi", "iCs"],
	["caps", "caps"],
	["smallCaps", "smallCaps"],
	["strike", "strike"],
	["doubleStrike", "dstrike"],
	["outline", "outline"],
	["shadow", "shadow"],
	["emboss", "emboss"],
	["imprint", "imprint"],
	["noProof", "noProof"]
]

// rPr children (without the element) for `props` against `base`.
export function runProperties(props: DocChar, base: DocChar, context: PropsContext, options: RunPrOptions = {}): string {
	const out: string[] = []
	const toggle = (key: keyof DocChar, name: string): void => {
		const value = props[key] as boolean

		const paragraph = options.absoluteToggles

		if (
			value !== (base[key] as boolean) ||
			(paragraph !== undefined && (value || (base[key] as boolean) || (paragraph[key] as boolean)))
		)
			out.push(onOff(name, value))
	}

	if (options.style !== undefined) out.push(val("rStyle", options.style))

	if (
		props.fontAscii !== base.fontAscii ||
		props.fontOther !== base.fontOther ||
		props.fontEastAsia !== base.fontEastAsia ||
		props.fontBi !== base.fontBi
	) {
		const names: [string, number][] = [
			["w:ascii", props.fontAscii],
			["w:hAnsi", props.fontOther],
			["w:eastAsia", props.fontEastAsia],
			["w:cs", props.fontBi]
		]
		let fonts = ""

		for (const [name, index] of names) {
			const font = fontName(context, index)

			if (font !== undefined) fonts += attr(name, font)
		}

		if (fonts !== "") out.push(`<w:rFonts${fonts}/>`)
	}

	for (const [key, name] of TOGGLES) toggle(key, name)

	toggle("vanish", "vanish")
	if (props.webHidden !== base.webHidden) out.push(onOff("webHidden", props.webHidden))
	if (!same(props.color, base.color)) out.push(val("color", hexColor(props.color)))
	if (props.spacing !== base.spacing) out.push(val("spacing", clamp(props.spacing, -31680, 31680)))
	if (props.scale !== base.scale) out.push(val("w", clamp(props.scale, 1, 600)))
	if (props.kern !== base.kern) out.push(val("kern", clamp(props.kern, 0, 3276)))
	if (props.position !== base.position) out.push(val("position", clamp(props.position, -3168, 3168)))
	if (props.size !== base.size) out.push(val("sz", clamp(props.size, 2, 3276)))
	if (props.sizeBi !== base.sizeBi) out.push(val("szCs", clamp(props.sizeBi, 2, 3276)))

	if (!same(props.highlight, base.highlight)) {
		const name = props.highlight === undefined || props.highlight === "auto" ? "none" : (HIGHLIGHTS.get(props.highlight) ?? "none")

		out.push(val("highlight", name))
	}

	if (props.underline !== base.underline || !same(props.underlineColor, base.underlineColor)) {
		const name = props.underline === 0 ? "none" : (UNDERLINES[props.underline] ?? "single")

		out.push(`<w:u${attr("w:val", name)}${props.underlineColor === "auto" ? "" : attr("w:color", hexColor(props.underlineColor))}/>`)
	}

	if (props.effect !== base.effect) out.push(val("effect", EFFECTS[props.effect] ?? "none"))
	if (!sameBorder(props.border, base.border))
		out.push(props.border === undefined ? '<w:bdr w:val="nil"/>' : border("bdr", props.border, context))
	if (!sameShading(props.shading, base.shading)) out.push(props.shading === undefined ? '<w:shd w:val="nil"/>' : shading(props.shading))

	if (props.vertAlign !== base.vertAlign)
		out.push(val("vertAlign", props.vertAlign === 1 ? "superscript" : props.vertAlign === 2 ? "subscript" : "baseline"))

	if (props.rtl !== base.rtl) out.push(onOff("rtl", props.rtl))
	if (props.complexScripts !== base.complexScripts) out.push(onOff("cs", props.complexScripts))
	if (props.emphasis !== base.emphasis) out.push(val("em", EMPHASIS[props.emphasis] ?? "none"))

	if (props.lang !== base.lang || props.langEastAsia !== base.langEastAsia || props.langBi !== base.langBi) {
		const tags: [string, string | undefined][] = [
			["w:val", lang(props.lang)],
			["w:eastAsia", lang(props.langEastAsia)],
			["w:bidi", lang(props.langBi)]
		]
		let attrs = ""

		for (const [name, tag] of tags) if (tag !== undefined) attrs += attr(name, tag)

		if (attrs !== "") out.push(`<w:lang${attrs}/>`)
	}

	if (props.specVanish !== base.specVanish) out.push(onOff("specVanish", props.specVanish))

	return out.join("")
}

// sprmPJc values → ST_Jc (transitional names). 6 ("paragraph is indented") has no ST_Jc name; numTab stands in.
const JUSTIFICATION = [
	"left",
	"center",
	"right",
	"both",
	"distribute",
	"mediumKashida",
	"numTab",
	"highKashida",
	"lowKashida",
	"thaiDistribute"
]
const TAB_ALIGN = ["left", "center", "right", "decimal", "bar", "left", "num", "left"]
const TAB_LEADER = ["none", "dot", "hyphen", "underscore", "heavy", "middleDot", "none", "none"]

function sameTabs(a: readonly DocTab[], b: readonly DocTab[]): boolean {
	return (
		a.length === b.length &&
		a.every((tab, k) => tab.position === b[k]?.position && tab.align === b[k]?.align && tab.leader === b[k]?.leader)
	)
}

export interface ParaPrOptions {
	readonly style?: string
	readonly numbering?: { readonly numId: number; readonly ilvl: number }
	// Write the indents even when they equal the base (a list level's indents would otherwise win).
	readonly forceIndent?: boolean
}

// pPr children up to (not including) rPr, sectPr and pPrChange.
export function paragraphProperties(props: DocPara, base: DocPara, context: PropsContext, options: ParaPrOptions = {}): string {
	const out: string[] = []

	if (options.style !== undefined) out.push(val("pStyle", options.style))
	if (props.keepNext !== base.keepNext) out.push(onOff("keepNext", props.keepNext))
	if (props.keep !== base.keep) out.push(onOff("keepLines", props.keep))
	if (props.pageBreakBefore !== base.pageBreakBefore) out.push(onOff("pageBreakBefore", props.pageBreakBefore))

	const frame = props.frame

	if (frame !== undefined && frame !== base.frame && (frame.x !== 0 || frame.y !== 0 || frame.width !== 0 || frame.height !== 0)) {
		out.push(
			framePr(frame.anchor, frame.x, frame.y, frame.width, frame.height, frame.wrap, frame.xFromText, frame.yFromText, props.dropCap)
		)
	}

	if (props.widowControl !== base.widowControl) out.push(onOff("widowControl", props.widowControl))

	if (options.numbering !== undefined) {
		out.push(`<w:numPr>${val("ilvl", options.numbering.ilvl)}${val("numId", options.numbering.numId)}</w:numPr>`)
	}

	if (props.suppressLineNumbers !== base.suppressLineNumbers) out.push(onOff("suppressLineNumbers", props.suppressLineNumbers))

	const sides: [string, DocBorder | undefined, DocBorder | undefined][] = [
		["top", props.borderTop, base.borderTop],
		["left", props.borderLeft, base.borderLeft],
		["bottom", props.borderBottom, base.borderBottom],
		["right", props.borderRight, base.borderRight],
		["between", props.borderBetween, base.borderBetween],
		["bar", props.borderBar, base.borderBar]
	]

	if (sides.some(([, a, b]) => !sameBorder(a, b))) {
		let borders = ""

		for (const [name, value, was] of sides) {
			if (value !== undefined) borders += border(name, value, context)
			else if (was !== undefined) borders += `<w:${name} w:val="nil"/>`
		}

		if (borders !== "") out.push(`<w:pBdr>${borders}</w:pBdr>`)
	}

	if (!sameShading(props.shading, base.shading)) out.push(props.shading === undefined ? '<w:shd w:val="nil"/>' : shading(props.shading))

	if (!sameTabs(props.tabs, base.tabs)) {
		let tabs = ""

		for (const tab of base.tabs) {
			if (!props.tabs.some(entry => entry.position === tab.position))
				tabs += `<w:tab w:val="clear"${attr("w:pos", clamp(tab.position, -31680, 31680))}/>`
		}

		for (const tab of props.tabs) {
			const leader = TAB_LEADER[tab.leader] ?? "none"

			tabs += `<w:tab${attr("w:val", TAB_ALIGN[tab.align] ?? "left")}${leader === "none" ? "" : attr("w:leader", leader)}${attr(
				"w:pos",
				clamp(tab.position, -31680, 31680)
			)}/>`
		}

		if (tabs !== "") out.push(`<w:tabs>${tabs}</w:tabs>`)
	}

	if (props.suppressAutoHyphens !== base.suppressAutoHyphens) out.push(onOff("suppressAutoHyphens", props.suppressAutoHyphens))
	if (props.rtl !== base.rtl) out.push(onOff("bidi", props.rtl))

	const spacingChanged =
		props.before !== base.before ||
		props.after !== base.after ||
		props.beforeAuto !== base.beforeAuto ||
		props.afterAuto !== base.afterAuto ||
		props.line !== base.line ||
		props.lineMultiple !== base.lineMultiple

	if (spacingChanged) {
		let spacing = `${attr("w:before", clamp(props.before, 0, 31680))}${attr("w:after", clamp(props.after, 0, 31680))}`

		if (props.beforeAuto) spacing += ' w:beforeAutospacing="1"'
		if (props.afterAuto) spacing += ' w:afterAutospacing="1"'

		if (props.lineMultiple) spacing += `${attr("w:line", clamp(props.line, 0, 31680))} w:lineRule="auto"`
		else if (props.line < 0) spacing += `${attr("w:line", clamp(-props.line, 0, 31680))} w:lineRule="exact"`
		else spacing += `${attr("w:line", clamp(props.line, 0, 31680))} w:lineRule="atLeast"`

		out.push(`<w:spacing${spacing}/>`)
	}

	const indentChanged =
		props.left !== base.left ||
		props.right !== base.right ||
		props.firstLine !== base.firstLine ||
		props.leftChars !== base.leftChars ||
		props.rightChars !== base.rightChars ||
		props.firstLineChars !== base.firstLineChars

	if (indentChanged || options.forceIndent === true) {
		let ind = `${attr("w:left", clamp(props.left, -31680, 31680))}${attr("w:right", clamp(props.right, -31680, 31680))}`

		if (props.leftChars !== undefined) ind += attr("w:leftChars", props.leftChars)
		if (props.rightChars !== undefined) ind += attr("w:rightChars", props.rightChars)

		if (props.firstLine < 0) ind += attr("w:hanging", clamp(-props.firstLine, 0, 31680))
		else ind += attr("w:firstLine", clamp(props.firstLine, 0, 31680))

		if (props.firstLineChars !== undefined) {
			ind += props.firstLineChars < 0 ? attr("w:hangingChars", -props.firstLineChars) : attr("w:firstLineChars", props.firstLineChars)
		}

		out.push(`<w:ind${ind}/>`)
	}

	if (props.contextualSpacing !== base.contextualSpacing) out.push(onOff("contextualSpacing", props.contextualSpacing))
	if (props.mirrorIndents !== base.mirrorIndents) out.push(onOff("mirrorIndents", props.mirrorIndents))
	if (props.jc !== base.jc) out.push(val("jc", JUSTIFICATION[props.jc] ?? "left"))

	if (props.outlineLevel !== base.outlineLevel) out.push(val("outlineLvl", clamp(props.outlineLevel, 0, 9)))

	return out.join("")
}

// PositionCodeOperand (§2.9.205): pcVert 0 margin, 1 page, 2 text; pcHorz 0 column, 1 margin, 2 page.
// dxaAbs/dyaAbs special values (§2.9.? XAS/YAS): -4 center, -8 right, -12 inside, -16 outside; -4 top … -20 bottom.
function framePr(
	anchor: number,
	x: number,
	y: number,
	width: number,
	height: number,
	wrap: number,
	xFrom: number,
	yFrom: number,
	dropCap: number
): string {
	const vert = (anchor >> 4) & 3
	const horz = (anchor >> 6) & 3
	let out = "<w:framePr"

	if ((dropCap & 7) === 1) out += ' w:dropCap="drop"'
	else if ((dropCap & 7) === 2) out += ' w:dropCap="margin"'

	if ((dropCap & 7) !== 0) out += attr("w:lines", Math.max(1, dropCap >> 3))

	if (width > 0) out += attr("w:w", clamp(width & 0x7fff, 0, 31680))

	if (height !== 0) {
		out += attr("w:h", clamp(height & 0x7fff, 0, 31680))
		out += (height & 0x8000) !== 0 ? ' w:hRule="atLeast"' : ' w:hRule="exact"'
	}

	out +=
		wrap === 0
			? ' w:wrap="auto"'
			: wrap === 1
				? ' w:wrap="notBeside"'
				: wrap === 2
					? ' w:wrap="around"'
					: wrap === 3
						? ' w:wrap="none"'
						: wrap === 4
							? ' w:wrap="tight"'
							: wrap === 5
								? ' w:wrap="through"'
								: ""
	out += attr("w:hSpace", clamp(xFrom, 0, 31680))
	out += attr("w:vSpace", clamp(yFrom, 0, 31680))
	out += attr("w:vAnchor", vert === 1 ? "page" : vert === 2 ? "text" : "margin")
	out += attr("w:hAnchor", horz === 1 ? "margin" : horz === 2 ? "page" : "text")

	const xAlign: Readonly<Record<number, string>> = { 0: "left", [-4]: "center", [-8]: "right", [-12]: "inside", [-16]: "outside" }
	const yAlign: Readonly<Record<number, string>> = { [-4]: "top", [-8]: "center", [-12]: "bottom", [-16]: "inside", [-20]: "outside" }

	if (x !== 0 && xAlign[x] !== undefined) out += attr("w:xAlign", xAlign[x] ?? "left")
	else out += attr("w:x", clamp(x, -31680, 31680))

	if (yAlign[y] !== undefined) out += attr("w:yAlign", yAlign[y] ?? "top")
	else out += attr("w:y", clamp(y, -31680, 31680))

	return `${out}/>`
}
