import {
	CellError,
	EmptyValue,
	ErrorType,
	FunctionArgumentType,
	SimpleRangeValue,
	type ImplementedFunctions,
	type SimpleCellAddress
} from "hyperformula"
import {
	divError,
	naError,
	numError,
	rawNumber,
	ROW_FILTERED,
	ROW_HIDDEN,
	ROW_SHOWN,
	rowStateOf,
	SheetFunctionPlugin,
	unwrap,
	valueError,
	wholeTail,
	type PluginAst,
	type PluginCall,
	type PluginScalar,
	type PluginState
} from "./plugin"
import { kth, mean, mode, percentileExclusive, percentileInclusive, sampleVariance, populationVariance } from "./statistics"

// SUBTOTAL, AGGREGATE and COUNTBLANK as Excel calculates them. SUBTOTAL and AGGREGATE leave out the cells of their
// references that hold a SUBTOTAL or AGGREGATE themselves, so totals of totals are not counted twice
// (support.microsoft.com "SUBTOTAL function": "If there are other subtotals within ref1, ref2,… (or nested
// subtotals), these nested subtotals are ignored to avoid double counting"). Rows a filter hides are left out by
// every SUBTOTAL ("The SUBTOTAL function ignores any rows that are not included in the result of a filter, no matter
// which function_num value you use"), rows hidden by hand too by 101-111 (the same page), and both by AGGREGATE's
// options 1, 3, 5 and 7. The engine is told what is hidden (formulaEngine.ts); only rows count, not columns, as in
// Excel.

const NESTED = /\b(?:SUBTOTAL|AGGREGATE)\s*\(/i
// Whether a formula cell's formula holds one, by the engine's vertex of it.
const NESTED_VERTICES = new WeakMap<object, boolean>()

interface Cell {
	readonly value: PluginScalar
	// Where it is, for a value read from a reference.
	readonly address?: SimpleCellAddress
}

// What one aggregate counts.
interface Totals {
	readonly numbers: number[]
	// Non-empty values, errors included (COUNTA).
	filled: number
	error: CellError | null
}

type Aggregate = (totals: Totals, k: PluginScalar | undefined) => number | CellError

function sum(numbers: readonly number[]): number {
	let total = 0

	for (const number of numbers) total += number

	return total
}

// The largest (sign 1) or smallest (sign -1) number, 0 for none. A loop: spread into Math.max, a range's numbers
// overflow the call stack.
function extreme(numbers: readonly number[], sign: 1 | -1): number {
	if (numbers.length === 0) return 0

	let best = numbers[0] ?? 0

	for (const number of numbers) if ((number - best) * sign > 0) best = number

	return best
}

function product(numbers: readonly number[]): number {
	if (numbers.length === 0) return 0

	let total = 1

	for (const number of numbers) total *= number

	return total
}

function deviation(variance: number | CellError): number | CellError {
	return variance instanceof CellError ? variance : Math.sqrt(variance)
}

function kArgument(k: PluginScalar | undefined): number | CellError {
	if (k instanceof CellError) return k

	const number = k === undefined || k === EmptyValue ? undefined : rawNumber(k)

	return number ?? valueError()
}

// The functions SUBTOTAL (1-11) and AGGREGATE (1-19) name, errors raised by the values first where the function
// is not one that counts them.
const FUNCTIONS: readonly (Aggregate | undefined)[] = [
	undefined,
	totals => (totals.numbers.length === 0 ? divError() : mean(totals.numbers)),
	totals => totals.numbers.length,
	totals => totals.filled,
	totals => extreme(totals.numbers, 1),
	totals => extreme(totals.numbers, -1),
	totals => product(totals.numbers),
	totals => deviation(sampleVariance(totals.numbers)),
	totals => deviation(populationVariance(totals.numbers)),
	totals => sum(totals.numbers),
	totals => sampleVariance(totals.numbers),
	totals => populationVariance(totals.numbers),
	totals =>
		totals.numbers.length === 0
			? numError()
			: percentileInclusive(
					[...totals.numbers].sort((a, z) => a - z),
					0.5
				),
	totals => mode(totals.numbers),
	(totals, k) => kth(totals.numbers, kArgument(k), true),
	(totals, k) => kth(totals.numbers, kArgument(k), false),
	(totals, k) => percentile(totals.numbers, kArgument(k), 1, true),
	(totals, k) => percentile(totals.numbers, kArgument(k), 4, true),
	(totals, k) => percentile(totals.numbers, kArgument(k), 1, false),
	(totals, k) => percentile(totals.numbers, kArgument(k), 4, false)
]

// The functions that count every value, errors among them, rather than raise the first error.
const COUNTING = new Set([2, 3])

function percentile(numbers: readonly number[], k: number | CellError, per: 1 | 4, inclusive: boolean): number | CellError {
	if (k instanceof CellError) return k
	if (numbers.length === 0) return numError()

	const sorted = [...numbers].sort((a, z) => a - z)

	if (per === 4) {
		const quart = Math.trunc(k)

		if (inclusive ? quart < 0 || quart > 4 : quart <= 0 || quart >= 4) return numError()

		return inclusive ? percentileInclusive(sorted, quart / 4) : percentileExclusive(sorted, quart / 4)
	}

	if (inclusive ? k < 0 || k > 1 : k <= 0 || k >= 1) return numError()

	return inclusive ? percentileInclusive(sorted, k) : percentileExclusive(sorted, k)
}

export class AggregateFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		SUBTOTAL: {
			method: "subtotal",
			parameters: [{ argumentType: FunctionArgumentType.NUMBER }, { argumentType: FunctionArgumentType.ANY }],
			repeatLastArgs: 1
		},
		AGGREGATE: {
			method: "aggregate",
			parameters: [
				{ argumentType: FunctionArgumentType.NUMBER },
				{ argumentType: FunctionArgumentType.NUMBER },
				{ argumentType: FunctionArgumentType.ANY }
			],
			repeatLastArgs: 1,
			enableArrayArithmeticForArguments: true
		},
		COUNTBLANK: {
			method: "countblank",
			parameters: [{ argumentType: FunctionArgumentType.RANGE }]
		}
	}

	// Whether a cell holds a SUBTOTAL or AGGREGATE.
	private nested(address: SimpleCellAddress | undefined): boolean {
		if (address === undefined) return false

		const vertex = this.dependencyGraph.getCell(address)

		// Values and empty cells hold no formula; a formula's answer is kept for its vertex (a new formula is a new one).
		if (vertex === undefined || !("getFormula" in vertex)) return false

		let known = NESTED_VERTICES.get(vertex)

		if (known === undefined) {
			const formula = this.formulaAt(address)

			known = formula !== undefined && NESTED.test(formula)
			NESTED_VERTICES.set(vertex, known)
		}

		return known
	}

	private *cells(ast: PluginAst, state: PluginState): Generator<Cell> {
		const node = unwrap(ast)
		const value = this.evaluateAst(node, state)

		if (value instanceof SimpleRangeValue) {
			if (value.range === undefined) {
				for (const row of value.data) for (const item of row) yield { value: item }

				return
			}

			for (const [item, address] of value.entriesFromTopLeftCorner(value.range.start)) yield { value: item, address }

			return
		}

		if (node.type === ("CELL_REFERENCE" as PluginAst["type"]) && "reference" in node) {
			yield { value, address: node.reference.toSimpleCellAddress(state.formulaAddress) }

			return
		}

		yield { value }
	}

	// What `refs` give `name`'s aggregate, leaving out nested totals, and errors when `skipErrors`.
	// `skipRows`: the row state from which a row is left out (ROW_FILTERED: only filtered rows; ROW_HIDDEN: hidden ones
	// too; ROW_SHOWN: none).
	private totals(refs: readonly PluginAst[], state: PluginState, skipNested: boolean, skipErrors: boolean, skipRows = ROW_SHOWN): Totals {
		const totals: Totals = { numbers: [], filled: 0, error: null }

		for (const ref of refs) {
			for (const cell of this.cells(ref, state)) {
				const value = cell.value
				const address = cell.address

				if (value === EmptyValue) continue
				if (skipRows !== ROW_SHOWN && address !== undefined && rowStateOf(address.sheet, address.row) >= skipRows) continue
				if (skipNested && this.nested(address)) continue

				if (value instanceof CellError) {
					if (skipErrors) continue

					totals.error ??= value
					totals.filled++

					continue
				}

				totals.filled++

				const number = rawNumber(value)

				// A number typed as an argument counts; text and logical values in references do not.
				if (number !== undefined) totals.numbers.push(number)
				else if (cell.address === undefined && typeof value === "boolean") totals.numbers.push(value ? 1 : 0)
			}
		}

		return totals
	}

	private calculate(type: number, totals: Totals, k: PluginScalar | undefined): number | CellError {
		const aggregate = FUNCTIONS[type]

		if (aggregate === undefined) return valueError()
		if (totals.error !== null && !COUNTING.has(type)) return totals.error

		return aggregate(totals, k)
	}

	subtotal(ast: PluginCall, state: PluginState): unknown {
		const [first, ...refs] = ast.args

		if (first === undefined || refs.length === 0) return naError()

		const type = this.numberOf(this.scalar(first, state))

		if (type instanceof CellError) return type

		const index = Math.trunc(type)
		const base = index > 100 ? index - 100 : index

		if (base < 1 || base > 11) return valueError()

		return this.calculate(base, this.totals(refs, state, true, false, index > 100 ? ROW_HIDDEN : ROW_FILTERED), undefined)
	}

	// AGGREGATE(function_num, options, ref1, [ref2], ...) or, for 14-19, (function_num, options, array, k)
	// (support.microsoft.com "AGGREGATE function"). Options 0-3 leave out nested totals, 2, 3, 6 and 7 errors.
	aggregate(ast: PluginCall, state: PluginState): unknown {
		const [first, second, ...refs] = ast.args

		if (first === undefined || second === undefined || refs.length === 0) return valueError()

		const type = this.numberOf(this.scalar(first, state))
		const options = this.numberOf(this.scalar(second, state))

		if (type instanceof CellError) return type
		if (options instanceof CellError) return options

		const index = Math.trunc(type)
		const option = Math.trunc(options)

		if (index < 1 || index > 19 || option < 0 || option > 7) return valueError()

		const skipNested = option <= 3
		const skipErrors = option === 2 || option === 3 || option === 6 || option === 7
		const skipRows = option % 2 === 1 ? ROW_HIDDEN : ROW_SHOWN

		if (index >= 14) {
			const [array, k, ...rest] = refs

			if (array === undefined || k === undefined || rest.length > 0) return valueError()

			return this.calculate(index, this.totals([array], state, skipNested, skipErrors, skipRows), this.scalar(k, state))
		}

		return this.calculate(index, this.totals(refs, state, skipNested, skipErrors, skipRows), undefined)
	}

	// COUNTBLANK(range): empty cells, and cells whose formula gives "" (support.microsoft.com "COUNTBLANK function").
	countblank(ast: PluginCall, state: PluginState): unknown {
		const [range, ...rest] = ast.args

		if (range === undefined || rest.length > 0) return naError()

		const value = this.evaluateAst(unwrap(range), state)

		if (!(value instanceof SimpleRangeValue)) return value === EmptyValue || value === "" ? 1 : 0

		let count = 0

		for (const item of value.valuesFromTopLeftCorner()) if (item === EmptyValue || item === "") count++

		return count + wholeTail(value)
	}

	private scalar(ast: PluginAst, state: PluginState): PluginScalar {
		const value = this.evaluateAst(ast, state)

		if (!(value instanceof SimpleRangeValue)) return value

		return value.width() === 1 && value.height() === 1 ? (value.data[0]?.[0] ?? EmptyValue) : new CellError(ErrorType.VALUE)
	}
}
