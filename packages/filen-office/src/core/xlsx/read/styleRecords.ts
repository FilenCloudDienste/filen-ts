import type { SheetBorderStyle, SheetHorizontalAlign, SheetPatternType, SheetUnderline, SheetVerticalAlign } from "../../sheet/protocol"
import type { XmlDocument } from "../../xml/index"
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

// The SpreadsheetML style records (ECMA-376 Part 1 §18.8) from a parsed part, by local name (Transitional and
// Strict alike). Absent attributes stay absent, so a record says only what the file says.

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export function* childElements(document: XmlDocument, node: number): Generator<number> {
	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) yield child
}

export function childByLocal(document: XmlDocument, node: number, local: string): number {
	for (let child = node < 0 ? -1 : document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === local) return child
	}

	return -1
}

// ST_Boolean: "1"/"true" or "0"/"false"; undefined for anything else.
export function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined

	const trimmed = value.trim()

	if (trimmed === "1" || trimmed === "true") return true
	if (trimmed === "0" || trimmed === "false") return false

	return undefined
}

export function booleanAttribute(document: XmlDocument, node: number, name: string, fallback: boolean): boolean {
	return parseBoolean(document.attribute(node, name)) ?? fallback
}

// A finite number, or undefined.
export function numberAttribute(document: XmlDocument, node: number, name: string): number | undefined {
	return numberValue(document.attribute(node, name))
}

function numberValue(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined

	const number = Number(value)

	return Number.isFinite(number) ? number : undefined
}

export function intAttribute(document: XmlDocument, node: number, name: string, fallback: number): number {
	return intValue(document.attribute(node, name), fallback)
}

export function intValue(value: string | undefined, fallback: number): number {
	const number = numberValue(value)

	return number === undefined || !Number.isInteger(number) ? fallback : number
}

// A CT_BooleanProperty element (<b/>, <i val="0"/>): val defaults to true.
function booleanProperty(document: XmlDocument, node: number): boolean {
	return parseBoolean(document.attribute(node, "val")) ?? true
}

const COLOR_ATTRIBUTES = ["rgb", "theme", "tint", "indexed", "auto"]

export function readColor(document: XmlDocument, node: number): XlsxColor {
	const color: Mutable<XlsxColor> = {}
	const [rgb, themeValue, tintValue, indexedValue, autoValue] = document.attributeValues(node, COLOR_ATTRIBUTES)

	if (rgb !== undefined && /^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(rgb.trim())) {
		const hex = rgb.trim()

		color.argb = (hex.length === 6 ? Number.parseInt(`FF${hex}`, 16) : Number.parseInt(hex, 16)) >>> 0
	}

	const theme = numberValue(themeValue)
	const tint = numberValue(tintValue)
	const indexed = numberValue(indexedValue)
	const auto = parseBoolean(autoValue)

	if (theme !== undefined) color.theme = theme
	if (tint !== undefined) color.tint = tint
	if (indexed !== undefined) color.indexed = indexed
	if (auto !== undefined) color.auto = auto

	return color
}

const UNDERLINES: ReadonlySet<string> = new Set(["single", "double", "singleAccounting", "doubleAccounting", "none"])

// A font (CT_Font) or a rich run's properties (CT_RPrElt, rFont for name).
export function readFont(document: XmlDocument, node: number): XlsxFont {
	const font: Mutable<XlsxFont> = {}

	for (const child of childElements(document, node)) {
		const val = document.attribute(child, "val")

		switch (document.localName(child)) {
			case "name":
			case "rFont":
				if (val !== undefined) font.name = val

				break
			case "sz": {
				const size = numberValue(val)

				if (size !== undefined) font.size = size

				break
			}
			case "b":
				font.bold = booleanProperty(document, child)
				break
			case "i":
				font.italic = booleanProperty(document, child)
				break
			case "strike":
				font.strike = booleanProperty(document, child)
				break
			case "outline":
				font.outline = booleanProperty(document, child)
				break
			case "shadow":
				font.shadow = booleanProperty(document, child)
				break
			case "condense":
				font.condense = booleanProperty(document, child)
				break
			case "extend":
				font.extend = booleanProperty(document, child)
				break
			case "u": {
				const underline = val ?? "single"

				if (UNDERLINES.has(underline)) font.underline = underline as SheetUnderline | "none"

				break
			}
			case "vertAlign":
				if (val === "baseline" || val === "superscript" || val === "subscript") font.vertAlign = val

				break
			case "color":
				font.color = readColor(document, child)
				break
			case "family": {
				const family = numberValue(val)

				if (family !== undefined) font.family = family

				break
			}
			case "charset": {
				const charset = numberValue(val)

				if (charset !== undefined) font.charset = charset

				break
			}
			case "scheme":
				if (val === "major" || val === "minor" || val === "none") font.scheme = val

				break
		}
	}

	return font
}

const PATTERNS: ReadonlySet<string> = new Set([
	"none",
	"solid",
	"mediumGray",
	"darkGray",
	"lightGray",
	"darkHorizontal",
	"darkVertical",
	"darkDown",
	"darkUp",
	"darkGrid",
	"darkTrellis",
	"lightHorizontal",
	"lightVertical",
	"lightDown",
	"lightUp",
	"lightGrid",
	"lightTrellis",
	"gray125",
	"gray0625"
])

export function readFill(document: XmlDocument, node: number): XlsxFill {
	const gradient = childByLocal(document, node, "gradientFill")

	if (gradient >= 0) {
		const stops: { position: number; color: XlsxColor }[] = []

		for (const stop of childElements(document, gradient)) {
			if (document.localName(stop) !== "stop") continue

			const color = childByLocal(document, stop, "color")

			stops.push({ position: numberAttribute(document, stop, "position") ?? 0, color: color < 0 ? {} : readColor(document, color) })
		}

		return {
			kind: "gradient",
			type: document.attribute(gradient, "type") === "path" ? "path" : "linear",
			degree: numberAttribute(document, gradient, "degree") ?? 0,
			left: numberAttribute(document, gradient, "left") ?? 0,
			right: numberAttribute(document, gradient, "right") ?? 0,
			top: numberAttribute(document, gradient, "top") ?? 0,
			bottom: numberAttribute(document, gradient, "bottom") ?? 0,
			stops
		}
	}

	const pattern = childByLocal(document, node, "patternFill")
	const fill: Mutable<Extract<XlsxFill, { kind: "pattern" }>> = { kind: "pattern", pattern: "none" }

	if (pattern < 0) return fill

	const type = document.attribute(pattern, "patternType")

	if (type !== undefined && PATTERNS.has(type)) fill.pattern = type as SheetPatternType | "none" | "solid"

	const fg = childByLocal(document, pattern, "fgColor")
	const bg = childByLocal(document, pattern, "bgColor")

	if (fg >= 0) fill.fg = readColor(document, fg)
	if (bg >= 0) fill.bg = readColor(document, bg)

	return fill
}

const BORDER_STYLES: ReadonlySet<string> = new Set([
	"thin",
	"medium",
	"thick",
	"dashed",
	"dotted",
	"double",
	"hair",
	"mediumDashed",
	"dashDot",
	"mediumDashDot",
	"dashDotDot",
	"mediumDashDotDot",
	"slantDashDot"
])

function readEdge(document: XmlDocument, node: number): XlsxBorderEdge {
	const edge: Mutable<XlsxBorderEdge> = {}
	const style = document.attribute(node, "style")
	const color = childByLocal(document, node, "color")

	if (style !== undefined && BORDER_STYLES.has(style)) edge.style = style as SheetBorderStyle
	if (color >= 0) edge.color = readColor(document, color)

	return edge
}

const BORDER_ATTRIBUTES = ["diagonalUp", "diagonalDown", "outline"]

export function readBorder(document: XmlDocument, node: number): XlsxBorder {
	const border: Mutable<XlsxBorder> = {}

	for (const child of childElements(document, node)) {
		switch (document.localName(child)) {
			// start and end are the Strict and Office 2010 names of left and right.
			case "left":
			case "start":
				border.left = readEdge(document, child)
				break
			case "right":
			case "end":
				border.right = readEdge(document, child)
				break
			case "top":
				border.top = readEdge(document, child)
				break
			case "bottom":
				border.bottom = readEdge(document, child)
				break
			case "diagonal":
				border.diagonal = readEdge(document, child)
				break
			case "vertical":
				border.vertical = readEdge(document, child)
				break
			case "horizontal":
				border.horizontal = readEdge(document, child)
				break
		}
	}

	const [upValue, downValue, outlineValue] = document.attributeValues(node, BORDER_ATTRIBUTES)
	const up = parseBoolean(upValue)
	const down = parseBoolean(downValue)
	const outline = parseBoolean(outlineValue)

	if (up !== undefined) border.diagonalUp = up
	if (down !== undefined) border.diagonalDown = down
	if (outline !== undefined) border.outline = outline

	return border
}

const HORIZONTAL: ReadonlySet<string> = new Set([
	"general",
	"left",
	"center",
	"right",
	"fill",
	"justify",
	"centerContinuous",
	"distributed"
])
const VERTICAL: ReadonlySet<string> = new Set(["top", "center", "bottom", "justify", "distributed"])

const ALIGNMENT_ATTRIBUTES = [
	"horizontal",
	"vertical",
	"wrapText",
	"shrinkToFit",
	"justifyLastLine",
	"indent",
	"relativeIndent",
	"textRotation",
	"readingOrder"
]

export function readAlignment(document: XmlDocument, node: number): XlsxAlignment {
	const alignment: Mutable<XlsxAlignment> = {}
	const [horizontal, vertical, wrapValue, shrinkValue, justifyValue, indentValue, relativeValue, rotationValue, orderValue] =
		document.attributeValues(node, ALIGNMENT_ATTRIBUTES)

	if (horizontal !== undefined && HORIZONTAL.has(horizontal)) alignment.horizontal = horizontal as SheetHorizontalAlign | "general"
	if (vertical !== undefined && VERTICAL.has(vertical)) alignment.vertical = vertical as SheetVerticalAlign

	const wrap = parseBoolean(wrapValue)
	const shrink = parseBoolean(shrinkValue)
	const justify = parseBoolean(justifyValue)
	const indent = numberValue(indentValue)
	const relativeIndent = numberValue(relativeValue)
	const rotation = numberValue(rotationValue)
	const readingOrder = numberValue(orderValue)

	if (wrap !== undefined) alignment.wrapText = wrap
	if (shrink !== undefined) alignment.shrinkToFit = shrink
	if (justify !== undefined) alignment.justifyLastLine = justify
	if (indent !== undefined) alignment.indent = indent
	if (relativeIndent !== undefined) alignment.relativeIndent = relativeIndent
	if (rotation !== undefined) alignment.textRotation = rotation
	if (readingOrder !== undefined) alignment.readingOrder = readingOrder

	return alignment
}

const PROTECTION_ATTRIBUTES = ["locked", "hidden"]

export function readProtection(document: XmlDocument, node: number): XlsxCellProtection {
	const protection: Mutable<XlsxCellProtection> = {}
	const [lockedValue, hiddenValue] = document.attributeValues(node, PROTECTION_ATTRIBUTES)
	const locked = parseBoolean(lockedValue)
	const hidden = parseBoolean(hiddenValue)

	if (locked !== undefined) protection.locked = locked
	if (hidden !== undefined) protection.hidden = hidden

	return protection
}

const APPLY: readonly (readonly [string, number])[] = [
	["applyNumberFormat", XfApply.NUMBER_FORMAT],
	["applyFont", XfApply.FONT],
	["applyFill", XfApply.FILL],
	["applyBorder", XfApply.BORDER],
	["applyAlignment", XfApply.ALIGNMENT],
	["applyProtection", XfApply.PROTECTION],
	["quotePrefix", XfApply.QUOTE_PREFIX],
	["pivotButton", XfApply.PIVOT_BUTTON]
]

// The attributes a cellStyleXfs record is read for (APPLY's, then the ids from XF_IDS on), and a cellXfs one.
const APPLY_BITS = APPLY.map(([, bit]) => bit)
const XF_ATTRIBUTES = [...APPLY.map(([name]) => name), "numFmtId", "fontId", "fillId", "borderId"]
const CELL_XF_ATTRIBUTES = [...XF_ATTRIBUTES, "xfId"]
const XF_IDS = APPLY.length

// A cellXfs or cellStyleXfs record (`styleRecord`: xfId is -1).
export function readXf(document: XmlDocument, node: number, styleRecord: boolean): XlsxXf {
	const values = document.attributeValues(node, styleRecord ? XF_ATTRIBUTES : CELL_XF_ATTRIBUTES)
	let flags = 0

	for (let k = 0; k < APPLY_BITS.length; k++) if (parseBoolean(values[k]) === true) flags |= APPLY_BITS[k] as number

	const xf: Mutable<XlsxXf> = {
		numFmtId: Math.max(0, intValue(values[XF_IDS], 0)),
		fontId: Math.max(0, intValue(values[XF_IDS + 1], 0)),
		fillId: Math.max(0, intValue(values[XF_IDS + 2], 0)),
		borderId: Math.max(0, intValue(values[XF_IDS + 3], 0)),
		xfId: styleRecord ? -1 : Math.max(0, intValue(values[XF_IDS + 4], 0)),
		flags
	}
	const alignment = childByLocal(document, node, "alignment")
	const protection = childByLocal(document, node, "protection")

	if (alignment >= 0) xf.alignment = readAlignment(document, alignment)
	if (protection >= 0) xf.protection = readProtection(document, protection)

	return xf
}

export function readDxf(document: XmlDocument, node: number): XlsxDxf {
	const dxf: Mutable<XlsxDxf> = {}

	for (const child of childElements(document, node)) {
		switch (document.localName(child)) {
			case "font":
				dxf.font = readFont(document, child)
				break
			case "numFmt":
				dxf.numFmt = { id: intAttribute(document, child, "numFmtId", 0), code: document.attribute(child, "formatCode") ?? "" }
				break
			case "fill":
				dxf.fill = readFill(document, child)
				break
			case "alignment":
				dxf.alignment = readAlignment(document, child)
				break
			case "border":
				dxf.border = readBorder(document, child)
				break
			case "protection":
				dxf.protection = readProtection(document, child)
				break
		}
	}

	return dxf
}
