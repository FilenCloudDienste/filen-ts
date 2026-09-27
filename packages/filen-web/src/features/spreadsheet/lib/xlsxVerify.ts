import { formulaTranslator } from "@/features/spreadsheet/lib/formulaRefs"
import { INDEXED_COLORS } from "@/features/spreadsheet/lib/styleTable"

// Whether saving a workbook loses anything: its unedited save compared with the file it was opened from,
// part by part, at the level of XML meaning. Every element, attribute and text the file holds must come
// back; only the differences in how the same thing is spelled are allowed (numbering of styles, shared
// strings, relationships and parts; attribute order; number and boolean spelling; counts and hints
// Excel recomputes). What saving writes anew is compared against the file, what it copies must be
// copied byte for byte.

interface XmlNode {
	name: string
	attrs: Map<string, string>
	children: XmlNode[]
	text: string
}

const decoder = new TextDecoder()

const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi

function decode(text: string): string {
	return text.includes("&")
		? text.replace(ENTITY, (_match, entity: string) => {
				switch (entity.toLowerCase()) {
					case "amp":
						return "&"
					case "lt":
						return "<"
					case "gt":
						return ">"
					case "quot":
						return '"'
					case "apos":
						return "'"
					default:
						return String.fromCodePoint(
							entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
						)
				}
			})
		: text
}

function localName(name: string): string {
	const colon = name.indexOf(":")

	return colon < 0 ? name : name.slice(colon + 1)
}

const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

// Attributes by local name; namespace declarations and markup-compatibility hints are not content. A
// relationship id keeps its prefix, as it is resolved (or dropped) by the caller.
function attributes(text: string): Map<string, string> {
	const found = new Map<string, string>()

	for (const [, name = "", double, single] of text.matchAll(ATTRIBUTE)) {
		if (name === "xmlns" || name.startsWith("xmlns:") || localName(name) === "Ignorable") {
			continue
		}

		found.set(name.startsWith("r:") ? name : localName(name), decode(double ?? single ?? ""))
	}

	return found
}

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g

export function parseXml(xml: string): XmlNode {
	const root: XmlNode = { name: "", attrs: new Map(), children: [], text: "" }
	const stack: XmlNode[] = [root]

	for (const match of xml.matchAll(TOKEN)) {
		const [, cdata, closing, name, attrs = "", selfClosing, text] = match
		const current = stack[stack.length - 1] ?? root

		if (cdata !== undefined) {
			current.text += cdata
		} else if (text !== undefined) {
			current.text += decode(text)
		} else if (name !== undefined) {
			if (closing === "/") {
				if (stack.length > 1) stack.pop()
			} else {
				const node: XmlNode = { name: localName(name), attrs: attributes(attrs), children: [], text: "" }

				current.children.push(node)

				if (selfClosing !== "/") stack.push(node)
			}
		}
	}

	return root.children[0] ?? root
}

const BOOLEAN = /^(true|false)$/
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i

function normalizeValue(value: string): string {
	if (BOOLEAN.test(value)) return value === "true" ? "1" : "0"
	if (NUMBER.test(value)) return String(Number(value))

	return value
}

// Attributes that carry nothing a reader shows or keeps: counts and spans Excel recomputes, revision ids,
// a font's descent hint, the application's apply-hints to itself, zoom levels of views not in use, and
// the printer's resolution and copy count (printer settings saving drops anyway).
const IGNORED_ATTRIBUTES = new Set([
	"count",
	"uniqueCount",
	"uid",
	"dyDescent",
	"spans",
	"applyNumberFormat",
	"applyFont",
	"applyFill",
	"applyBorder",
	"applyAlignment",
	"applyProtection",
	"zoomScaleNormal",
	"space",
	"tabSelected",
	"zoomScalePageLayoutView",
	"zoomScaleSheetLayoutView",
	"horizontalDpi",
	"verticalDpi",
	"copies"
])

// Attributes at their schema default, which a writer may spell out or leave out: "element@attribute", or
// "*@attribute" for every element.
const DEFAULTS: Readonly<Record<string, string>> = {
	"*@hidden": "0",
	"*@outlineLevel": "0",
	"*@collapsed": "0",
	"*@customHeight": "0",
	"*@customFormat": "0",
	"*@customWidth": "0",
	"*@customBuiltin": "0",
	"*@quotePrefix": "0",
	"*@pivotButton": "0",
	"*@zeroHeight": "0",
	"*@thickTop": "0",
	"*@thickBot": "0",
	"*@diagonalUp": "0",
	"*@diagonalDown": "0",
	"*@indent": "0",
	"*@textRotation": "0",
	"*@wrapText": "0",
	"*@shrinkToFit": "0",
	"*@justifyLastLine": "0",
	"*@readingOrder": "0",
	"*@relativeIndent": "0",
	"*@aca": "0",
	"alignment@horizontal": "general",
	"alignment@vertical": "bottom",
	"protection@locked": "1",
	"sheet@state": "visible",
	"workbookPr@backupFile": "0",
	"workbookPr@date1904": "0",
	"workbookPr@showObjects": "all",
	"sheetPr@filterMode": "0",
	"pageSetUpPr@fitToPage": "0",
	"sheetView@tabSelected": "0",
	"sheetView@rightToLeft": "0",
	"sheetView@showFormulas": "0",
	"sheetView@showGridLines": "1",
	"sheetView@showRowColHeaders": "1",
	"sheetView@showZeros": "1",
	"sheetView@showOutlineSymbols": "1",
	"sheetView@defaultGridColor": "1",
	"sheetView@colorId": "64",
	"sheetView@view": "normal",
	"sheetView@zoomScale": "100",
	"sheetView@windowProtection": "0",
	"sheetFormatPr@baseColWidth": "8",
	// Excel's own default height: a writer states it when the file did not.
	"sheetFormatPr@defaultRowHeight": "15",
	"printOptions@gridLines": "0",
	"printOptions@gridLinesSet": "1",
	"printOptions@headings": "0",
	"printOptions@horizontalCentered": "0",
	"printOptions@verticalCentered": "0",
	"pageSetup@blackAndWhite": "0",
	"pageSetup@cellComments": "none",
	"pageSetup@draft": "0",
	"pageSetup@fitToHeight": "1",
	"pageSetup@fitToWidth": "1",
	"pageSetup@pageOrder": "downThenOver",
	"pageSetup@paperSize": "1",
	"pageSetup@scale": "100",
	"pageSetup@firstPageNumber": "1",
	"pageSetup@useFirstPageNumber": "0",
	"pageSetup@usePrinterDefaults": "1",
	"pageSetup@errors": "displayed",
	"pageSetup@orientation": "default",
	"headerFooter@differentFirst": "0",
	"headerFooter@differentOddEven": "0",
	"headerFooter@scaleWithDoc": "1",
	"headerFooter@alignWithMargins": "1",
	"table@headerRowCount": "1",
	"tableStyleInfo@showFirstColumn": "0",
	"tableStyleInfo@showLastColumn": "0",
	"tableStyleInfo@showRowStripes": "0",
	"tableStyleInfo@showColumnStripes": "0",
	"workbookView@activeTab": "0",
	"workbookView@showHorizontalScroll": "1",
	"workbookView@showVerticalScroll": "1",
	"workbookView@showSheetTabs": "1",
	"workbookView@autoFilterDateGrouping": "1",
	"workbookView@visibility": "visible",
	"workbookView@minimized": "0",
	"calcPr@calcMode": "auto",
	"calcPr@fullPrecision": "1",
	"calcPr@refMode": "A1",
	"calcPr@iterate": "0",
	"calcPr@iterateCount": "100",
	"calcPr@iterateDelta": "0.001",
	"calcPr@calcCompleted": "1",
	"calcPr@calcOnSave": "1",
	"calcPr@concurrentCalc": "1",
	"calcPr@forceFullCalc": "0"
}

function isDefault(element: string, name: string, value: string): boolean {
	return DEFAULTS[`${element}@${name}`] === value || (DEFAULTS[`*@${name}`] === value && DEFAULTS[`${element}@${name}`] === undefined)
}

// Elements (by path) that carry no content: the window's selection, the Excel version that saved last and
// its co-authoring revision pointer, the file's own used-range note, a document's revision counter,
// spell-check language and last printing time, the recently used colours, and the statistics and
// application name a writer puts in app.xml.
const IGNORED_ELEMENTS = new Set([
	"worksheet/dimension",
	"worksheet/sheetViews/sheetView/selection",
	"workbook/fileVersion",
	"workbook/fileRecoveryPr",
	"workbook/revisionPtr",
	"coreProperties/revision",
	// Set by saving, as any save does.
	"coreProperties/modified",
	"coreProperties/language",
	"coreProperties/lastPrinted",
	"styleSheet/colors/mruColors",
	...[
		"Application",
		"AppVersion",
		"DocSecurity",
		"ScaleCrop",
		"HeadingPairs",
		"TitlesOfParts",
		"LinksUpToDate",
		"SharedDoc",
		"HyperlinksChanged",
		"TotalTime",
		"Pages",
		"Words",
		"Characters",
		"CharactersWithSpaces",
		"Lines",
		"Paragraphs"
	].map(name => `Properties/${name}`)
])

const LIBREOFFICE_CALC = "{7626C862-2A13-11E5-B345-FEFF819CDC9F}"
const CALC_FEATURES = "{B58B0392-4F1F-4190-BB64-5DF3571DCE5F}"
const X15_WORKBOOK = "{140A7094-0E35-4892-8432-C4D2E57EDEB5}"
const SLICER_STYLES = "{EB79DEF2-80B8-43E5-95BD-54CBDDF9020C}"
const TIMELINE_STYLES = "{9260A510-F301-46A8-8635-F512D64BE5F5}"

// Extensions (and the like) that say nothing about the workbook's content:
// - LibreOffice's formula syntax setting;
// - the calculation features the saving Excel had (formulas carry their own dynamic-array marks);
// - Excel 2013's chart-tracking preference;
// - the default slicer and timeline styles, with no styles of the file's own (a file with slicers or
//   timelines opens view-only anyway);
// - mc:AlternateContent holding only the folder the file was last saved in (the author's local path).
function meaningless(node: XmlNode): boolean {
	const uri = (node.attrs.get("uri") ?? "").toUpperCase()

	if (node.name === "ext") {
		if (uri === LIBREOFFICE_CALC || uri === CALC_FEATURES) return true
		if (uri === X15_WORKBOOK)
			return node.children.every(
				child => child.name === "workbookPr" && [...child.attrs.keys()].every(name => name === "chartTrackingRefBase")
			)
		if (uri === SLICER_STYLES || uri === TIMELINE_STYLES) return node.children.every(child => child.children.length === 0)

		return false
	}

	if (node.name === "AlternateContent") {
		const only = (child: XmlNode): boolean =>
			child.name === "Choice" || child.name === "Fallback" ? child.children.every(only) : child.name === "absPath"

		return node.children.every(only)
	}

	return false
}

// Attributes ignored on one element only.
const IGNORED_ELEMENT_ATTRIBUTES: Record<string, readonly string[]> = {
	"workbook/workbookPr": ["defaultThemeVersion", "filterPrivacy", "codeName"],
	"workbook/sheets/sheet": ["sheetId", "r:id"],
	// The window's place and size, where the tab bar starts, how wide it is.
	"workbook/bookViews/workbookView": ["xWindow", "yWindow", "windowWidth", "windowHeight", "firstSheet", "tabRatio"],
	// The calculation engine that saved last; a save has the file calculated in full on load.
	"workbook/calcPr": ["calcId", "fullCalcOnLoad"],
	// Whether a table's totals row was ever shown: Excel's memory for toggling it.
	table: ["totalsRowShown"],
	// The view's scroll position, like its selection.
	"worksheet/sheetViews/sheetView": ["workbookViewId", "topLeftCell"],
	// Whether a width was set by hand or fitted: it stays the width it is either way.
	col: ["customWidth", "bestFit"],
	"worksheet/sheetFormatPr": ["outlineLevelRow", "outlineLevelCol"]
}

// Boolean elements whose absence means false: <b/> and <b val="1"/> are one thing, <b val="0"/> is none.
const FLAG_ELEMENTS = new Set(["b", "i", "strike", "outline", "shadow", "condense", "extend", "u"])

function normalizeColor(node: XmlNode): void {
	const rgb = node.attrs.get("rgb")

	if (rgb !== undefined) {
		node.attrs.set("rgb", (rgb.length === 6 ? `FF${rgb}` : rgb).toUpperCase())
	}
}

// A node written canonically: name, sorted attributes, text and sorted children.
function canon(node: XmlNode, path = node.name, context?: Context): string {
	if (node.name === "color" || node.name === "fgColor" || node.name === "bgColor") normalizeColor(node)

	const skip = IGNORED_ELEMENT_ATTRIBUTES[path] ?? []
	const attrs: string[] = []

	// A row's height is only a hint unless set by hand.
	const autoHeight = node.name === "row" && normalizeValue(node.attrs.get("customHeight") ?? "0") !== "1"

	for (const [name, value] of node.attrs) {
		if (IGNORED_ATTRIBUTES.has(name) || skip.includes(name) || name.startsWith("r:")) continue
		if (
			FLAG_ELEMENTS.has(node.name) &&
			name === "val" &&
			(value === "1" || value === "true" || (node.name === "u" && value === "single"))
		)
			continue
		if (isDefault(node.name, name, normalizeValue(value)) || (autoHeight && name === "ht")) continue

		// A differential format by what it is, not by its number (dxfId, dataDxfId, headerRowDxfId, …).
		const resolved =
			(name === "dxfId" || name.endsWith("DxfId")) && context !== undefined
				? (context.dxfs[Number(value)] ?? value)
				: normalizeValue(value)

		attrs.push(`${name}=${resolved}`)
	}

	attrs.sort()

	const children: string[] = []

	for (const child of node.children) {
		const childPath = `${path}/${child.name}`

		if (IGNORED_ELEMENTS.has(childPath) || meaningless(child)) continue
		if (
			FLAG_ELEMENTS.has(child.name) &&
			(child.attrs.get("val") === "0" || child.attrs.get("val") === "false" || child.attrs.get("val") === "none")
		)
			continue

		children.push(canon(child, childPath, context))
	}

	children.sort()

	// Dates to the second: fractions are how a writer spells them. A defined name's sheets quoted only
	// where they must be.
	const text =
		node.name === "t" || node.name === "f"
			? node.text
			: node.name === "created"
				? node.text.trim().replace(/\.\d+(?=Z|[+-]\d\d:\d\d$)/, "")
				: node.name === "definedName"
					? node.text
							.trim()
							.replace(/'([A-Za-z_][A-Za-z0-9_.]*)'!/g, (quoted, name: string) =>
								/^([A-Za-z]{1,3}\d+|R\d*C\d*|TRUE|FALSE)$/i.test(name) ? quoted : `${name}!`
							)
					: node.text.trim()

	return `<${node.name} ${attrs.join(" ")}>${text}${children.join("")}</${node.name}>`
}

// Every element of a part (by path, attributes and text, without its children) as a multiset.
function elementSet(node: XmlNode, into: Map<string, number>, context: Context | undefined, path = node.name): void {
	const shallow = canon({ ...node, children: [] }, path, context)

	// An element with nothing of its own (no attributes, no text) says nothing beyond its children.
	if (shallow !== `<${node.name} ></${node.name}>`) {
		const record = `${path}|${shallow}`

		into.set(record, (into.get(record) ?? 0) + 1)
	}

	for (const child of node.children) {
		const childPath = `${path}/${child.name}`

		if (!IGNORED_ELEMENTS.has(childPath) && !meaningless(child)) elementSet(child, into, context, childPath)
	}
}

// Where `saved` differs from `original`, as element records: lost ones, and ones saving added (which
// change the file as much). Empty when they are the same.
function missing(original: Map<string, number>, saved: Map<string, number>): string[] {
	const differences: string[] = []

	for (const [record, count] of original) {
		if ((saved.get(record) ?? 0) < count) differences.push(`lost ${record}`)
	}

	for (const [record, count] of saved) {
		if ((original.get(record) ?? 0) < count) differences.push(`added ${record}`)
	}

	return differences
}

// A workbook's styles, resolved so that a cell's style reads the same however the styles are numbered.
interface Context {
	styles: string[]
	defaultStyle: string
	dxfs: string[]
	strings: string[]
}

function styleContext(stylesXml: string | undefined, stringsXml: string | undefined): Context {
	const styles = stylesXml === undefined ? undefined : parseXml(stylesXml)
	const section = (name: string) => styles?.children.find(child => child.name === name)?.children ?? []
	const formats = new Map(section("numFmts").map(node => [node.attrs.get("numFmtId") ?? "", node.attrs.get("formatCode") ?? ""]))
	const fonts = section("fonts").map(node => canon(node))
	// A cell fill without a pattern type has none (a differential format's means solid).
	const fills = section("fills").map(node => {
		for (const pattern of node.children) {
			if (pattern.name === "patternFill" && !pattern.attrs.has("patternType")) pattern.attrs.set("patternType", "none")
		}

		return canon(node)
	})
	const borders = section("borders").map(node => canon(node))
	const named = new Map(section("cellStyles").map(node => [node.attrs.get("xfId") ?? "", node.attrs.get("name") ?? ""]))
	const signature = (xf: XmlNode): string => {
		const id = xf.attrs.get("numFmtId") ?? "0"
		const xfId = xf.attrs.get("xfId") ?? "0"
		const extras = [...xf.attrs]
			.filter(([name, value]) => ["quotePrefix", "pivotButton"].includes(name) && !isDefault("xf", name, normalizeValue(value)))
			.map(([name, value]) => `${name}=${normalizeValue(value)}`)

		return [
			formats.get(id) ?? SAME_EVERYWHERE[id] ?? `builtin:${id}`,
			fonts[Number(xf.attrs.get("fontId") ?? 0)] ?? "",
			fills[Number(xf.attrs.get("fillId") ?? 0)] ?? "",
			borders[Number(xf.attrs.get("borderId") ?? 0)] ?? "",
			xfId === "0" ? "Normal" : (named.get(xfId) ?? `#${xfId}`),
			xf.children
				.map(child => canon(child))
				.filter(text => !/^<\w+ ><\/\w+>$/.test(text))
				.sort()
				.join(""),
			extras.join(" ")
		].join("|")
	}
	const cellStyles = section("cellXfs").map(signature)
	const strings: string[] = []

	if (stringsXml !== undefined) {
		for (const item of parseXml(stringsXml).children) {
			strings.push(richText(item))
		}
	}

	// A differential format's number format is its code; its number there is only a label.
	const dxfs = section("dxfs").map(node => {
		for (const child of node.children) {
			if (child.name === "numFmt") child.attrs.delete("numFmtId")
		}

		return canon(node)
	})

	return { styles: cellStyles, defaultStyle: cellStyles[0] ?? "", dxfs, strings }
}

function standardPalette(node: XmlNode): boolean {
	return node.children.every((color, index) => {
		const rgb = (color.attrs.get("rgb") ?? "").toUpperCase()

		return rgb.slice(-6) === INDEXED_COLORS[index]
	})
}

// Built-in number formats that read the same in every locale, as a custom format of the same code would:
// a file may name either. The others (dates, times, currencies) follow the reader's locale, so the
// built-in and the custom code differ.
const SAME_EVERYWHERE: Readonly<Record<string, string>> = {
	"0": "General",
	"1": "0",
	"2": "0.00",
	"3": "#,##0",
	"4": "#,##0.00",
	"9": "0%",
	"10": "0.00%",
	"11": "0.00E+00",
	"12": "# ?/?",
	"13": "# ??/??",
	"48": "##0.0E+0",
	"49": "@"
}

// A string item (shared, inline or a note's text) as one string: its text alone when it has no runs.
function richText(item: XmlNode): string {
	// Runs without formatting read as the plain text they spell.
	if (item.children.every(child => child.name === "t" || (child.name === "r" && child.children.every(part => part.name === "t")))) {
		return `t:${item.children.map(child => (child.name === "t" ? child.text : child.children.map(part => part.text).join(""))).join("")}`
	}

	return item.children.map(child => canon(child)).join("")
}

interface CellRecord {
	row: number
	col: number
	style: string
	value: string | undefined
	formula: string | undefined
	attrs: string
}

function columnIndex(letters: string): number {
	let index = 0

	for (let position = 0; position < letters.length; position++) index = index * 26 + (letters.charCodeAt(position) - 64)

	return index - 1
}

const CELL_REF = /^([A-Z]{1,3})(\d+)$/
const SHEET_DATA_TOKEN = /<(?:[\w.-]+:)?row\b([^>]*?)\/?>|<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g
const FORMULA = /<(?:[\w.-]+:)?f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?f>)/
const VALUE = /<(?:[\w.-]+:)?v>([\s\S]*?)<\/(?:[\w.-]+:)?v>/
const INLINE = /<(?:[\w.-]+:)?is>([\s\S]*?)<\/(?:[\w.-]+:)?is>/

type SheetItem = { kind: "row"; row: number; record: string } | ({ kind: "cell" } & CellRecord)

// A sheet's rows and cells in document order, each as it reads: styles resolved, strings resolved, shared
// formulas filled in as ordinary ones.
function* sheetItems(sheetData: string, context: Context): Generator<SheetItem> {
	const shared = new Map<string, { row: number; col: number; translate: (rows: number, cols: number) => string }>()
	let row = -1
	let col = -1

	for (const [, rowAttrs, cellAttrs, inner = ""] of sheetData.matchAll(SHEET_DATA_TOKEN)) {
		if (rowAttrs !== undefined) {
			const attrs = attributes(rowAttrs)

			row = attrs.has("r") ? Number(attrs.get("r")) - 1 : row + 1
			col = -1

			const parts: string[] = []
			const autoHeight = normalizeValue(attrs.get("customHeight") ?? "0") !== "1"

			for (const [name, value] of attrs) {
				if (
					name === "r" ||
					IGNORED_ATTRIBUTES.has(name) ||
					isDefault("row", name, normalizeValue(value)) ||
					(autoHeight && name === "ht")
				)
					continue

				parts.push(name === "s" ? `s=${context.styles[Number(value)] ?? value}` : `${name}=${normalizeValue(value)}`)
			}

			// A row's format applies only where customFormat says so.
			yield { kind: "row", row, record: parts.sort().join(" ") }

			continue
		}

		const attrs = attributes(cellAttrs ?? "")
		const ref = CELL_REF.exec(attrs.get("r") ?? "")

		if (ref !== null) {
			col = columnIndex(ref[1] ?? "A")
			row = Number(ref[2]) - 1
		} else {
			col++
		}

		const type = attrs.get("t") ?? "n"
		const formulaMatch = FORMULA.exec(inner)
		const valueText = VALUE.exec(inner)?.[1]
		let formula: string | undefined
		let formulaAttrs = ""

		if (formulaMatch !== null) {
			const fAttrs = attributes(formulaMatch[1] ?? "")
			let text = decode(formulaMatch[2] ?? "")

			if (fAttrs.get("t") === "shared") {
				const index = fAttrs.get("si") ?? ""
				const master = shared.get(index)

				if (text !== "") {
					shared.set(index, { row, col, translate: formulaTranslator(text) })
				} else if (master !== undefined) {
					text = master.translate(row - master.row, col - master.col)
				}

				fAttrs.delete("t")
				fAttrs.delete("si")
				fAttrs.delete("ref")
			}

			formula = text
			formulaAttrs = [...fAttrs]
				.filter(([name, value]) => name !== "ca" && !isDefault("f", name, normalizeValue(value)))
				.map(([name, value]) => `${name}=${normalizeValue(value)}`)
				.sort()
				.join(" ")
		}

		let value: string | undefined

		if (type === "inlineStr") {
			const item = INLINE.exec(inner)?.[1]

			value = item === undefined ? undefined : `s:${richText(parseXml(`<is>${item}</is>`))}`
		} else if (valueText !== undefined && valueText !== "") {
			const text = decode(valueText)

			switch (type) {
				case "s":
					value = `s:${context.strings[Number(text)] ?? ""}`
					break
				case "str":
					value = `s:t:${text}`
					break
				case "b":
					value = `b:${text === "1" || text === "true" ? "1" : "0"}`
					break
				case "e":
				case "d":
					value = `${type}:${text}`
					break
				default:
					value = `n:${String(Number(text))}`
			}
		}

		const extra = [...attrs]
			.filter(([name]) => !["r", "s", "t"].includes(name))
			.map(([name, v]) => `${name}=${v}`)
			.sort()
			.join(" ")

		yield {
			kind: "cell",
			row,
			col,
			style: context.styles[Number(attrs.get("s") ?? 0)] ?? context.defaultStyle,
			value,
			formula: formula === undefined ? undefined : `${formula}|${formulaAttrs}`,
			attrs: extra
		}
	}
}

function numbersClose(a: string, b: string): boolean {
	const x = Number(a.slice(2))
	const y = Number(b.slice(2))

	return x === y || Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x))
}

// What of a sheet's rows and cells saving lost, walking both in order (cells come by row, then column).
// Lets the worker take other messages (a close) in a long comparison.
export function pause(): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, 0)
	})
}

// Rows and cells compared between pauses.
const PAUSE_EVERY = 50_000

async function compareSheetData(
	original: string,
	saved: string,
	originalContext: Context,
	savedContext: Context,
	cancelled: () => boolean
): Promise<string[] | null> {
	const lost: string[] = []
	let walked = 0
	const out = sheetItems(saved, savedContext)
	let next = out.next()
	let lastRow = -1
	let lastCol = -1
	const savedRows = new Map<number, string>()

	const position = (item: SheetItem) => (item.kind === "row" ? item.row * 20_000 - 1 : item.row * 20_000 + item.col)

	for (const item of sheetItems(original, originalContext)) {
		if (++walked % PAUSE_EVERY === 0) {
			await pause()

			if (cancelled()) return null
		}

		// Out of order: not walked side by side, so not proven.
		if (item.row < lastRow || (item.kind === "cell" && item.row === lastRow && item.col <= lastCol)) {
			return ["unordered sheet data"]
		}

		lastRow = item.row
		lastCol = item.kind === "cell" ? item.col : -1

		while (!next.done && position(next.value) < position(item)) {
			if (next.value.kind === "row") savedRows.set(next.value.row, next.value.record)
			next = out.next()
		}

		const match = !next.done && position(next.value) === position(item) ? next.value : undefined

		if (match?.kind === "row") savedRows.set(match.row, match.record)

		if (item.kind === "row") {
			const record = match?.kind === "row" ? match.record : (savedRows.get(item.row) ?? "")

			if (item.record !== "" && item.record !== record) lost.push(`row ${String(item.row + 1)}: ${item.record} / ${record}`)

			continue
		}

		const empty =
			item.value === undefined && item.formula === undefined && item.attrs === "" && item.style === originalContext.defaultStyle

		if (match?.kind !== "cell") {
			if (!empty) lost.push(`cell ${String(item.row + 1)},${String(item.col + 1)} missing`)

			continue
		}

		// A formula's cached error may come back as text: Excel calculates the formula again either way.
		const cached = (value: string | undefined) =>
			item.formula !== undefined && value?.startsWith("e:") === true ? `s:t:${value.slice(2)}` : value
		const sameValue =
			item.value === undefined ||
			(item.formula !== undefined && match.value === undefined) ||
			cached(item.value) === cached(match.value) ||
			(item.value.startsWith("n:") && match.value?.startsWith("n:") === true && numbersClose(item.value, match.value))

		if (!sameValue || item.formula !== match.formula || item.attrs !== match.attrs || item.style !== match.style) {
			lost.push(
				`cell ${String(item.row + 1)},${String(item.col + 1)}: ${JSON.stringify([item.value, item.formula, item.attrs, item.style])} / ${JSON.stringify([match.value, match.formula, match.attrs, match.style])}`
			)
		}
	}

	return lost
}

// A sheet's columns as runs of equal settings, however the file splits them into <col> elements.
function columnRuns(node: XmlNode): string[] {
	const runs: string[] = []
	let current: { start: number; end: number; signature: string } | null = null

	for (const col of node.children) {
		const min = Number(col.attrs.get("min") ?? 0)
		const max = Number(col.attrs.get("max") ?? min)
		const shallow: XmlNode = {
			...col,
			attrs: new Map([...col.attrs].filter(([name]) => name !== "min" && name !== "max" && name !== "style"))
		}
		const signature = canon(shallow)

		if (current !== null && current.signature === signature && current.end + 1 === min) {
			current.end = max
		} else {
			if (current !== null) runs.push(`${String(current.start)}-${String(current.end)}:${current.signature}`)

			current = { start: min, end: max, signature }
		}
	}

	if (current !== null) runs.push(`${String(current.start)}-${String(current.end)}:${current.signature}`)

	return runs
}

const SHEET_DATA = /<(?:[\w.-]+:)?sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?sheetData>)/

// A worksheet part without its cells, as an element multiset: columns as runs, hyperlinks with their
// targets, conditional formats with their formats resolved.
function sheetElements(xml: string, context: Context, links: Map<string, string>): Map<string, number> {
	const tree = parseXml(xml.replace(SHEET_DATA, ""))
	const set = new Map<string, number>()

	for (const child of tree.children) {
		if (child.name === "cols") {
			for (const run of columnRuns(child)) set.set(`cols|${run}`, (set.get(`cols|${run}`) ?? 0) + 1)

			continue
		}

		if (child.name === "hyperlinks") {
			for (const link of child.children) {
				const id = link.attrs.get("r:id")

				if (id !== undefined) link.attrs.set("target", links.get(id) ?? "")
			}
		}

		const path = `worksheet/${child.name}`

		if (!IGNORED_ELEMENTS.has(path) && !meaningless(child)) elementSet(child, set, context, path)
	}

	// Conditional-format blocks over the same range are one block, however many the file splits it into
	// (each rule keeps its type, priority and format, compared on its own).
	for (const record of set.keys()) {
		if (record.startsWith("worksheet/conditionalFormatting|")) set.set(record, 1)
	}

	return set
}

interface Relationship {
	id: string
	type: string
	target: string
	external: boolean
}

function relationships(xml: string | undefined): Relationship[] {
	if (xml === undefined) return []

	return parseXml(xml).children.map(node => ({
		id: node.attrs.get("Id") ?? "",
		type: (node.attrs.get("Type") ?? "").replace(/^.*\//, ""),
		target: node.attrs.get("Target") ?? "",
		external: node.attrs.get("TargetMode") === "External"
	}))
}

function resolve(base: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1).toLowerCase()

	const parts = base.split("/").filter(Boolean)

	for (const part of target.split("/").filter(Boolean)) {
		if (part === "..") parts.pop()
		else if (part !== ".") parts.push(part)
	}

	return parts.join("/").toLowerCase()
}

function relsPath(part: string): string {
	const slash = part.lastIndexOf("/")

	return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`
}

function dirname(part: string): string {
	return part.slice(0, part.lastIndexOf("/"))
}

interface Package {
	entries: Map<string, Uint8Array>
	text: (path: string) => string | undefined
	rels: (part: string) => Relationship[]
}

function packageOf(raw: Map<string, Uint8Array>): Package {
	const entries = new Map<string, Uint8Array>()

	for (const [path, bytes] of raw) entries.set(path.toLowerCase(), bytes)

	const text = (path: string) => {
		const bytes = entries.get(path.toLowerCase())

		return bytes === undefined ? undefined : decoder.decode(bytes)
	}

	return { entries, text, rels: part => relationships(text(relsPath(part))) }
}

// The parts one sheet owns (its notes, tables, pictures' drawing), by kind.
function sheetParts(pkg: Package, sheetPath: string): { links: Map<string, string>; parts: Map<string, string[]> } {
	const links = new Map<string, string>()
	const parts = new Map<string, string[]>()

	for (const rel of pkg.rels(sheetPath)) {
		if (rel.external) {
			links.set(rel.id, rel.target)

			continue
		}

		const list = parts.get(rel.type) ?? []

		list.push(resolve(dirname(sheetPath), rel.target))
		parts.set(rel.type, list)
	}

	return { links, parts }
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (a === undefined || b === undefined) return false
	if (a.length !== b.length) return false

	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return false
	}

	return true
}

const NOTE_SHAPE = /<(?:[\w.-]+:)?shape\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?shape>/g

// Notes whose box saving would not draw as the file does. Saving writes every note's box anew as a hidden
// note of the default size and colour: one shown all the time, coloured, or sized by hand is lost. A box
// within a few points of the default (Excel's and LibreOffice's) and anchored over the default few cells is
// the default.
function notePresentation(vml: string): string[] {
	const lost: string[] = []

	for (const [, attrs = "", inner = ""] of vml.matchAll(NOTE_SHAPE)) {
		if (!/ObjectType\s*=\s*["']Note["']/.test(inner)) continue

		const shape = attributes(attrs)
		const style = shape.get("style") ?? ""
		const size = (name: string) => {
			const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\d.]+)pt`).exec(style)

			return match === null ? null : Number(match[1])
		}
		const width = size("width")
		const height = size("height")
		const fill = (shape.get("fillcolor") ?? "#ffffe1").trim().toLowerCase()
		const shown = /visibility\s*:\s*visible/.test(style) || /<(?:[\w.-]+:)?Visible\b/.test(inner)
		const anchor = /<(?:[\w.-]+:)?Anchor>([^<]*)</.exec(inner)?.[1]?.split(",").map(Number)
		const wide = anchor?.length === 8 && ((anchor[4] ?? 0) - (anchor[0] ?? 0) > 4 || (anchor[6] ?? 0) - (anchor[2] ?? 0) > 6)
		const where = `${/<(?:[\w.-]+:)?Row>(\d+)</.exec(inner)?.[1] ?? "?"},${/<(?:[\w.-]+:)?Column>(\d+)</.exec(inner)?.[1] ?? "?"}`

		if (shown) lost.push(`note ${where} shown all the time`)
		if (!fill.startsWith("#ffffe1") && !fill.startsWith("infobackground")) lost.push(`note ${where} coloured ${fill}`)
		if ((width !== null && (width < 90 || width > 130)) || (height !== null && (height < 45 || height > 80)) || wide) {
			lost.push(`note ${where} sized ${String(width)}x${String(height)}`)
		}
	}

	return lost
}

function commentRecords(xml: string | undefined): Map<string, number> {
	const set = new Map<string, number>()

	if (xml === undefined) return set

	const tree = parseXml(xml)
	const authors = tree.children.find(child => child.name === "authors")?.children.map(author => author.text) ?? []

	for (const comment of tree.children.find(child => child.name === "commentList")?.children ?? []) {
		const text = comment.children.find(child => child.name === "text")
		const record = `${comment.attrs.get("ref") ?? ""}|${authors[Number(comment.attrs.get("authorId") ?? 0)] ?? ""}|${text === undefined ? "" : richText(text)}`

		set.set(record, (set.get(record) ?? 0) + 1)
	}

	return set
}

function tableRecords(pkg: Package, paths: readonly string[], context: Context): Map<string, number> {
	const set = new Map<string, number>()

	for (const path of paths) {
		const xml = pkg.text(path)

		if (xml === undefined) continue

		const tree = parseXml(xml)

		tree.attrs.delete("id")

		for (const column of tree.children.find(child => child.name === "tableColumns")?.children ?? []) column.attrs.delete("id")

		elementSet(tree, set, context)
	}

	return set
}

// A picture drawing as its anchors and the pictures' bytes, whatever the parts are named.
function drawingRecords(pkg: Package, paths: readonly string[]): Map<string, number> {
	const set = new Map<string, number>()

	for (const path of paths) {
		const xml = pkg.text(path)

		if (xml === undefined) continue

		const images = new Map(pkg.rels(path).map(rel => [rel.id, pkg.entries.get(resolve(dirname(path), rel.target))]))
		const tree = parseXml(xml)
		const walk = (node: XmlNode) => {
			const embed = node.attrs.get("r:embed")

			if (embed !== undefined) node.attrs.set("image", String(images.get(embed)?.length ?? -1))
			if (node.name === "cNvPr") node.attrs.delete("id")

			node.children.forEach(walk)
		}

		walk(tree)
		elementSet(tree, set, undefined)
	}

	return set
}

// The parts an unedited save writes anew, compared by meaning; everything else must come back byte for
// byte at the same path.
const REWRITTEN =
	/^(\[content_types\]\.xml|_rels\/\.rels|xl\/_rels\/workbook\.xml\.rels|docprops\/app\.xml|xl\/calcchain\.xml|xl\/sharedstrings\.xml|xl\/styles\.xml|xl\/workbook\.xml|docprops\/core\.xml)$/

// Style-table numbers a part saving copies as it was may name: saving numbers custom number formats and
// differential formats afresh (in the order cells and rules use them), and an edit may again, so the
// copy would point at other formats. Built-in number formats (below 164) keep their numbers.
const STYLE_REFERENCE = /\b(\w*numFmtId|\w*[dD]xfId|xfId)="(\d+)"/g

export interface VerifyInput {
	original: Map<string, Uint8Array>
	saved: Map<string, Uint8Array>
	// Original sheet part paths, in the workbook's order.
	sheetPaths: readonly string[]
	// Parts the save plan drops on purpose (a thumbnail, empty custom properties, printer settings).
	dropped: readonly string[]
	// Empties `original` and `saved` once read, so each part can go as soon as it is compared.
	release?: boolean
}

// What saving loses, as readable records; empty when it loses nothing, null when `cancelled` said to stop.
export async function saveLosses(input: VerifyInput, cancelled: () => boolean = () => false): Promise<string[] | null> {
	const original = packageOf(input.original)
	const saved = packageOf(input.saved)

	if (input.release === true) {
		input.original.clear()
		input.saved.clear()
	}
	const lost: string[] = []
	const originalContext = styleContext(original.text("xl/styles.xml"), original.text("xl/sharedStrings.xml"))
	const savedContext = styleContext(saved.text("xl/styles.xml"), saved.text("xl/sharedStrings.xml"))
	const handled = new Set<string>(input.dropped.map(path => path.toLowerCase()))
	const report = (part: string, records: readonly string[]) => {
		for (const record of records.slice(0, 20)) lost.push(`${part}: ${record}`)
	}

	// Styles beyond what cells use: named styles, differential formats, table styles, colours.
	const styleSections = (xml: string | undefined, context: Context) => {
		const set = new Map<string, number>()

		for (const section of xml === undefined ? [] : parseXml(xml).children) {
			if (["numFmts", "fonts", "fills", "borders", "cellXfs", "cellStyleXfs", "dxfs"].includes(section.name)) continue

			// Built-in named styles Excel recreates as needed (cells using one are compared by name);
			// custom ones are content.
			if (section.name === "cellStyles") section.children = section.children.filter(style => !style.attrs.has("builtinId"))

			// The default styles for new tables and pivot tables, with no styles of the file's own.
			if (section.name === "tableStyles" && section.children.length === 0) continue

			// The standard palette spelled out.
			if (section.name === "colors")
				section.children = section.children.filter(child => !(child.name === "indexedColors" && standardPalette(child)))

			elementSet(section, set, context, `styleSheet/${section.name}`)
		}

		// Differential formats are compared where rules and tables use them: saving keeps only those.
		return set
	}

	report(
		"styles",
		missing(styleSections(original.text("xl/styles.xml"), originalContext), styleSections(saved.text("xl/styles.xml"), savedContext))
	)

	for (const part of ["xl/workbook.xml", "docProps/core.xml", "docProps/app.xml"]) {
		const before = original.text(part)
		const after = saved.text(part)

		if (before === undefined) continue

		const beforeSet = new Map<string, number>()
		const afterSet = new Map<string, number>()

		elementSet(parseXml(before), beforeSet, undefined)

		if (after !== undefined) elementSet(parseXml(after), afterSet, undefined)

		report(part, missing(beforeSet, afterSet))
	}

	for (const [index, path] of input.sheetPaths.entries()) {
		await pause()

		if (cancelled()) return null

		const savedPath = `xl/worksheets/sheet${String(index + 1)}.xml`
		const before = original.text(path)
		const after = saved.text(savedPath) ?? ""

		handled.add(path.toLowerCase())
		handled.add(relsPath(path.toLowerCase()))

		if (before === undefined) {
			lost.push(`${path}: missing`)

			continue
		}

		const beforeParts = sheetParts(original, path.toLowerCase())
		const afterParts = sheetParts(saved, savedPath)

		report(
			path,
			missing(sheetElements(before, originalContext, beforeParts.links), sheetElements(after, savedContext, afterParts.links))
		)
		// The sheets are the bulk of a file: each is let go once compared.
		original.entries.delete(path.toLowerCase())
		saved.entries.delete(savedPath)

		const cells = await compareSheetData(
			SHEET_DATA.exec(before)?.[1] ?? "",
			SHEET_DATA.exec(after)?.[1] ?? "",
			originalContext,
			savedContext,
			cancelled
		)

		if (cells === null) return null

		report(path, cells)

		const partsOf = (parts: Map<string, string[]>, type: string) => parts.get(type) ?? []

		for (const comments of partsOf(beforeParts.parts, "comments")) handled.add(comments)
		for (const vml of partsOf(beforeParts.parts, "vmlDrawing")) {
			handled.add(vml)
			report(`${path} notes`, notePresentation(original.text(vml) ?? ""))
		}
		for (const printer of partsOf(beforeParts.parts, "printerSettings")) handled.add(printer)

		report(
			`${path} notes`,
			missing(
				commentRecords(original.text(partsOf(beforeParts.parts, "comments")[0] ?? "")),
				commentRecords(saved.text(partsOf(afterParts.parts, "comments")[0] ?? ""))
			)
		)

		for (const table of partsOf(beforeParts.parts, "table")) handled.add(table)

		report(
			`${path} tables`,
			missing(
				tableRecords(original, partsOf(beforeParts.parts, "table"), originalContext),
				tableRecords(saved, partsOf(afterParts.parts, "table"), savedContext)
			)
		)

		// A drawing saving copies (it holds a chart) is compared byte for byte below; one it writes anew
		// (pictures) by what it shows.
		const drawings = partsOf(beforeParts.parts, "drawing").filter(
			drawing => !sameBytes(original.entries.get(drawing), saved.entries.get(drawing))
		)

		if (drawings.length > 0) {
			for (const drawing of drawings) {
				handled.add(drawing)
				handled.add(relsPath(drawing))

				for (const rel of original.rels(drawing)) handled.add(resolve(dirname(drawing), rel.target))
			}

			report(
				`${path} drawing`,
				missing(drawingRecords(original, drawings), drawingRecords(saved, partsOf(afterParts.parts, "drawing")))
			)
		}
	}

	for (const [path, bytes] of original.entries) {
		if (handled.has(path) || REWRITTEN.test(path) || path.endsWith("/")) continue

		if (!sameBytes(bytes, saved.entries.get(path))) {
			lost.push(`${path}: not copied`)

			continue
		}

		if (path.endsWith(".xml")) {
			for (const [, name = "", id = ""] of decoder.decode(bytes).matchAll(STYLE_REFERENCE)) {
				if (!(name.toLowerCase().endsWith("numfmtid") && Number(id) < 164)) {
					lost.push(`${path}: names style-table entry ${name}=${id}, which saving renumbers`)

					break
				}
			}
		}
	}

	return lost
}
