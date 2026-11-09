import { ISO_1900, type DateBase } from "../../numfmt/date"
import { textNumberParser } from "../../input/locale"
import { parserLocale } from "../textDates"
import {
	ArraySize,
	CellError,
	EmptyValue,
	ErrorType,
	FunctionArgumentType,
	FunctionPlugin,
	HyperFormula,
	SimpleRangeValue,
	type ConfigParams,
	type FunctionArgument,
	type SimpleCellAddress
} from "hyperformula"
import { MAX_COLUMNS, MAX_ROWS } from "../../model/model"

// The engine's plugin types, read from the plugin class (HyperFormula does not export them by name).
type RunFunction = FunctionPlugin["runFunction"]
export type PluginAst = Parameters<RunFunction>[0][number]
export type PluginState = Parameters<RunFunction>[1]
export type PluginValue = ReturnType<FunctionPlugin["evaluateAst"]>
export type PluginScalar = Exclude<PluginValue, SimpleRangeValue>
export type PluginRange = NonNullable<SimpleRangeValue["range"]>
type Helper = FunctionPlugin["arithmeticHelper"]
type Interpreter = ConstructorParameters<typeof FunctionPlugin>[0]

// A function call as the engine hands it to a plugin method.
export interface PluginCall {
	readonly args: PluginAst[]
	readonly procedureName: string
}

// Whether a row of a sheet (the engine's sheet id) is shown, hidden, or hidden by a filter, as the engine running now
// says (formulaEngine.ts sets it around every calculation).
export const ROW_SHOWN = 0
export const ROW_HIDDEN = 1
export const ROW_FILTERED = 2

export type RowState = (sheet: number, row: number) => number

let rowState: RowState | null = null

export function withRowState<T>(state: RowState | null, work: () => T): T {
	const previous = rowState

	rowState = state

	try {
		return work()
	} finally {
		rowState = previous
	}
}

export function rowStateOf(sheet: number, row: number): number {
	return rowState === null ? ROW_SHOWN : rowState(sheet, row)
}

// The longest text a cell holds ("Excel specifications and limits"): longer results are #VALUE!.
export const MAX_TEXT = 32767

// A number as text in a formula (""&A1): at most 15 significant digits, exponential from 1E+15 and below 1E-9.
export function numberText(value: number): string {
	if (value === 0 || !Number.isFinite(value)) return "0"

	const rounded = Number(value.toPrecision(15))
	const exponent = Math.floor(Math.log10(Math.abs(rounded)))

	if (exponent >= 15 || exponent < -9) {
		const [mantissa = "0", power = "0"] = rounded.toExponential().split("e")
		const shift = Number(power)

		return `${mantissa}E${shift < 0 ? "-" : "+"}${String(Math.abs(shift)).padStart(2, "0")}`
	}

	return String(rounded).includes("e")
		? rounded.toFixed(Math.min(100, Math.max(0, 14 - exponent))).replace(/\.?0+$/, "")
		: String(rounded)
}

// A value as text, as & and the text functions read it.
export function textOf(value: PluginScalar): string | CellError {
	if (value instanceof CellError) return value
	if (value === EmptyValue) return ""
	if (typeof value === "string") return value
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE"

	return numberText(rawNumber(value) ?? 0)
}

// The engine's helpers adjusted to Excel, once per engine (they are shared by every plugin of one engine).
const adjusted = new WeakSet<object>()

type Compared = PluginScalar
type ExcelHelper = {
	readonly config: {
		readonly parseDateTime: ConfigParams["parseDateTime"]
		readonly useWildcards: boolean
		readonly useRegularExpressions: boolean
		readonly matchWholeCell: boolean
	}
	compare(left: Compared, right: Compared): number
	stringCmp(left: string, right: string): number
	buildRegex(pattern: string, matchWholeCell?: boolean): RegExp
	normalizeString(text: string): string
}
type ExcelInterpreter = { concatOp: (left: PluginScalar, right: PluginScalar) => PluginScalar }

// A character a regular expression reads as syntax.
const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|/-]/

// Where the engine's own coercion differs from Excel's, for every function and operator of one engine:
// - text that is empty ("" from a formula) is not a number, so ""*2 and ""+1 are #VALUE! (the engine read it as 0).
//   An empty cell still is 0;
// - text reads as a number as Excel reads it, in the session's locale (input/locale.ts textNumber): "1,000"*1 is 1000
//   in en-US and "1.000,5"*1 1000.5 in de-DE (the engine took only plain digits with "." and "$"). Dates and times
//   still read after it, through the engine's parseDateTime (formula/textDates.ts);
// - text compares as text: never equal to a number, after every number and before every logical value, even text
//   that reads as a date ("1/1/2020"=DATE(2020,1,1) is FALSE; the engine compared the date). =, <, SORT, UNIQUE and
//   the others compare through compare;
// - a wildcard ? is exactly one character (the engine's matched none too) and every other character of a pattern is
//   itself ("a|c" was an alternation): COUNTIF and the other criteria, SEARCH, XLOOKUP's match_mode 2;
// - & turns a number into its General text (numberText; the engine's gave all 17 digits) and gives #VALUE! past
//   MAX_TEXT characters.
function adjustToExcel(interpreter: Interpreter, helper: Helper): void {
	if (adjusted.has(helper)) return

	adjusted.add(helper)

	const coerce = helper.coerceNonDateScalarToMaybeNumber.bind(helper)
	const excel = helper as unknown as ExcelHelper
	const config = excel.config
	const read = textNumberParser(parserLocale(config.parseDateTime))

	helper.coerceNonDateScalarToMaybeNumber = arg => (typeof arg === "string" ? (arg === "" ? undefined : read(arg)) : coerce(arg))

	const compare = excel.compare.bind(excel)
	const text = excel.stringCmp.bind(excel)

	excel.compare = (left, right) => {
		if (typeof left === "string") {
			if (typeof right === "string") return text(left, right)

			return right === EmptyValue ? text(left, "") : typeof right === "boolean" ? -1 : 1
		}

		if (typeof right === "string") return left === EmptyValue ? text("", right) : typeof left === "boolean" ? 1 : -1

		return compare(left, right)
	}

	const buildRegex = excel.buildRegex.bind(excel)

	excel.buildRegex = (pattern, matchWholeCell = true) => {
		if (config.useRegularExpressions || !config.useWildcards) return buildRegex(pattern, matchWholeCell)

		const normalized = excel.normalizeString(pattern)
		let source = ""

		for (let index = 0; index < normalized.length; index++) {
			let char = normalized.charAt(index)

			if (char === "*") source += "[^]*"
			else if (char === "?") source += "[^]"
			else {
				if (char === "~" && index + 1 < normalized.length) char = normalized.charAt(++index)

				source += REGEX_SYNTAX.test(char) ? `\\${char}` : char
			}
		}

		return new RegExp(config.matchWholeCell && matchWholeCell ? `^(?:${source})$` : source)
	}

	;(interpreter as unknown as ExcelInterpreter).concatOp = (left, right) => {
		const first = textOf(left)

		if (first instanceof CellError) return first

		const second = textOf(right)

		if (second instanceof CellError) return second

		return first.length + second.length > MAX_TEXT ? valueError() : first + second
	}
}

let textInstalled = false

// The engine's own text functions as Excel's, once: a number argument read as its General text (numberText; the
// engine's gave all 17 digits), REPT past MAX_TEXT characters #VALUE! before it builds the text.
function installExcelText(): void {
	if (textInstalled) return

	textInstalled = true

	const SCALAR: FunctionArgument = { argumentType: FunctionArgumentType.SCALAR }
	type Coerce = (this: FunctionPlugin, arg: unknown, type: FunctionArgument, state: unknown) => unknown
	const plugin = FunctionPlugin.prototype as unknown as { coerceToType: Coerce }
	const coerce = plugin.coerceToType

	plugin.coerceToType = function (arg, type, state) {
		if (type.argumentType !== FunctionArgumentType.STRING) return coerce.call(this, arg, type, state)

		const value = arg instanceof SimpleRangeValue ? coerce.call(this, arg, SCALAR, state) : arg

		return value === undefined ? undefined : textOf(value as PluginScalar)
	}

	const text = HyperFormula.getFunctionPlugin("REPT")?.prototype as unknown as
		| {
				flattenArgToStrings?: (arg: PluginValue) => string[] | CellError
				rept?: (this: FunctionPlugin, ast: PluginCall, state: PluginState) => unknown
		  }
		| undefined

	if (text === undefined) throw new Error("No REPT")

	// TEXTJOIN's delimiters and texts.
	text.flattenArgToStrings = arg => {
		const out: string[] = []

		for (const value of arg instanceof SimpleRangeValue ? arg.valuesFromTopLeftCorner() : [arg]) {
			// The engine types the empty value as any symbol.
			const item = textOf(value as PluginScalar)

			if (item instanceof CellError) return item

			out.push(item)
		}

		return out
	}

	text.rept = function (ast, state) {
		return this.runFunction(ast.args, state, this.metadata("REPT"), (repeated: string, count: number) => {
			if (count < 0) return valueError()

			const times = Math.trunc(count)

			// NaN (0 × an infinite count) is out of range too.
			return repeated.length * times <= MAX_TEXT ? repeated.repeat(times) : valueError()
		})
	}

	// Every result the engine's functions give through runFunction, one cell of a lifted call each.
	type Wrap = (this: FunctionPlugin, value: unknown, ...rest: unknown[]) => unknown
	const result = FunctionPlugin.prototype as unknown as { returnNumberWrapper: Wrap }
	const wrapNumber = result.returnNumberWrapper

	result.returnNumberWrapper = function (value, ...rest) {
		return typeof value === "string" && value.length > MAX_TEXT ? valueError() : wrapNumber.call(this, value, ...rest)
	}
}

// Every plugin of the app's own: the engine it runs in coerces as Excel does (adjustToExcel).
export abstract class SheetFunctionPlugin extends FunctionPlugin {
	constructor(interpreter: Interpreter) {
		super(interpreter)
		adjustToExcel(interpreter, this.arithmeticHelper)
	}

	// A number from a value as the engine coerces one (#VALUE! for text that reads as none).
	protected numberOf(value: PluginScalar): number | CellError {
		const number = this.coerceScalarToNumberOrError(value)

		return number instanceof CellError ? number : typeof number === "number" ? number : number.val
	}

	// The formula text of a cell, or undefined for a cell without one.
	protected formulaAt(address: SimpleCellAddress): string | undefined {
		return this.serialization.getCellFormula(address)
	}
}

// Thrown to unwind a calculation part-way, to be calculated again (functions/lambda.ts): never a cell's error.
export class EvaluationSuspended extends Error {}

// The error a function's JavaScript failure gives its cell: a number out of what JavaScript can work with (a
// RangeError: digits, lengths, a call stack too deep; SpiderMonkey's InternalError for "too much recursion") is #NUM!,
// anything else #VALUE!. The engine would let it escape the calculation and fail every later edit of the workbook.
function thrown(error: unknown): CellError {
	if (error instanceof CellError) return error
	if (error instanceof EvaluationSuspended) throw error

	const tooLarge = error instanceof RangeError || (error instanceof Error && error.name === "InternalError")

	return new CellError(tooLarge ? ErrorType.NUM : ErrorType.VALUE)
}

const guarded = new WeakSet<object>()

type PluginMethod = (this: unknown, ...args: unknown[]) => unknown

// Every function the engine knows (its own and the app's, registered by now) gives a failure as its cell's error.
// The engine calls them by method name on each plugin class's instance, so each class's methods are wrapped, once.
// Text past MAX_TEXT characters is #VALUE! too. The engine's text functions are made Excel's first (installExcelText).
export function guardFunctionPlugins(): void {
	installExcelText()

	for (const plugin of HyperFormula.getAllFunctionPlugins()) {
		const prototype = plugin.prototype as unknown as Record<string, unknown>

		for (const definition of Object.values(plugin.implementedFunctions)) {
			for (const [name, failed] of [
				[definition.method, thrown],
				[
					definition.sizeOfResultArrayMethod,
					(error: unknown) => {
						if (error instanceof EvaluationSuspended) throw error

						return ArraySize.scalar()
					}
				]
			] as const) {
				const method = name === undefined ? undefined : prototype[name]

				if (name === undefined || typeof method !== "function" || guarded.has(method)) continue

				const run = method as PluginMethod
				const wrapped: PluginMethod = function (this: unknown, ...args: unknown[]) {
					try {
						const result = run.apply(this, args)

						return typeof result === "string" && result.length > MAX_TEXT ? valueError() : result
					} catch (error) {
						return failed(error)
					}
				}

				guarded.add(wrapped)
				prototype[name] = wrapped
			}
		}
	}
}

// Whether a function was lifted over an array while `work` calculated: a range or array where it takes one value,
// so it gave an array of its results (Excel's dynamic arrays; the engine's vectorization).
let lifting: { lifted: boolean } | null = null

export function trackLifts<T>(work: () => T): { readonly value: T; readonly lifted: boolean } {
	const previous = lifting
	const tracked = { lifted: false }

	lifting = tracked

	try {
		return { value: work(), lifted: tracked.lifted }
	} finally {
		lifting = previous
	}
}

let liftsInstalled = false

// The engine sizes every lifted call's result before calculating it: a size past one cell is a lift.
export function installLiftTracking(): void {
	if (liftsInstalled) return

	liftsInstalled = true

	const prototype = FunctionPlugin.prototype as unknown as {
		calculateSizeOfVectorizedResultArray: (...args: unknown[]) => [number, number]
	}
	const size = prototype.calculateSizeOfVectorizedResultArray

	prototype.calculateSizeOfVectorizedResultArray = function (this: unknown, ...args: unknown[]) {
		const result = size.apply(this, args)

		if (lifting !== null && (result[0] > 1 || result[1] > 1)) lifting.lifted = true

		return result
	}
}

// The cells of a whole column (row) past where the engine ends reading it (formula/wholeRanges.ts), every one of
// them empty: Excel's columns have all 1,048,576 rows and its rows 16,384 columns.
export function wholeTail(value: SimpleRangeValue): number {
	const range = value.range

	if (range === undefined) return 0
	if (range.end.row === Number.POSITIVE_INFINITY) return Math.max(0, MAX_ROWS - range.start.row - value.height()) * value.width()
	if (range.end.col === Number.POSITIVE_INFINITY) return Math.max(0, MAX_COLUMNS - range.start.col - value.width()) * value.height()

	return 0
}

export function valueError(): CellError {
	return new CellError(ErrorType.VALUE)
}

export function naError(): CellError {
	return new CellError(ErrorType.NA)
}

export function numError(): CellError {
	return new CellError(ErrorType.NUM)
}

export function divError(): CellError {
	return new CellError(ErrorType.DIV_BY_ZERO)
}

// Excel's #CALC! (an array function given nothing to return), which the engine has no type of its own for: an
// error of its generic type with this message, given out as "#CALC!" (formulaEngine.ts).
export const CALC_ERROR = "#CALC!"

export function calcError(): CellError {
	return new CellError(ErrorType.ERROR, CALC_ERROR)
}

// Excel's #NULL! (references that do not intersect), likewise the generic type with this message.
export const NULL_ERROR = "#NULL!"

export function nullError(): CellError {
	return new CellError(ErrorType.ERROR, NULL_ERROR)
}

// Every Excel error the engine has no type for, each the generic type with its text as message, and the number
// ERROR.TYPE gives it ("ERROR.TYPE function": #NULL! 1, #GETTING_DATA 8; #CONNECT! to #CALC! 10 to 14 are Excel's
// numbers for the errors newer than the page's table; #BUSY! has none there, so #N/A).
export const GENERIC_ERRORS: ReadonlyMap<string, number | undefined> = new Map([
	[NULL_ERROR, 1],
	["#GETTING_DATA", 8],
	["#CONNECT!", 10],
	["#BLOCKED!", 11],
	["#UNKNOWN!", 12],
	["#FIELD!", 13],
	[CALC_ERROR, 14],
	["#BUSY!", undefined]
])

// The text of an error of the generic type that stands for one of GENERIC_ERRORS; undefined for any other.
export function genericErrorText(error: { readonly type: ErrorType; readonly message?: string | undefined }): string | undefined {
	return error.type === ErrorType.ERROR && error.message !== undefined && GENERIC_ERRORS.has(error.message) ? error.message : undefined
}

// What a function gives where it reads a whole column past the engine's end and cannot tell what Excel's empty rows
// there give (formula/wholeRanges.ts): the engine's generic error with this message. The formula keeps the file's
// result (formulaEngine.ts), or shows the engine failing on it.
export const UNMODELED = "#FILEN.UNMODELED"

export function unmodeledError(): CellError {
	return new CellError(ErrorType.ERROR, UNMODELED)
}

// The workbook's date base as the engine's configuration gives it (formulaEngine.ts engineConfig): 1904, a Strict
// workbook's 1900 date base counted from 1899-12-30, or the 1900 system.
export function dateBaseOf(config: { readonly nullDate: { readonly year: number; readonly day: number } }): DateBase {
	return config.nullDate.year === 1904 ? true : config.nullDate.day === 30 ? ISO_1900 : false
}

export function refError(): CellError {
	return new CellError(ErrorType.REF)
}

// The plain number of an engine number (dates, percentages and currencies carry their format).
export function rawNumber(value: PluginScalar): number | undefined {
	if (typeof value === "number") return value
	if (typeof value === "object" && !(value instanceof CellError)) return value.val

	return undefined
}
