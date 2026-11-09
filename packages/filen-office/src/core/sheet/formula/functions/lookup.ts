import { EmptyValue, FunctionArgumentType, HyperFormula, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import { lastLineValue, uniformTail, type Plugin } from "./blankTails"
import { naError, SheetFunctionPlugin, unmodeledError, valueError, type PluginCall, type PluginScalar, type PluginState } from "./plugin"
import { binarySearch, compareLookup, lookupValue, sameClass, vectorOf, wildcard, type Lookup } from "./values"

// LOOKUP and XMATCH as support.microsoft.com defines them. Their arrays are evaluated as arrays
// (LOOKUP(2,1/(A1:A9="x"),B1:B9) in an ordinary formula), as Excel does.

const ARRAY_ARGUMENTS = { enableArrayArithmeticForArguments: true, vectorizationForbidden: true } as const

// A row or column read value by value: a range's cells straight from the engine's graph, so a search reads only up to
// its match and copies nothing (the range's `data` builds a row array per cell at each call).
interface Vector {
	readonly length: number
	at(index: number): PluginScalar
}

type CellRead = { getCellValue(address: { readonly sheet: number; readonly row: number; readonly col: number }): unknown }

function arrayVector(values: readonly PluginScalar[]): Vector {
	return { length: values.length, at: index => values[index] ?? EmptyValue }
}

// The values of a one-row or one-column argument, or null for a block.
function vectorIn(where: SimpleRangeValue, graph: CellRead): Vector | null {
	const width = where.width()
	const height = where.height()

	if (width !== 1 && height !== 1) return null

	const range = where.range

	if (range === undefined) {
		const values = vectorOf(where.data)

		return values === null ? null : arrayVector(values)
	}

	const across = height === 1
	const { sheet, start } = range

	return {
		length: across ? width : height,
		at: index => {
			const value = graph.getCellValue({
				sheet,
				row: across ? start.row : start.row + index,
				col: across ? start.col + index : start.col
			})

			// A cell holding an array reads as the range's data gives it.
			if (value instanceof SimpleRangeValue) return (across ? where.data[0]?.[index] : where.data[index]?.[0]) ?? EmptyValue

			return value as PluginScalar
		}
	}
}

// The position of the value equal to `key` (text without regard to case, with wildcards when asked), the first or
// the last; -1 when none.
function exactIndex(values: Vector, key: Lookup, wildcards: boolean, fromEnd: boolean): number {
	const test = wildcards && typeof key === "string" ? wildcard(key) : null
	const count = values.length

	for (let step = 0; step < count; step++) {
		const index = fromEnd ? count - 1 - step : step
		const value = lookupValue(values.at(index))

		if (value === null) continue
		if (test !== null ? typeof value === "string" && test(value) : sameClass(value, key) && compareLookup(value, key) === 0)
			return index
	}

	return -1
}

// The exact match, else the next smaller (-1) or larger (1) value of key's class; -1 when none.
// One pass: the first exact match in search order ends it.
function nearestIndex(values: Vector, key: Lookup, mode: -1 | 1, fromEnd: boolean): number {
	let best = -1
	let bestValue: Lookup | null = null
	const count = values.length

	for (let step = 0; step < count; step++) {
		const index = fromEnd ? count - 1 - step : step
		const value = lookupValue(values.at(index))

		if (value === null || !sameClass(value, key)) continue

		const order = compareLookup(value, key)

		if (order === 0) return index
		if (mode === -1 ? order > 0 : order < 0) continue
		if (bestValue === null || (mode === -1 ? compareLookup(value, bestValue) > 0 : compareLookup(value, bestValue) < 0)) {
			best = index
			bestValue = value
		}
	}

	return best
}

type MatchRange = { width(): number; height(): number }
type MatchSearch = { advancedFind(matcher: (value: unknown) => boolean, range: MatchRange, options: object): number }
type DoMatch = (this: { columnSearch: MatchSearch; rowSearch: MatchSearch }, key: unknown, range: MatchRange, type: number) => unknown

const FIRST = { returnOccurrence: "first" } as const
// * any run, ? one character, ~ escaping the next.
const WILDCARD = /[*?~]/

let wildcardMatch = false

// The engine's MATCH with match_type 0 and a text key holding * ? or ~ searched with Excel's wildcards
// (support.microsoft.com MATCH; the engine's own wildcard path reads ? as at most one character). The search is the
// engine's advancedFind, so a whole column reads only its stored cells (wholeRanges.ts); match_type 1 and -1, other
// keys and the argument checks stay the engine's own. Once.
export function installWildcardMatch(): void {
	if (wildcardMatch) return

	wildcardMatch = true

	const prototype = HyperFormula.getFunctionPlugin("MATCH")?.prototype as { doMatch?: DoMatch } | undefined
	const doMatch = prototype?.doMatch

	if (prototype === undefined || doMatch === undefined) return

	prototype.doMatch = function (key, range, type) {
		if (type !== 0 || typeof key !== "string" || !WILDCARD.test(key) || (range.width() > 1 && range.height() > 1))
			return doMatch.call(this, key, range, type)

		const test = wildcard(key)
		const search = range.width() === 1 ? this.columnSearch : this.rowSearch
		const index = search.advancedFind(value => typeof value === "string" && test(value), range, FIRST)

		return index < 0 ? naError() : index + 1
	}
}

export class LookupFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		LOOKUP: {
			method: "lookup",
			parameters: [
				{ argumentType: FunctionArgumentType.NOERROR },
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.RANGE, optionalArg: true, emptyAsDefault: true }
			],
			...ARRAY_ARGUMENTS
		},
		XMATCH: {
			method: "xmatch",
			parameters: [
				{ argumentType: FunctionArgumentType.NOERROR },
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.INTEGER, defaultValue: 0, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.INTEGER, defaultValue: 1, emptyAsDefault: true }
			],
			...ARRAY_ARGUMENTS
		}
	}

	// LOOKUP(lookup_value, lookup_vector, [result_vector]) and LOOKUP(lookup_value, array): the largest value at most
	// lookup_value, found as in a sorted vector. The array form searches the first row of an array wider than tall
	// (else its first column) and gives the last row's (column's) value there. (A result_vector of one cell is read
	// from that cell along lookup_vector: refs/formulaRefs.ts gives the engine the cells.)
	lookup(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("LOOKUP"),
			(value: PluginScalar, where: SimpleRangeValue, result?: SimpleRangeValue) => {
				const key = lookupValue(value)

				if (key === null) return naError()

				const rows = where.data
				const width = where.width()
				const height = where.height()

				if (result === undefined && width > 1 && height > 1) {
					const byRow = width > height
					const searched = byRow ? (rows[0] ?? []) : rows.map(row => row[0] ?? EmptyValue)
					const found = binarySearch(searched, key)

					if (found < 0) return naError()

					return (byRow ? rows[height - 1]?.[found] : rows[found]?.[width - 1]) ?? naError()
				}

				// A block as lookup_vector (LibreOffice's reading; Excel's page wants one row or column): its first row when
				// wider than tall, else its first column.
				const searched = vectorOf(rows) ?? (width > height ? [...(rows[0] ?? [])] : rows.map(row => row[0] ?? EmptyValue))

				// A whole column's empty rows past where the engine ends reading it: as many more of its last value (the
				// first empty row's), Excel's search ending in the grid's last row (LOOKUP(2,1/(A:A=""),ROW(A:A))).
				const tail = this.tailOf(ast, 1, state, searched.at(-1))

				if (tail === null) return unmodeledError()

				const found = binarySearch(searched, key, false, tail)

				if (found < 0) return naError()

				if (found >= searched.length) {
					if (result === undefined) return tail?.value ?? naError()

					const value = lastLineValue(this as unknown as Plugin, ast.args[2], state)

					if (value instanceof SimpleRangeValue) return value.data[0]?.[0] ?? naError()

					return value === undefined || value === null ? unmodeledError() : (value as PluginScalar)
				}

				if (result === undefined) return searched[found] ?? naError()

				const results = result.data
				const vector = vectorOf(results)

				if (vector !== null && vector.length > found) return vector[found] ?? naError()

				return naError()
			}
		)
	}

	// XMATCH(lookup_value, lookup_array, [match_mode], [search_mode]): the position of a match in a row or column.
	// match_mode 0 exact, -1 exact or the next smaller, 1 exact or the next larger, 2 wildcards; search_mode 1 from the
	// first, -1 from the last, 2 and -2 binary over an ascending or descending array.
	xmatch(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("XMATCH"),
			(value: PluginScalar, where: SimpleRangeValue, matchMode: number, searchMode: number) => {
				const key = lookupValue(value)
				const values = vectorIn(where, this.dependencyGraph as unknown as CellRead)

				if (values === null) return valueError()
				if (![0, -1, 1, 2].includes(matchMode) || ![1, -1, 2, -2].includes(searchMode)) return valueError()
				if (key === null) return naError()

				let found: number

				const tail = this.tailOf(ast, 1, state, values.length === 0 ? undefined : values.at(values.length - 1))

				if (tail === null) return unmodeledError()

				if (searchMode === 2 || searchMode === -2) {
					const descending = searchMode === -2
					const all = Array.from({ length: values.length }, (_, index) => values.at(index))
					const at = binarySearch(all, key, descending, tail)
					const atValue = at >= all.length ? tail?.value : all[at]
					const exact = at >= 0 && compareLookup(lookupValue(atValue ?? EmptyValue) ?? key, key) === 0

					if (matchMode === 0 || matchMode === 2) found = exact ? at : -1
					else if (exact) found = at
					// Binary search ends on the next smaller (ascending) or larger (descending) value; the other side is
					// its neighbour.
					else if ((matchMode === -1) !== descending) found = at
					else found = this.neighbour(values, at, key)
				} else if (matchMode === -1 || matchMode === 1) found = nearestIndex(values, key, matchMode, searchMode === -1)
				else found = exactIndex(values, key, matchMode === 2, searchMode === -1)

				// From the last, a match in the first empty row is one in the grid's last row.
				if (tail !== undefined && searchMode === -1 && found === values.length - 1) found += tail.count

				return found < 0 ? naError() : found + 1
			}
		)
	}

	// The empty rows of the whole columns argument `index` reads past where the engine ends reading them, each as
	// `value`, the vector's last (its first empty row's); undefined when it reads none, null when they are not read the
	// same.
	private tailOf(
		ast: PluginCall,
		index: number,
		state: PluginState,
		value: PluginScalar | undefined
	): { readonly value: PluginScalar; readonly count: number } | undefined | null {
		const count = uniformTail(this as unknown as Plugin, ast.args[index], state)

		if (count === null) return null

		return count === 0 || value === undefined ? undefined : { value, count }
	}

	// The value of key's class after `at` (the first when `at` is -1), as a binary search's other side.
	private neighbour(values: Vector, at: number, key: Lookup): number {
		for (let index = at + 1; index < values.length; index++) {
			const value = lookupValue(values.at(index))

			if (value !== null && sameClass(value, key)) return index
		}

		return -1
	}
}
