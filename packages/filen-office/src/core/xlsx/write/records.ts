import type { XmlDocument } from "../../xml/index"
import type { SheetBorderStyle, SheetHorizontalAlign, SheetPatternType, SheetUnderline, SheetVerticalAlign } from "../../sheet/protocol"
import {
	XfApply,
	type XlsxAlignment,
	type XlsxBorder,
	type XlsxBorderEdge,
	type XlsxCellProtection,
	type XlsxColor,
	type XlsxDxf,
	type XlsxFill,
	type XlsxFont,
	type XlsxXf
} from "../model/types"
import { attr, qualify } from "./markup"
import { BORDER, DIFFERENTIAL_FORMAT } from "./order.generated"
import { childElement, colorAttributes, readColor, sameColor } from "./sections"
import { formatNumber, readBoolean } from "./text"

// Style records (styles.xml and rich text run properties) as markup, and read back from markup for the gate.

// --- Fonts ---

type FontElement =
	| "name"
	| "charset"
	| "family"
	| "b"
	| "i"
	| "strike"
	| "outline"
	| "shadow"
	| "condense"
	| "extend"
	| "color"
	| "sz"
	| "u"
	| "vertAlign"
	| "scheme"

function fontChild(font: XlsxFont, element: FontElement): string | null {
	const flag = (value: boolean | undefined): string | null => (value === undefined ? null : value ? "" : attr("val", 0))

	switch (element) {
		case "name":
			return font.name === undefined ? null : attr("val", font.name)
		case "charset":
			return font.charset === undefined ? null : attr("val", font.charset)
		case "family":
			return font.family === undefined ? null : attr("val", font.family)
		case "b":
			return flag(font.bold)
		case "i":
			return flag(font.italic)
		case "strike":
			return flag(font.strike)
		case "outline":
			return flag(font.outline)
		case "shadow":
			return flag(font.shadow)
		case "condense":
			return flag(font.condense)
		case "extend":
			return flag(font.extend)
		case "color":
			return font.color === undefined ? null : colorAttributes(font.color)
		case "sz":
			return font.size === undefined ? null : attr("val", formatNumber(font.size, "sz"))
		case "u":
			return font.underline === undefined ? null : font.underline === "single" ? "" : attr("val", font.underline)
		case "vertAlign":
			return font.vertAlign === undefined ? null : attr("val", font.vertAlign)
		case "scheme":
			return font.scheme === undefined ? null : attr("val", font.scheme)
	}
}

// CT_Font and CT_RPrElt are choices (any order); Excel writes them in this one, which the Open XML SDK
// expects.
const FONT_ORDER: readonly FontElement[] = [
	"b",
	"i",
	"strike",
	"condense",
	"extend",
	"outline",
	"shadow",
	"u",
	"vertAlign",
	"sz",
	"color",
	"name",
	"family",
	"charset",
	"scheme"
]

// A font's children; in run properties (`run`) the face is rFont.
export function fontChildren(font: XlsxFont, prefix: string, run: boolean): string {
	let markup = ""

	for (const element of FONT_ORDER) {
		const attributes = fontChild(font, element)

		if (attributes !== null) markup += `<${qualify(prefix, run && element === "name" ? "rFont" : element)}${attributes}/>`
	}

	return markup
}

export function fontMarkup(font: XlsxFont, prefix: string): string {
	return `<${qualify(prefix, "font")}>${fontChildren(font, prefix, false)}</${qualify(prefix, "font")}>`
}

export function readFont(document: XmlDocument, node: number): XlsxFont {
	const font: Record<string, unknown> = {}
	const val = (child: number): string | undefined => document.attribute(child, "val")
	const flag = (child: number): boolean => readBoolean(val(child), true)

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		switch (document.localName(child)) {
			case "name":
			case "rFont":
				font["name"] = val(child)
				break
			case "charset":
				font["charset"] = Number(val(child))
				break
			case "family":
				font["family"] = Number(val(child))
				break
			case "b":
				font["bold"] = flag(child)
				break
			case "i":
				font["italic"] = flag(child)
				break
			case "strike":
				font["strike"] = flag(child)
				break
			case "outline":
				font["outline"] = flag(child)
				break
			case "shadow":
				font["shadow"] = flag(child)
				break
			case "condense":
				font["condense"] = flag(child)
				break
			case "extend":
				font["extend"] = flag(child)
				break
			case "color":
				font["color"] = readColor(document, child)
				break
			case "sz":
				font["size"] = Number(val(child))
				break
			case "u":
				font["underline"] = (val(child) ?? "single") as SheetUnderline | "none"
				break
			case "vertAlign":
				font["vertAlign"] = val(child)
				break
			case "scheme":
				font["scheme"] = val(child)
				break
		}
	}

	return font as XlsxFont
}

const FONT_KEYS = [
	"name",
	"charset",
	"family",
	"bold",
	"italic",
	"strike",
	"outline",
	"shadow",
	"condense",
	"extend",
	"size",
	"underline",
	"vertAlign",
	"scheme"
] as const

export function sameFont(a: XlsxFont | undefined | null, b: XlsxFont | undefined | null): boolean {
	if (a === undefined || a === null || b === undefined || b === null) return (a ?? null) === (b ?? null)

	return FONT_KEYS.every(key => a[key] === b[key]) && sameColor(a.color, b.color)
}

// --- Fills ---

function colorElement(name: string, color: XlsxColor | undefined, prefix: string): string {
	return color === undefined ? "" : `<${qualify(prefix, name)}${colorAttributes(color)}/>`
}

export function fillMarkup(fill: XlsxFill, prefix: string): string {
	const tag = qualify(prefix, "fill")

	if (fill.kind === "pattern") {
		const pattern = qualify(prefix, "patternFill")
		const children = colorElement("fgColor", fill.fg, prefix) + colorElement("bgColor", fill.bg, prefix)

		return `<${tag}><${pattern}${attr("patternType", fill.pattern)}${children === "" ? "/>" : `>${children}</${pattern}>`}</${tag}>`
	}

	const gradient = qualify(prefix, "gradientFill")
	let head = `<${gradient}`

	if (fill.type === "path") head += attr("type", "path")
	if (fill.degree !== 0) head += attr("degree", formatNumber(fill.degree, "degree"))
	if (fill.left !== 0) head += attr("left", formatNumber(fill.left, "left"))
	if (fill.right !== 0) head += attr("right", formatNumber(fill.right, "right"))
	if (fill.top !== 0) head += attr("top", formatNumber(fill.top, "top"))
	if (fill.bottom !== 0) head += attr("bottom", formatNumber(fill.bottom, "bottom"))

	let stops = ""

	for (const stop of fill.stops) {
		stops += `<${qualify(prefix, "stop")}${attr("position", formatNumber(stop.position, "position"))}>${colorElement("color", stop.color, prefix)}</${qualify(prefix, "stop")}>`
	}

	return `<${tag}>${head}>${stops}</${gradient}></${tag}>`
}

export function readFill(document: XmlDocument, node: number): XlsxFill {
	const pattern = childElement(document, node, "patternFill")

	if (pattern >= 0) {
		const fg = childElement(document, pattern, "fgColor")
		const bg = childElement(document, pattern, "bgColor")
		const fill: { kind: "pattern"; pattern: SheetPatternType | "none" | "solid"; fg?: XlsxColor; bg?: XlsxColor } = {
			kind: "pattern",
			pattern: (document.attribute(pattern, "patternType") ?? "none") as SheetPatternType | "none" | "solid"
		}

		if (fg >= 0) fill.fg = readColor(document, fg)
		if (bg >= 0) fill.bg = readColor(document, bg)

		return fill
	}

	const gradient = childElement(document, node, "gradientFill")
	const number = (name: string): number => Number(gradient < 0 ? 0 : (document.attribute(gradient, name) ?? 0))
	const stops: { position: number; color: XlsxColor }[] = []

	for (let stop = gradient < 0 ? -1 : document.firstChildElement(gradient); stop >= 0; stop = document.nextSiblingElement(stop)) {
		if (document.localName(stop) !== "stop") continue

		const color = childElement(document, stop, "color")

		stops.push({ position: Number(document.attribute(stop, "position") ?? 0), color: color < 0 ? {} : readColor(document, color) })
	}

	return {
		kind: "gradient",
		type: gradient >= 0 && document.attribute(gradient, "type") === "path" ? "path" : "linear",
		degree: number("degree"),
		left: number("left"),
		right: number("right"),
		top: number("top"),
		bottom: number("bottom"),
		stops
	}
}

export function sameFill(a: XlsxFill | undefined, b: XlsxFill | undefined): boolean {
	if (a === undefined || b === undefined) return a === b
	if (a.kind === "pattern" || b.kind === "pattern") {
		return a.kind === "pattern" && b.kind === "pattern" && a.pattern === b.pattern && sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg)
	}

	return (
		a.type === b.type &&
		a.degree === b.degree &&
		a.left === b.left &&
		a.right === b.right &&
		a.top === b.top &&
		a.bottom === b.bottom &&
		a.stops.length === b.stops.length &&
		a.stops.every((stop, k) => stop.position === b.stops[k]?.position && sameColor(stop.color, b.stops[k]?.color))
	)
}

// --- Borders ---

const EDGES = ["left", "right", "top", "bottom", "diagonal", "vertical", "horizontal"] as const
// The edges Excel always writes, empty when unset.
const ALWAYS: ReadonlySet<string> = new Set(["left", "right", "top", "bottom", "diagonal"])

export function borderMarkup(border: XlsxBorder, prefix: string): string {
	let head = `<${qualify(prefix, "border")}`

	if (border.diagonalUp === true) head += attr("diagonalUp", 1)
	if (border.diagonalDown === true) head += attr("diagonalDown", 1)
	if (border.outline === false) head += attr("outline", 0)

	let children = ""

	for (const local of BORDER) {
		if (!(EDGES as readonly string[]).includes(local)) continue

		const edge = border[local as (typeof EDGES)[number]]

		if (edge === undefined && !ALWAYS.has(local)) continue

		const name = qualify(prefix, local)
		const style = edge?.style === undefined ? "" : attr("style", edge.style)
		const color = edge?.color === undefined ? "" : colorElement("color", edge.color, prefix)

		children += color === "" ? `<${name}${style}/>` : `<${name}${style}>${color}</${name}>`
	}

	return `${head}>${children}</${qualify(prefix, "border")}>`
}

export function readBorder(document: XmlDocument, node: number): XlsxBorder {
	const border: Record<string, unknown> = {}

	if (readBoolean(document.attribute(node, "diagonalUp"), false)) border["diagonalUp"] = true
	if (readBoolean(document.attribute(node, "diagonalDown"), false)) border["diagonalDown"] = true
	if (!readBoolean(document.attribute(node, "outline"), true)) border["outline"] = false

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)
		const key = local === "start" ? "left" : local === "end" ? "right" : local

		if (!(EDGES as readonly string[]).includes(key)) continue

		const style = document.attribute(child, "style")
		const color = childElement(document, child, "color")
		const edge: { style?: SheetBorderStyle; color?: XlsxColor } = {}

		if (style !== undefined && style !== "none") edge.style = style as SheetBorderStyle
		if (color >= 0) edge.color = readColor(document, color)
		if (edge.style !== undefined || edge.color !== undefined) border[key] = edge
	}

	return border as XlsxBorder
}

function sameEdge(a: XlsxBorderEdge | undefined, b: XlsxBorderEdge | undefined): boolean {
	const empty = (edge: XlsxBorderEdge | undefined): boolean =>
		edge === undefined || (edge.style === undefined && edge.color === undefined)

	if (empty(a) || empty(b)) return empty(a) && empty(b)

	return a?.style === b?.style && sameColor(a?.color, b?.color)
}

export function sameBorder(a: XlsxBorder | undefined, b: XlsxBorder | undefined): boolean {
	if (a === undefined || b === undefined) return a === b

	return (
		EDGES.every(edge => sameEdge(a[edge], b[edge])) &&
		(a.diagonalUp ?? false) === (b.diagonalUp ?? false) &&
		(a.diagonalDown ?? false) === (b.diagonalDown ?? false) &&
		(a.outline ?? true) === (b.outline ?? true)
	)
}

// --- Alignment, protection, xf, dxf ---

function alignmentMarkup(alignment: XlsxAlignment | undefined, prefix: string): string {
	if (alignment === undefined) return ""

	let markup = `<${qualify(prefix, "alignment")}`

	if (alignment.horizontal !== undefined) markup += attr("horizontal", alignment.horizontal)
	if (alignment.vertical !== undefined) markup += attr("vertical", alignment.vertical)
	if (alignment.textRotation !== undefined) markup += attr("textRotation", alignment.textRotation)
	if (alignment.wrapText !== undefined) markup += attr("wrapText", alignment.wrapText ? 1 : 0)
	if (alignment.indent !== undefined) markup += attr("indent", alignment.indent)
	if (alignment.relativeIndent !== undefined) markup += attr("relativeIndent", alignment.relativeIndent)
	if (alignment.justifyLastLine !== undefined) markup += attr("justifyLastLine", alignment.justifyLastLine ? 1 : 0)
	if (alignment.shrinkToFit !== undefined) markup += attr("shrinkToFit", alignment.shrinkToFit ? 1 : 0)
	if (alignment.readingOrder !== undefined) markup += attr("readingOrder", alignment.readingOrder)

	return `${markup}/>`
}

function readAlignment(document: XmlDocument, node: number): XlsxAlignment | undefined {
	if (node < 0) return undefined

	const alignment: Record<string, unknown> = {}
	const text = (name: string): string | undefined => document.attribute(node, name)

	if (text("horizontal") !== undefined) alignment["horizontal"] = text("horizontal") as SheetHorizontalAlign | "general"
	if (text("vertical") !== undefined) alignment["vertical"] = text("vertical") as SheetVerticalAlign
	if (text("textRotation") !== undefined) alignment["textRotation"] = Number(text("textRotation"))
	if (text("wrapText") !== undefined) alignment["wrapText"] = readBoolean(text("wrapText"), false)
	if (text("indent") !== undefined) alignment["indent"] = Number(text("indent"))
	if (text("relativeIndent") !== undefined) alignment["relativeIndent"] = Number(text("relativeIndent"))
	if (text("justifyLastLine") !== undefined) alignment["justifyLastLine"] = readBoolean(text("justifyLastLine"), false)
	if (text("shrinkToFit") !== undefined) alignment["shrinkToFit"] = readBoolean(text("shrinkToFit"), false)
	if (text("readingOrder") !== undefined) alignment["readingOrder"] = Number(text("readingOrder"))

	return alignment as XlsxAlignment
}

const ALIGNMENT_KEYS = [
	"horizontal",
	"vertical",
	"textRotation",
	"wrapText",
	"indent",
	"relativeIndent",
	"justifyLastLine",
	"shrinkToFit",
	"readingOrder"
] as const

function sameAlignment(a: XlsxAlignment | undefined, b: XlsxAlignment | undefined): boolean {
	if (a === undefined || b === undefined) return a === b

	return ALIGNMENT_KEYS.every(key => a[key] === b[key])
}

function protectionMarkup(protection: XlsxCellProtection | undefined, prefix: string): string {
	if (protection === undefined) return ""

	let markup = `<${qualify(prefix, "protection")}`

	if (protection.locked !== undefined) markup += attr("locked", protection.locked ? 1 : 0)
	if (protection.hidden !== undefined) markup += attr("hidden", protection.hidden ? 1 : 0)

	return `${markup}/>`
}

function readCellProtection(document: XmlDocument, node: number): XlsxCellProtection | undefined {
	if (node < 0) return undefined

	const protection: { locked?: boolean; hidden?: boolean } = {}
	const locked = document.attribute(node, "locked")
	const hidden = document.attribute(node, "hidden")

	if (locked !== undefined) protection.locked = readBoolean(locked, true)
	if (hidden !== undefined) protection.hidden = readBoolean(hidden, false)

	return protection
}

function sameCellProtection(a: XlsxCellProtection | undefined, b: XlsxCellProtection | undefined): boolean {
	if (a === undefined || b === undefined) return a === b

	return a.locked === b.locked && a.hidden === b.hidden
}

const APPLY: readonly (readonly [string, number])[] = [
	["applyNumberFormat", XfApply.NUMBER_FORMAT],
	["applyFont", XfApply.FONT],
	["applyFill", XfApply.FILL],
	["applyBorder", XfApply.BORDER],
	["applyAlignment", XfApply.ALIGNMENT],
	["applyProtection", XfApply.PROTECTION]
]

export function xfMarkup(xf: XlsxXf, prefix: string): string {
	let head = `<${qualify(prefix, "xf")}${attr("numFmtId", xf.numFmtId)}${attr("fontId", xf.fontId)}${attr("fillId", xf.fillId)}${attr("borderId", xf.borderId)}`

	if (xf.xfId >= 0) head += attr("xfId", xf.xfId)
	if ((xf.flags & XfApply.QUOTE_PREFIX) !== 0) head += attr("quotePrefix", 1)
	if ((xf.flags & XfApply.PIVOT_BUTTON) !== 0) head += attr("pivotButton", 1)

	for (const [name, bit] of APPLY) if ((xf.flags & bit) !== 0) head += attr(name, 1)

	const children = alignmentMarkup(xf.alignment, prefix) + protectionMarkup(xf.protection, prefix)

	return children === "" ? `${head}/>` : `${head}>${children}</${qualify(prefix, "xf")}>`
}

// `cellStyle`: a cellStyleXfs record (no xfId).
export function readXf(document: XmlDocument, node: number, cellStyle: boolean): XlsxXf {
	let flags = 0

	for (const [name, bit] of APPLY) if (readBoolean(document.attribute(node, name), false)) flags |= bit

	if (readBoolean(document.attribute(node, "quotePrefix"), false)) flags |= XfApply.QUOTE_PREFIX
	if (readBoolean(document.attribute(node, "pivotButton"), false)) flags |= XfApply.PIVOT_BUTTON

	const alignment = readAlignment(document, childElement(document, node, "alignment"))
	const protection = readCellProtection(document, childElement(document, node, "protection"))
	const number = (name: string): number => Number(document.attribute(node, name) ?? 0)

	return {
		numFmtId: number("numFmtId"),
		fontId: number("fontId"),
		fillId: number("fillId"),
		borderId: number("borderId"),
		xfId: cellStyle ? -1 : number("xfId"),
		flags,
		...(alignment === undefined ? {} : { alignment }),
		...(protection === undefined ? {} : { protection })
	}
}

export function sameXf(a: XlsxXf | undefined, b: XlsxXf | undefined): boolean {
	if (a === undefined || b === undefined) return a === b

	return (
		a.numFmtId === b.numFmtId &&
		a.fontId === b.fontId &&
		a.fillId === b.fillId &&
		a.borderId === b.borderId &&
		Math.max(-1, a.xfId) === Math.max(-1, b.xfId) &&
		a.flags === b.flags &&
		sameAlignment(a.alignment, b.alignment) &&
		sameCellProtection(a.protection, b.protection)
	)
}

export function numFmtMarkup(id: number, code: string, prefix: string): string {
	return `<${qualify(prefix, "numFmt")}${attr("numFmtId", id)}${attr("formatCode", code)}/>`
}

export function dxfMarkup(dxf: XlsxDxf, prefix: string): string {
	let children = ""

	for (const local of DIFFERENTIAL_FORMAT) {
		switch (local) {
			case "font":
				if (dxf.font !== undefined) children += fontMarkup(dxf.font, prefix)
				break
			case "numFmt":
				if (dxf.numFmt !== undefined) children += numFmtMarkup(dxf.numFmt.id, dxf.numFmt.code, prefix)
				break
			case "fill":
				if (dxf.fill !== undefined) children += fillMarkup(dxf.fill, prefix)
				break
			case "alignment":
				children += alignmentMarkup(dxf.alignment, prefix)
				break
			case "border":
				if (dxf.border !== undefined) children += borderMarkup(dxf.border, prefix)
				break
			case "protection":
				children += protectionMarkup(dxf.protection, prefix)
				break
		}
	}

	return children === "" ? `<${qualify(prefix, "dxf")}/>` : `<${qualify(prefix, "dxf")}>${children}</${qualify(prefix, "dxf")}>`
}

export function readDxf(document: XmlDocument, node: number): XlsxDxf {
	const dxf: Record<string, unknown> = {}
	const font = childElement(document, node, "font")
	const numFmt = childElement(document, node, "numFmt")
	const fill = childElement(document, node, "fill")
	const border = childElement(document, node, "border")
	const alignment = readAlignment(document, childElement(document, node, "alignment"))
	const protection = readCellProtection(document, childElement(document, node, "protection"))

	if (font >= 0) dxf["font"] = readFont(document, font)
	if (numFmt >= 0)
		dxf["numFmt"] = { id: Number(document.attribute(numFmt, "numFmtId") ?? 0), code: document.attribute(numFmt, "formatCode") ?? "" }
	if (fill >= 0) dxf["fill"] = readFill(document, fill)
	if (alignment !== undefined) dxf["alignment"] = alignment
	if (border >= 0) dxf["border"] = readBorder(document, border)
	if (protection !== undefined) dxf["protection"] = protection

	return dxf as XlsxDxf
}

export function sameDxf(a: XlsxDxf | undefined, b: XlsxDxf | undefined): boolean {
	if (a === undefined || b === undefined) return a === b

	return (
		sameFont(a.font, b.font) &&
		(a.numFmt === undefined || b.numFmt === undefined
			? a.numFmt === b.numFmt
			: a.numFmt.id === b.numFmt.id && a.numFmt.code === b.numFmt.code) &&
		sameFill(a.fill, b.fill) &&
		sameAlignment(a.alignment, b.alignment) &&
		sameBorder(a.border, b.border) &&
		sameCellProtection(a.protection, b.protection)
	)
}
