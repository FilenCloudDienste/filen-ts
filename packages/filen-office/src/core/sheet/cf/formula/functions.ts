import { dateSerial, serialDate, type DateParts } from "../../numfmt/date"
import { formatValue } from "../../numfmt/format"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../../protocol"
import { wildcardMatcher, type WildcardMatcher } from "../../find/match"
import { columnName } from "../../refs/cellRef"
import type { FormulaHost, FormulaPosition } from "./evaluate"
import { parseFormula, type FormulaNode } from "./syntax"
import {
	FormulaError,
	Unsupported,
	arrayAt,
	compareValues,
	denseValues,
	isArray,
	isRef,
	refCols,
	refRows,
	storedCols,
	storedRows,
	tailCells,
	textNumber,
	toBoolean,
	toNumber,
	toText,
	type FormulaArray,
	type FormulaRef,
	type FormulaValue,
	type Scalar
} from "./values"

// The worksheet functions a rule's formula may call, as Excel's function reference (support.microsoft.com) defines
// them: the logical, information, text, math, lookup and date functions conditional formats and validations use.
// A function not listed here is not calculated (the rule is not applied).

export interface FunctionContext {
	readonly host: FormulaHost
	readonly position: FormulaPosition
	node(node: FormulaNode): FormulaValue
	scalar(value: FormulaValue): Scalar
	array(value: FormulaValue): FormulaArray
	// Within a pass (FormulaEvaluator.pass), what `build` makes of `owner` (refKey of a reference, an array) for `use`,
	// once a second cell asks for it; undefined otherwise (the caller works without it).
	kept<T>(owner: object | string, use: string, build: () => T): T | undefined
	map1(value: FormulaValue, apply: (value: Scalar) => Scalar): FormulaValue
	map2(left: FormulaValue, right: FormulaValue, apply: (a: Scalar, b: Scalar) => Scalar): FormulaValue
}

type Fn = (context: FunctionContext, args: readonly FormulaNode[]) => FormulaValue

// A reference as a key of what a pass keeps of it.
export function refKey(ref: FormulaRef): string {
	return `${String(ref.sheet)}:${String(ref.startRow)}:${String(ref.startCol)}:${String(ref.endRow)}:${String(ref.endCol)}`
}

function arity(args: readonly FormulaNode[], min: number, max: number): void {
	if (args.length < min || args.length > max) throw new Unsupported("a function given the wrong number of arguments")
}

function arg(context: FunctionContext, args: readonly FormulaNode[], index: number): FormulaValue {
	const node = args[index]

	return node === undefined ? null : context.node(node)
}

function scalarArg(context: FunctionContext, args: readonly FormulaNode[], index: number): Scalar {
	return context.scalar(arg(context, args, index))
}

function numberArg(context: FunctionContext, args: readonly FormulaNode[], index: number, fallback?: number): number | FormulaError {
	if (fallback !== undefined && (args[index] === undefined || args[index]?.kind === "missing")) return fallback

	return toNumber(scalarArg(context, args, index))
}

function textArg(context: FunctionContext, args: readonly FormulaNode[], index: number): string | FormulaError {
	return toText(scalarArg(context, args, index))
}

// A function of one value applied to each value of an array argument.
function unaryFn(apply: (value: Scalar) => Scalar): Fn {
	return (context, args) => {
		arity(args, 1, 1)

		return context.map1(arg(context, args, 0), apply)
	}
}

function numberFn(apply: (value: number) => Scalar): Fn {
	return unaryFn(value => {
		const number = toNumber(value)

		return number instanceof FormulaError ? number : apply(number)
	})
}

// --- Aggregates ---

// The numbers of the arguments as Excel's SUM family reads them: in a reference or array only numbers count;
// given directly, logicals and numeric text count too. The first error stops it.
function numbers(context: FunctionContext, args: readonly FormulaNode[], visit: (value: number) => void): FormulaError | null {
	for (const node of args) {
		if (node.kind === "missing") continue

		const value = context.node(node)

		if (isRef(value)) {
			let error: FormulaError | null = null

			context.host.forEach(value, (_row, _col, cell) => {
				if (error !== null) return
				if (cell instanceof FormulaError) error = cell
				else if (typeof cell === "number") visit(cell)
			})

			if (error !== null) return error
		} else if (isArray(value)) {
			for (const item of value.values) {
				if (item instanceof FormulaError) return item
				if (typeof item === "number") visit(item)
			}

			const fill = value.fill ?? null
			const tail = tailCells(value)

			if (tail > 0 && fill instanceof FormulaError) return fill

			if (tail > 0 && typeof fill === "number") {
				if (tail > MAX_TAIL) throw new Unsupported("an array too large")

				for (let i = 0; i < tail; i++) visit(fill)
			}
		} else {
			const number = toNumber(value)

			if (number instanceof FormulaError) return number

			visit(number)
		}
	}

	return null
}

function collect(context: FunctionContext, args: readonly FormulaNode[]): number[] | FormulaError {
	const list: number[] = []
	const error = numbers(context, args, value => list.push(value))

	return error ?? list
}

// `keyed`: the criterion's keys (Criterion.equal, unequal), counted from the reference's kept counts in a pass.
function counted(context: FunctionContext, value: FormulaValue, test: (value: Scalar) => boolean, keyed?: Criterion): number {
	if (isRef(value)) {
		const keys = keyed?.equal ?? keyed?.unequal
		const counts = keys === undefined ? undefined : context.kept(refKey(value), "counts", () => equalCounts(context, value))

		if (keys !== undefined && counts !== undefined) {
			let count = 0

			for (const key of keys) count += counts.get(key) ?? 0

			return keyed?.equal === undefined ? refRows(value) * refCols(value) - count : count
		}

		let count = 0
		let stored = 0

		context.host.forEach(value, (_row, _col, cell) => {
			stored++

			if (test(cell)) count++
		})

		// Blank cells the reference holds beyond the stored ones.
		return test(null) ? count + refRows(value) * refCols(value) - stored : count
	}

	const array = context.array(value)

	return array.values.filter(test).length + (tailCells(array) > 0 && test(array.fill ?? null) ? tailCells(array) : 0)
}

// The most cells past an array's stored part an aggregate visits one by one.
const MAX_TAIL = 1_048_576

// A vector's cells for a lookup: a blank rest past what it stores is left out (a blank never matches).
function vectorValues(array: FormulaArray): readonly Scalar[] {
	return (array.fill ?? null) === null ? array.values : denseValues(array, MAX_TAIL)
}

// --- Criteria (COUNTIF and friends: support.microsoft.com "COUNTIF function") ---

interface Criterion {
	test(value: Scalar): boolean
	// A plain equality's keys (equalKeys): the values it matches are those with one of them, and never a blank.
	readonly equal?: readonly string[]
	// A plain inequality's: it matches every cell, blanks included, but those with one of them.
	readonly unequal?: readonly string[]
}

// The keys a stored value is counted under for the criteria's plain equalities: its type and value (text without case),
// and text that reads as a number under that number too (a numeric criterion's text matches it).
function equalKeys(value: Scalar, add: (key: string) => void): void {
	if (value instanceof FormulaError) add(`e${String(value.code)}`)
	else if (typeof value === "number") add(`n${String(value)}`)
	else if (typeof value === "boolean") add(`b${String(value)}`)
	else if (typeof value === "string") {
		const number = textNumber(value)

		add(`s${value.toUpperCase()}`)

		if (number !== null) add(`t${String(number)}`)
	}
}

// How many stored cells of a reference have each equality key.
function equalCounts(context: FunctionContext, ref: FormulaRef): Map<string, number> {
	const counts = new Map<string, number>()
	const add = (key: string): void => {
		counts.set(key, (counts.get(key) ?? 0) + 1)
	}

	context.host.forEach(ref, (_row, _col, value) => {
		equalKeys(value, add)
	})

	return counts
}

// A pattern's "*" and "?" as a matcher without regard to case ("~" makes the next character literal); null when it has
// none. A linear walk (find/match.ts), never a backtracking regular expression.
function wildcard(pattern: string): WildcardMatcher | null {
	return /[*?~]/u.test(pattern) ? wildcardMatcher(pattern, false) : null
}

export function criterion(raw: Scalar): Criterion {
	if (raw instanceof FormulaError)
		return { test: value => value instanceof FormulaError && value.code === raw.code, equal: [`e${String(raw.code)}`] }
	if (raw === null) return { test: value => value === 0, equal: ["n0"] }
	if (typeof raw === "number") return { test: value => typeof value === "number" && value === raw, equal: [`n${String(raw)}`] }
	if (typeof raw === "boolean") return { test: value => value === raw, equal: [`b${String(raw)}`] }

	const match = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/u.exec(raw)
	const op = match?.[1] ?? ""
	const operand = match?.[2] ?? ""
	const number = textNumber(operand)
	const upper = operand.toUpperCase()
	const logical = upper === "TRUE" ? true : upper === "FALSE" ? false : null
	const error = operand.startsWith("#") ? FormulaError.of(operand) : null

	if (op === "" || op === "=") {
		if (operand === "") return { test: value => value === null || (op === "=" ? false : value === "") }
		if (number !== null)
			return {
				test: value =>
					(typeof value === "number" && value === number) || (typeof value === "string" && textNumber(value) === number),
				equal: [`n${String(number)}`, `t${String(number)}`]
			}
		if (logical !== null) return { test: value => value === logical, equal: [`b${String(logical)}`] }
		if (error !== null)
			return { test: value => value instanceof FormulaError && value.code === error.code, equal: [`e${String(error.code)}`] }

		const pattern = wildcard(operand)

		if (pattern === null) return { test: value => typeof value === "string" && value.toUpperCase() === upper, equal: [`s${upper}`] }

		return { test: value => typeof value === "string" && pattern.test(value, true) }
	}

	if (op === "<>") {
		if (operand === "") return { test: value => value !== null && value !== "" }
		if (number !== null) return { test: value => !(typeof value === "number" && value === number), unequal: [`n${String(number)}`] }
		if (logical !== null) return { test: value => value !== logical, unequal: [`b${String(logical)}`] }

		const pattern = wildcard(operand)

		if (pattern === null)
			return { test: value => !(typeof value === "string" && value.toUpperCase() === upper), unequal: [`s${upper}`] }

		return { test: value => !(typeof value === "string" && pattern.test(value, true)) }
	}

	const compare = (order: number): boolean => (op === "<" ? order < 0 : op === ">" ? order > 0 : op === "<=" ? order <= 0 : order >= 0)

	if (number !== null) return { test: value => typeof value === "number" && compare(value - number) }

	return { test: value => typeof value === "string" && compare(compareValues(value, operand)) }
}

// One criteria pair over its range, by position in it (row-major): the stored cells that pass, and when a blank passes,
// the stored cells and the range's size, so the blank rest is never enumerated (a whole column is a million blanks).
interface CriteriaPair {
	readonly matches: ReadonlySet<number>
	// Null when a blank does not pass.
	readonly blanks: { readonly stored: ReadonlySet<number>; readonly size: number } | null
}

// The criteria pairs (range, criterion, range, criterion...), or #VALUE! when a range is no reference or differs from
// `shape`.
function criteriaPairs(context: FunctionContext, pairs: readonly FormulaNode[], shape: FormulaRef | null): CriteriaPair[] | FormulaError {
	const list: CriteriaPair[] = []

	for (let k = 0; k + 1 < pairs.length; k += 2) {
		const range = context.node(pairs[k] as FormulaNode)

		if (!isRef(range)) return FormulaError.VALUE

		const rows = refRows(range)
		const cols = refCols(range)

		if (shape !== null && (refRows(shape) !== rows || refCols(shape) !== cols)) return FormulaError.VALUE

		const test = criterion(context.scalar(context.node(pairs[k + 1] as FormulaNode)))
		const matches = new Set<number>()
		const stored = test.test(null) ? new Set<number>() : null

		context.host.forEach(range, (row, col, value) => {
			const index = (row - range.startRow) * cols + (col - range.startCol)

			stored?.add(index)

			if (test.test(value)) matches.add(index)
		})

		list.push({ matches, blanks: stored === null ? null : { stored, size: rows * cols } })
	}

	return list
}

// Whether every pair holds at a position: a stored cell that passes, or a blank one where blanks pass.
function passes(pairs: readonly CriteriaPair[], index: number): boolean {
	for (const pair of pairs) {
		if (pair.matches.has(index)) continue

		const blanks = pair.blanks

		if (blanks === null || index >= blanks.size || blanks.stored.has(index)) return false
	}

	return true
}

// How many positions every pair holds at: those some pair stores, tested, and when every pair passes blanks, the ones
// blank in all of them, counted.
function countPassing(pairs: readonly CriteriaPair[]): number {
	if (pairs.length === 0) return 0

	// A pair blanks fail: only its passing cells can pass all.
	const strict = pairs.find(pair => pair.blanks === null)

	if (strict !== undefined) {
		let count = 0

		for (const index of strict.matches) if (passes(pairs, index)) count++

		return count
	}

	let size = Number.POSITIVE_INFINITY

	for (const pair of pairs) size = Math.min(size, pair.blanks?.size ?? 0)

	const seen = new Set<number>()
	let count = 0
	let storedInside = 0

	for (const pair of pairs) {
		for (const index of pair.blanks?.stored ?? []) {
			if (seen.has(index)) continue

			seen.add(index)

			if (index < size) storedInside++
			if (passes(pairs, index)) count++
		}
	}

	return count + size - storedInside
}

function sumAt(context: FunctionContext, range: FormulaRef, pairs: readonly CriteriaPair[]): { sum: number; count: number } {
	const cols = refCols(range)
	let sum = 0
	let count = 0

	context.host.forEach(range, (row, col, value) => {
		if (typeof value === "number" && passes(pairs, (row - range.startRow) * cols + (col - range.startCol))) {
			sum += value
			count++
		}
	})

	return { sum, count }
}

// --- Lookup ---

// The key a value is found by in an exact lookup: equal keys are values compareValues finds equal, of one type (a
// number to Excel's 15 digits, as compareNumbers compares, text without case).
function exactKey(value: Exclude<Scalar, FormulaError | null>): string {
	if (typeof value === "number") return `n${String(Number(value.toPrecision(15)))}`
	if (typeof value === "string") return `s${value.toUpperCase()}`

	return `b${String(value)}`
}

// Each exact key's first index among the values (errors and blanks never match).
function firstIndexes(values: readonly Scalar[]): Map<string, number> {
	const firsts = new Map<string, number>()

	for (let i = 0; i < values.length; i++) {
		const value = values[i] ?? null

		if (value instanceof FormulaError || value === null) continue

		const key = exactKey(value)

		if (!firsts.has(key)) firsts.set(key, i)
	}

	return firsts
}

function lookupIndex(context: FunctionContext, values: readonly Scalar[], key: Scalar, mode: number): number {
	if (key instanceof FormulaError) return -1

	if (mode === 0) {
		const pattern = typeof key === "string" ? wildcard(key) : null

		// In a pass, the many cells looking a key up in the same values find it by the first index of each.
		const firsts = pattern === null && key !== null ? context.kept(values, "firsts", () => firstIndexes(values)) : undefined

		if (firsts !== undefined && key !== null) return firsts.get(exactKey(key)) ?? -1

		for (let i = 0; i < values.length; i++) {
			const value = values[i] ?? null

			if (value instanceof FormulaError || value === null) continue
			if (
				pattern !== null
					? typeof value === "string" && pattern.test(value, true)
					: typeof value === typeof key && compareValues(value, key) === 0
			)
				return i
		}

		return -1
	}

	// Sorted ascending (1) or descending (-1): the last value not past the key, by binary search as Excel does.
	let low = 0
	let high = values.length - 1
	let found = -1

	while (low <= high) {
		const middle = (low + high) >> 1
		const value = values[middle] ?? null

		if (value === null || value instanceof FormulaError || typeof value !== typeof key) {
			high = middle - 1

			continue
		}

		const order = compareValues(value, key)

		if (mode > 0 ? order <= 0 : order >= 0) {
			found = middle
			low = middle + 1
		} else {
			high = middle - 1
		}
	}

	return found
}

// --- Dates ---

const dateScratch: DateParts = { year: 0, month: 0, day: 0, weekday: 0 }

function dateParts(context: FunctionContext, serial: number): DateParts | FormulaError {
	if (serial < 0 || serial >= 2_958_466) return FormulaError.NUM

	return serialDate(Math.floor(serial), context.host.date1904, dateScratch)
}

// DATE(year, month, day): years below 1900 add 1900; months and days past their range carry over.
function makeDate(context: FunctionContext, year: number, month: number, day: number): number | FormulaError {
	let y = Math.trunc(year)

	if (y < 0 || y > 9999) return FormulaError.NUM
	if (y < 1900) y += 1900

	const months = y * 12 + (Math.trunc(month) - 1)
	const first = dateSerial(Math.floor(months / 12), (((months % 12) + 12) % 12) + 1, 1, context.host.date1904)
	const serial = first + Math.trunc(day) - 1

	return serial < 0 ? FormulaError.NUM : serial
}

function addMonths(context: FunctionContext, serial: number, months: number, end: boolean): number | FormulaError {
	const parts = dateParts(context, serial)

	if (parts instanceof FormulaError) return parts

	const total = parts.year * 12 + parts.month - 1 + Math.trunc(months)
	const year = Math.floor(total / 12)
	const month = total - year * 12 + 1
	const nextFirst = dateSerial(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1, context.host.date1904)
	const last = nextFirst - dateSerial(year, month, 1, context.host.date1904)

	return dateSerial(year, month, 1, context.host.date1904) + (end ? last : Math.min(parts.day, last)) - 1
}

function round(value: number, digits: number, mode: "half" | "down" | "up"): number {
	const factor = 10 ** Math.trunc(digits)
	const scaled = Number((Math.abs(value) * factor).toPrecision(15))
	const rounded = mode === "half" ? Math.floor(scaled + 0.5) : mode === "down" ? Math.floor(scaled) : Math.ceil(scaled)

	return (Math.sign(value) * rounded) / factor
}

function median(list: number[]): number | FormulaError {
	if (list.length === 0) return FormulaError.NUM

	list.sort((a, b) => a - b)

	const middle = list.length >> 1

	return list.length % 2 === 1 ? (list[middle] ?? 0) : ((list[middle - 1] ?? 0) + (list[middle] ?? 0)) / 2
}

function nth(context: FunctionContext, args: readonly FormulaNode[], largest: boolean): FormulaValue {
	arity(args, 2, 2)

	const list = collect(context, args.slice(0, 1))
	const k = numberArg(context, args, 1)

	if (list instanceof FormulaError) return list
	if (k instanceof FormulaError) return k

	const index = Math.ceil(k) - 1

	if (index < 0 || index >= list.length) return FormulaError.NUM

	list.sort((a, b) => (largest ? b - a : a - b))

	return list[index] ?? FormulaError.NUM
}

// CLEAN: the text without the first 32 (non-printing) characters of the 7-bit ASCII code.
function clean(text: string): string {
	let out = ""

	for (const char of text) if (char.charCodeAt(0) >= 32) out += char

	return out
}

// PROPER: the first letter of each word up, the rest down; a letter is what has a case.
function proper(text: string): string {
	let out = ""
	let after = false

	for (const char of text) {
		const lower = char.toLowerCase()
		const letter = lower !== char.toUpperCase()

		out += letter && !after ? char.toUpperCase() : lower
		after = letter
	}

	return out
}

function textFn(apply: (text: string) => Scalar): Fn {
	return unaryFn(value => {
		const text = toText(value)

		return text instanceof FormulaError ? text : apply(text)
	})
}

function isFn(test: (value: Scalar) => boolean): Fn {
	return (context, args) => {
		arity(args, 1, 1)

		const value = arg(context, args, 0)

		// A reference to one cell tests that cell; to many, each (array formula).
		return context.map1(value, test)
	}
}

function reference(context: FunctionContext, args: readonly FormulaNode[], index: number): FormulaRef | null {
	const value = arg(context, args, index)

	return isRef(value) ? value : null
}

// An array's values for a logical fold: the rest past what it stores is one value, given as often as XOR needs.
function logicalItems(array: FormulaArray): readonly Scalar[] {
	const tail = tailCells(array)
	const fill = array.fill ?? null

	if (tail === 0 || fill === null) return array.values

	return [...array.values, ...(tail % 2 === 1 ? [fill] : [fill, fill])]
}

function logicalFold(
	context: FunctionContext,
	args: readonly FormulaNode[],
	combine: (acc: boolean, value: boolean) => boolean,
	start: boolean
): FormulaValue {
	if (args.length === 0) throw new Unsupported("a logical function without arguments")

	let acc = start
	let any = false

	for (const node of args) {
		const value = context.node(node)
		const items = isRef(value) || isArray(value) ? logicalItems(context.array(value)) : [value]

		for (const item of items) {
			if (item instanceof FormulaError) return item
			// Text and blanks in references are ignored; given directly, text must read as a logical.
			if ((isRef(value) || isArray(value)) && (item === null || typeof item === "string")) continue

			const truth = toBoolean(item)

			if (truth instanceof FormulaError) return truth

			acc = combine(acc, truth)
			any = true
		}
	}

	return any ? acc : FormulaError.VALUE
}

function lookupVector(array: FormulaArray, index: number, byRows: boolean): Scalar[] | FormulaError {
	// A blank rest is left out (a blank never matches); one that is something else is read whole.
	const whole = (array.fill ?? null) !== null

	if (whole && array.rows * array.cols > MAX_TAIL) throw new Unsupported("an array too large")

	if (byRows) {
		if (index < 0 || index >= array.cols) return FormulaError.REF

		return Array.from({ length: whole ? array.rows : storedRows(array) }, (_, r) => arrayAt(array, r, index))
	}

	if (index < 0 || index >= array.rows) return FormulaError.REF

	return Array.from({ length: whole ? array.cols : storedCols(array) }, (_, c) => arrayAt(array, index, c))
}

function vhlookup(byRows: boolean): Fn {
	return (context, args) => {
		arity(args, 3, 4)

		const key = scalarArg(context, args, 0)
		const table = arg(context, args, 1)
		const index = numberArg(context, args, 2)
		const approximate = args.length < 4 ? true : toBoolean(scalarArg(context, args, 3))

		if (key instanceof FormulaError) return key
		if (index instanceof FormulaError) return index
		if (approximate instanceof FormulaError) return approximate
		if (index < 1) return FormulaError.VALUE

		// The table read once, and in a pass each vector of it made once.
		const array = context.array(table)
		const vector = (at: number): Scalar[] | FormulaError =>
			context.kept(array, `${byRows ? "col" : "row"} ${String(at)}`, () => lookupVector(array, at, byRows)) ??
			lookupVector(array, at, byRows)
		const keys = vector(0)
		const results = vector(Math.trunc(index) - 1)

		if (keys instanceof FormulaError) return keys
		if (results instanceof FormulaError) return results

		const at = lookupIndex(context, keys, key, approximate ? 1 : 0)

		return at < 0 ? FormulaError.NA : (results[at] ?? null)
	}
}

export const FUNCTIONS: ReadonlyMap<string, Fn> = new Map<string, Fn>([
	// --- Logical ---
	[
		"IF",
		(context, args) => {
			arity(args, 1, 3)

			const condition = scalarArg(context, args, 0)
			const truth = toBoolean(condition)

			if (truth instanceof FormulaError) return truth
			if (truth) return args.length < 2 ? true : (arg(context, args, 1) ?? 0)

			return args.length < 3 ? false : (arg(context, args, 2) ?? 0)
		}
	],
	[
		"IFS",
		(context, args) => {
			if (args.length < 2 || args.length % 2 !== 0) throw new Unsupported("IFS arguments")

			for (let k = 0; k < args.length; k += 2) {
				const truth = toBoolean(scalarArg(context, args, k))

				if (truth instanceof FormulaError) return truth
				if (truth) return arg(context, args, k + 1)
			}

			return FormulaError.NA
		}
	],
	["AND", (context, args) => logicalFold(context, args, (acc, value) => acc && value, true)],
	["OR", (context, args) => logicalFold(context, args, (acc, value) => acc || value, false)],
	["XOR", (context, args) => logicalFold(context, args, (acc, value) => acc !== value, false)],
	[
		"NOT",
		unaryFn(value => {
			const truth = toBoolean(value)

			return truth instanceof FormulaError ? truth : !truth
		})
	],
	["TRUE", () => true],
	["FALSE", () => false],
	[
		"IFERROR",
		(context, args) => {
			arity(args, 2, 2)

			const value = arg(context, args, 0)

			return context.map2(value, arg(context, args, 1), (a, b) => (a instanceof FormulaError ? b : a))
		}
	],
	[
		"IFNA",
		(context, args) => {
			arity(args, 2, 2)

			return context.map2(arg(context, args, 0), arg(context, args, 1), (a, b) => (a === FormulaError.NA ? b : a))
		}
	],
	[
		"CHOOSE",
		(context, args) => {
			if (args.length < 2) throw new Unsupported("CHOOSE arguments")

			const index = numberArg(context, args, 0)

			if (index instanceof FormulaError) return index

			const at = Math.trunc(index)

			return at < 1 || at >= args.length ? FormulaError.VALUE : arg(context, args, at)
		}
	],
	// --- Information ---
	["ISBLANK", isFn(value => value === null)],
	["ISERROR", isFn(value => value instanceof FormulaError)],
	["ISERR", isFn(value => value instanceof FormulaError && value !== FormulaError.NA)],
	["ISNA", isFn(value => value === FormulaError.NA)],
	["ISNUMBER", isFn(value => typeof value === "number")],
	["ISTEXT", isFn(value => typeof value === "string")],
	["ISNONTEXT", isFn(value => typeof value !== "string")],
	["ISLOGICAL", isFn(value => typeof value === "boolean")],
	[
		"ISREF",
		(context, args) => {
			arity(args, 1, 1)

			return isRef(arg(context, args, 0))
		}
	],
	["ISEVEN", numberFn(value => Math.trunc(value) % 2 === 0)],
	["ISODD", numberFn(value => Math.abs(Math.trunc(value)) % 2 === 1)],
	["NA", () => FormulaError.NA],
	[
		"N",
		(context, args) => {
			arity(args, 1, 1)

			const value = scalarArg(context, args, 0)

			return typeof value === "number" || value instanceof FormulaError ? value : typeof value === "boolean" ? (value ? 1 : 0) : 0
		}
	],
	[
		"T",
		(context, args) => {
			arity(args, 1, 1)

			const value = scalarArg(context, args, 0)

			return typeof value === "string" || value instanceof FormulaError ? value : ""
		}
	],
	// --- Text ---
	["LEN", textFn(text => text.length)],
	["TRIM", textFn(text => text.replace(/ +/gu, " ").replace(/^ | $/gu, ""))],
	["UPPER", textFn(text => text.toUpperCase())],
	["LOWER", textFn(text => text.toLowerCase())],
	["PROPER", textFn(proper)],
	["CLEAN", textFn(clean)],
	[
		"LEFT",
		(context, args) => {
			arity(args, 1, 2)

			const count = numberArg(context, args, 1, 1)

			if (count instanceof FormulaError) return count
			if (count < 0) return FormulaError.VALUE

			return context.map1(arg(context, args, 0), value => {
				const text = toText(value)

				return text instanceof FormulaError ? text : text.slice(0, Math.trunc(count))
			})
		}
	],
	[
		"RIGHT",
		(context, args) => {
			arity(args, 1, 2)

			const count = numberArg(context, args, 1, 1)

			if (count instanceof FormulaError) return count
			if (count < 0) return FormulaError.VALUE

			return context.map1(arg(context, args, 0), value => {
				const text = toText(value)

				return text instanceof FormulaError ? text : Math.trunc(count) === 0 ? "" : text.slice(-Math.trunc(count))
			})
		}
	],
	[
		"MID",
		(context, args) => {
			arity(args, 3, 3)

			const text = textArg(context, args, 0)
			const start = numberArg(context, args, 1)
			const count = numberArg(context, args, 2)

			if (text instanceof FormulaError) return text
			if (start instanceof FormulaError) return start
			if (count instanceof FormulaError) return count
			if (start < 1 || count < 0) return FormulaError.VALUE

			return text.slice(Math.trunc(start) - 1, Math.trunc(start) - 1 + Math.trunc(count))
		}
	],
	[
		"SEARCH",
		(context, args) => {
			arity(args, 2, 3)

			const find = textArg(context, args, 0)
			const start = numberArg(context, args, 2, 1)

			if (find instanceof FormulaError) return find
			if (start instanceof FormulaError) return start

			const pattern = wildcard(find)
			const needle = find.toUpperCase()

			return context.map1(arg(context, args, 1), value => {
				const text = toText(value)

				if (text instanceof FormulaError) return text
				if (start < 1 || start > text.length + 1) return FormulaError.VALUE

				const from = Math.trunc(start) - 1
				const at = pattern === null ? text.toUpperCase().indexOf(needle, from) : pattern.search(text, from)

				return at < 0 ? FormulaError.VALUE : at + 1
			})
		}
	],
	[
		"FIND",
		(context, args) => {
			arity(args, 2, 3)

			const find = textArg(context, args, 0)
			const start = numberArg(context, args, 2, 1)

			if (find instanceof FormulaError) return find
			if (start instanceof FormulaError) return start

			return context.map1(arg(context, args, 1), value => {
				const text = toText(value)

				if (text instanceof FormulaError) return text
				if (start < 1 || start > text.length + 1) return FormulaError.VALUE

				const at = text.indexOf(find, Math.trunc(start) - 1)

				return at < 0 ? FormulaError.VALUE : at + 1
			})
		}
	],
	[
		"EXACT",
		(context, args) => {
			arity(args, 2, 2)

			return context.map2(arg(context, args, 0), arg(context, args, 1), (a, b) => {
				const x = toText(a)
				const y = toText(b)

				return x instanceof FormulaError ? x : y instanceof FormulaError ? y : x === y
			})
		}
	],
	[
		"CONCATENATE",
		(context, args) => {
			let text = ""

			for (let k = 0; k < args.length; k++) {
				const part = textArg(context, args, k)

				if (part instanceof FormulaError) return part

				text += part
			}

			return text
		}
	],
	[
		"CONCAT",
		(context, args) => {
			let text = ""

			for (const node of args) {
				for (const value of denseValues(context.array(context.node(node)), MAX_TAIL)) {
					const part = toText(value)

					if (part instanceof FormulaError) return part

					text += part
				}
			}

			return text
		}
	],
	[
		"SUBSTITUTE",
		(context, args) => {
			arity(args, 3, 4)

			const text = textArg(context, args, 0)
			const from = textArg(context, args, 1)
			const to = textArg(context, args, 2)
			const which = args.length < 4 ? 0 : numberArg(context, args, 3)

			if (text instanceof FormulaError) return text
			if (from instanceof FormulaError) return from
			if (to instanceof FormulaError) return to
			if (which instanceof FormulaError) return which
			if (from === "") return text
			if (which === 0) return text.split(from).join(to)
			if (which < 1) return FormulaError.VALUE

			let at = -1

			for (let k = 0; k < Math.trunc(which); k++) {
				at = text.indexOf(from, at + 1)

				if (at < 0) return text
			}

			return text.slice(0, at) + to + text.slice(at + from.length)
		}
	],
	[
		"REPT",
		(context, args) => {
			arity(args, 2, 2)

			const text = textArg(context, args, 0)
			const count = numberArg(context, args, 1)

			if (text instanceof FormulaError) return text
			if (count instanceof FormulaError) return count
			if (count < 0 || text.length * Math.trunc(count) > 32_767) return FormulaError.VALUE

			return text.repeat(Math.trunc(count))
		}
	],
	["VALUE", textFn(text => textNumber(text) ?? FormulaError.VALUE)],
	[
		"TEXT",
		(context, args) => {
			arity(args, 2, 2)

			const value = scalarArg(context, args, 0)
			const code = textArg(context, args, 1)

			if (value instanceof FormulaError) return value
			if (code instanceof FormulaError) return code

			const number = typeof value === "number" ? value : typeof value === "string" ? textNumber(value) : null

			return formatValue(number ?? (value === null ? 0 : (toText(value) as string)), code, { date1904: context.host.date1904 }).text
		}
	],
	["CHAR", numberFn(value => (value >= 1 && value <= 255 ? String.fromCharCode(Math.trunc(value)) : FormulaError.VALUE))],
	["CODE", textFn(text => (text === "" ? FormulaError.VALUE : text.charCodeAt(0)))],
	// --- Math ---
	[
		"SUM",
		(context, args) => {
			let sum = 0

			return numbers(context, args, value => (sum += value)) ?? sum
		}
	],
	[
		"AVERAGE",
		(context, args) => {
			let sum = 0
			let count = 0
			const error = numbers(context, args, value => {
				sum += value
				count++
			})

			return error ?? (count === 0 ? FormulaError.DIV0 : sum / count)
		}
	],
	[
		"MIN",
		(context, args) => {
			let min = Number.POSITIVE_INFINITY

			return numbers(context, args, value => (min = Math.min(min, value))) ?? (min === Number.POSITIVE_INFINITY ? 0 : min)
		}
	],
	[
		"MAX",
		(context, args) => {
			let max = Number.NEGATIVE_INFINITY

			return numbers(context, args, value => (max = Math.max(max, value))) ?? (max === Number.NEGATIVE_INFINITY ? 0 : max)
		}
	],
	[
		"MEDIAN",
		(context, args) => {
			const list = collect(context, args)

			return list instanceof FormulaError ? list : median(list)
		}
	],
	[
		"PRODUCT",
		(context, args) => {
			let product = 1

			return numbers(context, args, value => (product *= value)) ?? product
		}
	],
	[
		"COUNT",
		(context, args) => {
			let count = 0

			for (const node of args) {
				const value = context.node(node)

				if (isRef(value)) context.host.forEach(value, (_row, _col, cell) => typeof cell === "number" && count++)
				else if (isArray(value))
					count +=
						value.values.filter(item => typeof item === "number").length +
						(typeof value.fill === "number" ? tailCells(value) : 0)
				else if (
					typeof value === "number" ||
					typeof value === "boolean" ||
					(typeof value === "string" && textNumber(value) !== null)
				)
					count++
			}

			return count
		}
	],
	[
		"COUNTA",
		(context, args) => {
			let count = 0

			for (const node of args) {
				if (node.kind === "missing") continue

				const value = context.node(node)

				if (isRef(value)) context.host.forEach(value, (_row, _col, cell) => cell !== null && count++)
				else if (isArray(value))
					count += value.values.filter(item => item !== null).length + ((value.fill ?? null) !== null ? tailCells(value) : 0)
				else count++
			}

			return count
		}
	],
	[
		"COUNTBLANK",
		(context, args) => {
			arity(args, 1, 1)

			return counted(context, arg(context, args, 0), value => value === null || value === "")
		}
	],
	[
		"SUMPRODUCT",
		(context, args) => {
			if (args.length === 0) throw new Unsupported("SUMPRODUCT arguments")

			const arrays = args.map(node => context.array(context.node(node)))
			const first = arrays[0] as FormulaArray

			if (arrays.some(array => array.rows !== first.rows || array.cols !== first.cols)) return FormulaError.VALUE

			// Over the part any array stores, then the rest at once: there every array is its fill.
			const rows = Math.max(...arrays.map(storedRows))
			const cols = Math.max(...arrays.map(storedCols))
			let sum = 0

			for (let r = 0; r < rows; r++) {
				for (let c = 0; c < cols; c++) {
					let product = 1

					for (const array of arrays) {
						const value = arrayAt(array, r, c)

						if (value instanceof FormulaError) return value

						product *= typeof value === "number" ? value : 0
					}

					sum += product
				}
			}

			const rest = first.rows * first.cols - rows * cols

			if (rest > 0) {
				let product = 1

				for (const array of arrays) {
					const value = array.fill ?? null

					if (value instanceof FormulaError) return value

					product *= typeof value === "number" ? value : 0
				}

				sum += product * rest
			}

			return sum
		}
	],
	["LARGE", (context, args) => nth(context, args, true)],
	["SMALL", (context, args) => nth(context, args, false)],
	[
		"MOD",
		(context, args) => {
			arity(args, 2, 2)

			return context.map2(arg(context, args, 0), arg(context, args, 1), (a, b) => {
				const x = toNumber(a)
				const y = toNumber(b)

				if (x instanceof FormulaError) return x
				if (y instanceof FormulaError) return y
				if (y === 0) return FormulaError.DIV0

				return x - y * Math.floor(x / y)
			})
		}
	],
	["ABS", numberFn(value => Math.abs(value))],
	["INT", numberFn(value => Math.floor(value))],
	["SIGN", numberFn(value => Math.sign(value))],
	["SQRT", numberFn(value => (value < 0 ? FormulaError.NUM : Math.sqrt(value)))],
	[
		"POWER",
		(context, args) => {
			arity(args, 2, 2)

			const x = numberArg(context, args, 0)
			const y = numberArg(context, args, 1)

			if (x instanceof FormulaError) return x
			if (y instanceof FormulaError) return y

			const result = x ** y

			return Number.isFinite(result) ? result : FormulaError.NUM
		}
	],
	...(["ROUND", "ROUNDDOWN", "ROUNDUP"] as const).map((name): [string, Fn] => [
		name,
		(context, args) => {
			arity(args, 1, 2)

			const digits = numberArg(context, args, 1, 0)

			if (digits instanceof FormulaError) return digits

			return context.map1(arg(context, args, 0), value => {
				const number = toNumber(value)

				return number instanceof FormulaError
					? number
					: round(number, digits, name === "ROUND" ? "half" : name === "ROUNDDOWN" ? "down" : "up")
			})
		}
	]),
	...(["FLOOR", "CEILING"] as const).map((name): [string, Fn] => [
		name,
		(context, args) => {
			arity(args, 1, 2)

			const value = numberArg(context, args, 0)
			const step = numberArg(context, args, 1, 1)

			if (value instanceof FormulaError) return value
			if (step instanceof FormulaError) return step
			if (step === 0) return 0
			if (value > 0 && step < 0) return FormulaError.NUM

			const units = value / step
			const whole = Number(units.toPrecision(15))

			return (name === "FLOOR" ? Math.floor(whole) : Math.ceil(whole)) * step
		}
	]),
	[
		"COUNTIF",
		(context, args) => {
			arity(args, 2, 2)

			const range = arg(context, args, 0)
			const test = criterion(scalarArg(context, args, 1))

			if (!isRef(range) && !isArray(range)) return FormulaError.VALUE

			return counted(context, range, value => test.test(value), test)
		}
	],
	[
		"COUNTIFS",
		(context, args) => {
			if (args.length < 2 || args.length % 2 !== 0) throw new Unsupported("COUNTIFS arguments")

			const pairs = criteriaPairs(context, args, null)

			return pairs instanceof FormulaError ? pairs : countPassing(pairs)
		}
	],
	[
		"SUMIF",
		(context, args) => {
			arity(args, 2, 3)

			const range = reference(context, args, 0)

			if (range === null) return FormulaError.VALUE

			const pairs = criteriaPairs(context, args.slice(0, 2), null)
			const target = args.length < 3 ? range : reference(context, args, 2)

			if (pairs instanceof FormulaError) return pairs
			if (target === null) return FormulaError.VALUE

			// The sum range takes the criteria range's size from its own top-left cell (support.microsoft.com "SUMIF").
			const sized = { ...target, endRow: target.startRow + refRows(range) - 1, endCol: target.startCol + refCols(range) - 1 }

			return sumAt(context, sized, pairs).sum
		}
	],
	[
		"SUMIFS",
		(context, args) => {
			if (args.length < 3 || args.length % 2 !== 1) throw new Unsupported("SUMIFS arguments")

			const target = reference(context, args, 0)

			if (target === null) return FormulaError.VALUE

			const pairs = criteriaPairs(context, args.slice(1), target)

			return pairs instanceof FormulaError ? pairs : sumAt(context, target, pairs).sum
		}
	],
	[
		"AVERAGEIF",
		(context, args) => {
			arity(args, 2, 3)

			const range = reference(context, args, 0)

			if (range === null) return FormulaError.VALUE

			const pairs = criteriaPairs(context, args.slice(0, 2), null)
			const target = args.length < 3 ? range : reference(context, args, 2)

			if (pairs instanceof FormulaError) return pairs
			if (target === null) return FormulaError.VALUE

			const { sum, count } = sumAt(
				context,
				{ ...target, endRow: target.startRow + refRows(range) - 1, endCol: target.startCol + refCols(range) - 1 },
				pairs
			)

			return count === 0 ? FormulaError.DIV0 : sum / count
		}
	],
	[
		"AVERAGEIFS",
		(context, args) => {
			if (args.length < 3 || args.length % 2 !== 1) throw new Unsupported("AVERAGEIFS arguments")

			const target = reference(context, args, 0)

			if (target === null) return FormulaError.VALUE

			const pairs = criteriaPairs(context, args.slice(1), target)

			if (pairs instanceof FormulaError) return pairs

			const { sum, count } = sumAt(context, target, pairs)

			return count === 0 ? FormulaError.DIV0 : sum / count
		}
	],
	// --- Lookup and reference ---
	[
		"ROW",
		(context, args) => {
			arity(args, 0, 1)

			if (args.length === 0) return context.position.row + 1

			const ref = reference(context, args, 0)

			return ref === null ? FormulaError.VALUE : ref.startRow + 1
		}
	],
	[
		"COLUMN",
		(context, args) => {
			arity(args, 0, 1)

			if (args.length === 0) return context.position.col + 1

			const ref = reference(context, args, 0)

			return ref === null ? FormulaError.VALUE : ref.startCol + 1
		}
	],
	[
		"ROWS",
		(context, args) => {
			arity(args, 1, 1)

			const value = arg(context, args, 0)

			return isRef(value) ? refRows(value) : isArray(value) ? value.rows : 1
		}
	],
	[
		"COLUMNS",
		(context, args) => {
			arity(args, 1, 1)

			const value = arg(context, args, 0)

			return isRef(value) ? refCols(value) : isArray(value) ? value.cols : 1
		}
	],
	[
		"INDEX",
		(context, args) => {
			arity(args, 2, 3)

			const table = arg(context, args, 0)
			const row = numberArg(context, args, 1, 0)
			const col = numberArg(context, args, 2, 0)

			if (row instanceof FormulaError) return row
			if (col instanceof FormulaError) return col

			const rows = isRef(table) ? refRows(table) : isArray(table) ? table.rows : 1
			const cols = isRef(table) ? refCols(table) : isArray(table) ? table.cols : 1
			// One row or column: the single index runs along it.
			let r = Math.trunc(row)
			let c = Math.trunc(col)

			if (args.length === 2 && rows === 1) {
				c = r
				r = 1
			} else if (args.length === 2 && cols === 1) {
				c = 1
			}

			if (r < 0 || c < 0 || r > rows || c > cols) return FormulaError.REF

			if (isRef(table)) {
				return {
					kind: "ref",
					sheet: table.sheet,
					startRow: r === 0 ? table.startRow : table.startRow + r - 1,
					endRow: r === 0 ? table.endRow : table.startRow + r - 1,
					startCol: c === 0 ? table.startCol : table.startCol + c - 1,
					endCol: c === 0 ? table.endCol : table.startCol + c - 1
				}
			}

			if (r === 0 || c === 0) throw new Unsupported("INDEX of a whole array row or column")

			return isArray(table) ? arrayAt(table, r - 1, c - 1) : table
		}
	],
	[
		"MATCH",
		(context, args) => {
			arity(args, 2, 3)

			const key = scalarArg(context, args, 0)
			const mode = numberArg(context, args, 2, 1)

			if (key instanceof FormulaError) return key
			if (mode instanceof FormulaError) return mode

			const array = context.array(arg(context, args, 1))

			if (array.rows !== 1 && array.cols !== 1) return FormulaError.NA

			const at = lookupIndex(
				context,
				context.kept(array, "vector", () => vectorValues(array)) ?? vectorValues(array),
				key,
				Math.sign(Math.trunc(mode))
			)

			return at < 0 ? FormulaError.NA : at + 1
		}
	],
	["VLOOKUP", vhlookup(true)],
	["HLOOKUP", vhlookup(false)],
	[
		"OFFSET",
		(context, args) => {
			arity(args, 3, 5)

			const base = reference(context, args, 0)
			const rows = numberArg(context, args, 1)
			const cols = numberArg(context, args, 2)

			if (base === null) return FormulaError.VALUE
			if (rows instanceof FormulaError) return rows
			if (cols instanceof FormulaError) return cols

			const height = numberArg(context, args, 3, refRows(base))
			const width = numberArg(context, args, 4, refCols(base))

			if (height instanceof FormulaError) return height
			if (width instanceof FormulaError) return width

			const startRow = base.startRow + Math.trunc(rows)
			const startCol = base.startCol + Math.trunc(cols)
			const h = Math.trunc(height)
			const w = Math.trunc(width)

			if (h === 0 || w === 0) return FormulaError.REF

			const endRow = startRow + (h > 0 ? h - 1 : h + 1)
			const endCol = startCol + (w > 0 ? w - 1 : w + 1)
			const top = Math.min(startRow, endRow)
			const left = Math.min(startCol, endCol)
			const bottom = Math.max(startRow, endRow)
			const right = Math.max(startCol, endCol)

			if (top < 0 || left < 0 || bottom >= SHEET_MAX_ROWS || right >= SHEET_MAX_COLS) return FormulaError.REF

			return { kind: "ref", sheet: base.sheet, startRow: top, startCol: left, endRow: bottom, endCol: right }
		}
	],
	[
		"INDIRECT",
		(context, args) => {
			arity(args, 1, 2)

			const text = textArg(context, args, 0)
			const a1 = args.length < 2 ? true : toBoolean(scalarArg(context, args, 1))

			if (text instanceof FormulaError) return text
			if (a1 instanceof FormulaError) return a1
			if (!a1) throw new Unsupported("INDIRECT in R1C1 style")

			let node: FormulaNode

			try {
				node = parseFormula(text).root
			} catch {
				return FormulaError.REF
			}

			if (node.kind !== "area" && node.kind !== "name" && !(node.kind === "binary" && node.op === ":")) return FormulaError.REF

			// The text is read as written: its references are where it says (relative ones taken from A1).
			const value = context.node(absolute(node))

			return isRef(value) ? value : FormulaError.REF
		}
	],
	[
		"ADDRESS",
		(context, args) => {
			arity(args, 2, 5)

			const row = numberArg(context, args, 0)
			const col = numberArg(context, args, 1)
			const kind = numberArg(context, args, 2, 1)
			const a1 = args.length < 4 || args[3]?.kind === "missing" ? true : toBoolean(scalarArg(context, args, 3))
			const sheet = args.length < 5 ? null : textArg(context, args, 4)

			if (row instanceof FormulaError) return row
			if (col instanceof FormulaError) return col
			if (kind instanceof FormulaError) return kind
			if (a1 instanceof FormulaError) return a1
			if (sheet instanceof FormulaError) return sheet
			if (!a1) throw new Unsupported("ADDRESS in R1C1 style")

			const r = Math.trunc(row)
			const c = Math.trunc(col)

			if (r < 1 || c < 1 || r > SHEET_MAX_ROWS || c > SHEET_MAX_COLS || kind < 1 || kind > 4) return FormulaError.VALUE

			const rowAbs = kind === 1 || kind === 2
			const colAbs = kind === 1 || kind === 3
			const address = `${colAbs ? "$" : ""}${columnName(c - 1)}${rowAbs ? "$" : ""}${String(r)}`

			if (sheet === null) return address

			return `${/^[A-Za-z_][\w.]*$/u.test(sheet) ? sheet : `'${sheet.replace(/'/gu, "''")}'`}!${address}`
		}
	],
	// --- Dates and times ---
	["TODAY", context => context.host.today()],
	["NOW", context => context.host.now()],
	[
		"DATE",
		(context, args) => {
			arity(args, 3, 3)

			const year = numberArg(context, args, 0)
			const month = numberArg(context, args, 1)
			const day = numberArg(context, args, 2)

			if (year instanceof FormulaError) return year
			if (month instanceof FormulaError) return month
			if (day instanceof FormulaError) return day

			return makeDate(context, year, month, day)
		}
	],
	...(["YEAR", "MONTH", "DAY"] as const).map((name): [string, Fn] => [
		name,
		(context, args) => {
			arity(args, 1, 1)

			return context.map1(arg(context, args, 0), value => {
				const serial = toNumber(value)

				if (serial instanceof FormulaError) return serial

				const parts = dateParts(context, serial)

				if (parts instanceof FormulaError) return parts

				return name === "YEAR" ? parts.year : name === "MONTH" ? parts.month : parts.day
			})
		}
	]),
	[
		"WEEKDAY",
		(context, args) => {
			arity(args, 1, 2)

			const serial = numberArg(context, args, 0)
			const type = numberArg(context, args, 1, 1)

			if (serial instanceof FormulaError) return serial
			if (type instanceof FormulaError) return type

			const parts = dateParts(context, serial)

			if (parts instanceof FormulaError) return parts

			// 0 Sunday .. 6 Saturday.
			const day = parts.weekday

			switch (Math.trunc(type)) {
				case 1:
				case 17:
					return day + 1
				case 2:
				case 11:
					return ((day + 6) % 7) + 1
				case 3:
					return (day + 6) % 7
				case 12:
				case 13:
				case 14:
				case 15:
				case 16:
					return ((day - (Math.trunc(type) - 10) + 7) % 7) + 1
				default:
					return FormulaError.NUM
			}
		}
	],
	...(["EDATE", "EOMONTH"] as const).map((name): [string, Fn] => [
		name,
		(context, args) => {
			arity(args, 2, 2)

			const serial = numberArg(context, args, 0)
			const months = numberArg(context, args, 1)

			if (serial instanceof FormulaError) return serial
			if (months instanceof FormulaError) return months

			return addMonths(context, serial, months, name === "EOMONTH")
		}
	]),
	...(["HOUR", "MINUTE", "SECOND"] as const).map((name): [string, Fn] => [
		name,
		numberFn(value => {
			if (value < 0) return FormulaError.NUM

			const seconds = Math.round((value - Math.floor(value)) * 86_400) % 86_400

			return name === "HOUR" ? Math.floor(seconds / 3600) : name === "MINUTE" ? Math.floor(seconds / 60) % 60 : seconds % 60
		})
	]),
	[
		"TIME",
		(context, args) => {
			arity(args, 3, 3)

			const hour = numberArg(context, args, 0)
			const minute = numberArg(context, args, 1)
			const second = numberArg(context, args, 2)

			if (hour instanceof FormulaError) return hour
			if (minute instanceof FormulaError) return minute
			if (second instanceof FormulaError) return second

			const total = Math.trunc(hour) * 3600 + Math.trunc(minute) * 60 + Math.trunc(second)

			return total < 0 ? FormulaError.NUM : (total % 86_400) / 86_400
		}
	],
	[
		"DAYS",
		(context, args) => {
			arity(args, 2, 2)

			const end = numberArg(context, args, 0)
			const start = numberArg(context, args, 1)

			if (end instanceof FormulaError) return end
			if (start instanceof FormulaError) return start

			return Math.floor(end) - Math.floor(start)
		}
	]
])

// A reference as INDIRECT reads it: every part absolute.
function absolute(node: FormulaNode): FormulaNode {
	if (node.kind === "area")
		return { kind: "area", ref: { ...node.ref, startRowAbs: true, startColAbs: true, endRowAbs: true, endColAbs: true } }
	if (node.kind === "binary") return { ...node, left: absolute(node.left), right: absolute(node.right) }

	return node
}
