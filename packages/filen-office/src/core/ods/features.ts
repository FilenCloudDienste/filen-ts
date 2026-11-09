import { appendAll, minOf } from "../arrays"
import type { OdfElement } from "../odf/tree"
import { parseColor } from "../odf/units"
import { parseRelationships, type Relationship } from "../opc/relationships"
import { escapeAttribute, escapeText } from "../xml/index"
import type { XlsxDefinedName, XlsxDxf, XlsxSection } from "../xlsx/model/types"
import {
	cellAddress,
	columnText,
	rangeAddress,
	rangeAddresses,
	type ReferenceShift,
	sheetRef,
	translateExpression,
	withoutSheet
} from "./formula/toXlsx"
import type { OdsIssues } from "./issues"
import type { UnheldCollector } from "./unheld"
import { capturedText, parseCaptured } from "./read/captured"
import type { OdsContent, OdsTable } from "./read/content"
import { OdsReadError } from "./read/errors"
import type { OdsCellLink, OdsCellNote } from "./read/sheet"
import type { OdsCellStyles } from "./styles/cell"
import { NO_CHARTS, type OdsChartParts } from "./charts/read"

// The sheet features' sources in their SpreadsheetML form, built from what content.xml held, so the features read an
// OpenDocument sheet as they read a worksheet: annotations as a comments part (§18.7), text:a links as hyperlinks
// (§18.3.1.47), content validations as dataValidations (§18.3.1.33), database ranges with filter buttons as
// autoFilter (§18.3.1.2), calcext conditional formats as conditionalFormatting (§18.3.1.18) with their dxfs, and
// named ranges and expressions as defined names. What a section cannot say is named in the issues.

const encoder = new TextEncoder()

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const COMMENTS_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
const HYPERLINK_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
const COMMENTS_CONTENT = "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"

export interface OdsSheetFeatures {
	readonly sections: XlsxSection[]
	readonly relationships: Relationship[]
	// Each validation's dataValidation element without its sqref (as validationRuleKey gives it), to the name of the
	// table:content-validation it came from.
	readonly validationNames: ReadonlyMap<string, string>
}

// Attribute values a dataValidation element has when it leaves them out (ECMA-376 Part 1 §18.3.1.32).
const DV_DEFAULTS: Readonly<Record<string, string>> = {
	type: "none",
	operator: "between",
	allowBlank: "0",
	showDropDown: "0",
	showInputMessage: "0",
	showErrorMessage: "0",
	errorStyle: "stop",
	imeMode: "noControl",
	error: "",
	errorTitle: "",
	prompt: "",
	promptTitle: ""
}

// A dataValidation element's rule, its sqref aside, however its attributes are spelled and ordered: what tells two
// validations apart.
const FORMULA1 = /<formula1>([\s\S]*?)<\/formula1>/
const FORMULA2 = /<formula2>([\s\S]*?)<\/formula2>/

export function validationRuleKey(markup: string): string {
	const open = markup.slice(0, markup.indexOf(">") + 1)
	const attributes: string[] = []

	for (const match of open.matchAll(/\s([A-Za-z:]+)="([^"]*)"/g)) {
		const name = match[1] ?? ""
		const raw = match[2] ?? ""
		const value = raw === "true" ? "1" : raw === "false" ? "0" : raw

		if (name === "sqref" || name.startsWith("xmlns") || DV_DEFAULTS[name] === value) continue

		attributes.push(`${name}=${value}`)
	}

	return JSON.stringify([attributes.sort(), FORMULA1.exec(markup)?.[1] ?? "", FORMULA2.exec(markup)?.[1] ?? ""])
}

export interface OdsFeatureParts {
	readonly sheets: OdsSheetFeatures[]
	readonly definedNames: XlsxDefinedName[]
	readonly parts: Map<string, Uint8Array>
}

function section(name: string, markup: string): XlsxSection {
	return { name, start: 0, end: 0, bytes: encoder.encode(markup) }
}

function cellRef(row: number, col: number): string {
	return `${columnText(col)}${row + 1}`
}

function rangeRef(startRow: number, startCol: number, endRow: number, endCol: number): string {
	return startRow === endRow && startCol === endCol
		? cellRef(startRow, startCol)
		: `${cellRef(startRow, startCol)}:${cellRef(endRow, endCol)}`
}

// A formula's top-level arguments ("a;b", quotes, brackets and parentheses respected).
function splitArguments(text: string): string[] {
	const out: string[] = []
	let depth = 0
	let quoted = false
	let bracket = false
	let start = 0

	for (let k = 0; k < text.length; k++) {
		const c = text[k]

		if (c === '"') quoted = !quoted
		else if (quoted) continue
		else if (c === "[") bracket = true
		else if (c === "]") bracket = false
		else if (bracket) continue
		else if (c === "(" || c === "{") depth++
		else if (c === ")" || c === "}") depth--
		else if ((c === ";" || c === ",") && depth === 0) {
			out.push(text.slice(start, k).trim())
			start = k + 1
		}
	}

	out.push(text.slice(start).trim())

	return out
}

// The formula grammar prefix of a condition ("of:", "oooc:"), dropped.
function withoutNamespace(text: string): string {
	return text.replace(/^(?:of|oooc|msoxl):/, "").trim()
}

function expression(text: string, shift?: ReferenceShift): string | null {
	const translated = translateExpression(text, shift)

	return "text" in translated ? translated.text : null
}

// The move from a condition's base cell (§19.584), which its relative references are relative to, to the cell at
// `row`, `col` that SpreadsheetML resolves them against (the top-left of the range): undefined when there is none.
function baseShift(base: string | undefined, row: number, col: number): ReferenceShift | undefined {
	const cell = base === undefined ? null : cellAddress(base)

	if (cell === null || (cell.row === row && cell.col === col)) return undefined

	return { rows: row - cell.row, cols: col - cell.col }
}

// --- Notes ---

// Copies of annotations a workbook may show, and the text they come to: a repeated annotated cell is one note per
// copy in SpreadsheetML (a comment names one cell), so a short file could otherwise ask for millions. Past either the
// workbook is refused ("tooLarge"), never shown with notes missing.
const MAX_NOTE_CELLS = 262_144
const MAX_NOTE_BYTES = 64 * 1024 * 1024

interface NoteBudget {
	cells: number
	bytes: number
}

function commentsPart(
	notes: readonly OdsCellNote[],
	prefixes: ReadonlyMap<string, string>,
	issues: OdsIssues,
	sheet: string,
	budget: NoteBudget
): Uint8Array | null {
	const authors: string[] = []
	const comments: string[] = []

	for (const note of notes) {
		const copies = (note.endRow - note.row + 1) * (note.endCol - note.col + 1)

		budget.cells -= copies

		if (budget.cells < 0) throw new OdsReadError("tooLarge", "The workbook holds more notes than the limit")

		let text: string
		let author = ""

		// Read once for all its copies.
		try {
			const captured = parseCaptured(note.markup, prefixes)

			text = capturedText(captured, new Set(["dc:creator", "dc:date", "meta:date-string", "text:list-header"]))

			for (
				let child = captured.document.firstChildElement(captured.node);
				child >= 0;
				child = captured.document.nextSiblingElement(child)
			) {
				if (
					captured.namespaces.elementUri(child) === "http://purl.org/dc/elements/1.1/" &&
					captured.document.localName(child) === "creator"
				) {
					author = captured.document.textContent(child)
				}
			}
		} catch {
			issues.add("drawing", sheet, "annotation")

			continue
		}

		const body = escapeText(text)

		budget.bytes -= copies * (body.length + 64)

		if (budget.bytes < 0) throw new OdsReadError("tooLarge", "The workbook holds more notes than the limit")

		let id = authors.indexOf(author)

		if (id < 0) {
			id = authors.length
			authors.push(author)
		}

		const tail = `" authorId="${id}"><text><t xml:space="preserve">${body}</t></text></comment>`

		for (let row = note.row; row <= note.endRow; row++) {
			for (let col = note.col; col <= note.endCol; col++) comments.push(`<comment ref="${cellRef(row, col)}${tail}`)
		}
	}

	if (comments.length === 0) return null

	return encoder.encode(
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="${MAIN}"><authors>${authors
			.map(author => `<author>${escapeText(author)}</author>`)
			.join("")}</authors><commentList>${comments.join("")}</commentList></comments>`
	)
}

// --- Links ---

// A link target as SpreadsheetML holds it: a place in the workbook (location) or an external target; undefined for a
// place whose percent-encoding is malformed (the cell keeps its text, without the link).
function linkTarget(href: string): { location: string } | { external: string } | null | undefined {
	if (href.startsWith("#")) {
		let place: string

		try {
			place = decodeURIComponent(href.slice(1))
		} catch {
			return undefined
		}

		// "#Sheet2.A1" and "#Sheet2!A1" name a cell; anything else is a name or a range of the workbook.
		const dot = place.lastIndexOf(".")
		const bang = place.lastIndexOf("!")

		if (bang > 0) return { location: place }
		if (dot > 0 && /^\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/.test(place.slice(dot + 1))) {
			const sheet = place
				.slice(0, dot)
				.replace(/^\$/, "")
				.replace(/^'(.*)'$/, "$1")

			return { location: `${sheetRef(sheet)}${place.slice(dot + 1)}` }
		}

		return { location: place }
	}

	return href === "" ? null : { external: href }
}

// --- Validations ---

const OPERATORS: Readonly<Record<string, string>> = {
	"=": "equal",
	"!=": "notEqual",
	"<>": "notEqual",
	"<": "lessThan",
	"<=": "lessThanOrEqual",
	">": "greaterThan",
	">=": "greaterThanOrEqual"
}

interface ValidationRule {
	readonly type: string
	readonly operator: string
	readonly formula1: string | null
	readonly formula2: string | null
}

// table:condition (ODF 1.3 Part 3 §19.618) as a validation type, operator and formulas.
function validationRule(condition: string, shift?: ReferenceShift): ValidationRule | string {
	const text = withoutNamespace(condition)
	const list = /^cell-content-is-in-list\((.*)\)$/s.exec(text)

	if (list !== null) {
		const items = splitArguments(list[1] ?? "")

		// One item that is no string or number constant: an expression giving the list (a range, a name, §19.618).
		const only = (items[0] ?? "").trim()

		if (items.length === 1 && (only.startsWith("[") || (!only.startsWith('"') && only !== "" && Number.isNaN(Number(only))))) {
			const range = expression(only, shift)

			return range === null ? "list range" : { type: "list", operator: "between", formula1: range, formula2: null }
		}

		const values: string[] = []

		for (const item of items) {
			const match = /^"((?:[^"]|"")*)"$/.exec(item)
			const value = match === null ? item : (match[1] ?? "").replaceAll('""', '"')

			if (value.includes(",")) return "list item with a comma"

			values.push(value)
		}

		return { type: "list", operator: "between", formula1: `"${values.join(",").replaceAll('"', '""')}"`, formula2: null }
	}

	const truth = /^is-true-formula\((.*)\)$/s.exec(text)

	if (truth !== null) {
		const formula = expression(truth[1] ?? "", shift)

		return formula === null ? "formula" : { type: "custom", operator: "between", formula1: formula, formula2: null }
	}

	const length = /^cell-content-text-length\(\)\s*(<=|>=|!=|<>|<|>|=)\s*(.*)$/s.exec(text)

	if (length !== null) {
		const value = expression(length[2] ?? "", shift)

		return value === null
			? "value"
			: { type: "textLength", operator: OPERATORS[length[1] ?? "="] ?? "equal", formula1: value, formula2: null }
	}

	const lengthBetween = /^cell-content-text-length-is-(not-)?between\((.*)\)$/s.exec(text)

	if (lengthBetween !== null) return between("textLength", lengthBetween[1] !== undefined, lengthBetween[2] ?? "", shift)

	const typed = /^cell-content-is-(whole-number|decimal-number|date|time)\(\)\s+and\s+(.*)$/s.exec(text)

	if (typed !== null) {
		const type =
			{ "whole-number": "whole", "decimal-number": "decimal", date: "date", time: "time" }[typed[1] as "whole-number"] ?? "whole"
		const rest = typed[2] ?? ""
		const compare = /^cell-content\(\)\s*(<=|>=|!=|<>|<|>|=)\s*(.*)$/s.exec(rest)

		if (compare !== null) {
			const value = expression(compare[2] ?? "", shift)

			return value === null ? "value" : { type, operator: OPERATORS[compare[1] ?? "="] ?? "equal", formula1: value, formula2: null }
		}

		const range = /^cell-content-is-(not-)?between\((.*)\)$/s.exec(rest)

		if (range !== null) return between(type, range[1] !== undefined, range[2] ?? "", shift)
	}

	return "condition"
}

function between(type: string, negated: boolean, args: string, shift?: ReferenceShift): ValidationRule | string {
	const [low = "", high = ""] = splitArguments(args)
	const formula1 = expression(low, shift)
	const formula2 = expression(high, shift)

	if (formula1 === null || formula2 === null) return "value"

	return { type, operator: negated ? "notBetween" : "between", formula1, formula2 }
}

// `ordered`: the message's text in document order, where it was captured so.
function messageOf(element: OdfElement | undefined, ordered?: string): { title: string; text: string; display: boolean; kind: string } {
	if (element === undefined) return { title: "", text: "", display: false, kind: "stop" }

	const text =
		ordered ??
		element.children
			.filter(child => child.name === "text:p")
			.map(child => paragraphText(child))
			.join("\n")

	return {
		title: element.attributes.get("table:title") ?? "",
		text,
		display: element.attributes.get("table:display") === "true",
		kind: element.attributes.get("table:message-type") ?? "stop"
	}
}

function paragraphText(paragraph: OdfElement): string {
	let text = paragraph.text

	for (const child of paragraph.children) {
		if (child.name === "text:s") text += " ".repeat(Math.max(1, Number(child.attributes.get("text:c") ?? "1") || 1))
		else if (child.name === "text:tab") text += "\t"
		else if (child.name === "text:line-break") text += "\n"
		else text += paragraphText(child)
	}

	return text
}

// Validations worked through between yields.
const VALIDATIONS_PER_STEP = 256

function* validationsSection(
	table: OdsTable,
	validations: OdfElement | undefined,
	messages: ReadonlyMap<string, { readonly help: string; readonly error: string }>,
	issues: OdsIssues,
	names: Map<string, string>,
	unheld: UnheldCollector | undefined
): Generator<void, string | null> {
	const used = table.built.validations

	if (used.size === 0 || validations === undefined) return null

	const byName = new Map<string, OdfElement>()

	for (const child of validations.children) {
		const name = child.attributes.get("table:name")

		if (child.name === "table:content-validation" && name !== undefined) byName.set(name, child)
	}

	const out: string[] = []

	let step = 0

	for (const [name, rects] of used) {
		if (++step % VALIDATIONS_PER_STEP === 0) yield

		const validation = byName.get(name)

		if (validation === undefined) continue

		const condition = validation.attributes.get("table:condition")
		// SpreadsheetML's formulas are for the top-left cell of the rectangle around the ranges.
		const rule: ValidationRule | string =
			condition === undefined
				? { type: "none", operator: "between", formula1: null, formula2: null }
				: validationRule(
						condition,
						rects.length === 0
							? undefined
							: baseShift(
									validation.attributes.get("table:base-cell-address"),
									minOf(rects.map(rect => rect[0])),
									minOf(rects.map(rect => rect[1]))
								)
					)

		if (typeof rule === "string") {
			issues.add("validation", table.name, rule)
			// Kept as written: its base cell and the cells its condition reads (on any sheet) are not moved with them.
			unheld?.makeOpaque("validation")

			continue
		}

		const ordered = messages.get(name)
		const help = messageOf(
			validation.children.find(child => child.name === "table:help-message"),
			ordered?.help
		)
		const error = messageOf(
			validation.children.find(child => child.name === "table:error-message"),
			ordered?.error
		)

		if (validation.children.some(child => child.name === "table:error-macro")) issues.add("validation", table.name, "error macro")

		const display = validation.attributes.get("table:display-list")

		if (display === "sort-ascending") issues.add("validation", table.name, "sorted list")

		const sqref = rects.map(([startRow, startCol, endRow, endCol]) => rangeRef(startRow, startCol, endRow, endCol)).join(" ")
		const attributes = [
			`type="${rule.type}"`,
			rule.operator === "between" ? "" : `operator="${rule.operator}"`,
			validation.attributes.get("table:allow-empty-cell") === "false" ? "" : 'allowBlank="1"',
			rule.type === "list" && display === "none" ? 'showDropDown="1"' : "",
			help.display ? 'showInputMessage="1"' : "",
			error.display ? 'showErrorMessage="1"' : "",
			error.kind === "warning" || error.kind === "information" ? `errorStyle="${error.kind}"` : "",
			error.title === "" ? "" : `errorTitle="${escapeAttribute(error.title)}"`,
			error.text === "" ? "" : `error="${escapeAttribute(error.text)}"`,
			help.title === "" ? "" : `promptTitle="${escapeAttribute(help.title)}"`,
			help.text === "" ? "" : `prompt="${escapeAttribute(help.text)}"`,
			`sqref="${sqref}"`
		].filter(part => part !== "")

		const element = `<dataValidation ${attributes.join(" ")}>${rule.formula1 === null ? "" : `<formula1>${escapeText(rule.formula1)}</formula1>`}${rule.formula2 === null ? "" : `<formula2>${escapeText(rule.formula2)}</formula2>`}</dataValidation>`

		if (!names.has(validationRuleKey(element))) names.set(validationRuleKey(element), name)

		out.push(element)
	}

	return out.length === 0 ? null : `<dataValidations xmlns="${MAIN}" count="${out.length}">${out.join("")}</dataValidations>`
}

// --- Filters ---

interface TargetRange {
	readonly sheet: string
	readonly ref: string
	readonly firstCol: number
}

// "Sheet1.A1:Sheet1.D20" as the sheet it is on and its A1 text.
function targetRange(address: string): TargetRange | null {
	const translated = rangeAddress(address)

	if ("refused" in translated) return null

	const text = translated.text
	const bang = text.lastIndexOf("!")

	if (bang < 0) return null

	const sheet = text
		.slice(0, bang)
		.replace(/^'(.*)'$/, "$1")
		.replaceAll("''", "'")
	const ref = text.slice(bang + 1).replaceAll("$", "")
	const column = /^([A-Z]{1,3})/.exec(ref)?.[1] ?? "A"
	let firstCol = 0

	for (const letter of column) firstCol = firstCol * 26 + (letter.charCodeAt(0) - 64)

	return { sheet, ref, firstCol: firstCol - 1 }
}

const FILTER_OPERATORS: Readonly<Record<string, string>> = {
	"=": "equal",
	"!=": "notEqual",
	"<": "lessThan",
	"<=": "lessThanOrEqual",
	">": "greaterThan",
	">=": "greaterThanOrEqual"
}

// table:filter (§9.5.2) as filterColumn elements; null where a criterion has no SpreadsheetML form.
function filterColumns(filter: OdfElement | undefined, table: string, issues: OdsIssues): string {
	if (filter === undefined) return ""

	const conditions: OdfElement[] = []
	const collect = (element: OdfElement): void => {
		for (const child of element.children) {
			if (child.name === "table:filter-condition") conditions.push(child)
			else collect(child)
		}
	}

	collect(filter)

	const byField = new Map<number, OdfElement[]>()

	for (const condition of conditions) {
		const field = Number(condition.attributes.get("table:field-number") ?? "0")
		const list = byField.get(field) ?? []

		list.push(condition)
		byField.set(field, list)
	}

	const out: string[] = []

	for (const [field, list] of byField) {
		const equal = list.every(condition => (condition.attributes.get("table:operator") ?? "=") === "=")

		if (equal) {
			const values = list.flatMap(condition => {
				const set = condition.children
					.filter(child => child.name === "table:filter-set-item")
					.map(child => child.attributes.get("table:value") ?? "")

				return set.length > 0 ? set : [condition.attributes.get("table:value") ?? ""]
			})

			out.push(
				`<filterColumn colId="${field}"><filters>${values.map(value => `<filter val="${escapeAttribute(value)}"/>`).join("")}</filters></filterColumn>`
			)

			continue
		}

		const custom = list.map(condition => {
			const operator = FILTER_OPERATORS[condition.attributes.get("table:operator") ?? ""]

			return operator === undefined
				? null
				: `<customFilter operator="${operator}" val="${escapeAttribute(condition.attributes.get("table:value") ?? "")}"/>`
		})

		if (custom.some(entry => entry === null) || custom.length > 2) {
			issues.add("filter", table, list.map(condition => condition.attributes.get("table:operator") ?? "").join(","))

			continue
		}

		out.push(
			`<filterColumn colId="${field}"><customFilters${filter.children[0]?.name === "table:filter-and" ? ' and="1"' : ""}>${custom.join("")}</customFilters></filterColumn>`
		)
	}

	return out.join("")
}

// --- Conditional formats ---

const CF_OPERATORS: Readonly<Record<string, string>> = {
	"=": "equal",
	"!=": "notEqual",
	"<": "lessThan",
	"<=": "lessThanOrEqual",
	">": "greaterThan",
	">=": "greaterThanOrEqual"
}

const ICON_SETS: ReadonlySet<string> = new Set([
	"3Arrows",
	"3ArrowsGray",
	"3Flags",
	"3TrafficLights1",
	"3TrafficLights2",
	"3Signs",
	"3Symbols",
	"3Symbols2",
	"4Arrows",
	"4ArrowsGray",
	"4RedToBlack",
	"4Rating",
	"4TrafficLights",
	"5Arrows",
	"5ArrowsGray",
	"5Rating",
	"5Quarters"
])

// LibreOffice's calcext:date names to ST_TimePeriod (§18.18.82).
export const DATES: Readonly<Record<string, string>> = {
	today: "today",
	yesterday: "yesterday",
	tomorrow: "tomorrow",
	"last-7-days": "last7Days",
	"this-week": "thisWeek",
	"last-week": "lastWeek",
	"next-week": "nextWeek",
	"this-month": "thisMonth",
	"last-month": "lastMonth",
	"next-month": "nextMonth"
}

function argb(color: string | undefined): string | null {
	const rgb = parseColor(color)

	return rgb === undefined ? null : ((0xff000000 | rgb) >>> 0).toString(16).toUpperCase().padStart(8, "F")
}

// A conditional format's entry type and value (calcext:type, calcext:value) as a cfvo.
function cfvo(entry: OdfElement): string {
	const type = entry.attributes.get("calcext:type") ?? "number"
	const value = entry.attributes.get("calcext:value") ?? "0"

	switch (type) {
		case "minimum":
		case "auto-minimum":
			return '<cfvo type="min"/>'
		case "maximum":
		case "auto-maximum":
			return '<cfvo type="max"/>'
		case "percentile":
			return `<cfvo type="percentile" val="${escapeAttribute(value)}"/>`
		case "percent":
			return `<cfvo type="percent" val="${escapeAttribute(value)}"/>`
		case "formula":
			return `<cfvo type="formula" val="${escapeAttribute(expression(value) ?? "0")}"/>`
		default:
			return `<cfvo type="num" val="${escapeAttribute(value)}"/>`
	}
}

// A cell style as a dxf: the properties it sets over the default cell style.
function dxfOf(styles: OdsCellStyles, name: string): XlsxDxf {
	const resolved = styles.resolved(name)
	const chain = resolved.chain.filter(style => !style.isDefault && style.name !== "Default")
	const has = (kind: string, attribute: string): boolean =>
		chain.some(style => style.properties.get(kind)?.attributes.has(attribute) === true)
	const dxf: { -readonly [K in keyof XlsxDxf]: XlsxDxf[K] } = {}
	const font = styles.font(resolved)
	const own: Record<string, unknown> = {}

	if (has("text", "fo:font-weight") && font.bold === true) own["bold"] = true
	if (has("text", "fo:font-style") && font.italic === true) own["italic"] = true
	if (has("text", "fo:color") && font.color !== undefined) own["color"] = font.color
	if (has("text", "style:text-underline-style") && font.underline !== undefined) own["underline"] = font.underline
	if (has("text", "style:text-line-through-style") && font.strike === true) own["strike"] = true
	if (Object.keys(own).length > 0) dxf.font = own

	const fill = styles.fill(resolved.properties("table-cell"))

	if (fill !== undefined && has("table-cell", "fo:background-color") && fill.kind === "pattern") {
		dxf.fill = { kind: "pattern", pattern: "solid", ...(fill.fg !== undefined && { bg: fill.fg, fg: fill.fg }) }
	}

	const border = styles.border(resolved.properties("table-cell"))

	if (
		Object.keys(border).length > 0 &&
		chain.some(style => [...(style.properties.get("table-cell")?.attributes.keys() ?? [])].some(key => key.startsWith("fo:border")))
	) {
		dxf.border = border
	}

	return dxf
}

// A table's calcext:conditional-formats as its conditionalFormatting sections, their looks as dxfs.
export function conditionalSections(formats: readonly OdfElement[], tableName: string, styles: OdsCellStyles, issues: OdsIssues): string[] {
	const out: string[] = []
	let priority = 1

	for (const container of formats) {
		for (const format of container.children) {
			if (format.name !== "calcext:conditional-format") continue

			const target = rangeAddresses(format.attributes.get("calcext:target-range-address") ?? "")

			if ("refused" in target) {
				issues.add("conditionalFormat", tableName, "target range")

				continue
			}

			const sqref = target.parts.map(part => withoutSheet(part).replaceAll("$", "")).join(" ")
			const rules: string[] = []
			// The top-left cell of the rectangle around the ranges, which SpreadsheetML's formulas are for (a whole column
			// starts at row 1, a whole row at column A).
			const corners = sqref.split(" ").map(item => /^([A-Z]{0,3})(\d*)$/.exec(item.split(":")[0] ?? ""))
			const originRow = Math.max(0, minOf(corners.map(corner => Number(corner?.[2] || "1") - 1)))
			const originCol = Math.max(
				0,
				minOf(
					corners.map(
						corner => [...(corner?.[1] || "A")].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1
					)
				)
			)
			const first = cellRef(originRow, originCol)

			for (const rule of format.children) {
				const shift =
					rule.name === "calcext:condition"
						? baseShift(rule.attributes.get("calcext:base-cell-address"), originRow, originCol)
						: undefined
				const markup = cfRule(rule, styles, issues, tableName, priority, first, shift)

				if (markup !== null) {
					rules.push(markup)
					priority++
				}
			}

			if (rules.length > 0)
				out.push(`<conditionalFormatting xmlns="${MAIN}" sqref="${sqref}">${rules.join("")}</conditionalFormatting>`)
		}
	}

	return out
}

function cfRule(
	rule: OdfElement,
	styles: OdsCellStyles,
	issues: OdsIssues,
	table: string,
	priority: number,
	first: string,
	shift: ReferenceShift | undefined
): string | null {
	const dxfId = (name: string | undefined): number => (name === undefined ? -1 : styles.table.appendDxf(dxfOf(styles, name)))

	switch (rule.name) {
		case "calcext:condition": {
			const value = (rule.attributes.get("calcext:value") ?? "").trim()
			const dxf = dxfId(rule.attributes.get("calcext:apply-style-name"))
			const head = `priority="${priority}" dxfId="${dxf}"`
			const compare = /^(<=|>=|!=|<|>|=)(.*)$/s.exec(value)

			if (compare !== null) {
				const formula = expression(compare[2] ?? "", shift)

				if (formula !== null)
					return `<cfRule type="cellIs" ${head} operator="${CF_OPERATORS[compare[1] ?? "="] ?? "equal"}"><formula>${escapeText(formula)}</formula></cfRule>`
			}

			const range = /^(not-)?between\((.*)\)$/s.exec(value)

			if (range !== null) {
				const [low = "", high = ""] = splitArguments(range[2] ?? "")
				const formula1 = expression(low, shift)
				const formula2 = expression(high, shift)

				if (formula1 !== null && formula2 !== null) {
					return `<cfRule type="cellIs" ${head} operator="${range[1] === undefined ? "between" : "notBetween"}"><formula>${escapeText(formula1)}</formula><formula>${escapeText(formula2)}</formula></cfRule>`
				}
			}

			const formula = /^formula-is\((.*)\)$/s.exec(value)

			if (formula !== null) {
				const text = expression(formula[1] ?? "", shift)

				if (text !== null) return `<cfRule type="expression" ${head}><formula>${escapeText(text)}</formula></cfRule>`
			}

			const textRule = /^(begins-with|ends-with|contains-text|not-contains-text)\((.*)\)$/s.exec(value)

			if (textRule !== null) {
				const literal = /^"((?:[^"]|"")*)"$/.exec((textRule[2] ?? "").trim())?.[1]?.replaceAll('""', '"')

				if (literal !== undefined) {
					const quoted = `"${literal.replaceAll('"', '""')}"`
					const rules: Readonly<Record<string, readonly [string, string, string]>> = {
						"begins-with": ["beginsWith", "beginsWith", `LEFT(${first},LEN(${quoted}))=${quoted}`],
						"ends-with": ["endsWith", "endsWith", `RIGHT(${first},LEN(${quoted}))=${quoted}`],
						"contains-text": ["containsText", "containsText", `NOT(ISERROR(SEARCH(${quoted},${first})))`],
						"not-contains-text": ["notContainsText", "notContains", `ISERROR(SEARCH(${quoted},${first}))`]
					}
					const [type, operator, check] = rules[textRule[1] ?? ""] ?? ["containsText", "containsText", ""]

					return `<cfRule type="${type}" ${head} operator="${operator}" text="${escapeAttribute(literal)}"><formula>${escapeText(check)}</formula></cfRule>`
				}
			}

			const ranked = /^(top|bottom)-(elements|percent)\((\d+)\)$/.exec(value)

			if (ranked !== null) {
				return `<cfRule type="top10" ${head}${ranked[1] === "bottom" ? ' bottom="1"' : ""}${ranked[2] === "percent" ? ' percent="1"' : ""} rank="${ranked[3]}"/>`
			}

			switch (value) {
				case "duplicate":
					return `<cfRule type="duplicateValues" ${head}/>`
				case "unique":
					return `<cfRule type="uniqueValues" ${head}/>`
				case "above-average":
					return `<cfRule type="aboveAverage" ${head}/>`
				case "below-average":
					return `<cfRule type="aboveAverage" ${head} aboveAverage="0"/>`
				case "above-equal-average":
					return `<cfRule type="aboveAverage" ${head} equalAverage="1"/>`
				case "below-equal-average":
					return `<cfRule type="aboveAverage" ${head} aboveAverage="0" equalAverage="1"/>`
				case "error":
					return `<cfRule type="containsErrors" ${head}><formula>ISERROR(${first})</formula></cfRule>`
				case "no-error":
					return `<cfRule type="notContainsErrors" ${head}><formula>NOT(ISERROR(${first}))</formula></cfRule>`
			}

			issues.add("conditionalFormat", table, value.slice(0, 40))

			return null
		}
		case "calcext:color-scale": {
			const entries = rule.children.filter(child => child.name === "calcext:color-scale-entry")

			if (entries.length < 2 || entries.length > 3) {
				issues.add("conditionalFormat", table, "color scale")

				return null
			}

			return `<cfRule type="colorScale" priority="${priority}"><colorScale>${entries.map(cfvo).join("")}${entries
				.map(entry => `<color rgb="${argb(entry.attributes.get("calcext:color")) ?? "FF000000"}"/>`)
				.join("")}</colorScale></cfRule>`
		}
		case "calcext:data-bar": {
			const entries = rule.children.filter(child => child.name === "calcext:formatting-entry")

			if (entries.length !== 2) {
				issues.add("conditionalFormat", table, "data bar")

				return null
			}

			return `<cfRule type="dataBar" priority="${priority}"><dataBar>${entries.map(cfvo).join("")}<color rgb="${argb(rule.attributes.get("calcext:positive-color")) ?? "FF638EC6"}"/></dataBar></cfRule>`
		}
		case "calcext:icon-set": {
			const type = rule.attributes.get("calcext:icon-set-type") ?? ""
			const entries = rule.children.filter(child => child.name === "calcext:formatting-entry")

			if (!ICON_SETS.has(type)) {
				issues.add("conditionalFormat", table, `icon set ${type}`)

				return null
			}

			return `<cfRule type="iconSet" priority="${priority}"><iconSet iconSet="${type}"${rule.attributes.get("calcext:show-value") === "false" ? ' showValue="0"' : ""}>${entries.map(cfvo).join("")}</iconSet></cfRule>`
		}
		case "calcext:date-is": {
			const period = DATES[rule.attributes.get("calcext:date") ?? ""]

			if (period === undefined) {
				issues.add("conditionalFormat", table, `date ${rule.attributes.get("calcext:date") ?? ""}`)

				return null
			}

			return `<cfRule type="timePeriod" priority="${priority}" dxfId="${dxfId(rule.attributes.get("calcext:style"))}" timePeriod="${period}"/>`
		}
		default:
			issues.add("conditionalFormat", table, rule.name)

			return null
	}
}

// --- The whole ---

const CONTENT_TYPES_START =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
	'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
	'<Default Extension="xml" ContentType="application/xml"/>'

function relationshipsPart(relationships: readonly { id: string; type: string; target: string; external: boolean }[]): Uint8Array {
	return encoder.encode(
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships
			.map(
				relationship =>
					`<Relationship Id="${relationship.id}" Type="${relationship.type}" Target="${escapeAttribute(relationship.target)}"${relationship.external ? ' TargetMode="External"' : ""}/>`
			)
			.join("")}</Relationships>`
	)
}

// A named expression's or range's key among the unheld (unheld.ts): its scope (a table's index, "" for the
// workbook's), its name in upper case and the attribute.
export function nameKey(sheet: number | null, name: string, attribute: string): string {
	return `name\u0000${sheet ?? ""}\u0000${name.toUpperCase()}\u0000${attribute}`
}

// A database range the model does not hold: its range and its filter's output address. Its filter, sort and
// subtotal rules name columns by their position in it (table:field-number), so it moves only whole.
function databaseRangeAddresses(range: OdfElement, unheld: UnheldCollector): void {
	const name = range.attributes.get("table:name") ?? ""
	const positional = (element: OdfElement): boolean =>
		element.children.some(
			child => child.attributes.has("table:field-number") || child.attributes.has("table:group-by-field-number") || positional(child)
		)
	const target = range.attributes.get("table:target-range-address")

	if (target !== undefined) unheld.element(positional(range) ? "fields" : "address", `db\u0000${name}\u0000target-range-address`, target)

	const walk = (element: OdfElement, path: string): void => {
		element.children.forEach((child, index) => {
			const output = child.attributes.get("table:condition-source-range-address")

			if (output !== undefined)
				unheld.element("address", `db\u0000${name}\u0000${path}/${index}\u0000condition-source-range-address`, output)

			walk(child, `${path}/${index}`)
		})
	}

	walk(range, "")
}

// featureParts as steps: it yields between sheets and every VALIDATIONS_PER_STEP validations, so a sliced open gives
// the host its turns.
export function* featurePartsSteps(
	content: OdsContent,
	styles: OdsCellStyles,
	issues: OdsIssues,
	prefixes: ReadonlyMap<string, string>,
	charts: OdsChartParts = NO_CHARTS,
	unheld?: UnheldCollector
): Generator<void, OdsFeatureParts> {
	const parts = new Map<string, Uint8Array>(charts.parts)
	const overrides: string[] = [...charts.overrides]
	const definedNames: XlsxDefinedName[] = []
	const sheetIndex = new Map(content.tables.map((table, index) => [table.name, index]))
	const filters = new Map<number, string>()
	const noteBudget: NoteBudget = { cells: MAX_NOTE_CELLS, bytes: MAX_NOTE_BYTES }

	// Database ranges: one with filter buttons is its sheet's autofilter.
	for (const range of content.databaseRanges?.children ?? []) {
		if (range.name !== "table:database-range") continue

		const target = targetRange(range.attributes.get("table:target-range-address") ?? "")
		const name = range.attributes.get("table:name") ?? ""

		if (target === null) {
			issues.add("filter", undefined, "target range")

			if (unheld !== undefined) databaseRangeAddresses(range, unheld)

			continue
		}

		const index = sheetIndex.get(target.sheet)

		// A named database range is no defined name: formulas reading it (DGET) keep their results.
		if (index !== undefined && !name.startsWith("__Anonymous_Sheet_DB__")) issues.add("name", target.sheet, `database range ${name}`)

		if (index === undefined || range.attributes.get("table:display-filter-buttons") !== "true" || filters.has(index)) {
			if (unheld !== undefined) databaseRangeAddresses(range, unheld)

			continue
		}

		const filter = range.children.find(child => child.name === "table:filter")

		filters.set(index, `<autoFilter xmlns="${MAIN}" ref="${target.ref}">${filterColumns(filter, target.sheet, issues)}</autoFilter>`)
		definedNames.push({
			name: "_xlnm._FilterDatabase",
			sheet: index,
			formula: `${sheetRef(target.sheet)}${target.ref.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}`,
			hidden: true,
			source: null
		})
	}

	// Named ranges and expressions, the workbook's and each sheet's own.
	const names = (container: OdfElement, sheet: number | null, table: string | undefined): void => {
		for (const named of container.children) {
			const name = named.attributes.get("table:name")

			if (name === undefined) continue

			let formula: string | null = null

			if (named.name === "table:named-range") {
				const translated = rangeAddress(named.attributes.get("table:cell-range-address") ?? "")

				formula = "text" in translated ? translated.text : null
			} else if (named.name === "table:named-expression") {
				const translated = expression(withoutNamespace(named.attributes.get("table:expression") ?? "").replace(/^=/, ""))

				formula = translated
			} else {
				continue
			}

			if (formula === null) {
				issues.add("name", table, name)

				const kept = named.name === "table:named-range" ? "cell-range-address" : "expression"
				const text = named.attributes.get(`table:${kept}`)

				if (text !== undefined) unheld?.element("name", nameKey(sheet, name, kept), text)

				continue
			}

			// Relative references are relative to table:base-cell-address, which a defined name does not carry.
			if (/(^|[^$A-Za-z])[A-Z]{1,3}\d/.test(formula.replace(/"[^"]*"/g, "")) && named.attributes.has("table:base-cell-address")) {
				const base = named.attributes.get("table:base-cell-address") ?? ""

				if (!/\.\$?A\$?1$/.test(base)) issues.add("name", table, `${name}: relative to ${base}`)
			}

			definedNames.push({ name, sheet, formula, hidden: named.attributes.get("table:hidden") === "true", source: null })
		}
	}

	for (const container of content.names) names(container, null, undefined)

	const sheets: OdsSheetFeatures[] = []

	for (const [index, table] of content.tables.entries()) {
		yield

		for (const container of table.names) names(container, index, table.name)

		const sections: XlsxSection[] = []
		const relationships: { id: string; type: string; target: string; external: boolean }[] = []
		const comments = commentsPart(table.built.notes, prefixes, issues, table.name, noteBudget)

		if (comments !== null) {
			const part = `xl/comments${index + 1}.xml`

			parts.set(part, comments)
			overrides.push(`<Override PartName="/${part}" ContentType="${COMMENTS_CONTENT}"/>`)
			relationships.push({
				id: `rId${relationships.length + 1}`,
				type: COMMENTS_TYPE,
				target: `../comments${index + 1}.xml`,
				external: false
			})
		}

		const links = hyperlinks(table.built.links, relationships, table.name)

		if (links !== null) sections.push(section("hyperlinks", links))

		const filter = filters.get(index)

		if (filter !== undefined) sections.push(section("autoFilter", filter))

		for (const markup of conditionalSections(table.conditionalFormats, table.name, styles, issues))
			sections.push(section("conditionalFormatting", markup))

		const validationNames = new Map<string, string>()
		const validations = yield* validationsSection(
			table,
			content.validations,
			content.validationMessages,
			issues,
			validationNames,
			unheld
		)

		if (validations !== null) sections.push(section("dataValidations", validations))

		// The sheet's charts: their drawing's relationship after the others, its section in schema order.
		const sheetCharts = charts.sheets.get(index)

		if (sheetCharts !== undefined) {
			const ids: string[] = []

			for (const relationship of sheetCharts.relationships) {
				const id = `rId${relationships.length + 1}`

				ids.push(id)
				relationships.push({ id, type: relationship.type, target: relationship.target, external: false })
			}

			appendAll(sections, sheetCharts.sections(ids))
		}

		const relationshipsName = `xl/worksheets/_rels/sheet${index + 1}.xml.rels`
		const bytes = relationshipsPart(relationships)

		parts.set(relationshipsName, bytes)

		sheets.push({ sections, relationships: [...parseRelationships(bytes, `xl/worksheets/sheet${index + 1}.xml`).all], validationNames })
	}

	parts.set("[Content_Types].xml", encoder.encode(`${CONTENT_TYPES_START}${overrides.join("")}</Types>`))

	return { sheets, definedNames, parts }

	function hyperlinks(
		list: readonly OdsCellLink[],
		relationships: { id: string; type: string; target: string; external: boolean }[],
		sheetName: string
	): string | null {
		const out: string[] = []
		// One relationship per external target, however many cells link to it.
		const external = new Map<string, string>()

		for (const link of list) {
			const target = linkTarget(link.href)
			const ref = rangeRef(link.row, link.col, link.endRow, link.endCol)

			if (target === undefined) {
				issues.add("link", sheetName, `${ref}: malformed address`)

				continue
			}

			if (target === null) continue

			if ("location" in target) {
				out.push(`<hyperlink ref="${ref}" location="${escapeAttribute(target.location)}"/>`)
			} else {
				let id = external.get(target.external)

				if (id === undefined) {
					id = `rId${relationships.length + 1}`
					external.set(target.external, id)
					relationships.push({ id, type: HYPERLINK_TYPE, target: target.external, external: true })
				}

				out.push(`<hyperlink ref="${ref}" r:id="${id}"/>`)
			}
		}

		return out.length === 0 ? null : `<hyperlinks xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}">${out.join("")}</hyperlinks>`
	}
}
