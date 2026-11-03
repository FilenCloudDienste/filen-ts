import { CellError, EmptyValue, SimpleRangeValue } from "hyperformula"
import { rawNumber, type PluginScalar, type PluginValue } from "./plugin"

// Values as Excel's lookup and array functions read them.

// A value of a lookup: kept as given, with its class for comparing (Excel orders numbers before text before
// logical values; errors and empty cells match nothing).
export type Lookup = number | string | boolean

export function lookupValue(value: PluginScalar): Lookup | null {
	if (value === EmptyValue || value instanceof CellError) return null
	if (typeof value === "string" || typeof value === "boolean") return value

	return rawNumber(value) ?? null
}

function rank(value: Lookup): number {
	return typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2
}

// Whether two values can be compared at all: the same class.
export function sameClass(a: Lookup, b: Lookup): boolean {
	return typeof a === typeof b
}

// Compares two values of one class: text without regard to case, FALSE before TRUE.
export function compareLookup(a: Lookup, b: Lookup): number {
	if (typeof a === "string" && typeof b === "string") {
		const left = a.toLowerCase()
		const right = b.toLowerCase()

		return left < right ? -1 : left > right ? 1 : 0
	}

	if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0
	if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)

	return rank(a) - rank(b)
}

// The rows of a value: a range's or array's, or one row of one value.
export function rowsOf(value: PluginValue): PluginScalar[][] {
	return value instanceof SimpleRangeValue ? value.data : [[value]]
}

// The values of a one-row or one-column array in order, or null for a block.
export function vectorOf(rows: readonly (readonly PluginScalar[])[]): PluginScalar[] | null {
	if (rows.length === 1) return [...(rows[0] ?? [])]
	if (rows.every(row => row.length === 1)) return rows.map(row => row[0] ?? EmptyValue)

	return null
}

// Every value of an array, row by row.
export function flatten(rows: readonly (readonly PluginScalar[])[]): PluginScalar[] {
	const out: PluginScalar[] = []

	for (const row of rows) for (const value of row) out.push(value)

	return out
}

// The position of the largest value at most `key` (ascending) or the smallest at least it (descending) in a
// sorted vector, by binary search over the values of key's class only (others are skipped, as Excel's
// approximate lookups skip what they cannot compare: LOOKUP(2,1/(A1:A9="x"),B1:B9) finds the last match). -1 when
// none.
// `tail`: `count` more copies of one value after `values` (the empty rows of a whole column past where the engine
// ends reading it, formula/wholeRanges.ts), searched as if they were there.
export function binarySearch(
	values: readonly PluginScalar[],
	key: Lookup,
	descending = false,
	tail?: { readonly value: PluginScalar; readonly count: number }
): number {
	const positions: number[] = []
	const keys: Lookup[] = []

	values.forEach((value, index) => {
		const read = lookupValue(value)

		if (read !== null && sameClass(read, key)) {
			positions.push(index)
			keys.push(read)
		}
	})

	const tailKey = tail === undefined ? null : lookupValue(tail.value)
	const extra = tail !== undefined && tailKey !== null && sameClass(tailKey, key) ? tail.count : 0
	const keyAt = (index: number): Lookup => (index < keys.length ? (keys[index] as Lookup) : (tailKey as Lookup))
	const positionAt = (index: number): number => (index < keys.length ? (positions[index] ?? -1) : values.length + index - keys.length)

	let low = 0
	let high = keys.length + extra - 1
	let best = -1
	let exact = false

	while (low <= high) {
		const mid = (low + high) >> 1
		const order = compareLookup(keyAt(mid), key)

		if (order === 0) {
			// The last of equal values, as a sorted search ends there; once one is found only another equal one replaces
			// it.
			best = mid
			exact = true
			low = mid + 1
		} else if (descending ? order > 0 : order < 0) {
			if (!exact) best = mid

			low = mid + 1
		} else high = mid - 1
	}

	return best < 0 ? -1 : positionAt(best)
}

// A wildcard pattern (* any run, ? one character, ~ escaping the next) as a test, without regard to case. Matched
// by the greedy star walk, at most pattern × text steps (never a backtracking regular expression).
export function wildcard(pattern: string): (text: string) => boolean {
	// -1: any run, -2: any one character, else a character code (lower case).
	const tokens: number[] = []
	const lower = pattern.toLowerCase()

	for (let index = 0; index < lower.length; index++) {
		const code = lower.charCodeAt(index)

		if (code === 126 && index + 1 < lower.length) tokens.push(lower.charCodeAt(++index))
		else if (code === 42) tokens.push(-1)
		else if (code === 63) tokens.push(-2)
		else tokens.push(code)
	}

	return text => {
		const subject = text.toLowerCase()
		let t = 0
		let p = 0
		let star = -1
		let resume = 0

		while (t < subject.length) {
			const token = tokens[p]

			if (token !== undefined && (token === -2 || token === subject.charCodeAt(t))) {
				t++
				p++
			} else if (token === -1) {
				star = p++
				resume = t
			} else if (star >= 0) {
				p = star + 1
				t = ++resume
			} else return false
		}

		while (tokens[p] === -1) p++

		return p === tokens.length
	}
}
