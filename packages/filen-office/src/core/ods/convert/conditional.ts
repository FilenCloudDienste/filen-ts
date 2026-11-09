import { minOf } from "../../arrays"
import type { SheetStyles } from "../../sheet/style/resolve"
import type { XlsxColor, XlsxDxf, XlsxStyleTable } from "../../xlsx/model/types"
import { parseRangeRef } from "../../xlsx/write/text"
import { encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../xml/index"
import { DATES } from "../features"
import { openFormula } from "../formula/toOf"

// Conditional formats (ECMA-376 Part 1 §18.3.1.18) as LibreOffice's calcext:conditional-formats, which an ODF 1.3
// document of extended conformance carries and LibreOffice reads (the inverse of the reader's features.ts cfRule):
// each rule's look a common cell style in styles.xml. Rules it has no form for (blanks, standard-deviation averages,
// and colour scales, data bars or icon sets outside LibreOffice's forms) are left out and counted.

// ST_TimePeriod (§18.18.82) to LibreOffice's calcext:date names.
const PERIODS: ReadonlyMap<string, string> = new Map(Object.entries(DATES).map(([ods, period]) => [period, ods]))

export interface SheetConditions {
	// calcext:conditional-formats, or "" for none.
	readonly markup: string
	readonly lost: number
}

const OPERATORS: Readonly<Record<string, string>> = {
	equal: "=",
	notEqual: "!=",
	lessThan: "<",
	lessThanOrEqual: "<=",
	greaterThan: ">",
	greaterThanOrEqual: ">="
}

function children(document: XmlDocument, node: number, local: string): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === local) out.push(child)

	return out
}

function quotedSheet(sheet: string): string {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet) ? sheet : `'${sheet.replaceAll("'", "''")}'`
}

function column(index: number): string {
	let text = ""

	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + ((n - 1) % 26)) + text

	return text
}

// A formula as calcext:value's expression: OpenFormula without its "of:=".
function expression(formula: string): string | null {
	const written = openFormula(formula)

	return "refused" in written ? null : written.text.replace(/^of:=/, "")
}

// Named styles for rules' looks, in styles.xml.
export class ConditionStyles {
	private readonly names = new Map<number, string>()
	private readonly elements: string[] = []
	private readonly dxfs: readonly XlsxDxf[]
	private readonly color: (color: XlsxColor) => number

	constructor(styles: XlsxStyleTable, sheetStyles: SheetStyles) {
		this.dxfs = styles.dxfs
		this.color = color => sheetStyles.color(color)
	}

	hex(color: XlsxColor): string | null {
		const rgb = this.color(color)

		return rgb < 0 ? null : `#${rgb.toString(16).padStart(6, "0")}`
	}

	get markup(): string {
		return this.elements.join("")
	}

	name(dxf: number): string | undefined {
		let name = this.names.get(dxf)

		if (name !== undefined) return name

		const record = this.dxfs[dxf]

		if (record === undefined) return undefined

		const hex = (color: XlsxColor | undefined): string | undefined => {
			const rgb = color === undefined || color.auto === true ? -1 : this.color(color)

			return rgb < 0 ? undefined : `#${rgb.toString(16).padStart(6, "0")}`
		}
		const font = record.font
		const text: string[] = []

		if (font?.bold !== undefined) text.push(` fo:font-weight="${font.bold ? "bold" : "normal"}"`)
		if (font?.italic !== undefined) text.push(` fo:font-style="${font.italic ? "italic" : "normal"}"`)
		if (font?.strike !== undefined) text.push(` style:text-line-through-style="${font.strike ? "solid" : "none"}"`)
		if (font?.underline !== undefined)
			text.push(
				font.underline === "none"
					? ' style:text-underline-style="none"'
					: ` style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"${font.underline.startsWith("double") ? ' style:text-underline-type="double"' : ""}`
			)

		const fontColor = hex(font?.color)

		if (fontColor !== undefined) text.push(` fo:color="${fontColor}"`)

		const fill = record.fill
		const background = fill?.kind === "pattern" && fill.pattern !== "none" ? hex(fill.bg ?? fill.fg) : undefined
		const cell = background === undefined ? "" : `<style:table-cell-properties fo:background-color="${background}"/>`

		name = `ConditionalStyle_${String(this.names.size + 1)}`
		this.names.set(dxf, name)
		this.elements.push(
			`<style:style style:name="${name}" style:family="table-cell">${cell}${text.length === 0 ? "" : `<style:text-properties${text.join("")}/>`}</style:style>`
		)

		return name
	}
}

// A cfvo (§18.3.1.11) as a calcext entry's type and value.
function entry(document: XmlDocument, node: number, element: string, color?: string): string | null {
	const type = document.attribute(node, "type") ?? "num"
	const value = document.attribute(node, "val") ?? "0"
	const types: Readonly<Record<string, string>> = {
		min: "minimum",
		max: "maximum",
		percentile: "percentile",
		percent: "percent",
		num: "number"
	}
	const said = type === "formula" ? expression(value) : value
	const kind = type === "formula" ? "formula" : types[type]

	if (said === null || kind === undefined) return null

	return `<calcext:${element} calcext:value="${escapeAttribute(kind === "minimum" || kind === "maximum" ? "0" : said)}" calcext:type="${kind}"${color === undefined ? "" : ` calcext:color="${color}"`}/>`
}

// A colour scale, data bar or icon set (§18.3.1.16, §18.3.1.28, §18.3.1.49) as LibreOffice's; undefined for any other
// rule, null for one it cannot say.
function scaleMarkup(document: XmlDocument, rule: number, styles: ConditionStyles): string | null | undefined {
	const type = document.attribute(rule, "type")
	const colorOf = (node: number | undefined): string | null => {
		if (node === undefined) return null

		const rgb = document.attribute(node, "rgb")

		if (rgb !== undefined && /^[0-9A-Fa-f]{8}$/.test(rgb)) return `#${rgb.slice(2).toLowerCase()}`

		const theme = document.attribute(node, "theme")

		return theme === undefined
			? null
			: styles.hex({
					theme: Number(theme),
					...(document.attribute(node, "tint") !== undefined && { tint: Number(document.attribute(node, "tint")) })
				})
	}

	if (type === "colorScale") {
		const scale = children(document, rule, "colorScale")[0]

		if (scale === undefined) return null

		const values = children(document, scale, "cfvo")
		const colors = children(document, scale, "color")

		if (values.length < 2 || values.length > 3 || colors.length !== values.length) return null

		const entries = values.map((node, k) => {
			const color = colorOf(colors[k])

			return color === null ? null : entry(document, node, "color-scale-entry", color)
		})

		return entries.some(item => item === null) ? null : `<calcext:color-scale>${entries.join("")}</calcext:color-scale>`
	}

	if (type === "dataBar") {
		const bar = children(document, rule, "dataBar")[0]

		if (bar === undefined) return null

		const values = children(document, bar, "cfvo").map(node => entry(document, node, "formatting-entry"))
		const color = colorOf(children(document, bar, "color")[0])

		if (values.length !== 2 || values.some(item => item === null) || color === null) return null

		return `<calcext:data-bar calcext:positive-color="${color}">${values.join("")}</calcext:data-bar>`
	}

	if (type === "iconSet") {
		const set = children(document, rule, "iconSet")[0]

		if (set === undefined || document.attribute(set, "reverse") === "1" || document.attribute(set, "custom") === "1") return null

		const values = children(document, set, "cfvo").map(node => entry(document, node, "formatting-entry"))

		if (values.some(item => item === null)) return null

		return `<calcext:icon-set calcext:icon-set-type="${escapeAttribute(document.attribute(set, "iconSet") ?? "3TrafficLights1")}"${document.attribute(set, "showValue") === "0" ? ' calcext:show-value="false"' : ""}>${values.join("")}</calcext:icon-set>`
	}

	return undefined
}

// One rule's calcext:condition value, null for a rule it has no form for.
function conditionValue(document: XmlDocument, rule: number): string | null {
	const type = document.attribute(rule, "type") ?? ""
	const formulas = children(document, rule, "formula").map(node => document.textContent(node))
	const quoted = (text: string): string => `"${text.replaceAll('"', '""')}"`

	switch (type) {
		case "cellIs": {
			const operator = document.attribute(rule, "operator") ?? "equal"
			const [first = "", second = ""] = formulas

			if (operator === "between" || operator === "notBetween") {
				const low = expression(first)
				const high = expression(second)

				return low === null || high === null ? null : `${operator === "notBetween" ? "not-" : ""}between(${low},${high})`
			}

			const value = expression(first)
			const symbol = OPERATORS[operator]

			return value === null || symbol === undefined ? null : `${symbol}${value}`
		}
		case "expression": {
			const value = expression(formulas[0] ?? "")

			return value === null ? null : `formula-is(${value})`
		}
		case "beginsWith":
		case "endsWith":
		case "containsText":
		case "notContainsText": {
			const text = document.attribute(rule, "text")
			const names: Readonly<Record<string, string>> = {
				beginsWith: "begins-with",
				endsWith: "ends-with",
				containsText: "contains-text",
				notContainsText: "not-contains-text"
			}

			return text === undefined ? null : `${names[type] ?? ""}(${quoted(text)})`
		}
		case "top10": {
			const rank = document.attribute(rule, "rank") ?? "10"
			const bottom = document.attribute(rule, "bottom") === "1"
			const percent = document.attribute(rule, "percent") === "1"

			return `${bottom ? "bottom" : "top"}-${percent ? "percent" : "elements"}(${rank})`
		}
		case "duplicateValues":
			return "duplicate"
		case "uniqueValues":
			return "unique"
		case "aboveAverage": {
			const above = document.attribute(rule, "aboveAverage") !== "0"
			const equal = document.attribute(rule, "equalAverage") === "1"

			if (document.attribute(rule, "stdDev") !== undefined) return null

			return `${above ? "above" : "below"}-${equal ? "equal-" : ""}average`
		}
		case "containsErrors":
			return "error"
		case "notContainsErrors":
			return "no-error"
		default:
			return null
	}
}

// A sheet's conditional formatting sections as calcext:conditional-formats.
export function sheetConditions(sections: readonly string[], sheet: string, styles: ConditionStyles): SheetConditions {
	const formats: string[] = []
	let lost = 0

	for (const markup of sections) {
		const document = parseXml(encodeUtf8(markup))
		const root = document.documentElement()
		const ranges = (document.attribute(root, "sqref") ?? "").split(/\s+/).flatMap(text => {
			const range = parseRangeRef(text)

			return range === null || range === undefined ? [] : [range]
		})
		if (ranges.length === 0) {
			lost += children(document, root, "cfRule").length

			continue
		}

		const name = quotedSheet(sheet)
		const target = ranges
			.map(
				range =>
					`${name}.${column(range.startCol)}${range.startRow + 1}${range.startRow === range.endRow && range.startCol === range.endCol ? "" : `:${name}.${column(range.endCol)}${range.endRow + 1}`}`
			)
			.join(" ")
		// SpreadsheetML's formulas are for the top-left cell of the rectangle around the ranges: the base cell.
		const base = `${name}.${column(minOf(ranges.map(range => range.startCol)))}${minOf(ranges.map(range => range.startRow)) + 1}`
		const rules = children(document, root, "cfRule").sort(
			(a, b) => Number(document.attribute(a, "priority") ?? "0") - Number(document.attribute(b, "priority") ?? "0")
		)
		const conditions: string[] = []

		for (const rule of rules) {
			const scale = scaleMarkup(document, rule, styles)

			if (scale !== undefined) {
				if (scale === null) lost++
				else conditions.push(scale)

				continue
			}

			const dxf = Number(document.attribute(rule, "dxfId") ?? "-1")
			const style = dxf >= 0 ? styles.name(dxf) : undefined

			// A Date Occurring (§18.3.1.10 @timePeriod): calcext:date-is, which has no value or base cell.
			if (document.attribute(rule, "type") === "timePeriod") {
				const date = PERIODS.get(document.attribute(rule, "timePeriod") ?? "")

				if (date === undefined || style === undefined) lost++
				else conditions.push(`<calcext:date-is calcext:date="${date}" calcext:style="${escapeAttribute(style)}"/>`)

				continue
			}

			const value = conditionValue(document, rule)

			if (value === null || style === undefined) {
				lost++

				continue
			}

			conditions.push(
				`<calcext:condition calcext:apply-style-name="${escapeAttribute(style)}" calcext:value="${escapeAttribute(value)}" calcext:base-cell-address="${escapeAttribute(base)}"/>`
			)
		}

		if (conditions.length > 0)
			formats.push(
				`<calcext:conditional-format calcext:target-range-address="${escapeAttribute(target)}">${conditions.join("")}</calcext:conditional-format>`
			)
	}

	return { markup: formats.length === 0 ? "" : `<calcext:conditional-formats>${formats.join("")}</calcext:conditional-formats>`, lost }
}
