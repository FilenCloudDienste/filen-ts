import { minOf } from "../../arrays"
import type { SheetId } from "../protocol"
import { FormulaEvaluator, ruleTruth, type FormulaHost } from "../cf/formula/evaluate"
import { parseFormula } from "../cf/formula/syntax"
import {
	FormulaError,
	Unsupported,
	arrayAt,
	compareNumbers,
	isArray,
	isRef,
	storedRows,
	textNumber,
	toText,
	type FormulaRef,
	type FormulaValue,
	type Scalar
} from "../cf/formula/values"
import type { DvOperator, DvRule } from "./rules"

// Whether a value meets a cell's data validation, as Excel checks what is typed into the cell
// (support.microsoft.com, "Apply data validation to cells"): its type, the operator against the rule's formulas
// (written for the rule's first cell, moved to the cell), a list's items, a custom formula with the new value in
// the cell. A value the rule cannot judge here (a formula not calculated here) is let through.

export interface DvListItem {
	// As the list shows it.
	readonly text: string
	// What choosing it enters into the cell.
	readonly input: string
}

// Excel shows at most this many items in a validation's list.
export const MAX_LIST_ITEMS = 32_767

// A host that reads one cell as holding `value` (the entry under check).
class EntryHost implements FormulaHost {
	private readonly base: FormulaHost
	private readonly sheet: SheetId
	private readonly row: number
	private readonly col: number
	private readonly entry: Scalar

	constructor(base: FormulaHost, sheet: SheetId, row: number, col: number, entry: Scalar) {
		this.base = base
		this.sheet = sheet
		this.row = row
		this.col = col
		this.entry = entry
	}

	get date1904(): boolean {
		return this.base.date1904
	}

	private here(sheet: SheetId, row: number, col: number): boolean {
		return sheet === this.sheet && row === this.row && col === this.col
	}

	value(sheet: SheetId, row: number, col: number): Scalar {
		return this.here(sheet, row, col) ? this.entry : this.base.value(sheet, row, col)
	}

	// Cells in no particular order (every reader places them by position).
	forEach(ref: FormulaRef, visit: (row: number, col: number, value: Scalar) => void): void {
		const inside =
			ref.sheet === this.sheet &&
			this.row >= ref.startRow &&
			this.row <= ref.endRow &&
			this.col >= ref.startCol &&
			this.col <= ref.endCol

		this.base.forEach(ref, (row, col, value) => {
			if (!inside || row !== this.row || col !== this.col) visit(row, col, value)
		})

		if (inside && this.entry !== null) visit(this.row, this.col, this.entry)
	}

	extent(sheet: SheetId): { readonly rows: number; readonly cols: number } {
		const extent = this.base.extent(sheet)

		return sheet === this.sheet ? { rows: Math.max(extent.rows, this.row + 1), cols: Math.max(extent.cols, this.col + 1) } : extent
	}

	sheetByName(name: string): SheetId | null {
		return this.base.sheetByName(name)
	}

	definedName(name: string, sheet: SheetId): string | null {
		return this.base.definedName(name, sheet)
	}

	today(): number {
		return this.base.today()
	}

	now(): number {
		return this.base.now()
	}
}

export interface DvCell {
	readonly sheet: SheetId
	readonly row: number
	readonly col: number
}

// A rule's formulas are written for the top-left cell of the rectangle around its ranges (as conditional formats'
// are: every multi-range validation of the corpus whose formulas say so, 14 of 14).
function position(rule: DvRule, cell: DvCell): { sheet: SheetId; anchorRow: number; anchorCol: number; row: number; col: number } {
	let anchorRow = cell.row
	let anchorCol = cell.col

	if (rule.ranges.length > 0) {
		anchorRow = minOf(rule.ranges.map(range => range.startRow))
		anchorCol = minOf(rule.ranges.map(range => range.startCol))
	}

	return { sheet: cell.sheet, anchorRow, anchorCol, row: cell.row, col: cell.col }
}

// A literal list ("a,b,c" in quotes): its items as written.
function literalItems(formula: string): string[] | null {
	const text = formula.trim()

	if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return null

	return text.slice(1, -1).replace(/""/gu, '"').split(",")
}

// The values a list's source gives: a reference's cells row by row (blank ones too), an array's values.
function sourceValues(
	evaluator: FormulaEvaluator,
	value: FormulaValue,
	visit: (value: Scalar, row: number, col: number, sheet: SheetId) => void
): void {
	if (isRef(value)) {
		const array = evaluator.array(value)
		// Blank rows a reference holds past the used area count, up to what a list shows.
		const rows = Math.min(array.rows, Math.max(storedRows(array), MAX_LIST_ITEMS))

		for (let r = 0; r < rows; r++)
			for (let c = 0; c < array.cols; c++) visit(arrayAt(array, r, c), value.startRow + r, value.startCol + c, value.sheet)

		return
	}

	if (isArray(value)) {
		const rows = Math.min(value.rows, Math.max(storedRows(value), MAX_LIST_ITEMS))

		for (let r = 0; r < rows; r++) for (let c = 0; c < value.cols; c++) visit(arrayAt(value, r, c), -1, -1, -1)

		return
	}

	visit(value, -1, -1, -1)
}

// What a list rule offers: each item as shown and as entered. `shown` gives a cell's text as the grid shows it and
// what typing it takes, for items read from cells. Null when the source cannot be read here.
export function listItems(
	rule: DvRule,
	cell: DvCell,
	host: FormulaHost,
	shown: (sheet: SheetId, row: number, col: number) => DvListItem
): DvListItem[] | null {
	if (rule.type !== "list" || rule.formula1 === null) return null

	const literal = literalItems(rule.formula1)

	if (literal !== null) return literal.slice(0, MAX_LIST_ITEMS).map(item => ({ text: item, input: item }))

	const evaluator = new FormulaEvaluator(host)
	const items: DvListItem[] = []

	try {
		const value = evaluator.evaluate(rule.formula1, position(rule, cell))

		sourceValues(evaluator, value, (item, row, col, sheet) => {
			if (items.length >= MAX_LIST_ITEMS) return

			if (row >= 0 && item !== null && !(item instanceof FormulaError)) {
				items.push(shown(sheet, row, col))

				return
			}

			const text = toText(item)

			items.push({ text: text instanceof FormulaError ? text.code : text, input: text instanceof FormulaError ? text.code : text })
		})
	} catch (error) {
		if (error instanceof Unsupported) return null

		throw error
	}

	return items
}

function numberOf(value: Scalar): number | null {
	if (typeof value === "number") return value
	if (typeof value === "string") return textNumber(value)

	return null
}

function compare(operator: DvOperator, value: number, first: number, second: number): boolean {
	switch (operator) {
		case "between":
			return compareNumbers(value, Math.min(first, second)) >= 0 && compareNumbers(value, Math.max(first, second)) <= 0
		case "notBetween":
			return compareNumbers(value, Math.min(first, second)) < 0 || compareNumbers(value, Math.max(first, second)) > 0
		case "equal":
			return compareNumbers(value, first) === 0
		case "notEqual":
			return compareNumbers(value, first) !== 0
		case "lessThan":
			return compareNumbers(value, first) < 0
		case "lessThanOrEqual":
			return compareNumbers(value, first) <= 0
		case "greaterThan":
			return compareNumbers(value, first) > 0
		case "greaterThanOrEqual":
			return compareNumbers(value, first) >= 0
	}
}

// Whether `value` (what the cell would hold) meets the rule; null when it cannot be judged here.
export function meetsValidation(rule: DvRule, cell: DvCell, value: Scalar, base: FormulaHost): boolean | null {
	if (rule.type === "none") return true

	const host = new EntryHost(base, cell.sheet, cell.row, cell.col, value)
	const evaluator = new FormulaEvaluator(host)
	const at = position(rule, cell)
	const operand = (formula: string | null): Scalar | undefined => {
		if (formula === null) return undefined

		return evaluator.scalar(evaluator.evaluate(parseFormula(formula), at))
	}

	try {
		switch (rule.type) {
			case "custom": {
				if (rule.formula1 === null) return true

				const result = operand(rule.formula1) ?? null

				return result instanceof FormulaError ? false : ruleTruth(result)
			}
			case "list": {
				if (rule.formula1 === null) return true

				const literal = literalItems(rule.formula1)
				const text = toText(value)

				if (text instanceof FormulaError) return false

				const number = numberOf(value)
				const matches = (item: Scalar): boolean => {
					if (item === null || item instanceof FormulaError) return false

					const itemNumber = numberOf(item)

					if (number !== null && itemNumber !== null) return compareNumbers(number, itemNumber) === 0

					const itemText = toText(item) as string

					return itemText.toUpperCase() === text.toUpperCase()
				}

				if (literal !== null) return literal.some(item => matches(item))

				let found = false
				let blankSource = true

				sourceValues(evaluator, evaluator.evaluate(parseFormula(rule.formula1), at), item => {
					if (item !== null) blankSource = false
					if (!found && matches(item)) found = true
				})

				// "Ignore blank" lets anything through while the list's source is empty.
				return found || (rule.allowBlank && blankSource)
			}
			case "textLength":
			case "whole":
			case "decimal":
			case "date":
			case "time": {
				const first = operand(rule.formula1)
				const second = rule.operator === "between" || rule.operator === "notBetween" ? operand(rule.formula2) : undefined

				// "Ignore blank": a bound that reads a blank cell lets any value through.
				if (rule.allowBlank && (first === null || second === null)) return true

				const low = first === undefined ? Number.NaN : numberOf(first)
				const high = second === undefined ? (low ?? Number.NaN) : numberOf(second)

				if (low === null || high === null || Number.isNaN(low) || Number.isNaN(high)) return false

				if (rule.type === "textLength") {
					const text = value === null ? "" : toText(value)

					return !(text instanceof FormulaError) && compare(rule.operator, text.length, low, high)
				}

				const number = typeof value === "number" ? value : null

				if (number === null) return false
				if (rule.type === "whole" && !Number.isInteger(number)) return false

				return compare(rule.operator, number, low, high)
			}
		}
	} catch (error) {
		if (error instanceof Unsupported) return null

		throw error
	}
}

// The value an entry gives once typed (a formula's result, when it is calculated here).
export function entryResult(formula: string, cell: DvCell, host: FormulaHost): Scalar | undefined {
	try {
		const evaluator = new FormulaEvaluator(host)

		return evaluator.scalar(
			evaluator.evaluate(parseFormula(formula), {
				sheet: cell.sheet,
				anchorRow: cell.row,
				anchorCol: cell.col,
				row: cell.row,
				col: cell.col
			})
		)
	} catch (error) {
		if (error instanceof Unsupported) return undefined

		throw error
	}
}
