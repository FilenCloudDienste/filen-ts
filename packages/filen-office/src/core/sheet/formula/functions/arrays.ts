import { CellError, EmptyValue, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import {
	ARRAY_ARGUMENTS,
	calcError,
	rawNumber,
	SheetFunctionPlugin,
	valueError,
	type PluginAst,
	type PluginCall,
	type PluginScalar,
	type PluginState,
	type PluginValue
} from "./plugin"

// Array shaping functions as support.microsoft.com defines them, and TYPE.

const SHAPE = {
	parameters: [
		{ argumentType: FunctionArgumentType.RANGE },
		{ argumentType: FunctionArgumentType.INTEGER, optionalArg: true, emptyAsDefault: true },
		{ argumentType: FunctionArgumentType.INTEGER, optionalArg: true, emptyAsDefault: true }
	],
	...ARRAY_ARGUMENTS
}
const CHOOSE = {
	parameters: [{ argumentType: FunctionArgumentType.RANGE }, { argumentType: FunctionArgumentType.INTEGER }],
	repeatLastArgs: 1,
	...ARRAY_ARGUMENTS
}

// The span `count` takes from one end of `size` (from the end when negative), clamped to it; null for 0.
function taken(size: number, count: number | undefined): [number, number] | null {
	if (count === undefined) return [0, size]
	if (count === 0) return null

	const length = Math.min(size, Math.abs(count))

	return count > 0 ? [0, length] : [size - length, size]
}

// What dropping `count` from one end of `size` leaves (from the end when negative); null when nothing is left.
function left(size: number, count: number | undefined): [number, number] | null {
	if (count === undefined || count === 0) return [0, size]

	const length = Math.abs(count)

	if (length >= size) return null

	return count > 0 ? [length, size] : [0, size - length]
}

function block(
	rows: readonly (readonly PluginScalar[])[],
	[top, bottom]: [number, number],
	[first, last]: [number, number]
): SimpleRangeValue {
	return SimpleRangeValue.onlyValues(rows.slice(top, bottom).map(row => row.slice(first, last)))
}

export class ArrayFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		TAKE: { method: "take", ...SHAPE },
		DROP: { method: "drop", ...SHAPE },
		CHOOSECOLS: { method: "choosecols", ...CHOOSE },
		CHOOSEROWS: { method: "chooserows", ...CHOOSE },
		TYPE: { method: "type", parameters: [{ argumentType: FunctionArgumentType.ANY }] },
		FILTER: { method: "filter", parameters: [{ argumentType: FunctionArgumentType.ANY }], repeatLastArgs: 1, ...ARRAY_ARGUMENTS }
	}

	// FILTER(array, include, [if_empty]) (support.microsoft.com "FILTER function"): the rows (include a column as tall as
	// the array) or columns (a row as wide) where include is TRUE or a number other than 0; with none, if_empty, or
	// #CALC! without it. An include of another shape is #VALUE!; an error in it is the result. (The engine's own read a
	// third argument as another include, and refused a block.)
	filter(ast: PluginCall, state: PluginState): unknown {
		const [arrayAst, includeAst, emptyAst] = ast.args

		if (arrayAst === undefined || includeAst === undefined || ast.args.length > 3) return valueError()

		const array = this.evaluateAst(arrayAst, state)

		if (array instanceof CellError) return array

		const include = this.evaluateAst(includeAst, state)

		if (include instanceof CellError) return include

		const rows: PluginScalar[][] = array instanceof SimpleRangeValue ? array.data : [[array as PluginScalar]]
		const height = rows.length
		const width = rows[0]?.length ?? 0
		const flags: PluginScalar[][] = include instanceof SimpleRangeValue ? include.data : [[include as PluginScalar]]
		const flagHeight = flags.length
		const flagWidth = flags[0]?.length ?? 0
		const byRows = flagWidth === 1 && flagHeight === height
		const byCols = !byRows && flagHeight === 1 && flagWidth === width

		if (!byRows && !byCols) return valueError()

		const kept: number[] = []
		const count = byRows ? height : width

		for (let index = 0; index < count; index++) {
			const flag = byRows ? flags[index]?.[0] : flags[0]?.[index]

			if (flag instanceof CellError) return flag
			if (typeof flag === "string") return valueError()

			const number = typeof flag === "boolean" ? Number(flag) : flag === undefined ? 0 : (rawNumber(flag) ?? 0)

			if (number !== 0) kept.push(index)
		}

		if (kept.length === 0) {
			if (emptyAst === undefined || emptyAst.type === ("EMPTY" as PluginAst["type"])) return calcError()

			return this.evaluateAst(emptyAst, state) satisfies PluginValue
		}

		return SimpleRangeValue.onlyValues(
			byRows ? kept.map(row => [...(rows[row] ?? [])]) : rows.map(line => kept.map(col => line[col] ?? EmptyValue))
		)
	}

	// TAKE(array, rows, [columns]): rows and columns from the start (from the end when negative); 0 is #CALC!.
	take(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("TAKE"), (array: SimpleRangeValue, rows?: number, cols?: number) => {
			if (rows === undefined && cols === undefined) return valueError()

			const rowSpan = taken(array.height(), rows)
			const colSpan = taken(array.width(), cols)

			return rowSpan === null || colSpan === null ? calcError() : block(array.data, rowSpan, colSpan)
		})
	}

	// DROP(array, rows, [columns]): the array without rows and columns from the start (the end when negative); #CALC!
	// when nothing is left.
	drop(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("DROP"), (array: SimpleRangeValue, rows?: number, cols?: number) => {
			if (rows === undefined && cols === undefined) return valueError()

			const rowSpan = left(array.height(), rows)
			const colSpan = left(array.width(), cols)

			return rowSpan === null || colSpan === null ? calcError() : block(array.data, rowSpan, colSpan)
		})
	}

	private choose(ast: PluginCall, state: PluginState, name: "CHOOSECOLS" | "CHOOSEROWS"): unknown {
		return this.runFunction(ast.args, state, this.metadata(name), (array: SimpleRangeValue, ...picks: number[]) => {
			const rows = array.data
			const size = name === "CHOOSECOLS" ? array.width() : array.height()
			const indices: number[] = []

			for (const pick of picks) {
				if (pick === 0 || Math.abs(pick) > size) return valueError()

				indices.push(pick > 0 ? pick - 1 : size + pick)
			}

			return SimpleRangeValue.onlyValues(
				name === "CHOOSECOLS"
					? rows.map(row => indices.map(index => row[index] ?? EmptyValue))
					: indices.map(index => [...(rows[index] ?? [])])
			)
		})
	}

	// CHOOSECOLS(array, col_num1, ...) and CHOOSEROWS: the columns or rows named, from the end when negative; 0 or
	// past the array is #VALUE!.
	choosecols(ast: PluginCall, state: PluginState): unknown {
		return this.choose(ast, state, "CHOOSECOLS")
	}

	chooserows(ast: PluginCall, state: PluginState): unknown {
		return this.choose(ast, state, "CHOOSEROWS")
	}

	// TYPE(value): 1 a number (or an empty cell), 2 text, 4 a logical value, 16 an error, 64 an array.
	type(ast: PluginCall, state: PluginState): unknown {
		const [arg, ...rest] = ast.args

		if (arg === undefined || rest.length > 0) return valueError()

		const value = this.evaluateAst(arg, state)

		if (value instanceof SimpleRangeValue) return value.width() * value.height() > 1 ? 64 : 1
		if (value instanceof CellError) return 16
		if (typeof value === "string") return 2
		if (typeof value === "boolean") return 4

		return 1
	}
}
