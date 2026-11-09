import { CellFlag, type SheetCell, type SheetId, type SheetLocale } from "../protocol"
import { localizedInput, localizeFormula } from "../input/locale"
import { defineSheetFeature, type SheetReadContext } from "../registry"
import { typedSerial, type XlsxDocument } from "../../xlsx/edit/document"
import { entryYear, readEntry } from "../../xlsx/edit/cells"
import { setValidation } from "../../xlsx/edit/dv"
import { DocumentFormulaHost } from "../cf/host"
import { SectionCache } from "../cf/sections"
import { formulaSheets } from "../cf/formula/evaluate"
import { FormulaError, textNumber, type Scalar } from "../cf/formula/values"
import { readValidations, validationAt, type DvErrorStyle, type DvOperator, type DvRule, type DvType } from "./rules"
import { entryResult, listItems, meetsValidation, type DvListItem } from "./validate"

// Data validation on an xlsx session: which cells offer a list or show an input message (the layout's
// "validations"), a list's items, the check of an entry before it is written, and validations set and cleared.

// A validation as a dialog shows and edits it: bounds and a list's source as typed ("=" before a formula, a list's
// items comma-separated, dates and times as typed into a cell).
export interface SheetValidationRule {
	readonly type: DvType
	readonly operator: DvOperator
	readonly value1: string
	readonly value2: string
	readonly allowBlank: boolean
	readonly inCellDropdown: boolean
	readonly showInputMessage: boolean
	readonly promptTitle: string
	readonly prompt: string
	readonly showErrorMessage: boolean
	readonly errorStyle: DvErrorStyle
	readonly errorTitle: string
	readonly error: string
}

// What an entry that breaks its cell's validation shows (null title and message: the app's own words).
export interface SheetValidationAlert {
	readonly style: DvErrorStyle
	readonly title: string | null
	readonly message: string | null
}

// The cells that offer a list or show an input message: `ranges` as quads (startRow, startCol, endRow, endCol), each
// with the index of its entry in `rules`.
export interface SheetValidationLayout {
	readonly ranges: Uint32Array
	readonly rules: Uint32Array
	readonly entries: readonly { readonly dropdown: boolean; readonly promptTitle: string | null; readonly prompt: string | null }[]
}

declare module "../protocol" {
	interface SheetLayoutExtensionMap {
		readonly validations: SheetValidationLayout
	}

	interface SheetQueryMap {
		// A list validation's items for a cell (each as shown and as typed in the session's locale), null when the cell
		// has none or its source cannot be read here.
		"validation.list": { request: SheetCell; result: { readonly items: readonly DvListItem[] } | null }
		// Whether typing `input` into the cell breaks its validation: what to show, or null when it may be written.
		"validation.check": { request: SheetCell & { readonly input: string }; result: SheetValidationAlert | null }
		// The validation of a cell, for the dialog that edits it; null when it has none.
		"validation.rule": { request: SheetCell; result: SheetValidationRule | null }
	}

	interface SheetCommandMap {
		// Sets the validation of every cell of `ranges` (null clears it), replacing what they had. Its formulas are typed
		// for `at` (the active cell; the top-left cell around the ranges when absent).
		"validation.set": {
			readonly sheet: SheetId
			readonly ranges: readonly SheetRange[]
			readonly rule: SheetValidationRule | null
			readonly at?: { readonly row: number; readonly col: number }
		}
	}
}

interface DocumentState {
	readonly host: DocumentFormulaHost
	readonly rules: SectionCache<readonly DvRule[]>
}

const states = new WeakMap<XlsxDocument, DocumentState>()

function stateOf(document: XlsxDocument): DocumentState {
	let state = states.get(document)

	if (state === undefined) {
		state = {
			host: new DocumentFormulaHost(document),
			rules: new SectionCache(["dataValidations", "extLst"], ([sections = [], ext = []]) =>
				readValidations(sections, ext.length === 0 ? null : ext.join(""))
			)
		}
		states.set(document, state)
	}

	return state
}

export function validations(context: SheetReadContext<XlsxDocument>, sheet: SheetId): readonly DvRule[] {
	const model = context.doc.model(sheet)

	return model === null ? [] : stateOf(context.doc).rules.get(context.doc.workbook, model, context.version)
}

// The sheets a rule's formula reads (names followed), read before it is evaluated: every sheet for one that reads a
// sheet only known when it runs.
async function readNamedSheets(context: SheetReadContext<XlsxDocument>, sheet: SheetId, formula: string): Promise<void> {
	const read = formulaSheets(formula, sheet, stateOf(context.doc).host)

	for (const entry of context.doc.workbook.sheets) {
		if (entry.model !== null || entry.kind !== "worksheet") continue
		if (read.all || [...read.names].some(name => name.toUpperCase() === entry.name.toUpperCase()))
			await context.doc.ready(entry.id, context.slicing, context.signal)
	}
}

function layoutOf(rules: readonly DvRule[]): SheetValidationLayout | undefined {
	const ranges: number[] = []
	const indices: number[] = []
	const entries: { dropdown: boolean; promptTitle: string | null; prompt: string | null }[] = []

	for (const rule of rules) {
		const dropdown = rule.type === "list" && !rule.hideDropDown && rule.formula1 !== null
		const prompt = rule.showInputMessage && ((rule.prompt ?? "") !== "" || (rule.promptTitle ?? "") !== "")

		if (!dropdown && !prompt) continue

		const index = entries.length

		entries.push({ dropdown, promptTitle: prompt ? rule.promptTitle : null, prompt: prompt ? (rule.prompt ?? "") : null })

		for (const range of rule.ranges) {
			ranges.push(range.startRow, range.startCol, range.endRow, range.endCol)
			indices.push(index)
		}
	}

	return entries.length === 0 ? undefined : { ranges: Uint32Array.from(ranges), rules: Uint32Array.from(indices), entries }
}

// A bound or source as the dialog shows it, in the session's locale (a formula's separators, a number's decimal, a
// typed list's separator).
function typedOf(rule: DvRule, formula: string | null, date1904: boolean, locale: SheetLocale | undefined): string {
	if (formula === null) return ""

	if (rule.type === "list") {
		const text = formula.trim()
		const literal = text.startsWith('"') && text.endsWith('"') && text.length >= 2

		if (!literal) return `=${localizeFormula(formula, locale)}`

		const items = text.slice(1, -1).replace(/""/gu, '"')

		return locale?.argument === ";" ? items.split(",").join(";") : items
	}

	if (rule.type === "custom") return `=${localizeFormula(formula, locale)}`

	const number = textNumber(formula)

	if (number === null || /%/u.test(formula)) return `=${localizeFormula(formula, locale)}`
	if (rule.type === "date" || rule.type === "time") return typedSerial(rule.type === "time" ? number % 1 : number, date1904)

	return localizedInput(formula.trim(), locale)
}

export function ruleForDialog(rule: DvRule, date1904: boolean, locale?: SheetLocale): SheetValidationRule {
	return {
		type: rule.type,
		operator: rule.operator,
		value1: typedOf(rule, rule.formula1, date1904, locale),
		value2: typedOf(rule, rule.formula2, date1904, locale),
		allowBlank: rule.allowBlank,
		inCellDropdown: !rule.hideDropDown,
		showInputMessage: rule.showInputMessage,
		promptTitle: rule.promptTitle ?? "",
		prompt: rule.prompt ?? "",
		showErrorMessage: rule.showErrorMessage,
		errorStyle: rule.errorStyle,
		errorTitle: rule.errorTitle ?? "",
		error: rule.error ?? ""
	}
}

// The value an entry gives: what readEntry makes of it, a formula's result when it is calculated here (undefined
// when it is not).
function entryValue(
	context: SheetReadContext<XlsxDocument>,
	cell: SheetCell,
	input: string,
	host: DocumentFormulaHost
): Scalar | undefined {
	const document = context.doc
	const model = document.model(cell.sheet)
	const view = model === null ? null : document.cellView(cell.sheet, cell.row, cell.col)
	// Read as the session will store it: in the session's locale ("1,5" is 1.5 where "," is the decimal).
	const entry = readEntry(
		input,
		view !== null && (view.flags & CellFlag.TEXT_FORMAT) !== 0,
		document.date1904,
		document.settings.locale,
		entryYear(document)
	)

	switch (entry.type) {
		case "empty":
			return null
		case "formula":
			return entryResult(entry.text, cell, host)
		case "text":
			return entry.text
		case "error":
			return FormulaError.of(entry.text)
		case "boolean":
			return entry.value
		case "number":
			return entry.value
	}
}

export const dataValidationFeature = defineSheetFeature<XlsxDocument>({
	id: "dataValidation",
	commands: {
		"validation.set": {
			info: { write: true },
			run: (context, command) =>
				setValidation(
					context.doc,
					command.sheet,
					command.ranges,
					command.rule,
					context.changes,
					command.at,
					context.settings.locale
				)
		}
	},
	queries: {
		"validation.list": {
			run: async (context, cell) => {
				const rule = validationAt(validations(context, cell.sheet), cell.row, cell.col)

				if (rule === null || rule.type !== "list" || rule.formula1 === null) return null

				await readNamedSheets(context, cell.sheet, rule.formula1)

				const document = context.doc
				const items = listItems(rule, cell, stateOf(document).host, (sheet, row, col) => {
					const view = document.cellView(sheet, row, col)

					return { text: view.text, input: (view.flags & CellFlag.FORMULA) !== 0 ? view.text : (view.input ?? view.text) }
				})

				// What choosing an item enters is typed in the session's locale, as cells.set reads it.
				const locale = context.settings.locale

				return items === null
					? null
					: { items: items.map(item => ({ text: item.text, input: localizedInput(item.input, locale) })) }
			}
		},
		"validation.check": {
			run: async (context, request) => {
				const rule = validationAt(validations(context, request.sheet), request.row, request.col)

				// Excel lets anything through a validation that shows no error alert.
				if (rule === null || !rule.showErrorMessage || rule.type === "none") return null

				for (const formula of [rule.formula1, rule.formula2])
					if (formula !== null) await readNamedSheets(context, request.sheet, formula)

				const host = stateOf(context.doc).host
				const value = entryValue(context, request, request.input, host)

				// A cleared cell is never checked; a value not calculated here is not judged.
				if (value === null || value === undefined) return null

				const meets = meetsValidation(rule, request, value, host)

				// An empty title or message is the app's own words, as Excel shows its own.
				return meets === false
					? {
							style: rule.errorStyle,
							title: rule.errorTitle === "" ? null : rule.errorTitle,
							message: rule.error === "" ? null : rule.error
						}
					: null
			}
		},
		"validation.rule": {
			run: (context, cell) => {
				const rule = validationAt(validations(context, cell.sheet), cell.row, cell.col)

				return rule === null ? null : ruleForDialog(rule, context.doc.date1904, context.settings.locale)
			}
		}
	},
	layout: {
		validations: (context, sheet) => layoutOf(validations(context, sheet))
	}
})
