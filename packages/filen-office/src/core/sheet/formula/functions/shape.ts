import { CellError, EmptyValue, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import { MAX_COLUMNS, MAX_ROWS } from "../../model/model"
import { BLANK_SORT_VALUE, SortType, sortOrder, textSortKey, type SortValue } from "../../sort/order"
import {
	calcError,
	naError,
	numError,
	rawNumber,
	SheetFunctionPlugin,
	unmodeledError,
	valueError,
	type PluginCall,
	type PluginScalar,
	type PluginState
} from "./plugin"

// Array building and reshaping functions as support.microsoft.com defines them.

const ARRAY_ARGUMENTS = { enableArrayArithmeticForArguments: true, vectorizationForbidden: true } as const

// The most cells an array built here may hold (as formulaRefs.ts bounds the arrays a formula builds): the engine
// keeps every value, a few hundred bytes each. Past it the formula keeps its result in the file.
const MAX_BUILT_CELLS = 200_000

const SCAN = {
	parameters: [
		{ argumentType: FunctionArgumentType.RANGE },
		{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 0, emptyAsDefault: true },
		{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: false, emptyAsDefault: true }
	],
	...ARRAY_ARGUMENTS
}
const WRAP = {
	parameters: [
		{ argumentType: FunctionArgumentType.RANGE },
		{ argumentType: FunctionArgumentType.NUMBER },
		{ argumentType: FunctionArgumentType.SCALAR, optionalArg: true, emptyAsDefault: true }
	],
	...ARRAY_ARGUMENTS
}

// Whether the call has its argument at `index`, not left empty (FN(a,,c)): the functions here read an empty one as
// left out.
export function given(ast: PluginCall, index: number): boolean {
	const arg = ast.args[index]

	return arg !== undefined && arg.type !== ("EMPTY" as typeof arg.type)
}

// The error a size past the grid (#NUM!, "array is too large") or past what is held here gives; null when it fits.
function sizeError(rows: number, cols: number): CellError | null {
	if (rows > MAX_ROWS || cols > MAX_COLUMNS) return numError()

	return rows * cols > MAX_BUILT_CELLS ? unmodeledError() : null
}

// A value as SORTBY orders it (Excel's sort order, sort/order.ts).
export function sortValue(value: PluginScalar): SortValue {
	if (value === EmptyValue) return BLANK_SORT_VALUE
	if (value instanceof CellError) return { type: SortType.ERROR, number: 0, key: "" }
	if (typeof value === "string") return { type: SortType.TEXT, number: 0, key: textSortKey(value, false) }
	if (typeof value === "boolean") return { type: SortType.BOOLEAN, number: value ? 1 : 0, key: "" }

	return { type: SortType.NUMBER, number: rawNumber(value) ?? 0, key: "" }
}

// The values of a one-row or one-column array in order, or null for a block.
function vector(value: SimpleRangeValue): PluginScalar[] | null {
	const rows = value.data

	if (rows.length === 1) return rows[0] ?? []
	if (value.width() !== 1) return null

	return rows.map(row => row[0] ?? EmptyValue)
}

// The span left after trimming blank lines from either end of `count` lines, `mode` 1 leading, 2 trailing, 3 both.
function trimmed(count: number, mode: number, blank: (line: number) => boolean): [number, number] {
	let first = 0
	let last = count

	if (mode === 1 || mode === 3) while (first < last && blank(first)) first++
	if (mode === 2 || mode === 3) while (last > first && blank(last - 1)) last--

	return [first, last]
}

export class ShapeFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		// Replaces the engine's SORT, which takes one key, orders by the engine's collation and gives the first error
		// anywhere in the array.
		SORT: {
			method: "sort",
			parameters: [
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.RANGE, optionalArg: true, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.RANGE, optionalArg: true, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: false, emptyAsDefault: true }
			],
			...ARRAY_ARGUMENTS
		},
		SORTBY: {
			method: "sortby",
			parameters: [
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.NUMBER, optionalArg: true, emptyAsDefault: true }
			],
			repeatLastArgs: 2,
			...ARRAY_ARGUMENTS
		},
		TOCOL: { method: "tocol", ...SCAN },
		TOROW: { method: "torow", ...SCAN },
		WRAPCOLS: { method: "wrapcols", ...WRAP },
		WRAPROWS: { method: "wraprows", ...WRAP },
		EXPAND: {
			method: "expand",
			parameters: [
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.NUMBER, optionalArg: true, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.NUMBER, optionalArg: true, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.SCALAR, optionalArg: true, emptyAsDefault: true }
			],
			...ARRAY_ARGUMENTS
		},
		RANDARRAY: {
			method: "randarray",
			parameters: [
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 1, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 1, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 0, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 1, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: false, emptyAsDefault: true }
			],
			isVolatile: true,
			vectorizationForbidden: true
		},
		TRIMRANGE: {
			method: "trimrange",
			parameters: [
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 3, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 3, emptyAsDefault: true }
			],
			...ARRAY_ARGUMENTS
		}
	}

	// SORT(array, [sort_index], [sort_order], [by_col]): array's rows (its columns when by_col) in the order of the
	// column (row) at sort_index, ascending unless sort_order is -1, in SORTBY's order. sort_index and sort_order may be
	// arrays, one key per index (a single order applies to every key). An index outside array or a sort order other
	// than 1 or -1 is #VALUE!. Stable.
	sort(ast: PluginCall, state: PluginState): unknown {
		const [, indexed, ordered] = [0, 1, 2].map(index => given(ast, index))

		return this.runFunction(
			ast.args,
			state,
			this.metadata("SORT"),
			(
				array: SimpleRangeValue,
				sortIndex: SimpleRangeValue | undefined,
				sortOrders: SimpleRangeValue | undefined,
				byCol: boolean
			) => {
				const height = array.height()
				const width = array.width()

				if (height === 0 || width === 0) return naError()

				const indexes = indexed === true && sortIndex !== undefined ? sortIndex.data.flat() : [1]
				const orders = ordered === true && sortOrders !== undefined ? sortOrders.data.flat() : [1]

				if (orders.length !== 1 && orders.length !== indexes.length) return valueError()

				const lines = byCol ? height : width
				const at: number[] = []
				const keys: { readonly descending: boolean }[] = []

				for (let key = 0; key < indexes.length; key++) {
					const index = this.numberOf(indexes[key] ?? EmptyValue)
					const order = this.numberOf(orders[orders.length === 1 ? 0 : key] ?? EmptyValue)

					if (index instanceof CellError) return index
					if (order instanceof CellError) return order

					const line = Math.trunc(index)

					if (line < 1 || line > lines || (order !== 1 && order !== -1)) return valueError()

					at.push(line - 1)
					keys.push({ descending: order === -1 })
				}

				const rows = array.data
				const order = sortOrder(byCol ? width : height, keys, (key, item) => {
					const line = at[key] ?? 0

					return sortValue((byCol ? rows[line]?.[item] : rows[item]?.[line]) ?? EmptyValue)
				})

				return SimpleRangeValue.onlyValues(
					byCol
						? rows.map(row => Array.from(order, item => row[item] ?? EmptyValue))
						: Array.from(order, item => rows[item] ?? [])
				)
			}
		)
	}

	// SORTBY(array, by_array1, [sort_order1], ...): array's rows (by columns) or columns (by rows) in the order of the
	// by arrays, each one row high or one column wide and as long as array; a sort order other than 1 or -1, or by
	// arrays of different shapes, is #VALUE!. Stable: rows equal on every key keep their order.
	sortby(ast: PluginCall, state: PluginState): unknown {
		const orders = ast.args.map((_, index) => given(ast, index))

		return this.runFunction(ast.args, state, this.metadata("SORTBY"), (array: SimpleRangeValue, ...rest: unknown[]) => {
			const height = array.height()
			const width = array.width()
			const keys: { readonly descending: boolean }[] = []
			const columns: PluginScalar[][] = []
			let byRows: boolean | null = null

			for (let index = 0; index < rest.length; index += 2) {
				const by = rest[index]
				const order = orders[index + 2] === true ? rest[index + 1] : undefined

				if (!(by instanceof SimpleRangeValue)) return valueError()
				if (order !== undefined && order !== 1 && order !== -1) return valueError()

				// A column as tall as array orders its rows; a row as wide as array its columns.
				const rows = by.width() === 1 && by.height() === height
				const cols = !rows && by.height() === 1 && by.width() === width

				if ((!rows && !cols) || (byRows !== null && byRows !== rows)) return valueError()

				byRows = rows
				keys.push({ descending: order === -1 })
				columns.push(rows ? by.data.map(row => row[0] ?? EmptyValue) : (by.data[0] ?? []))
			}

			const count = byRows === false ? width : height
			const values = columns.map(column => column.map(sortValue))
			const order = sortOrder(count, keys, (key, item) => values[key]?.[item] ?? BLANK_SORT_VALUE)
			const rows = array.data

			return SimpleRangeValue.onlyValues(
				byRows === false
					? rows.map(row => Array.from(order, item => row[item] ?? EmptyValue))
					: Array.from(order, item => rows[item] ?? [])
			)
		})
	}

	// TOCOL(array, [ignore], [scan_by_column]) and TOROW: the values of array in one column (row), read by row unless
	// scan_by_column; ignore 1 leaves out empty cells, 2 errors, 3 both. ignore outside 0 to 3 is #VALUE!; nothing
	// left is #CALC!.
	private scan(ast: PluginCall, state: PluginState, name: "TOCOL" | "TOROW"): unknown {
		return this.runFunction(ast.args, state, this.metadata(name), (array: SimpleRangeValue, ignore: number, byColumn: boolean) => {
			const mode = Math.trunc(ignore)

			if (mode < 0 || mode > 3) return valueError()

			const rows = array.data
			const height = array.height()
			const width = array.width()
			const out: PluginScalar[] = []
			const keep = (value: PluginScalar): void => {
				if ((mode & 1) !== 0 && value === EmptyValue) return
				if ((mode & 2) !== 0 && value instanceof CellError) return

				out.push(value)
			}

			if (byColumn) {
				for (let col = 0; col < width; col++) for (let row = 0; row < height; row++) keep(rows[row]?.[col] ?? EmptyValue)
			} else for (const row of rows) for (const value of row) keep(value)

			if (out.length === 0) return calcError()

			return SimpleRangeValue.onlyValues(name === "TOCOL" ? out.map(value => [value]) : [out])
		})
	}

	tocol(ast: PluginCall, state: PluginState): unknown {
		return this.scan(ast, state, "TOCOL")
	}

	torow(ast: PluginCall, state: PluginState): unknown {
		return this.scan(ast, state, "TOROW")
	}

	// WRAPCOLS(vector, wrap_count, [pad_with]) and WRAPROWS: the values of a one-row or one-column vector in columns
	// (rows) of wrap_count values, the last one padded with pad_with (#N/A by default); a vector of no more values than
	// wrap_count is one column (row). A block is #VALUE!; wrap_count below 1 #NUM!.
	private wrap(ast: PluginCall, state: PluginState, name: "WRAPCOLS" | "WRAPROWS"): unknown {
		const padded = given(ast, 2)

		return this.runFunction(
			ast.args,
			state,
			this.metadata(name),
			(array: SimpleRangeValue, count: number, padding: PluginScalar | undefined) => {
				const values = vector(array)

				if (values === null) return valueError()

				const size = Math.trunc(count)

				if (size < 1) return numError()

				const length = Math.min(size, values.length)
				const lines = Math.ceil(values.length / length)
				const pad = padded && padding !== undefined ? padding : naError()
				const block: PluginScalar[][] = []

				for (let line = 0; line < lines; line++) {
					const items: PluginScalar[] = []

					for (let index = line * length; index < (line + 1) * length; index++)
						items.push(index < values.length ? (values[index] as PluginScalar) : pad)

					block.push(items)
				}

				if (name === "WRAPROWS") return SimpleRangeValue.onlyValues(block)

				return SimpleRangeValue.onlyValues(Array.from({ length }, (_, row) => block.map(items => items[row] ?? pad)))
			}
		)
	}

	wrapcols(ast: PluginCall, state: PluginState): unknown {
		return this.wrap(ast, state, "WRAPCOLS")
	}

	wraprows(ast: PluginCall, state: PluginState): unknown {
		return this.wrap(ast, state, "WRAPROWS")
	}

	// EXPAND(array, rows, [columns], [pad_with]): array grown to rows by columns (its own size where left out), padded
	// with pad_with (#N/A by default). A size below array's is #VALUE!; one past the grid #NUM!.
	expand(ast: PluginCall, state: PluginState): unknown {
		const [, withRows, withCols, padded] = [0, 1, 2, 3].map(index => given(ast, index))

		return this.runFunction(
			ast.args,
			state,
			this.metadata("EXPAND"),
			(array: SimpleRangeValue, rowCount: number | undefined, colCount: number | undefined, padding: PluginScalar | undefined) => {
				const height = array.height()
				const width = array.width()
				const rows = withRows !== true || rowCount === undefined ? height : Math.trunc(rowCount)
				const cols = withCols !== true || colCount === undefined ? width : Math.trunc(colCount)

				if (rows < height || cols < width) return valueError()

				const tooLarge = sizeError(rows, cols)

				if (tooLarge !== null) return tooLarge

				const pad = padded === true && padding !== undefined ? padding : naError()
				const data = array.data
				const out: PluginScalar[][] = new Array<PluginScalar[]>(rows)

				for (let row = 0; row < rows; row++) {
					const source = data[row]
					const line = new Array<PluginScalar>(cols)

					for (let col = 0; col < cols; col++) line[col] = source !== undefined && col < width ? (source[col] ?? EmptyValue) : pad

					out[row] = line
				}

				return SimpleRangeValue.onlyValues(out)
			}
		)
	}

	// RANDARRAY([rows], [columns], [min], [max], [whole_number]): rows by columns random numbers from min to max (0 and
	// 1 by default), whole numbers when asked. min not below max is #VALUE! ("The minimum number argument must be less
	// than the maximum number"); a size of 0 is #CALC!, a negative one #VALUE!.
	randarray(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("RANDARRAY"),
			(rowCount: number, colCount: number, min: number, max: number, whole: boolean) => {
				const rows = Math.trunc(rowCount)
				const cols = Math.trunc(colCount)

				if (rows < 0 || cols < 0 || min >= max) return valueError()
				if (rows === 0 || cols === 0) return calcError()

				const tooLarge = sizeError(rows, cols)

				if (tooLarge !== null) return tooLarge

				const low = whole ? Math.ceil(min) : min
				const high = whole ? Math.floor(max) : max

				if (low > high) return valueError()

				const out: number[][] = new Array<number[]>(rows)

				for (let row = 0; row < rows; row++) {
					const line = new Array<number>(cols)

					for (let col = 0; col < cols; col++)
						line[col] = whole ? low + Math.floor(Math.random() * (high - low + 1)) : low + Math.random() * (high - low)

					out[row] = line
				}

				return SimpleRangeValue.onlyNumbers(out)
			}
		)
	}

	// TRIMRANGE(range, [trim_rows], [trim_cols]): range without its empty rows and columns at the edges: 1 the leading
	// ones, 2 the trailing ones, 3 both (the default), 0 none. Another mode is #VALUE!; nothing left #CALC!.
	trimrange(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("TRIMRANGE"),
			(range: SimpleRangeValue, rowMode: number, colMode: number) => {
				const rowTrim = Math.trunc(rowMode)
				const colTrim = Math.trunc(colMode)

				if (rowTrim < 0 || rowTrim > 3 || colTrim < 0 || colTrim > 3) return valueError()

				const data = range.data
				const height = range.height()
				const width = range.width()
				const [top, bottom] = trimmed(height, rowTrim, row => (data[row] ?? []).every(value => value === EmptyValue))
				const [left, right] = trimmed(width, colTrim, col => {
					for (let row = top; row < bottom; row++) if ((data[row]?.[col] ?? EmptyValue) !== EmptyValue) return false

					return true
				})

				if (top >= bottom || left >= right) return calcError()
				if (top === 0 && bottom === height && left === 0 && right === width) return range

				return SimpleRangeValue.onlyValues(data.slice(top, bottom).map(row => row.slice(left, right)))
			}
		)
	}
}
