import { EmptyValue, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import { lastLineValue, uniformTail, type Plugin } from "./blankTails"
import { naError, SheetFunctionPlugin, unmodeledError, valueError, type PluginCall, type PluginScalar, type PluginState } from "./plugin"
import { binarySearch, compareLookup, lookupValue, rowsOf, sameClass, vectorOf, wildcard, type Lookup } from "./values"

// LOOKUP and XMATCH as support.microsoft.com defines them. Their arrays are evaluated as arrays
// (LOOKUP(2,1/(A1:A9="x"),B1:B9) in an ordinary formula), as Excel does.

const ARRAY_ARGUMENTS = { enableArrayArithmeticForArguments: true, vectorizationForbidden: true } as const

// The position of the value equal to `key` (text without regard to case, with wildcards when asked), the first or
// the last; -1 when none.
function exactIndex(values: readonly PluginScalar[], key: Lookup, wildcards: boolean, fromEnd: boolean): number {
	const test = wildcards && typeof key === "string" ? wildcard(key) : null
	const count = values.length

	for (let step = 0; step < count; step++) {
		const index = fromEnd ? count - 1 - step : step
		const value = lookupValue(values[index] ?? EmptyValue)

		if (value === null) continue
		if (test !== null ? typeof value === "string" && test(value) : sameClass(value, key) && compareLookup(value, key) === 0)
			return index
	}

	return -1
}

// The exact match, else the next smaller (-1) or larger (1) value of key's class; -1 when none.
function nearestIndex(values: readonly PluginScalar[], key: Lookup, mode: -1 | 1, fromEnd: boolean): number {
	const exact = exactIndex(values, key, false, fromEnd)

	if (exact >= 0) return exact

	let best = -1
	let bestValue: Lookup | null = null
	const count = values.length

	for (let step = 0; step < count; step++) {
		const index = fromEnd ? count - 1 - step : step
		const value = lookupValue(values[index] ?? EmptyValue)

		if (value === null || !sameClass(value, key)) continue

		const order = compareLookup(value, key)

		if (mode === -1 ? order >= 0 : order <= 0) continue
		if (bestValue === null || (mode === -1 ? compareLookup(value, bestValue) > 0 : compareLookup(value, bestValue) < 0)) {
			best = index
			bestValue = value
		}
	}

	return best
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
				const tail = this.tailOf(ast, 1, state, searched)

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
				const values = vectorOf(rowsOf(where))

				if (values === null) return valueError()
				if (![0, -1, 1, 2].includes(matchMode) || ![1, -1, 2, -2].includes(searchMode)) return valueError()
				if (key === null) return naError()

				let found: number

				const tail = this.tailOf(ast, 1, state, values)

				if (tail === null) return unmodeledError()

				if (searchMode === 2 || searchMode === -2) {
					const descending = searchMode === -2
					const at = binarySearch(values, key, descending, tail)
					const atValue = at >= values.length ? tail?.value : values[at]
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

	// The empty rows of the whole columns argument `index` reads past where the engine ends reading them, each as the
	// vector's last value (its first empty row's); undefined when it reads none, null when they are not read the same.
	private tailOf(
		ast: PluginCall,
		index: number,
		state: PluginState,
		vector: readonly PluginScalar[]
	): { readonly value: PluginScalar; readonly count: number } | undefined | null {
		const count = uniformTail(this as unknown as Plugin, ast.args[index], state)
		const value = vector.at(-1)

		if (count === null) return null

		return count === 0 || value === undefined ? undefined : { value, count }
	}

	// The value of key's class after `at` (the first when `at` is -1), as a binary search's other side.
	private neighbour(values: readonly PluginScalar[], at: number, key: Lookup): number {
		for (let index = at + 1; index < values.length; index++) {
			const value = lookupValue(values[index] ?? EmptyValue)

			if (value !== null && sameClass(value, key)) return index
		}

		return -1
	}
}
