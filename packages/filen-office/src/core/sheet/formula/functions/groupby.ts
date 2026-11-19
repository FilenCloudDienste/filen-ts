import { CellError, EmptyValue, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import { MAX_ARRAY_CELLS } from "../../refs/formulaRefs"
import { sortOrder, type SortValue } from "../../sort/order"
import { Lambda, LambdaFunctions } from "./lambda"
import { sortValue } from "./shape"
import {
	calcError,
	rawNumber,
	unmodeledError,
	unwrap,
	valueError,
	type PluginAst,
	type PluginCall,
	type PluginScalar,
	type PluginState,
	type PluginValue
} from "./plugin"

// GROUPBY and PIVOTBY as support.microsoft.com defines them. Where the pages are silent: generated headers read
// "Row Field n", "Column Field n" and "Value n"; several functions are named by their function ("LAMBDA" for a
// LAMBDA) in a header row (HSTACK) or a label column (VSTACK); parent keys repeat on every row and column; a
// subtotal shows its group's keys with the deeper ones blank; a group with no values for a column is blank; a sort
// by a value sorts by the first function's result over the whole other axis.

// Arguments evaluated here, as arrays (filter_array is often a comparison of a range: B2:B9="x").
const LAZY = { vectorizationForbidden: true, enableArrayArithmeticForArguments: true } as const
const ANY = { argumentType: FunctionArgumentType.ANY } as const

// Named functions that take the set a value is relative to as a second value.
const PAIRED: ReadonlySet<string> = new Set(["PERCENTOF"])

const TOTAL = "Total"

interface Aggregator {
	readonly lambda: Lambda
	readonly name: string
	readonly paired: boolean
}

// A group of one axis: its keys (one per level down to it), the data rows in it in data order, and its subgroups in
// output order. `first` and `end` span the ranks of its leaves (column axis).
interface Group {
	readonly keys: readonly PluginScalar[]
	readonly parent: Group | null
	readonly rows: number[]
	readonly children: Map<string, Group>
	ordered: Group[]
	first: number
	end: number
}

// One row (column) of the output: a leaf group, or a group's total.
interface Entry {
	readonly group: Group
	readonly total: boolean
}

interface Sort {
	readonly index: number
	readonly descending: boolean
}

interface Request {
	readonly rows: PluginAst | undefined
	readonly cols: PluginAst | undefined
	readonly values: PluginAst | undefined
	readonly fn: PluginAst | undefined
	readonly headers: PluginAst | undefined
	readonly rowDepth: PluginAst | undefined
	readonly rowSort: PluginAst | undefined
	readonly colDepth: PluginAst | undefined
	readonly colSort: PluginAst | undefined
	readonly filter: PluginAst | undefined
	readonly relationship: PluginAst | undefined
	readonly relative: PluginAst | undefined
}

function group(keys: readonly PluginScalar[], parent: Group | null): Group {
	return { keys, parent, rows: [], children: new Map(), ordered: [], first: 0, end: 0 }
}

// Equal keys group together: text without regard to case.
function groupKey(value: PluginScalar): string {
	if (value === EmptyValue) return "e"
	if (typeof value === "string") return `s${value.toLowerCase()}`
	if (typeof value === "boolean") return value ? "b1" : "b0"
	if (value instanceof CellError) return `x${value.type}${value.message ?? ""}`

	return `n${String(rawNumber(value) ?? 0)}`
}

function omitted(ast: PluginAst | undefined): boolean {
	return ast === undefined || ast.type === ("EMPTY" as PluginAst["type"])
}

function matrix(value: PluginValue): PluginScalar[][] {
	return value instanceof SimpleRangeValue ? value.data : [[value]]
}

// The groups of the data rows `rows` by the key columns of `keys`: a tree of `levels` levels, or (table) one level
// of their combinations.
function grouped(keys: readonly (readonly PluginScalar[])[], rows: readonly number[], levels: number, table: boolean): Group {
	const root = group([], null)

	for (const row of rows) {
		const line = keys[row] ?? []

		root.rows.push(row)

		if (levels === 0) continue

		if (table) {
			const values = line.slice(0, levels)
			const key = values.map(groupKey).join("\u0000")
			let child = root.children.get(key)

			if (child === undefined) {
				child = group(values, root)
				root.children.set(key, child)
			}

			child.rows.push(row)
			continue
		}

		let node = root

		for (let level = 0; level < levels; level++) {
			const key = groupKey(line[level] ?? EmptyValue)
			let child = node.children.get(key)

			if (child === undefined) {
				child = group(line.slice(0, level + 1), node)
				node.children.set(key, child)
			}

			child.rows.push(row)
			node = child
		}
	}

	return root
}

// The output entries of an axis: leaves in order, a group's total after (before, `top`) its subgroups where `depth`
// asks for it (1: the grand total, 2: and the first level's subtotals, ...).
function entries(root: Group, depth: number, top: boolean): Entry[] {
	const out: Entry[] = []
	const visit = (node: Group): void => {
		if (node.ordered.length === 0) {
			out.push({ group: node, total: false })

			return
		}

		const shown = node.parent === null ? depth >= 1 : node.keys.length <= depth - 1

		if (shown && top) out.push({ group: node, total: true })

		for (const child of node.ordered) visit(child)

		if (shown && !top) out.push({ group: node, total: true })
	}

	visit(root)

	return out
}

// The ranks of an axis's leaves in output order; each group spans its leaves'.
function rank(node: Group, next: number): number {
	node.first = next

	if (node.ordered.length === 0) {
		node.end = next + 1

		return node.end
	}

	let at = next

	for (const child of node.ordered) at = rank(child, at)

	node.end = at

	return at
}

export class GroupFunctions extends LambdaFunctions {
	static override implementedFunctions: ImplementedFunctions = {
		GROUPBY: { method: "groupby", parameters: [ANY], repeatLastArgs: 1, ...LAZY },
		PIVOTBY: { method: "pivotby", parameters: [ANY], repeatLastArgs: 1, ...LAZY }
	}

	// GROUPBY(row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array],
	// [field_relationship]).
	groupby(ast: PluginCall, state: PluginState): unknown {
		const a = ast.args

		if (a.length < 3 || a.length > 8) return valueError()

		return this.summarize(state, {
			rows: a[0],
			cols: undefined,
			values: a[1],
			fn: a[2],
			headers: a[3],
			rowDepth: a[4],
			rowSort: a[5],
			colDepth: undefined,
			colSort: undefined,
			filter: a[6],
			relationship: a[7],
			relative: undefined
		})
	}

	// PIVOTBY(row_fields, col_fields, values, function, [field_headers], [row_total_depth], [row_sort_order],
	// [col_total_depth], [col_sort_order], [filter_array], [relative_to]).
	pivotby(ast: PluginCall, state: PluginState): unknown {
		const a = ast.args

		if (a.length < 4 || a.length > 11) return valueError()

		return this.summarize(state, {
			rows: a[0],
			cols: a[1],
			values: a[2],
			fn: a[3],
			headers: a[4],
			rowDepth: a[5],
			rowSort: a[6],
			colDepth: a[7],
			colSort: a[8],
			filter: a[9],
			relationship: undefined,
			relative: a[10]
		})
	}

	// An array argument's rows, or its error.
	private array(ast: PluginAst | undefined, state: PluginState): PluginScalar[][] | CellError {
		if (omitted(ast)) return valueError()

		const value = this.evaluateAst(ast as PluginAst, state)

		return value instanceof CellError ? value : matrix(value)
	}

	// A whole-number option, undefined when left out or empty.
	private option(ast: PluginAst | undefined, state: PluginState): number | undefined | CellError {
		if (omitted(ast)) return undefined

		let value = this.evaluateAst(ast as PluginAst, state)

		if (value instanceof SimpleRangeValue) {
			if (value.width() !== 1 || value.height() !== 1) return valueError()

			value = value.data[0]?.[0] ?? EmptyValue
		}

		if (value === EmptyValue) return undefined
		if (value instanceof CellError) return value

		const number = this.numberOf(value)

		return number instanceof CellError ? number : Math.trunc(number)
	}

	// sort_order: 1-based columns of the fields then of the values, negative descending; several only of the fields.
	private sorts(ast: PluginAst | undefined, state: PluginState, fields: number, values: number): Sort[] | CellError {
		if (omitted(ast)) return []

		const value = this.evaluateAst(ast as PluginAst, state)

		if (value instanceof CellError) return value

		const rows = matrix(value)
		const list =
			rows.length === 1 ? (rows[0] ?? []) : rows.every(row => row.length === 1) ? rows.map(row => row[0] ?? EmptyValue) : null

		if (list === null) return valueError()

		const out: Sort[] = []

		for (const item of list) {
			if (item instanceof CellError) return item
			if (item === EmptyValue) return valueError()

			const number = this.numberOf(item)

			if (number instanceof CellError) return number

			const index = Math.trunc(number)

			if (index === 0 || Math.abs(index) > fields + values) return valueError()
			if (list.length > 1 && Math.abs(index) > fields) return valueError()

			out.push({ index: Math.abs(index) - 1, descending: index < 0 })
		}

		return out
	}

	// The function argument: one LAMBDA (or named function), or an HSTACK (VSTACK) of them.
	private aggregators(ast: PluginAst | undefined, state: PluginState): { list: Aggregator[]; vertical: boolean } | CellError {
		if (omitted(ast)) return valueError()

		const node = unwrap(ast as PluginAst)
		const stack =
			node.type === ("FUNCTION_CALL" as PluginAst["type"]) && "procedureName" in node ? node.procedureName.toUpperCase() : ""
		const items = (stack === "HSTACK" || stack === "VSTACK") && "args" in node ? (node.args as PluginAst[]) : [node]
		const list: Aggregator[] = []

		for (const item of items) {
			const bound = this.bound(item, state)

			if (bound instanceof CellError) return bound
			if (!(bound instanceof Lambda)) return valueError()

			const paired = bound.eta !== null ? PAIRED.has(bound.eta) : bound.params.length === 2

			if (bound.eta === null && bound.params.length !== 1 && bound.params.length !== 2) return valueError()

			list.push({ lambda: bound, name: bound.eta ?? "LAMBDA", paired })
		}

		if (list.length === 0) return valueError()

		return { list, vertical: stack === "VSTACK" && list.length > 1 }
	}

	// A group's result for one value column: blank without values, one value otherwise (#CALC! for an array).
	private aggregate(
		rows: readonly number[],
		relative: () => readonly number[],
		values: readonly (readonly PluginScalar[])[],
		column: number,
		aggregator: Aggregator,
		state: PluginState
	): PluginScalar {
		if (rows.length === 0) return EmptyValue

		const vector = (of: readonly number[]): SimpleRangeValue =>
			SimpleRangeValue.onlyValues(of.map(row => [values[row]?.[column] ?? EmptyValue]))
		const args = aggregator.paired ? [vector(rows), vector(relative())] : [vector(rows)]
		const result = this.apply(aggregator.lambda, args, state)

		if (!(result instanceof SimpleRangeValue)) return result

		return result.width() === 1 && result.height() === 1 ? (result.data[0]?.[0] ?? EmptyValue) : calcError()
	}

	// Orders every group's subgroups: by the sorts that concern their level (all of them in a table), then by key.
	private order(
		root: Group,
		levels: number,
		table: boolean,
		sorts: readonly Sort[],
		measure: (rows: readonly number[], column: number) => PluginScalar
	): void {
		const visit = (node: Group, level: number): void => {
			const children = [...node.children.values()]
			const keys: { descending: boolean; read: (child: Group) => SortValue }[] = []

			for (const sort of sorts) {
				if (sort.index >= levels) {
					const column = sort.index - levels

					keys.push({ descending: sort.descending, read: child => sortValue(measure(child.rows, column)) })
				} else if (table || sort.index === level) {
					const at = sort.index

					keys.push({ descending: sort.descending, read: child => sortValue(child.keys[at] ?? EmptyValue) })
				}
			}

			for (let at = table ? 0 : level; at < (table ? levels : level + 1); at++)
				keys.push({ descending: false, read: child => sortValue(child.keys[at] ?? EmptyValue) })

			const sorted = sortOrder(children.length, keys, (key, item) =>
				(keys[key] as (typeof keys)[number]).read(children[item] as Group)
			)

			node.ordered = Array.from(sorted, index => children[index] as Group)

			if (!table) for (const child of node.ordered) visit(child, level + 1)
		}

		if (levels > 0) visit(root, 0)
	}

	private summarize(state: PluginState, request: Request): unknown {
		const rowFields = this.array(request.rows, state)

		if (rowFields instanceof CellError) return rowFields

		const pivot = request.cols !== undefined
		const colFields = pivot ? this.array(request.cols, state) : []

		if (colFields instanceof CellError) return colFields

		const valueRows = this.array(request.values, state)

		if (valueRows instanceof CellError) return valueRows

		const functions = this.aggregators(request.fn, state)

		if (functions instanceof CellError) return functions

		const height = rowFields.length

		if (valueRows.length !== height || (pivot && colFields.length !== height)) return valueError()

		const rowLevels = rowFields[0]?.length ?? 0
		const colLevels = pivot ? (colFields[0]?.length ?? 0) : 0
		const valueCount = valueRows[0]?.length ?? 0

		const headersMode = this.option(request.headers, state)
		const relationship = this.option(request.relationship, state) ?? 0
		const relativeTo = this.option(request.relative, state) ?? 0
		const rowDepthOption = this.option(request.rowDepth, state)
		const colDepthOption = this.option(request.colDepth, state)

		if (headersMode instanceof CellError) return headersMode
		if (relationship instanceof CellError) return relationship
		if (relativeTo instanceof CellError) return relativeTo
		if (rowDepthOption instanceof CellError) return rowDepthOption
		if (colDepthOption instanceof CellError) return colDepthOption
		if (headersMode !== undefined && (headersMode < 0 || headersMode > 3)) return valueError()
		if (relationship !== 0 && relationship !== 1) return valueError()
		if (relativeTo < 0 || relativeTo > 4) return valueError()

		const rowSorts = this.sorts(request.rowSort, state, rowLevels, valueCount)

		if (rowSorts instanceof CellError) return rowSorts

		const colSorts = this.sorts(request.colSort, state, colLevels, valueCount)

		if (colSorts instanceof CellError) return colSorts

		// Headers: guessed from the values (text above a number), shown then with several group levels.
		const first = valueRows[0]?.[0]
		const second = valueRows[1]?.[0]
		const guessed = typeof first === "string" && second !== undefined && typeof second !== "boolean" && rawNumber(second) !== undefined
		const hasHeaders = headersMode === undefined ? guessed : headersMode === 1 || headersMode === 3
		const show = headersMode === undefined ? guessed && (rowLevels > 1 || colLevels > 1) : headersMode >= 2
		const generate = headersMode === 2
		const start = hasHeaders ? 1 : 0

		// The data rows kept by filter_array.
		const kept: number[] = []

		if (omitted(request.filter)) for (let row = start; row < height; row++) kept.push(row)
		else {
			const filter = this.array(request.filter, state)

			if (filter instanceof CellError) return filter
			if (filter.length !== height || filter.some(line => line.length !== 1)) return valueError()

			for (let row = start; row < height; row++) {
				const mark = filter[row]?.[0] ?? EmptyValue

				if (mark instanceof CellError) return mark
				if (typeof mark === "string") return valueError()
				if (mark === true || (typeof mark !== "boolean" && mark !== EmptyValue && rawNumber(mark) !== 0)) kept.push(row)
			}
		}

		if (kept.length === 0) return calcError()

		const table = relationship === 1
		const rowRoot = grouped(rowFields, kept, rowLevels, table)
		const colRoot = grouped(colFields, kept, colLevels, false)
		const [main] = functions.list as [Aggregator]
		const sortMeasure =
			(other: Group) =>
			(rows: readonly number[], column: number): PluginScalar =>
				this.aggregate(rows, () => other.rows, valueRows, column, main, state)

		this.order(rowRoot, rowLevels, table, rowSorts, sortMeasure(rowRoot))
		this.order(colRoot, colLevels, false, colSorts, sortMeasure(colRoot))
		rank(colRoot, 0)

		const rowDepth = rowDepthOption ?? (table ? 1 : rowLevels)
		const colDepth = colDepthOption ?? colLevels
		const rowEntries = entries(rowRoot, Math.abs(rowDepth), rowDepth < 0)
		const colEntries = entries(colRoot, Math.abs(colDepth), colDepth < 0)

		// Measures: each value column with each function laid out by column; the functions laid out by row apart.
		const across: [number, Aggregator | null][] = []

		for (let column = 0; column < valueCount; column++)
			if (functions.vertical) across.push([column, null])
			else for (const aggregator of functions.list) across.push([column, aggregator])

		const down: (Aggregator | null)[] = functions.vertical ? functions.list : [null]
		const named = !functions.vertical && functions.list.length > 1
		const labels = rowLevels + (functions.vertical ? 1 : 0)
		const headerRows = colLevels + (show ? 1 : 0) + (named ? 1 : 0)
		const outRows = headerRows + rowEntries.length * down.length
		const outCols = labels + colEntries.length * across.length

		if (outRows * outCols > MAX_ARRAY_CELLS) return unmodeledError()

		const header = (fields: readonly (readonly PluginScalar[])[], column: number, generated: string): PluginScalar =>
			generate ? `${generated} ${String(column + 1)}` : (fields[0]?.[column] ?? EmptyValue)
		const out: PluginScalar[][] = []

		// Column headers: the column groups' keys, then the value headers, then the functions' names.
		for (let level = 0; level < colLevels; level++) {
			const line: PluginScalar[] = new Array<PluginScalar>(outCols).fill(EmptyValue)

			if (show) line[labels - 1] = header(colFields, level, "Column Field")

			colEntries.forEach((entry, index) => {
				const keys = entry.group.keys
				const label = entry.group.parent === null ? (level === 0 ? TOTAL : EmptyValue) : (keys[level] ?? EmptyValue)

				for (let at = 0; at < across.length; at++) line[labels + index * across.length + at] = label
			})
			out.push(line)
		}

		if (show) {
			const line: PluginScalar[] = new Array<PluginScalar>(outCols).fill(EmptyValue)

			colEntries.forEach((_, index) => {
				across.forEach(([column], at) => {
					line[labels + index * across.length + at] = header(valueRows, column, "Value")
				})
			})
			out.push(line)
		}

		if (named) {
			const line: PluginScalar[] = new Array<PluginScalar>(outCols).fill(EmptyValue)

			colEntries.forEach((_, index) => {
				across.forEach(([, aggregator], at) => {
					line[labels + index * across.length + at] = aggregator?.name ?? EmptyValue
				})
			})
			out.push(line)
		}

		if (show) {
			const line = out[out.length - 1] as PluginScalar[]

			for (let level = 0; level < rowLevels; level++) line[level] = header(rowFields, level, "Row Field")
		}

		// The rows of a row group within a column group, in data order.
		const within = (rowGroup: Group, colGroup: Group, ranks: Int32Array): readonly number[] => {
			if (colGroup.parent === null) return rowGroup.rows
			if (rowGroup.parent === null) return colGroup.rows

			return rowGroup.rows.filter(row => {
				const at = ranks[row] as number

				return at >= colGroup.first && at < colGroup.end
			})
		}
		// Each data row's column leaf rank.
		const ranks = new Int32Array(height)

		if (colLevels > 0) {
			const mark = (node: Group): void => {
				if (node.ordered.length === 0) for (const row of node.rows) ranks[row] = node.first
				else for (const child of node.ordered) mark(child)
			}

			mark(colRoot)
		}

		for (const entry of rowEntries) {
			const rowGroup = entry.group
			// Each column leaf's rows of this row group.
			const buckets: number[][] = []

			if (colLevels > 0)
				for (const row of rowGroup.rows) {
					const at = ranks[row] as number

					;(buckets[at] ??= []).push(row)
				}

			for (const aggregator of down) {
				const line: PluginScalar[] = new Array<PluginScalar>(outCols).fill(EmptyValue)

				if (rowGroup.parent === null) line[0] = TOTAL
				else for (let level = 0; level < rowGroup.keys.length; level++) line[level] = rowGroup.keys[level] ?? EmptyValue

				if (aggregator !== null) line[rowLevels] = aggregator.name

				colEntries.forEach((colEntry, index) => {
					const colGroup = colEntry.group
					const rows =
						colLevels > 0 && colGroup.ordered.length === 0 ? (buckets[colGroup.first] ?? []) : within(rowGroup, colGroup, ranks)
					const relative = (): readonly number[] => {
						switch (relativeTo) {
							case 1:
								return rowGroup.rows
							case 2:
								return rowRoot.rows
							case 3:
								return within(rowGroup.parent ?? rowGroup, colGroup, ranks)
							case 4:
								return within(rowGroup, colGroup.parent ?? colGroup, ranks)
							default:
								return colGroup.rows
						}
					}

					across.forEach(([column, horizontal], at) => {
						line[labels + index * across.length + at] = this.aggregate(
							rows,
							relative,
							valueRows,
							column,
							(aggregator ?? horizontal) as Aggregator,
							state
						)
					})
				})
				out.push(line)
			}
		}

		return out.length === 1 && out[0]?.length === 1 ? (out[0][0] ?? EmptyValue) : SimpleRangeValue.onlyValues(out)
	}
}
