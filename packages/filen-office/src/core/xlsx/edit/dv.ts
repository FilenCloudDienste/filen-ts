import { minOf } from "../../arrays"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetId, type SheetLocale, type SheetRange } from "../../sheet/protocol"
import type { SheetChangeSink, SheetHandled } from "../../sheet/registry"
import { numberText } from "../../sheet/cf/formula/values"
import type { SheetValidationRule } from "../../sheet/dv/xlsx"
import { unwritableText } from "../../sheet/numfmt/edit"
import { delocalizeFormula } from "../../sheet/input/locale"
import { formulaTranslator, wellFormedFormula } from "../../sheet/refs/formulaRefs"
import { decodeUtf8, encodeUtf8, escapeAttribute, escapeText, parseXml, XmlEditor, type XmlDocument } from "../../xml/index"
import { childByLocal, childElements } from "../read/styleRecords"
import { XlsxSheet } from "../read/worksheet"
import { RefRefused } from "../refs/catalogue"
import { formatSqref, parseSqref } from "../refs/sqref"
import { refState } from "../refs/state"
import { rootTag } from "../write/markup"
import type { XlsxSheetModel, XlsxWorkbookModel } from "../model/types"
import { readEntry } from "./cells"
import type { XlsxDocument } from "./document"

// Data validations set on cells and cleared (ECMA-376 Part 1 §18.3.1.32): the cells leave the validations they had
// (2007 and Excel 2010 ones alike, a rule whose top-left cell moves keeping its formulas for the cells they were for)
// and take the new one. The sections are written through the reference catalogue's state, so structure edits go on
// moving them.

const DV_EXT = "{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}"
// Excel's limits on a validation ("Apply data validation to cells", support.microsoft.com): a typed list of 255
// characters, input and error titles of 32, an input message of 255 and an error message of 225.
const MAX_LIST = 255
const MAX_TITLE = 32
const MAX_PROMPT = 255
const MAX_ERROR = 225
// Ranges one edit may name (Excel keeps the cells of a validation as a list of ranges).
const MAX_RANGES = 2_048

// The cells of `range` outside `cut`, as at most four rectangles.
function subtract(range: SheetRange, cut: SheetRange): SheetRange[] {
	if (cut.startRow > range.endRow || cut.endRow < range.startRow || cut.startCol > range.endCol || cut.endCol < range.startCol)
		return [range]

	const out: SheetRange[] = []

	if (range.startRow < cut.startRow) out.push({ ...range, endRow: cut.startRow - 1 })
	if (range.endRow > cut.endRow) out.push({ ...range, startRow: cut.endRow + 1 })

	const top = Math.max(range.startRow, cut.startRow)
	const bottom = Math.min(range.endRow, cut.endRow)

	if (range.startCol < cut.startCol) out.push({ startRow: top, endRow: bottom, startCol: range.startCol, endCol: cut.startCol - 1 })
	if (range.endCol > cut.endCol) out.push({ startRow: top, endRow: bottom, startCol: cut.endCol + 1, endCol: range.endCol })

	return out
}

function without(ranges: readonly SheetRange[], cuts: readonly SheetRange[]): SheetRange[] {
	let left = [...ranges]

	for (const cut of cuts) left = left.flatMap(range => subtract(range, cut))

	return left
}

function wrapped(markup: string): XmlDocument {
	return parseXml(encodeUtf8(`<sections>${markup}</sections>`))
}

function unwrapped(editor: XmlEditor): string {
	const text = decodeUtf8(editor.serialize())

	return text.slice(text.indexOf("<sections>") + "<sections>".length, text.lastIndexOf("</sections>"))
}

// The cell a range list's formulas are written for: the top-left cell of the rectangle around its ranges.
function anchorOf(ranges: readonly SheetRange[]): { readonly row: number; readonly col: number } {
	return { row: minOf(ranges.map(range => range.startRow)), col: minOf(ranges.map(range => range.startCol)) }
}

// A formula written for one cell, written again for another.
function moved(
	formula: string,
	from: { readonly row: number; readonly col: number },
	to: { readonly row: number; readonly col: number }
): string {
	return formulaTranslator(formula)(to.row - from.row, to.col - from.col)
}

// Rewrites a validation's ranges (and its formulas for a new first cell); false when none is left.
function cutRule(document: XmlDocument, editor: XmlEditor, node: number, sqrefNode: number | null, cuts: readonly SheetRange[]): boolean {
	const text = sqrefNode === null ? (document.attribute(node, "sqref") ?? "") : document.textContent(sqrefNode)
	const ranges = parseSqref(text)

	if (ranges === null || ranges.length === 0) return true

	const left = without(ranges, cuts)

	if (left.length === 0) return false
	if (left.length === ranges.length && left.every((range, i) => range === ranges[i])) return true

	if (sqrefNode === null) editor.setAttribute(node, "sqref", formatSqref(left))
	else editor.setText(sqrefNode, formatSqref(left))

	const first = anchorOf(ranges)
	const next = anchorOf(left)

	if (first.row !== next.row || first.col !== next.col) {
		for (const local of ["formula1", "formula2"]) {
			const formula = childByLocal(document, node, local)

			if (formula < 0) continue

			const f = childByLocal(document, formula, "f")
			const holder = f >= 0 ? f : formula

			editor.setText(holder, moved(document.textContent(holder), first, next))
		}
	}

	return true
}

// The 2007 validations without the cut cells, plus `added`: the section's new markup ("" for none).
function mainSection(markup: string, cuts: readonly SheetRange[], added: string | null, prefix: string): string {
	const tag = (name: string): string => (prefix === "" ? name : `${prefix}:${name}`)

	if (markup.trim() === "") return added === null ? "" : `<${tag("dataValidations")} count="1">${added}</${tag("dataValidations")}>`

	const document = wrapped(markup)
	const editor = new XmlEditor(document)
	const section = [...childElements(document, document.documentElement())].find(node => document.localName(node) === "dataValidations")

	if (section === undefined) return added === null ? markup : `<${tag("dataValidations")} count="1">${added}</${tag("dataValidations")}>`

	let count = 0

	for (const node of childElements(document, section)) {
		if (document.localName(node) !== "dataValidation") continue

		if (cutRule(document, editor, node, null, cuts)) count++
		else editor.remove(node)
	}

	if (added !== null) {
		editor.append(section, added)
		count++
	}

	if (count === 0) return ""

	editor.setAttribute(section, "count", String(count))

	return unwrapped(editor)
}

// The extLst with the cut cells out of its Excel 2010 validations ("" when nothing is left of it).
function extSection(markup: string, cuts: readonly SheetRange[]): string {
	if (markup.trim() === "") return markup

	const document = wrapped(markup)
	const editor = new XmlEditor(document)
	const list = [...childElements(document, document.documentElement())].find(node => document.localName(node) === "extLst")

	if (list === undefined) return markup

	let extensions = 0

	for (const ext of childElements(document, list)) {
		if (document.localName(ext) !== "ext") continue
		if ((document.attribute(ext, "uri") ?? "").toUpperCase() !== DV_EXT) {
			extensions++

			continue
		}

		const section = childByLocal(document, ext, "dataValidations")
		let count = 0

		for (const node of section < 0 ? [] : childElements(document, section)) {
			if (document.localName(node) !== "dataValidation") continue

			const sqref = childByLocal(document, node, "sqref")

			if (cutRule(document, editor, node, sqref < 0 ? null : sqref, cuts)) count++
			else editor.remove(node)
		}

		if (count === 0) {
			editor.remove(ext)
		} else {
			editor.setAttribute(section, "count", String(count))
			extensions++
		}
	}

	return extensions === 0 ? "" : unwrapped(editor)
}

type Bound = { readonly formula: string } | { readonly refused: "formula" | "tooLarge" }

// A bound as typed into the dialog (in the session's locale), as the file writes it: "=" starts a formula; a number,
// date or time is its serial; anything else is refused.
function bound(value: string, date1904: boolean, locale: SheetLocale | undefined): Bound {
	const text = value.trim()

	if (text.startsWith("=")) return typedFormula(text.slice(1), locale)

	const entry = readEntry(text, false, date1904, locale)

	return entry.type === "number" ? { formula: numberText(entry.value) } : { refused: "formula" }
}

// A formula as typed in the session's locale (without its "="), in the file's syntax, or refused when it does not
// read as one.
function typedFormula(typed: string, locale: SheetLocale | undefined): Bound {
	const formula = delocalizeFormula(typed, locale)

	return formula !== "" && wellFormedFormula(formula) ? { formula } : { refused: "formula" }
}

// A list's source as typed: "=" and a formula, or items separated by the locale's list separator (written as one
// quoted string, comma-separated, as the file holds it).
function listSource(value: string, locale: SheetLocale | undefined): Bound {
	const text = value.trim()

	if (text.startsWith("=")) return typedFormula(text.slice(1), locale)
	if (text === "") return { refused: "formula" }

	const items = locale?.argument === ";" ? text.split(";").join(",") : text

	if (items.length > MAX_LIST) return { refused: "tooLarge" }

	return { formula: `"${items.replace(/"/gu, '""')}"` }
}

// The new validation's element, or why it cannot be written.
function ruleMarkup(
	rule: SheetValidationRule,
	ranges: readonly SheetRange[],
	at: { readonly row: number; readonly col: number },
	date1904: boolean,
	locale: SheetLocale | undefined,
	prefix: string
): { readonly markup: string } | { readonly refused: "formula" | "tooLarge" | "unsupported" } {
	const texts = [rule.promptTitle, rule.prompt, rule.errorTitle, rule.error, rule.value1, rule.value2]

	if (texts.some(unwritableText)) return { refused: "unsupported" }
	if (
		rule.promptTitle.length > MAX_TITLE ||
		rule.errorTitle.length > MAX_TITLE ||
		rule.prompt.length > MAX_PROMPT ||
		rule.error.length > MAX_ERROR
	)
		return { refused: "tooLarge" }

	const anchor = anchorOf(ranges)
	// Formulas are typed for the active cell; the file writes them for the top-left cell around the ranges.
	const relative = (formula: string): string => (at.row === anchor.row && at.col === anchor.col ? formula : moved(formula, at, anchor))
	const formulas: string[] = []

	if (rule.type === "list") {
		const source = listSource(rule.value1, locale)

		if ("refused" in source) return source

		formulas.push(source.formula.startsWith('"') ? source.formula : relative(source.formula))
	} else if (rule.type === "custom") {
		const text = rule.value1.trim()
		const formula = typedFormula(text.startsWith("=") ? text.slice(1) : text, locale)

		if ("refused" in formula) return formula

		formulas.push(relative(formula.formula))
	} else if (rule.type !== "none") {
		const two = rule.operator === "between" || rule.operator === "notBetween"

		for (const value of two ? [rule.value1, rule.value2] : [rule.value1]) {
			const parsed = bound(value, date1904, locale)

			if ("refused" in parsed) return parsed

			formulas.push(relative(parsed.formula))
		}
	}

	const tag = (name: string): string => (prefix === "" ? name : `${prefix}:${name}`)
	const attributes: string[] = []
	const add = (name: string, value: string): void => {
		attributes.push(`${name}="${escapeAttribute(value)}"`)
	}

	if (rule.type !== "none") add("type", rule.type)
	if (rule.errorStyle !== "stop") add("errorStyle", rule.errorStyle)
	if (rule.type !== "none" && rule.type !== "list" && rule.type !== "custom" && rule.operator !== "between")
		add("operator", rule.operator)
	if (rule.allowBlank) add("allowBlank", "1")
	// showDropDown="1" hides the in-cell list (as Excel writes it).
	if (rule.type === "list" && !rule.inCellDropdown) add("showDropDown", "1")
	if (rule.showInputMessage) add("showInputMessage", "1")
	if (rule.showErrorMessage) add("showErrorMessage", "1")
	if (rule.errorTitle !== "") add("errorTitle", rule.errorTitle)
	if (rule.error !== "") add("error", rule.error)
	if (rule.promptTitle !== "") add("promptTitle", rule.promptTitle)
	if (rule.prompt !== "") add("prompt", rule.prompt)
	add("sqref", formatSqref(ranges))

	const children = formulas
		.map((formula, i) => `<${tag(`formula${String(i + 1)}`)}>${escapeText(formula)}</${tag(`formula${String(i + 1)}`)}>`)
		.join("")
	const name = tag("dataValidation")

	return { markup: children === "" ? `<${name} ${attributes.join(" ")}/>` : `<${name} ${attributes.join(" ")}>${children}</${name}>` }
}

// The prefix the worksheet's elements take (x:worksheet), from a section the source wrote or its root.
async function elementPrefix(workbook: XlsxWorkbookModel, model: XlsxSheetModel): Promise<string> {
	if (model instanceof XlsxSheet) return model.prefix
	if (model.freshRoot !== undefined) return rootTag(encodeUtf8(model.freshRoot)).prefix

	const written = model.sections.find(section => section.bytes !== null && section.bytes.length > 0)

	if (written?.bytes !== undefined && written.bytes !== null) return rootTag(written.bytes).prefix

	return rootTag(await workbook.parts.read(model.part)).prefix
}

export async function setValidation(
	document: XlsxDocument,
	sheet: SheetId,
	ranges: readonly SheetRange[],
	rule: SheetValidationRule | null,
	changes: SheetChangeSink,
	at?: { readonly row: number; readonly col: number },
	locale?: SheetLocale
): Promise<SheetHandled> {
	if (ranges.length === 0) return null
	if (ranges.length > MAX_RANGES) return { refused: { reason: "tooLarge" } }

	for (const range of ranges) {
		if (
			range.startRow < 0 ||
			range.startCol < 0 ||
			range.endRow >= SHEET_MAX_ROWS ||
			range.endCol >= SHEET_MAX_COLS ||
			range.startRow > range.endRow ||
			range.startCol > range.endCol
		)
			return { refused: { reason: "tooLarge" } }
	}

	const model = await document.ready(sheet)

	// Excel offers no data validation on a protected sheet.
	if (model.protection !== null) return { refused: { reason: "protectedSheet", detail: "dataValidation" } }

	const workbook = document.workbook
	const prefix = await elementPrefix(workbook, model)
	let added: string | null = null

	if (rule !== null) {
		const made = ruleMarkup(rule, ranges, at ?? anchorOf(ranges), document.date1904, locale, prefix)

		if ("refused" in made) return { refused: { reason: made.refused, detail: "dataValidation" } }

		added = made.markup
	}

	const state = refState(workbook)
	let beforeMain: readonly string[]
	let beforeExt: readonly string[]

	try {
		beforeMain = state.sectionMarkup(model, "dataValidations")
		beforeExt = state.sectionMarkup(model, "extLst")
	} catch (error) {
		if (error instanceof RefRefused) return { refused: error.refusal }

		throw error
	}

	const main = mainSection(beforeMain.join(""), ranges, added, prefix)
	const ext = extSection(beforeExt.join(""), ranges)
	const afterMain = main === "" ? [] : [main]
	const afterExt = ext === "" ? [] : [ext]
	const mainChanged = main !== beforeMain.join("")
	const extChanged = ext !== beforeExt.join("")

	if (!mainChanged && !extChanged) return null

	const write = (mainMarkup: readonly string[], extMarkup: readonly string[], sink: SheetChangeSink): void => {
		if (mainChanged) state.setSection(model, "dataValidations", mainMarkup)
		if (extChanged) state.setSection(model, "extLst", extMarkup)

		sink.layout(sheet)
	}

	write(afterMain, afterExt, changes)

	return {
		bytes: 2 * (main.length + ext.length + beforeMain.join("").length + beforeExt.join("").length),
		undo: sink => write(beforeMain, beforeExt, sink),
		redo: sink => write(afterMain, afterExt, sink)
	}
}
