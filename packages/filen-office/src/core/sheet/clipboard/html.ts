import {
	SHEET_MAX_CELL_TEXT,
	type SheetRange,
	SHEET_MAX_COLS,
	SHEET_MAX_ROWS,
	type SheetBorderStyle,
	type SheetFormatPatch,
	type SheetHorizontalAlign,
	type SheetRenderStyle
} from "../protocol"
import { numFmtProblem, unwritableText } from "../numfmt/edit"
import type { SheetBorderLineInput } from "../style/borders"
import { libreOfficeNumber, type LibreOfficeNumber } from "./libreOffice"

// Spreadsheet cells as clipboard HTML, read and written without a DOM (the session runs in a worker or a
// JavaScript engine without one), in one linear pass. Read: the first table of HTML a host has sanitised (the
// web app passes it through @filen/shared's sheet clipboard sanitizer first), as Excel, Google Sheets, LibreOffice
// and web pages put tables on the clipboard:
// - values: LibreOffice's sdval, Google Sheets' data-sheets-value (JSON: "1" the type, 2 text, 3 number, 4 boolean;
//   LibreOffice 26.8 writes it too, its numbers cut to integers, so sdval goes first), Excel's x:num, x:str and
//   x:bool, else the cell's text, read as typed;
// - formulas: Google Sheets' data-sheets-formula (R1C1, relative to the cell), and this app's own data-filen-formula
//   (A1, as written in the cell data-filen-origin names);
// - formats: inline style, the style element's td and .class rules (Excel's), inherited table and row styles, and the
//   presentational attributes (bgcolor, align, valign); number formats from Excel's mso-number-format, LibreOffice's
//   sdnum (in its locale's syntax: libreOffice.ts) and Google Sheets' data-sheets-numberformat. A format a workbook
//   could not hold is left out.
// Rows and columns spanned (colspan, rowspan) keep the cells after them where a browser lays them out; the cells a
// span covers are pasted empty. Text runs of a cell are flattened, a format all of them share taken for the cell.
// Written: a table of the cells' shown text, inline styles a browser, Excel and Google Sheets read, and the values
// and formulas in the attributes above.

declare module "../protocol" {
	interface SheetCommandMap {
		// A paste whose clipboard holds HTML (sanitised by the host) beside its text: the session's own copy when
		// `clip` names it and `text` is still its text, else the HTML's first table, else `text` as tab-separated values.
		// `target` is the paste area, repeated over as clipboard.paste's is.
		"clipboard.pasteHtml": {
			readonly sheet: SheetId
			readonly at: { readonly row: number; readonly col: number }
			readonly html: string
			readonly text: string
			readonly clip?: number
			readonly target?: SheetRange
		}
	}

	interface SheetQueryMap {
		// The cells to copy as clipboard HTML, beside the "copy" query's text; null past what a copy writes as HTML.
		copyHtml: {
			request: { readonly sheet: SheetId; readonly range: SheetRange }
			result: { readonly html: string | null }
		}
	}
}

// Cells past this many are copied as text only: the host sanitises the HTML on its main thread, and a table that size
// would cost far more there than its formats are worth; the text keeps the values.
export const MAX_HTML_COPY_CELLS = 10_000
// Characters of clipboard HTML a copy writes at most: sanitising it stays under a long task (about 40 ms in Chromium).
export const MAX_HTML_COPY_LENGTH = 768 * 1024

export type ClipValue =
	// Text to read as typed (a number, a date, "=..." a formula): a table with nothing more said about it.
	| { readonly kind: "typed"; readonly text: string }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "empty" }

export type ClipFormula =
	| { readonly kind: "r1c1"; readonly text: string }
	// A1 text as written in the cell `row`, `col` (0-based) of the sheet it came from.
	| { readonly kind: "a1"; readonly text: string; readonly row: number; readonly col: number }

export interface ClipBorders {
	readonly top?: SheetBorderLineInput
	readonly right?: SheetBorderLineInput
	readonly bottom?: SheetBorderLineInput
	readonly left?: SheetBorderLineInput
}

export interface ClipCell {
	// Offsets in the table.
	readonly row: number
	readonly col: number
	readonly value: ClipValue
	readonly formula: ClipFormula | null
	// Null when the HTML says nothing of the cell's format.
	readonly format: SheetFormatPatch | null
	readonly borders: ClipBorders | null
}

export interface ClipTable {
	readonly rows: number
	readonly cols: number
	// Row by row; covered cells of a span are there, empty.
	readonly cells: readonly ClipCell[]
	// The cells spans join (colspan, rowspan), as offsets in the table: merged where pasted.
	readonly spans: readonly SheetRange[]
}

// --- Entities ---

// A table's own entry: never one an object inherits ("constructor" names no colour, format or alignment).
function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined
}

// A DOM's serialisation leaves only these named references (and numeric ones); others stay as written.
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

function decode(text: string): string {
	if (!text.includes("&")) return text

	return text.replace(/&(#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z]{2,6});/g, (reference, body: string) => {
		if (body.startsWith("#")) {
			const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)

			return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : reference
		}

		return lookup(NAMED, body) ?? reference
	})
}

// --- Tokens ---

interface StartTag {
	readonly name: string
	readonly attributes: ReadonlyMap<string, string>
	readonly selfClosing: boolean
}

interface TokenSink {
	start(tag: StartTag): void
	end(name: string): void
	text(text: string): void
	// The text of a style element.
	style(css: string): void
}

const RAW_TEXT = new Set(["style", "script", "textarea", "title", "xmp", "noscript", "template"])

function isNameChar(code: number): boolean {
	return !(code === 32 || code === 9 || code === 10 || code === 12 || code === 13 || code === 47 || code === 62 || code === 61)
}

function isSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 12 || code === 13
}

// One pass over the markup: tags with their attributes (names lower-cased), text, the style elements' CSS. Raw text
// elements (script and the like) are skipped whole; comments, doctypes and processing instructions dropped.
function tokenize(html: string, sink: TokenSink): void {
	const length = html.length
	let at = 0

	while (at < length) {
		const open = html.indexOf("<", at)

		if (open < 0) {
			sink.text(decode(html.slice(at)))

			break
		}

		if (open > at) sink.text(decode(html.slice(at, open)))

		const next = html.charCodeAt(open + 1)

		// A comment, a doctype or CDATA, a processing instruction: skipped to its end.
		if (next === 33 || next === 63) {
			if (html.startsWith("<!--", open)) {
				const close = html.indexOf("-->", open + 4)

				at = close < 0 ? length : close + 3
			} else {
				const close = html.indexOf(">", open + 2)

				at = close < 0 ? length : close + 1
			}

			continue
		}

		const closing = next === 47
		let i = open + (closing ? 2 : 1)
		const nameStart = i
		const first = html.charCodeAt(i) | 0x20

		// A tag name starts with a letter; anything else is "<" as text (and is not scanned again).
		if (first < 97 || first > 122) {
			sink.text("<")
			at = open + 1

			continue
		}

		while (i < length && isNameChar(html.charCodeAt(i)) && html.charCodeAt(i) !== 60) i++

		const name = html.slice(nameStart, i).toLowerCase()

		if (name === "") {
			// Not a tag: "<" as text.
			sink.text("<")
			at = open + 1

			continue
		}

		const attributes = new Map<string, string>()
		let selfClosing = false

		while (i < length) {
			while (i < length && isSpace(html.charCodeAt(i))) i++

			const code = html.charCodeAt(i)

			if (code === 62) {
				i++

				break
			}

			if (code === 47) {
				selfClosing = true
				i++

				continue
			}

			const attributeStart = i

			while (i < length && isNameChar(html.charCodeAt(i))) i++

			const attribute = html.slice(attributeStart, i).toLowerCase()

			if (attribute === "") {
				i++

				continue
			}

			while (i < length && isSpace(html.charCodeAt(i))) i++

			let value = ""

			if (html.charCodeAt(i) === 61) {
				i++

				while (i < length && isSpace(html.charCodeAt(i))) i++

				const quote = html.charCodeAt(i)

				if (quote === 34 || quote === 39) {
					const close = html.indexOf(String.fromCharCode(quote), i + 1)
					const end = close < 0 ? length : close

					value = decode(html.slice(i + 1, end))
					i = end + 1
				} else {
					const valueStart = i

					while (i < length && !isSpace(html.charCodeAt(i)) && html.charCodeAt(i) !== 62) i++

					value = decode(html.slice(valueStart, i))
				}
			}

			if (!attributes.has(attribute)) attributes.set(attribute, value)
		}

		at = i

		if (closing) {
			sink.end(name)

			continue
		}

		sink.start({ name, attributes, selfClosing })

		if (RAW_TEXT.has(name) && !selfClosing) {
			let close = html.indexOf("</", at)

			while (close >= 0 && html.slice(close + 2, close + 2 + name.length).toLowerCase() !== name)
				close = html.indexOf("</", close + 2)

			const end = close < 0 ? length : close

			if (name === "style") sink.style(html.slice(at, end))

			const after = close < 0 ? length : html.indexOf(">", close)

			at = after < 0 ? length : after + 1
			sink.end(name)
		}
	}
}

// --- CSS ---

type Declarations = Map<string, string>

// What a cell's format is read from (formatOf); a declaration of anything else is dropped as it is read, so no rule,
// cell or text run holds more than these whatever the markup says.
const READ: ReadonlySet<string> = new Set([
	"font-weight",
	"font-style",
	"text-decoration",
	"text-decoration-line",
	"text-underline-style",
	"color",
	"background-color",
	"background",
	"text-align",
	"vertical-align",
	"font-family",
	"font-size",
	"white-space",
	"mso-number-format",
	"border",
	"border-top",
	"border-right",
	"border-bottom",
	"border-left"
])

// Properties looked up through a cell's layers (its own style, its classes', the style element's td rule, its row's
// and table's), nearest first: no layer is copied per cell.
interface Css {
	get(name: string): string | undefined
}

class Layers implements Css {
	private readonly layers: readonly Declarations[]

	constructor(layers: readonly Declarations[]) {
		this.layers = layers
	}

	get(name: string): string | undefined {
		for (const layer of this.layers) {
			const value = layer.get(name)

			if (value !== undefined) return value
		}

		return undefined
	}
}

// Declarations split at their semicolons, not at one quoted or escaped (Excel writes "\;" in number formats).
function splitDeclarations(text: string): string[] {
	const parts: string[] = []
	let start = 0
	let quote = ""

	for (let i = 0; i < text.length; i++) {
		const char = text[i]

		if (char === "\\") i++
		else if (quote !== "") {
			if (char === quote) quote = ""
		} else if (char === '"' || char === "'") quote = char
		else if (char === ";") {
			parts.push(text.slice(start, i))
			start = i + 1
		}
	}

	parts.push(text.slice(start))

	return parts
}

const IMPORTANT = "!important"

// "a: b; c: d" as a map of the READ properties, names lower-cased; later declarations win.
function declarations(text: string, into: Declarations = new Map()): Declarations {
	for (const part of splitDeclarations(text)) {
		const colon = part.indexOf(":")

		if (colon <= 0) continue

		const name = part.slice(0, colon).trim().toLowerCase()

		if (!READ.has(name)) continue

		let value = part.slice(colon + 1).trim()

		if (value.length >= IMPORTANT.length && value.slice(-IMPORTANT.length).toLowerCase() === IMPORTANT)
			value = value.slice(0, -IMPORTANT.length).trim()

		if (value !== "") into.set(name, value)
	}

	return into
}

interface StyleSheet {
	// Declarations for td (and th) elements, and per class.
	readonly cells: Declarations
	readonly classes: Map<string, Declarations>
}

// CSS without its comments (one left open runs to the end, as CSS reads it).
function withoutComments(css: string): string {
	let out = ""
	let at = 0

	for (;;) {
		const open = css.indexOf("/*", at)

		if (open < 0) return out + css.slice(at)

		out += css.slice(at, open)

		const close = css.indexOf("*/", open + 2)

		if (close < 0) return out

		at = close + 2
	}
}

function readStyleSheet(css: string, sheet: StyleSheet): void {
	const text = withoutComments(css).replace(/<!--|-->/g, "")
	let at = 0

	while (at < text.length) {
		const open = text.indexOf("{", at)

		if (open < 0) break

		const close = text.indexOf("}", open + 1)
		const end = close < 0 ? text.length : close
		const selectors = text.slice(at, open).trim()

		// An at-rule's block ("@page { ... }") is skipped whole.
		// Read once for all its selectors.
		const rules = selectors.startsWith("@") ? null : declarations(text.slice(open + 1, end))

		if (rules !== null && rules.size > 0)
			for (const raw of selectors.split(",")) {
				const selector = raw.trim().toLowerCase()
				const match = /^(?:td|th)?\.([a-z0-9_-]+)$/.exec(selector)

				// Google Sheets draws its gridlines as a td border rule: an element rule's borders are no cell's own.
				if (selector === "td" || selector === "th")
					for (const [name, value] of rules) {
						if (!name.startsWith("border")) sheet.cells.set(name, value)
					}
				else if (match?.[1] !== undefined) {
					const found = sheet.classes.get(match[1]) ?? new Map<string, string>()

					for (const [name, value] of rules) found.set(name, value)

					sheet.classes.set(match[1], found)
				}
			}

		at = end + 1
	}
}

// CSS escapes decoded: "\0022" and "\." as Excel writes them in mso-number-format.
function cssUnescape(value: string): string {
	return value.replace(/\\([\da-fA-F]{1,6})\s?|\\(.)/g, (_match, hex: string | undefined, char: string | undefined) => {
		if (hex !== undefined) {
			const code = Number.parseInt(hex, 16)

			return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : ""
		}

		return char ?? ""
	})
}

function unquote(value: string): string {
	const trimmed = value.trim()

	return trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'")) && trimmed.endsWith(trimmed.charAt(0))
		? trimmed.slice(1, -1)
		: trimmed
}

const NAMED_COLORS: Readonly<Record<string, number>> = {
	black: 0x000000,
	white: 0xffffff,
	red: 0xff0000,
	lime: 0x00ff00,
	green: 0x008000,
	blue: 0x0000ff,
	yellow: 0xffff00,
	cyan: 0x00ffff,
	aqua: 0x00ffff,
	magenta: 0xff00ff,
	fuchsia: 0xff00ff,
	gray: 0x808080,
	grey: 0x808080,
	silver: 0xc0c0c0,
	maroon: 0x800000,
	olive: 0x808000,
	navy: 0x000080,
	purple: 0x800080,
	teal: 0x008080,
	orange: 0xffa500
}

// A CSS colour as 0xRRGGBB; null for one that means "automatic" or that does not read (Excel's windowtext, a
// transparent or translucent one).
export function cssColor(value: string): number | null {
	const text = value.trim().toLowerCase()
	const hex = /^#([\da-f]{3}|[\da-f]{6})$/.exec(text)?.[1]

	if (hex !== undefined)
		return hex.length === 3
			? Number.parseInt(
					hex
						.split("")
						.map(digit => digit + digit)
						.join(""),
					16
				)
			: Number.parseInt(hex, 16)

	const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text)

	if (rgb !== null) {
		if (rgb[4] !== undefined && Number(rgb[4]) < 1) return null

		const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(part => Math.min(255, Number(part)))

		return ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0)
	}

	return lookup(NAMED_COLORS, text) ?? null
}

// A CSS length in points; null when it does not read.
function points(value: string): number | null {
	const match = /^([\d.]+)\s*(pt|px|em|rem)?$/.exec(value.trim().toLowerCase())

	if (match === null) return null

	const size = Number(match[1])

	if (!Number.isFinite(size)) return null

	switch (match[2]) {
		case "px":
			return size * 0.75
		case "em":
		case "rem":
			return size * 12
		default:
			return size
	}
}

// A CSS value's parts between spaces, a function's arguments ("rgb(1, 2, 3)") kept whole; in one pass.
function valueParts(value: string): string[] {
	const parts: string[] = []
	let depth = 0
	let start = -1

	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)

		if (depth === 0 && isSpace(code)) {
			if (start >= 0) parts.push(value.slice(start, i))

			start = -1

			continue
		}

		if (start < 0) start = i
		if (code === 40) depth++
		else if (code === 41 && depth > 0) depth--
	}

	if (start >= 0) parts.push(value.slice(start))

	return parts
}

// One edge from "width style colour" (any order), or null for none.
function borderOf(value: string): SheetBorderLineInput | null | undefined {
	let width: number | null = null
	let style: string | null = null
	let color: number | null = null

	for (const part of valueParts(value.toLowerCase())) {
		if (["none", "hidden"].includes(part)) return null
		if (["solid", "dotted", "dashed", "double", "groove", "ridge", "inset", "outset"].includes(part)) style = part
		else if (part === "thin") width = 0.75
		else if (part === "medium") width = 1.5
		else if (part === "thick") width = 2.25
		else {
			const length = points(part)

			if (length !== null) width = length
			else color = cssColor(part) ?? color
		}
	}

	if (style === null) return undefined
	if (width === 0) return null

	const thick = width ?? 0.75
	const line: SheetBorderStyle =
		style === "double"
			? "double"
			: style === "dotted"
				? thick > 0.75
					? "mediumDashDot"
					: "dotted"
				: style === "dashed"
					? thick > 0.75
						? "mediumDashed"
						: "dashed"
					: thick <= 0.75
						? "thin"
						: thick <= 1.5
							? "medium"
							: "thick"

	return color === null ? { style: line } : { style: line, color }
}

// The first family of a font-family list (a quoted name may hold a comma).
function firstFamily(value: string): string {
	const text = value.trim()
	const quote = text.charAt(0)

	if (quote === '"' || quote === "'") {
		const close = text.indexOf(quote, 1)

		return close < 0 ? text : text.slice(0, close + 1)
	}

	return text.split(",")[0] ?? ""
}

// Excel's named number formats (its HTML's mso-number-format) as codes.
const NAMED_FORMATS: Readonly<Record<string, string>> = {
	general: "General",
	"general number": "General",
	fixed: "0.00",
	standard: "#,##0.00",
	percent: "0.00%",
	scientific: "0.00E+00",
	"short date": "m/d/yyyy",
	"medium date": "d-mmm-yy",
	"long date": "dddd, mmmm d, yyyy",
	"short time": "h:mm",
	"medium time": "h:mm AM/PM",
	"long time": "h:mm:ss AM/PM",
	"@": "@"
}

// A number format code a workbook can hold, or undefined.
function numberFormat(code: string): string | undefined {
	const text = lookup(NAMED_FORMATS, code.trim().toLowerCase()) ?? code

	return text === "" || numFmtProblem(text) !== null ? undefined : text
}

const ALIGNS: Readonly<Record<string, SheetHorizontalAlign>> = {
	left: "left",
	start: "left",
	center: "center",
	right: "right",
	end: "right",
	justify: "justify"
}

const VALIGNS: Readonly<Record<string, NonNullable<SheetFormatPatch["valign"]>>> = { top: "top", middle: "center", bottom: "bottom" }

// What a value means to a cell format, read once per distinct value of a parse: a rule's values are shared by every
// cell it applies to, so no cell reads them again (cached).
interface Cached<T> {
	readonly value: T
}

function cached<T>(cache: Map<string, Cached<T>>, key: string, read: (key: string) => T): T {
	const hit = cache.get(key)

	if (hit !== undefined) return hit.value

	const value = read(key)

	cache.set(key, { value })

	return value
}

interface Decoration {
	readonly underline: boolean
	readonly strike: boolean
}

function decorationOf(value: string): Decoration {
	const text = value.toLowerCase()

	return { underline: text.includes("underline"), strike: text.includes("line-through") }
}

function fontOf(value: string): string | undefined {
	const font = cssUnescape(unquote(firstFamily(value)))

	return font !== "" && font.length <= 31 && !unwritableText(font) ? font : undefined
}

function sizeOf(value: string): number | undefined {
	const pt = points(value)

	return pt !== null && pt >= 1 && pt <= 409 ? Math.round(pt * 2) / 2 : undefined
}

function boldOf(value: string): boolean {
	return value === "bold" || value === "bolder" || Number(value) >= 600
}

class FormatReader {
	private readonly bold = new Map<string, Cached<boolean>>()
	private readonly decoration = new Map<string, Cached<Decoration>>()
	private readonly double = new Map<string, Cached<boolean>>()
	private readonly color = new Map<string, Cached<number | null>>()
	private readonly fill = new Map<string, Cached<number | null>>()
	private readonly lower = new Map<string, Cached<string>>()
	private readonly font = new Map<string, Cached<string | undefined>>()
	private readonly size = new Map<string, Cached<number | undefined>>()
	private readonly code = new Map<string, Cached<string | undefined>>()
	private readonly border = new Map<string, Cached<SheetBorderLineInput | null | undefined>>()

	lowerCase(value: string): string {
		return cached(this.lower, value, text => text.toLowerCase())
	}

	// The cell format declarations ask for; borders apart.
	format(css: Css): { patch: SheetFormatPatch; borders: ClipBorders } {
		const patch: { -readonly [K in keyof SheetFormatPatch]: SheetFormatPatch[K] } = {}
		const borders: { -readonly [K in keyof ClipBorders]: ClipBorders[K] } = {}
		const weight = css.get("font-weight")

		if (weight !== undefined && cached(this.bold, weight, boldOf)) patch.bold = true

		const fontStyle = css.get("font-style")

		if (fontStyle === "italic" || fontStyle === "oblique") patch.italic = true

		const decoration = css.get("text-decoration")
		const decorationLine = css.get("text-decoration-line")
		const lines = decoration === undefined ? null : cached(this.decoration, decoration, decorationOf)
		const moreLines = decorationLine === undefined ? null : cached(this.decoration, decorationLine, decorationOf)

		if (lines?.underline === true || moreLines?.underline === true) {
			const style = css.get("text-underline-style")

			patch.underline = style !== undefined && cached(this.double, style, text => text.includes("double")) ? "double" : "single"
		}

		if (lines?.strike === true || moreLines?.strike === true) patch.strike = true

		const color = css.get("color")
		const ink = color === undefined ? null : cached(this.color, color, cssColor)

		// Black is automatic text: the cell keeps the theme's.
		if (ink !== null && ink !== 0) patch.color = ink

		const background = css.get("background-color") ?? css.get("background")
		const fill = background === undefined ? null : cached(this.fill, background, value => cssColor(valueParts(value)[0] ?? ""))

		if (fill !== null) patch.fill = fill

		const textAlign = css.get("text-align")
		const align = textAlign === undefined ? undefined : lookup(ALIGNS, this.lowerCase(textAlign))

		if (align !== undefined) patch.align = align

		const verticalAlign = css.get("vertical-align")
		const valign = verticalAlign === undefined ? undefined : lookup(VALIGNS, this.lowerCase(verticalAlign))

		if (valign !== undefined) patch.valign = valign

		const family = css.get("font-family")
		const font = family === undefined ? undefined : cached(this.font, family, fontOf)

		if (font !== undefined) patch.font = font

		const fontSize = css.get("font-size")
		const size = fontSize === undefined ? undefined : cached(this.size, fontSize, sizeOf)

		if (size !== undefined) patch.size = size

		const whiteSpace = css.get("white-space")
		const space = whiteSpace === undefined ? "" : this.lowerCase(whiteSpace)

		if (space === "normal" || space === "pre-wrap" || space === "pre-line") patch.wrap = true

		const code = css.get("mso-number-format")
		const numFmt = code === undefined ? undefined : cached(this.code, code, text => numberFormat(cssUnescape(unquote(text))))

		if (numFmt !== undefined) patch.numFmt = numFmt

		const all = css.get("border")
		const everywhere = all === undefined ? undefined : cached(this.border, all, borderOf)

		for (const side of ["top", "right", "bottom", "left"] as const) {
			const own = css.get(`border-${side}`)
			const line = own === undefined ? everywhere : cached(this.border, own, borderOf)

			if (line !== undefined && line !== null) borders[side] = line
		}

		return { patch, borders }
	}
}

// --- Tables ---

// The align attribute, kept apart from text-align until the cell's value says whether it is General's side.
const ALIGN_ATTRIBUTE = "-align-attribute"

// Where General puts a value: numbers and booleans right (as LibreOffice draws them), text left.
function generalSide(value: ClipValue): string {
	return value.kind === "number" || value.kind === "boolean" ? "right" : "left"
}

// Inherited CSS properties: the ones a table's or row's style passes on to its cells.
const INHERITED = ["color", "font-family", "font-size", "font-style", "font-weight", "text-align", "white-space", "text-decoration"]

interface Run {
	readonly css: Declarations
}

interface OpenCell {
	readonly row: number
	readonly col: number
	readonly attributes: ReadonlyMap<string, string>
	// Nearest first.
	readonly layers: readonly Declarations[]
	text: string
	// Text run formats inside the cell (b, i, u, s, font, span), for what all of them share.
	readonly runs: Run[]
	readonly stack: Declarations[]
	texted: boolean
}

const RUN_TAGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	b: { "font-weight": "bold" },
	strong: { "font-weight": "bold" },
	i: { "font-style": "italic" },
	em: { "font-style": "italic" },
	u: { "text-decoration": "underline" },
	s: { "text-decoration": "line-through" },
	strike: { "text-decoration": "line-through" },
	del: { "text-decoration": "line-through" }
}

const BLOCK_TAGS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6"])

// Elements without an end tag: no text run opens.
const VOID_TAGS = new Set(["area", "base", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])

function jsonValue(text: string): ClipValue | null {
	try {
		const parsed: unknown = JSON.parse(text)

		if (typeof parsed !== "object" || parsed === null) return null

		const value = parsed as Record<string, unknown>

		switch (value["1"]) {
			case 2:
				return typeof value["2"] === "string" ? (value["2"] === "" ? { kind: "empty" } : { kind: "text", text: value["2"] }) : null
			case 3:
				return typeof value["3"] === "number" && Number.isFinite(value["3"]) ? { kind: "number", value: value["3"] } : null
			case 4:
				return typeof value["4"] === "boolean"
					? { kind: "boolean", value: value["4"] }
					: typeof value["4"] === "number"
						? { kind: "boolean", value: value["4"] !== 0 }
						: null
			default:
				return null
		}
	} catch {
		return null
	}
}

function jsonFormat(text: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(text)

		return typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>)["2"] === "string"
			? numberFormat((parsed as Record<string, string>)["2"] ?? "")
			: undefined
	} catch {
		return undefined
	}
}

function finiteNumber(text: string | undefined): number | null {
	if (text === undefined || text.trim() === "") return null

	const value = Number(text.trim())

	return Number.isFinite(value) ? value : null
}

// The cell's value from its attributes, else its text.
function valueOf(attributes: ReadonlyMap<string, string>, text: string, libreOffice: LibreOfficeNumber | null): ClipValue {
	// LibreOffice's value (in its locale's syntax); its booleans are numbers in a BOOLEAN format.
	const sdval = libreOffice?.value ?? null

	if (sdval !== null) return libreOffice?.boolean === true ? { kind: "boolean", value: sdval !== 0 } : { kind: "number", value: sdval }

	// Google Sheets' (also written by LibreOffice 26.8, after its own exact sdval).
	const sheets = attributes.get("data-sheets-value")
	const fromSheets = sheets === undefined ? null : jsonValue(sheets)

	if (fromSheets !== null) return fromSheets

	if (attributes.has("x:num")) {
		const value = finiteNumber(attributes.get("x:num")) ?? finiteNumber(text.replaceAll(",", ""))

		if (value !== null) return { kind: "number", value }
	}

	if (attributes.has("x:bool")) return { kind: "boolean", value: /^(true|1)$/i.test((attributes.get("x:bool") || text).trim()) }

	const str = attributes.get("x:str")

	if (str !== undefined) return { kind: "text", text: str === "" ? text : str }

	return text === "" ? { kind: "empty" } : { kind: "typed", text }
}

// Collapses whitespace as a browser lays text out: runs to one space, ends trimmed per line, empty lines at either end
// dropped; no-break spaces become spaces, as Excel pastes them.
function laidOut(text: string): string {
	const lines = text.split("\n").map(line => line.replace(/[ \t\r\f]+/g, " ").trim())
	let first = 0
	let last = lines.length

	while (first < last && lines[first] === "") first++
	while (last > first && lines[last - 1] === "") last--

	return (first === 0 && last === lines.length ? lines : lines.slice(first, last)).join("\n").replaceAll(" ", " ")
}

function shared(runs: readonly Run[], name: string): string | undefined {
	const first = runs[0]?.css.get(name)

	return first !== undefined && runs.every(run => run.css.get(name) === first) ? first : undefined
}

// The first table of `html` as cells; null when there is none, "tooLarge" past `limit` cells or the sheet's size.
export function parseClipboardHtml(html: string, limit: number): ClipTable | "tooLarge" | null {
	const sheet: StyleSheet = { cells: new Map(), classes: new Map() }
	const cells: ClipCell[] = []
	const joined: SheetRange[] = []
	// Where row spans from rows above still reach: column → the last row they cover.
	const spans = new Map<number, number>()
	let depth = 0
	let done = false
	let tooLarge = false
	let tableCss: Declarations = new Map()
	let rowCss: Declarations = new Map()
	let row = -1
	let col = 0
	let rows = 0
	let cols = 0
	let cell: OpenCell | null = null
	const reader = new FormatReader()

	const inherited = (css: Declarations): Declarations => {
		const out: Declarations = new Map()

		for (const name of INHERITED) {
			const value = css.get(name)

			if (value !== undefined) out.set(name, value)
		}

		return out
	}

	const push = (entry: ClipCell): boolean => {
		if (cells.length >= limit || entry.row >= SHEET_MAX_ROWS || entry.col >= SHEET_MAX_COLS) {
			tooLarge = true

			return false
		}

		cells.push(entry)
		rows = Math.max(rows, entry.row + 1)
		cols = Math.max(cols, entry.col + 1)

		return true
	}

	const skipSpanned = (): void => {
		while ((spans.get(col) ?? -1) >= row) col++
	}

	const finishCell = (): void => {
		const open = cell

		cell = null

		if (open === null) return

		const text = laidOut(open.text).slice(0, SHEET_MAX_CELL_TEXT)
		// What the cell's text says over its layers.
		const over: Declarations = new Map()
		const css = new Layers([over, ...open.layers])

		// What every text run of the cell has (a cell wholly bold in <b>).
		if (open.runs.length > 0)
			for (const name of ["font-weight", "font-style", "text-decoration", "color", "font-family", "font-size"]) {
				const value = shared(open.runs, name)

				if (value !== undefined) over.set(name, value)
			}

		const sdval = open.attributes.get("sdval")
		const sdnum = open.attributes.get("sdnum")
		const libreOffice = sdval === undefined && sdnum === undefined ? null : libreOfficeNumber(sdval, sdnum)
		const value = valueOf(open.attributes, text, libreOffice)
		const align = css.get(ALIGN_ATTRIBUTE)
		const alignAttribute = align === undefined ? undefined : reader.lowerCase(align)

		// LibreOffice and Excel write every cell's align as drawn: a value's own (General) side is no format.
		if (alignAttribute !== undefined && css.get("text-align") === undefined && alignAttribute !== generalSide(value))
			over.set("text-align", alignAttribute)

		const { patch, borders } = reader.format(css)
		const sheetsFormat = open.attributes.get("data-sheets-numberformat")
		// LibreOffice 26.8 writes data-sheets-numberformat beside sdnum: sdnum says which locale's syntax it is in.
		const numFmt =
			sdnum !== undefined
				? libreOffice?.format === undefined
					? undefined
					: numberFormat(libreOffice.format)
				: sheetsFormat === undefined
					? undefined
					: jsonFormat(sheetsFormat)
		const format: SheetFormatPatch = numFmt === undefined || numFmt === "General" ? patch : { ...patch, numFmt }
		const sheetsFormula = open.attributes.get("data-sheets-formula")
		const ownFormula = open.attributes.get("data-filen-formula")
		const origin = /^(\d+),(\d+)$/.exec(open.attributes.get("data-filen-cell") ?? "")
		const formula: ClipFormula | null =
			sheetsFormula !== undefined && sheetsFormula.startsWith("=")
				? { kind: "r1c1", text: sheetsFormula }
				: ownFormula !== undefined && ownFormula.startsWith("=") && origin !== null
					? { kind: "a1", text: ownFormula, row: Number(origin[1]), col: Number(origin[2]) }
					: null
		const rowSpan = Math.max(1, Math.min(SHEET_MAX_ROWS, Number.parseInt(open.attributes.get("rowspan") ?? "1", 10) || 1))
		const colSpan = Math.max(1, Math.min(SHEET_MAX_COLS, Number.parseInt(open.attributes.get("colspan") ?? "1", 10) || 1))

		if (
			!push({
				row: open.row,
				col: open.col,
				value,
				formula,
				format: Object.keys(format).length === 0 ? null : format,
				borders: Object.keys(borders).length === 0 ? null : borders
			})
		)
			return

		// The cells the span covers: empty.
		for (let r = 0; r < rowSpan; r++)
			for (let c = 0; c < colSpan; c++) {
				if (r === 0 && c === 0) continue
				if (!push({ row: open.row + r, col: open.col + c, value: { kind: "empty" }, formula: null, format: null, borders: null }))
					return
			}

		if (rowSpan > 1) for (let c = 0; c < colSpan; c++) spans.set(open.col + c, open.row + rowSpan - 1)
		if (rowSpan > 1 || colSpan > 1)
			joined.push({ startRow: open.row, startCol: open.col, endRow: open.row + rowSpan - 1, endCol: open.col + colSpan - 1 })

		col = open.col + colSpan
	}

	// A cell's layers, nearest first: its style, its classes' rules (a later class first), its presentational
	// attributes, the style element's td rule, its row's and table's.
	const cellLayers = (attributes: ReadonlyMap<string, string>): Declarations[] => {
		const own: Declarations = new Map()
		const bgcolor = attributes.get("bgcolor")
		const align = attributes.get("align")
		const valign = attributes.get("valign")

		if (bgcolor !== undefined) own.set("background-color", bgcolor)
		if (align !== undefined) own.set(ALIGN_ATTRIBUTE, align)
		if (valign !== undefined) own.set("vertical-align", valign)

		return [declarations(attributes.get("style") ?? ""), ...classRules(attributes.get("class")).reverse(), own, sheet.cells, rowCss]
	}

	// The rules of a class attribute's classes, each once, in the attribute's order.
	const classRules = (attribute: string | undefined): Declarations[] => {
		const found: Declarations[] = []

		if (attribute === undefined || attribute === "" || sheet.classes.size === 0) return found

		const seen = new Set<Declarations>()

		for (const name of attribute.toLowerCase().split(/\s+/)) {
			const rules = sheet.classes.get(name)

			if (rules !== undefined && !seen.has(rules)) {
				seen.add(rules)
				found.push(rules)
			}
		}

		return found
	}

	tokenize(html, {
		style: css => readStyleSheet(css, sheet),
		start: tag => {
			if (done || tooLarge) return

			if (tag.name === "table") {
				depth++

				if (depth === 1) tableCss = inherited(declarations(tag.attributes.get("style") ?? ""))

				return
			}

			if (depth !== 1) {
				if (cell !== null && tag.name === "br") cell.text += "\n"

				return
			}

			switch (tag.name) {
				case "tr":
					finishCell()
					row++
					col = 0
					rowCss = new Map([...tableCss, ...inherited(declarations(tag.attributes.get("style") ?? ""))])

					return
				case "td":
				case "th": {
					finishCell()

					if (row < 0) {
						row = 0
						rowCss = new Map(tableCss)
					}

					skipSpanned()

					cell = {
						row,
						col,
						attributes: tag.attributes,
						layers: cellLayers(tag.attributes),
						text: "",
						runs: [],
						stack: [new Map()],
						texted: false
					}

					return
				}
				case "br":
					if (cell !== null) cell.text += "\n"

					return
			}

			if (cell === null || tag.selfClosing || VOID_TAGS.has(tag.name)) return

			if (BLOCK_TAGS.has(tag.name) && cell.text !== "" && !cell.text.endsWith("\n")) cell.text += "\n"

			// The run's own format; one that says nothing more shares its parent's (no copy per nested element).
			const own: Declarations = new Map(Object.entries(lookup(RUN_TAGS, tag.name) ?? {}))

			if (tag.name === "font") {
				const color = tag.attributes.get("color")
				const face = tag.attributes.get("face")

				if (color !== undefined) own.set("color", color)
				if (face !== undefined) own.set("font-family", face)
			}

			declarations(tag.attributes.get("style") ?? "", own)

			for (const rules of classRules(tag.attributes.get("class"))) for (const [key, value] of rules) own.set(key, value)

			const parent = cell.stack[cell.stack.length - 1] ?? new Map<string, string>()

			if (own.size === 0) cell.stack.push(parent)
			else {
				const run = new Map(parent)

				for (const [key, value] of own) run.set(key, value)

				cell.stack.push(run)
			}
		},
		end: name => {
			if (done || tooLarge) return

			if (name === "table") {
				if (depth === 1) {
					finishCell()
					done = true
				}

				depth = Math.max(0, depth - 1)

				return
			}

			if (depth !== 1) return

			if (name === "td" || name === "th") finishCell()
			else if (name === "tr") finishCell()
			else if (cell !== null && cell.stack.length > 1 && !RAW_TEXT.has(name)) {
				cell.stack.pop()

				if (BLOCK_TAGS.has(name) && !cell.text.endsWith("\n")) cell.text += "\n"
			}
		},
		text: text => {
			if (done || tooLarge || depth < 1 || cell === null) return

			cell.text += text

			if (text.trim() !== "") cell.runs.push({ css: cell.stack[cell.stack.length - 1] ?? new Map() })
		}
	})

	finishCell()

	if (tooLarge) return "tooLarge"
	if (cells.length === 0) return null

	return { rows, cols, cells, spans: joined }
}

// --- Writing ---

export interface ClipOutCell {
	// What the cell shows.
	readonly text: string
	readonly value: ClipValue
	// "=..." as typed, A1.
	readonly formula: string | null
	readonly style: SheetRenderStyle
	readonly numFmt: string
}

function escapeText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeAttribute(text: string): string {
	return escapeText(text).replaceAll('"', "&quot;")
}

// A CSS string as Excel writes one: quotes and backslashes as hex escapes, nothing a declaration could break on.
function cssString(text: string): string {
	let out = '"'

	for (const char of text) {
		const code = char.codePointAt(0) ?? 0

		out +=
			char === '"' || char === "\\" || char === ";" || char === "<" || char === ">" || code < 0x20
				? `\\${code.toString(16).padStart(4, "0")} `
				: char
	}

	return `${out}"`
}

function hex(color: number): string {
	return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`
}

const BORDER_CSS: Readonly<Record<SheetBorderStyle, string>> = {
	thin: "1px solid",
	hair: "1px dotted",
	dotted: "1px dotted",
	dashed: "1px dashed",
	dashDot: "1px dashed",
	dashDotDot: "1px dotted",
	medium: "2px solid",
	mediumDashed: "2px dashed",
	mediumDashDot: "2px dashed",
	mediumDashDotDot: "2px dotted",
	slantDashDot: "2px dashed",
	thick: "3px solid",
	double: "3px double"
}

const ALIGN_CSS: Partial<Readonly<Record<SheetHorizontalAlign, string>>> = {
	left: "left",
	center: "center",
	centerContinuous: "center",
	right: "right",
	justify: "justify",
	distributed: "justify"
}

function styleCss(style: SheetRenderStyle, numFmt: string): string {
	const parts: string[] = []

	if (style.font !== undefined) parts.push(`font-family:${cssString(style.font)}`)
	if (style.size !== undefined) parts.push(`font-size:${String(style.size)}pt`)
	if (style.bold === true) parts.push("font-weight:700")
	if (style.italic === true) parts.push("font-style:italic")

	const lines = [style.underline === undefined ? "" : "underline", style.strike === true ? "line-through" : ""].filter(
		line => line !== ""
	)

	if (lines.length > 0) parts.push(`text-decoration:${lines.join(" ")}`)
	if (style.underline === "double" || style.underline === "doubleAccounting") parts.push("text-underline-style:double")
	if (style.color !== undefined) parts.push(`color:${hex(style.color)}`)
	if (style.fill !== undefined) parts.push(`background:${hex(style.fill)}`)

	const align = style.align === undefined ? undefined : ALIGN_CSS[style.align]

	if (align !== undefined) parts.push(`text-align:${align}`)
	if (style.valign !== undefined)
		parts.push(`vertical-align:${style.valign === "center" ? "middle" : style.valign === "top" ? "top" : "bottom"}`)
	if (style.wrap === true) parts.push("white-space:normal")

	for (const side of ["top", "right", "bottom", "left"] as const) {
		const line = style[side]

		if (line !== undefined) parts.push(`border-${side}:${BORDER_CSS[line.style]} ${hex(line.color)}`)
	}

	if (numFmt !== "General" && numFmt !== "") parts.push(`mso-number-format:${cssString(numFmt)}`)

	return parts.join(";")
}

function sheetsValue(value: ClipValue): string | null {
	switch (value.kind) {
		case "number":
			return JSON.stringify({ 1: 3, 3: value.value })
		case "boolean":
			return JSON.stringify({ 1: 4, 4: value.value })
		case "text":
			return JSON.stringify({ 1: 2, 2: value.text })
		// Read as typed where it lands, as its text is.
		case "typed":
		case "empty":
			return null
	}
}

// A range as a table for the clipboard: `cell` gives each cell at its offset (null for one with nothing), `origin`
// the range's first cell on its sheet (formulas name it). Null once the markup passes `maxLength` characters (a
// paste of a range that large keeps its values through the tab-separated text).
export function clipboardHtml(
	rows: number,
	cols: number,
	origin: { readonly row: number; readonly col: number },
	cell: (row: number, col: number) => ClipOutCell | null,
	maxLength: number
): string | null {
	const parts: string[] = [
		'<html><head><meta charset="utf-8"><style>td{white-space:nowrap}br{mso-data-placement:same-cell}</style></head><body><table style="border-collapse:collapse">'
	]
	let length = parts[0]?.length ?? 0

	for (let row = 0; row < rows; row++) {
		let line = "<tr>"

		for (let col = 0; col < cols; col++) {
			const found = cell(row, col)

			if (found === null) {
				line += "<td></td>"

				continue
			}

			const css = styleCss(found.style, found.numFmt)
			const value = sheetsValue(found.value)
			let attributes = css === "" ? "" : ` style="${escapeAttribute(css)}"`

			if (value !== null) attributes += ` data-sheets-value="${escapeAttribute(value)}"`
			if (found.value.kind === "number") attributes += ` x:num="${String(found.value.value)}"`
			if (found.formula !== null)
				attributes += ` data-filen-formula="${escapeAttribute(found.formula)}" data-filen-cell="${String(origin.row + row)},${String(origin.col + col)}"`

			line += `<td${attributes}>${escapeText(found.text).replaceAll("\r\n", "<br>").replaceAll("\n", "<br>")}</td>`
		}

		line += "</tr>"
		length += line.length

		if (length > maxLength) return null

		parts.push(line)
	}

	parts.push("</table></body></html>")

	return parts.join("")
}
