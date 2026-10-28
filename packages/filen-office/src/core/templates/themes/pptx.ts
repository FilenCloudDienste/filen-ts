import { THEME_COLOR_SLOTS, themeName, type FilenTheme, type ThemeDecoration, type ThemeVariant } from "./model"

// A Filen theme as PresentationML: the theme part (a:theme, ECMA-376 Part 1 §20.1.6), a slide master (§19.3.1.42)
// and the eleven slide layouts PowerPoint offers by default (§19.3.1.39, ST_SlideLayoutType §19.7.15), sized to the
// deck. Placeholder geometry is computed from the slide size; layout placeholders inherit their text formatting from
// the master's text styles (§19.3.1.51), and every colour and font is theme-relative, so a variant only changes the
// theme part and the master's colour map. Layout placeholders carry no prompt text: without hasCustomPrompt the
// application shows its own, in the user's language.

export const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
export const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
export const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"

const ROOT_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`

export interface SlideSize {
	readonly cx: number
	readonly cy: number
}

// The deck size of the templates: 16:9 at 13.333 × 7.5 in.
export const WIDESCREEN: SlideSize = { cx: 12_192_000, cy: 6_858_000 }

// The eleven layouts, in the order a master lists them (and New slide offers them).
export const LAYOUT_TYPES = [
	"title",
	"obj",
	"secHead",
	"twoObj",
	"twoTxTwoObj",
	"titleOnly",
	"blank",
	"objTx",
	"picTx",
	"vertTx",
	"vertTitleAndTx"
] as const

export type FilenLayoutType = (typeof LAYOUT_TYPES)[number]

const LAYOUT_NAMES: Readonly<Record<FilenLayoutType, string>> = {
	title: "Title Slide",
	obj: "Title and Content",
	secHead: "Section Header",
	twoObj: "Two Content",
	twoTxTwoObj: "Comparison",
	titleOnly: "Title Only",
	blank: "Blank",
	objTx: "Content with Caption",
	picTx: "Picture with Caption",
	vertTx: "Title and Vertical Text",
	vertTitleAndTx: "Vertical Title and Text"
}

// Our own fixed GUID for the slide-number field of the master (a:fld@id is required, §21.1.2.2.4).
const SLIDE_NUMBER_FIELD = "{5D3A0F6E-2E7B-4C8A-9F1D-6B1E2A7C4F10}"
const DATE_FIELD = "{8C1B6E2A-4F3D-4E9B-A2C7-1D5E6F7A8B90}"

// A box in fractions of the slide.
interface Box {
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
}

const MARGIN_X = 0.06875
const CONTENT_W = 1 - 2 * MARGIN_X
const TITLE: Box = { x: MARGIN_X, y: 0.0532, w: CONTENT_W, h: 0.1933 }
const BODY: Box = { x: MARGIN_X, y: 0.2662, w: CONTENT_W, h: 0.6345 }
const FOOTER_Y = 0.9268
const FOOTER_H = 0.0532
const DATE: Box = { x: MARGIN_X, y: FOOTER_Y, w: 0.225, h: FOOTER_H }
const FOOTER: Box = { x: 0.33125, y: FOOTER_Y, w: 0.3375, h: FOOTER_H }
const NUMBER: Box = { x: 0.70625, y: FOOTER_Y, w: 0.225, h: FOOTER_H }
const HALF_W = (CONTENT_W - 0.0187) / 2
const RIGHT_X = MARGIN_X + HALF_W + 0.0187

function emu(value: number): string {
	return String(Math.round(value))
}

function xfrm(box: Box, size: SlideSize): string {
	return (
		`<a:xfrm><a:off x="${emu(box.x * size.cx)}" y="${emu(box.y * size.cy)}"/>` +
		`<a:ext cx="${emu(box.w * size.cx)}" cy="${emu(box.h * size.cy)}"/></a:xfrm>`
	)
}

function escape(text: string): string {
	return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;")
}

// --- the theme part ---

function fontXml(tag: "majorFont" | "minorFont", typeface: string): string {
	return `<a:${tag}><a:latin typeface="${escape(typeface)}"/><a:ea typeface=""/><a:cs typeface=""/></a:${tag}>`
}

const PH = '<a:schemeClr val="phClr"/>'

// Three of each style list (§20.1.4.1.13 needs at least three): subtle, moderate, intense.
const FORMAT_SCHEME =
	'<a:fmtScheme name="Filen"><a:fillStyleLst>' +
	`<a:solidFill>${PH}</a:solidFill>` +
	'<a:solidFill><a:schemeClr val="phClr"><a:tint val="60000"/></a:schemeClr></a:solidFill>' +
	'<a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill>' +
	"</a:fillStyleLst><a:lnStyleLst>" +
	`<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>${PH}</a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>` +
	`<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>${PH}</a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>` +
	`<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>${PH}</a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>` +
	"</a:lnStyleLst><a:effectStyleLst>" +
	"<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>" +
	"</a:effectStyleLst><a:bgFillStyleLst>" +
	`<a:solidFill>${PH}</a:solidFill>` +
	'<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>' +
	`<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0">${PH}</a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>` +
	"</a:bgFillStyleLst></a:fmtScheme>"

export function themeXml(theme: FilenTheme, variantIndex: number): string {
	const variant = variantOf(theme, variantIndex)
	const name = escape(themeName(theme, variantIndex))
	const colors = THEME_COLOR_SLOTS.map(slot => `<a:${slot}><a:srgbClr val="${variant.colors[slot]}"/></a:${slot}>`).join("")

	return (
		`<a:theme xmlns:a="${NS_A}" name="${name}"><a:themeElements>` +
		`<a:clrScheme name="${name}">${colors}</a:clrScheme>` +
		`<a:fontScheme name="${name}">${fontXml("majorFont", theme.major)}${fontXml("minorFont", theme.minor)}</a:fontScheme>` +
		FORMAT_SCHEME +
		"</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"
	)
}

export function variantOf(theme: FilenTheme, index: number): ThemeVariant {
	return theme.variants[Math.max(0, Math.min(3, Math.trunc(index)))] ?? theme.variants[0]
}

// --- the master ---

export function clrMapAttributes(dark: boolean): string {
	return dark ? 'bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"' : 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"'
}

const CLR_MAP_REST =
	'accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'

function backgroundXml(variant: ThemeVariant): string {
	// bgRef 1001 is the first background fill style, 1003 the third (the gradient), in bg1 (§20.1.4.2.10).
	return `<p:bg><p:bgRef idx="${variant.background === "gradient" ? "1003" : "1001"}"><a:schemeClr val="bg1"/></p:bgRef></p:bg>`
}

interface Decoration {
	readonly box: Box
	readonly geometry: string
	readonly flipH?: boolean
	readonly outline?: boolean
}

const DECORATIONS: Readonly<Record<Exclude<ThemeDecoration, "none">, Decoration>> = {
	leftBar: { box: { x: 0, y: 0, w: 0.0125, h: 1 }, geometry: "rect" },
	bottomBand: { box: { x: 0, y: 0.985, w: 1, h: 0.015 }, geometry: "rect" },
	topRule: { box: { x: MARGIN_X, y: 0.0305, w: CONTENT_W, h: 0.004 }, geometry: "rect" },
	sideBand: { box: { x: 0.975, y: 0, w: 0.025, h: 1 }, geometry: "rect" },
	frame: { box: { x: 0.02, y: 0.0356, w: 0.96, h: 0.9288 }, geometry: "rect", outline: true },
	titleRule: { box: { x: MARGIN_X, y: 0.2495, w: 0.1, h: 0.006 }, geometry: "rect" },
	corner: { box: { x: 0.88, y: 0.79, w: 0.12, h: 0.21 }, geometry: "rtTriangle", flipH: true }
}

export function decorationOf(theme: FilenTheme): Decoration | undefined {
	return theme.decoration === "none" ? undefined : DECORATIONS[theme.decoration]
}

function decorationXml(theme: FilenTheme, size: SlideSize, id: number): string {
	const decoration = decorationOf(theme)

	if (decoration === undefined) return ""

	const { box } = decoration
	const frame =
		`<a:xfrm${decoration.flipH === true ? ' flipH="1"' : ""}><a:off x="${emu(box.x * size.cx)}" y="${emu(box.y * size.cy)}"/>` +
		`<a:ext cx="${emu(box.w * size.cx)}" cy="${emu(box.h * size.cy)}"/></a:xfrm>`
	const paint =
		decoration.outline === true
			? '<a:noFill/><a:ln w="12700"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln>'
			: '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln><a:noFill/></a:ln>'

	return (
		`<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="Decoration"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr>` +
		`<p:spPr>${frame}<a:prstGeom prst="${decoration.geometry}"><a:avLst/></a:prstGeom>${paint}</p:spPr></p:sp>`
	)
}

interface Placeholder {
	readonly type?: string
	readonly idx?: number
	readonly name: string
	readonly box?: Box
	readonly sz?: "half" | "quarter"
	readonly orient?: "vert"
	readonly anchor?: "t" | "ctr" | "b"
	readonly vert?: "eaVert"
	readonly lstStyle?: string
	// Paragraph markup in place of an empty paragraph (the master's fields).
	readonly paragraph?: string
}

function placeholderXml(ph: Placeholder, id: number, size: SlideSize, master: boolean): string {
	const attributes =
		(ph.type === undefined ? "" : ` type="${ph.type}"`) +
		(ph.orient === undefined ? "" : ` orient="${ph.orient}"`) +
		(ph.sz === undefined ? "" : ` sz="${ph.sz}"`) +
		(ph.idx === undefined ? "" : ` idx="${String(ph.idx)}"`)
	const geometry = ph.box === undefined ? "" : xfrm(ph.box, size) + (master ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' : "")
	const bodyPr =
		"<a:bodyPr" +
		(ph.vert === undefined ? "" : ` vert="${ph.vert}"`) +
		(master ? ' lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"' : "") +
		(ph.anchor === undefined ? "" : ` anchor="${ph.anchor}"`) +
		(master && ph.type === "title"
			? "><a:normAutofit/></a:bodyPr>"
			: master && ph.type === "body"
				? "><a:normAutofit/></a:bodyPr>"
				: "/>")
	const lstStyle = ph.lstStyle === undefined ? "<a:lstStyle/>" : `<a:lstStyle>${ph.lstStyle}</a:lstStyle>`
	const paragraph = ph.paragraph ?? '<a:p><a:endParaRPr lang="en-US"/></a:p>'

	return (
		`<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="${escape(ph.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
		`<p:nvPr><p:ph${attributes}/></p:nvPr></p:nvSpPr><p:spPr>${geometry}</p:spPr>` +
		`<p:txBody>${bodyPr}${lstStyle}${paragraph}</p:txBody></p:sp>`
	)
}

function spTree(content: string): string {
	return (
		'<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
		'<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
		`${content}</p:spTree>`
	)
}

const LEFT = ' algn="l"'
const CENTER = ' algn="ctr"'
const RIGHT = ' algn="r"'

function levelXml(level: number, pPr: string, rPr: string): string {
	return `<a:lvl${String(level)}pPr${pPr}>${rPr}</a:lvl${String(level)}pPr>`
}

function runFont(size: number, font: "mj" | "mn", color = "tx1"): string {
	return (
		`<a:defRPr sz="${String(size)}" kern="1200"><a:solidFill><a:schemeClr val="${color}"/></a:solidFill>` +
		`<a:latin typeface="+${font}-lt"/><a:ea typeface="+${font}-ea"/><a:cs typeface="+${font}-cs"/></a:defRPr>`
	)
}

const BODY_SIZES = [2800, 2400, 2000, 1800, 1800, 1800, 1800, 1800, 1800]

function textStylesXml(): string {
	const title =
		"<p:titleStyle>" +
		levelXml(
			1,
			`${LEFT} defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"`,
			'<a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/>' + runFont(4400, "mj")
		) +
		"</p:titleStyle>"
	const body =
		"<p:bodyStyle>" +
		BODY_SIZES.map((size, index) =>
			levelXml(
				index + 1,
				` marL="${String(228_600 + index * 457_200)}" indent="-228600"${LEFT} defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"`,
				`<a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="${index === 0 ? "1000" : "500"}"/></a:spcBef>` +
					'<a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="&#8226;"/>' +
					runFont(size, "mn")
			)
		).join("") +
		"</p:bodyStyle>"
	const other =
		'<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>' +
		Array.from({ length: 9 }, (_, index) =>
			levelXml(
				index + 1,
				` marL="${String(index * 457_200)}"${LEFT} defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"`,
				runFont(1800, "mn")
			)
		).join("") +
		"</p:otherStyle>"

	return `<p:txStyles>${title}${body}${other}</p:txStyles>`
}

function footerStyle(algn: string): string {
	return levelXml(
		1,
		algn,
		'<a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr></a:solidFill></a:defRPr>'
	)
}

const MASTER_FOOTERS: readonly Placeholder[] = [
	{
		type: "dt",
		idx: 2,
		sz: "half",
		name: "Date Placeholder 3",
		box: DATE,
		anchor: "ctr",
		lstStyle: footerStyle(LEFT),
		paragraph: `<a:p><a:fld id="${DATE_FIELD}" type="datetimeFigureOut"><a:rPr lang="en-US"/><a:t></a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>`
	},
	{ type: "ftr", idx: 3, sz: "quarter", name: "Footer Placeholder 4", box: FOOTER, anchor: "ctr", lstStyle: footerStyle(CENTER) },
	{
		type: "sldNum",
		idx: 4,
		sz: "quarter",
		name: "Slide Number Placeholder 5",
		box: NUMBER,
		anchor: "ctr",
		lstStyle: footerStyle(RIGHT),
		paragraph: `<a:p><a:fld id="${SLIDE_NUMBER_FIELD}" type="slidenum"><a:rPr lang="en-US"/><a:t>&#8249;#&#8250;</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>`
	}
]

// The master: decoration first (behind), then title, body and the three footers; `layoutRIds` its layouts'
// relationship ids in LAYOUT_TYPES order, `layoutIds` their p:sldLayoutId@id values.
export function masterXml(
	theme: FilenTheme,
	variantIndex: number,
	size: SlideSize,
	layouts: readonly { readonly id: number; readonly rId: string }[]
): string {
	const variant = variantOf(theme, variantIndex)
	const decoration = decorationXml(theme, size, 7)
	const placeholders = [
		placeholderXml({ type: "title", name: "Title Placeholder 1", box: TITLE, anchor: "ctr" }, 2, size, true),
		placeholderXml({ type: "body", idx: 1, name: "Text Placeholder 2", box: BODY }, 3, size, true),
		...MASTER_FOOTERS.map((ph, index) => placeholderXml(ph, 4 + index, size, true))
	].join("")
	const list = layouts.map(layout => `<p:sldLayoutId id="${String(layout.id)}" r:id="${layout.rId}"/>`).join("")

	return (
		`<p:sldMaster ${ROOT_NS}><p:cSld name="${escape(themeName(theme, variantIndex))}">${backgroundXml(variant)}` +
		spTree(decoration + placeholders) +
		`</p:cSld><p:clrMap ${clrMapAttributes(variant.dark)} ${CLR_MAP_REST}/>` +
		`<p:sldLayoutIdLst>${list}</p:sldLayoutIdLst>${textStylesXml()}</p:sldMaster>`
	)
}

// --- the layouts ---

const LAYOUT_FOOTERS: readonly Placeholder[] = [
	{ type: "dt", idx: 10, sz: "half", name: "Date Placeholder" },
	{ type: "ftr", idx: 11, sz: "quarter", name: "Footer Placeholder" },
	{ type: "sldNum", idx: 12, sz: "quarter", name: "Slide Number Placeholder" }
]

const NO_BULLET_CENTER = '<a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr>'

function layoutPlaceholders(type: FilenLayoutType): Placeholder[] {
	const title: Placeholder = { type: "title", name: "Title 1" }

	switch (type) {
		case "title":
			return [
				{
					type: "ctrTitle",
					name: "Title 1",
					box: { x: 0.125, y: 0.1637, w: 0.75, h: 0.3481 },
					anchor: "b",
					lstStyle: '<a:lvl1pPr algn="ctr"><a:defRPr sz="6000"/></a:lvl1pPr>'
				},
				{
					type: "subTitle",
					idx: 1,
					name: "Subtitle 2",
					box: { x: 0.125, y: 0.5252, w: 0.75, h: 0.2414 },
					lstStyle: NO_BULLET_CENTER
				}
			]
		case "obj":
			return [title, { idx: 1, name: "Content Placeholder 2" }]
		case "secHead":
			return [
				{
					type: "title",
					name: "Title 1",
					box: { x: 0.0719, y: 0.2667, w: CONTENT_W, h: 0.4451 },
					anchor: "b",
					lstStyle: '<a:lvl1pPr><a:defRPr sz="6000"/></a:lvl1pPr>'
				},
				{
					type: "body",
					idx: 1,
					name: "Text Placeholder 2",
					box: { x: 0.0719, y: 0.7161, w: CONTENT_W, h: 0.2341 },
					lstStyle:
						'<a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>'
				}
			]
		case "twoObj":
			return [
				title,
				{ sz: "half", idx: 1, name: "Content Placeholder 2", box: { x: MARGIN_X, y: BODY.y, w: HALF_W, h: BODY.h } },
				{ sz: "half", idx: 2, name: "Content Placeholder 3", box: { x: RIGHT_X, y: BODY.y, w: HALF_W, h: BODY.h } }
			]
		case "twoTxTwoObj": {
			const head = '<a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="2400" b="1"/></a:lvl1pPr>'

			return [
				title,
				{
					type: "body",
					idx: 1,
					name: "Text Placeholder 2",
					box: { x: MARGIN_X, y: 0.2449, w: HALF_W, h: 0.1202 },
					anchor: "b",
					lstStyle: head
				},
				{ sz: "half", idx: 2, name: "Content Placeholder 3", box: { x: MARGIN_X, y: 0.3651, w: HALF_W, h: 0.5376 } },
				{
					type: "body",
					sz: "quarter",
					idx: 3,
					name: "Text Placeholder 4",
					box: { x: RIGHT_X, y: 0.2449, w: HALF_W, h: 0.1202 },
					anchor: "b",
					lstStyle: head
				},
				{ sz: "quarter", idx: 4, name: "Content Placeholder 5", box: { x: RIGHT_X, y: 0.3651, w: HALF_W, h: 0.5376 } }
			]
		}
		case "titleOnly":
			return [title]
		case "blank":
			return []
		case "objTx":
		case "picTx": {
			const caption = '<a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="1600"/></a:lvl1pPr>'

			return [
				{
					type: "title",
					name: "Title 1",
					box: { x: 0.0719, y: 0.0667, w: 0.3359, h: 0.2333 },
					anchor: "b",
					lstStyle: '<a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr>'
				},
				type === "picTx"
					? {
							type: "pic",
							idx: 1,
							name: "Picture Placeholder 2",
							box: { x: 0.4318, y: 0.144, w: 0.5, h: 0.7106 },
							lstStyle: '<a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="3200"/></a:lvl1pPr>'
						}
					: { idx: 1, name: "Content Placeholder 2", box: { x: 0.4318, y: 0.144, w: 0.5, h: 0.7106 } },
				{
					type: "body",
					sz: "half",
					idx: 2,
					name: "Text Placeholder 3",
					box: { x: 0.0719, y: 0.3, w: 0.3359, h: 0.5558 },
					lstStyle: caption
				}
			]
		}
		case "vertTx":
			return [title, { type: "body", orient: "vert", idx: 1, name: "Vertical Text Placeholder 2", vert: "eaVert" }]
		case "vertTitleAndTx":
			return [
				{
					type: "title",
					orient: "vert",
					name: "Vertical Title 1",
					box: { x: 0.7271, y: 0.0532, w: 0.2156, h: 0.8475 },
					vert: "eaVert"
				},
				{
					type: "body",
					orient: "vert",
					idx: 1,
					name: "Vertical Text Placeholder 2",
					box: { x: MARGIN_X, y: 0.0532, w: 0.6333, h: 0.8475 },
					vert: "eaVert"
				}
			]
	}
}

export function layoutXml(type: FilenLayoutType, size: SlideSize): string {
	const shapes = [...layoutPlaceholders(type), ...LAYOUT_FOOTERS].map((ph, index) => placeholderXml(ph, index + 2, size, false)).join("")

	return (
		`<p:sldLayout ${ROOT_NS} type="${type}" preserve="1"><p:cSld name="${escape(LAYOUT_NAMES[type])}">${spTree(shapes)}</p:cSld>` +
		"<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
	)
}

// --- a slide on a layout ---

// A slide with the layout's title and body placeholders, empty (or with `title` written in the first).
export function slideXml(type: FilenLayoutType, title?: string, lang = "en-US"): string {
	const shapes = layoutPlaceholders(type)
		.map((ph, index) => {
			const text =
				index === 0 && title !== undefined && title !== ""
					? `<a:p><a:r><a:rPr lang="${escape(lang)}" dirty="0"/><a:t>${escape(title)}</a:t></a:r></a:p>`
					: `<a:p><a:endParaRPr lang="${escape(lang)}" dirty="0"/></a:p>`
			const attributes =
				(ph.type === undefined ? "" : ` type="${ph.type}"`) +
				(ph.orient === undefined ? "" : ` orient="${ph.orient}"`) +
				(ph.sz === undefined ? "" : ` sz="${ph.sz}"`) +
				(ph.idx === undefined ? "" : ` idx="${String(ph.idx)}"`)

			return (
				`<p:sp><p:nvSpPr><p:cNvPr id="${String(index + 2)}" name="${escape(ph.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
				`<p:nvPr><p:ph${attributes}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${text}</p:txBody></p:sp>`
			)
		})
		.join("")

	return `<p:sld ${ROOT_NS}><p:cSld>${spTree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

// --- the parts of a theme, related ---

export const RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
export const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships"

export const CONTENT_TYPE = {
	presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
	master: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
	layout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
	slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
	theme: "application/vnd.openxmlformats-officedocument.theme+xml"
} as const

export function relationshipsXml(entries: readonly { readonly id: string; readonly type: string; readonly target: string }[]): string {
	return (
		`<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
		entries
			.map(entry => `<Relationship Id="${entry.id}" Type="${RELATIONSHIP}/${entry.type}" Target="${escape(entry.target)}"/>`)
			.join("") +
		"</Relationships>"
	)
}

// A part of a theme set: its zip name ("ppt/slideMasters/slideMaster1.xml"), markup and relationships markup.
export interface DesignPart {
	readonly name: string
	readonly contentType: string
	readonly markup: string
	readonly rels?: string
}

export interface DesignSet {
	readonly theme: DesignPart
	readonly master: DesignPart
	readonly layouts: readonly (DesignPart & { readonly type: FilenLayoutType })[]
}

// The theme, master and layouts of one Filen theme variant under the given names; `firstId` is the master's
// p:sldMasterId@id and its layouts take the ids after it (ids ≥ 2^31 shared by masters and layouts, §19.2.1.27).
export function designSet(
	theme: FilenTheme,
	variantIndex: number,
	size: SlideSize,
	names: { readonly theme: string; readonly master: string; readonly layouts: readonly string[] },
	firstId: number
): DesignSet {
	const relative = (from: string, to: string): string => {
		const fromParts = from.split("/").slice(0, -1)
		const toParts = to.split("/")
		let common = 0

		while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common++

		return [...fromParts.slice(common).map(() => ".."), ...toParts.slice(common)].join("/")
	}
	const layouts = LAYOUT_TYPES.map((type, index) => {
		const name = names.layouts[index] ?? ""

		return {
			type,
			name,
			contentType: CONTENT_TYPE.layout,
			markup: layoutXml(type, size),
			rels: relationshipsXml([{ id: "rId1", type: "slideMaster", target: relative(name, names.master) }])
		}
	})
	const layoutRefs = LAYOUT_TYPES.map((_, index) => ({ id: firstId + 1 + index, rId: `rId${String(index + 1)}` }))

	return {
		theme: { name: names.theme, contentType: CONTENT_TYPE.theme, markup: themeXml(theme, variantIndex) },
		master: {
			name: names.master,
			contentType: CONTENT_TYPE.master,
			markup: masterXml(theme, variantIndex, size, layoutRefs),
			rels: relationshipsXml([
				...layouts.map((layout, index) => ({
					id: `rId${String(index + 1)}`,
					type: "slideLayout",
					target: relative(names.master, layout.name)
				})),
				{ id: `rId${String(layouts.length + 1)}`, type: "theme", target: relative(names.master, names.theme) }
			])
		},
		layouts
	}
}
