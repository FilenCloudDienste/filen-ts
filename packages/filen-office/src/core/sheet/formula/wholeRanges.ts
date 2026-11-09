import { EmptyValue, HyperFormula, SimpleRangeValue } from "hyperformula"
import { MAX_COLUMNS, MAX_ROWS } from "../model/model"
import { compareLookup, lookupValue, sameClass, type Lookup } from "./functions/values"
import type { PluginScalar } from "./functions/plugin"

// Whole-column (A:A) and whole-row (1:1) references, as far as the engine reads them. HyperFormula ends one at the
// sheet's height (or width), so a single cell written in the grid's last row makes every whole-column reference of
// that sheet read a million cells at each recalculation, whichever column the cell is in. Here they end one row past
// the last cell of the columns (rows) that the sheet's whole-column (whole-row) references cover, one end for all of
// them and for the sheets a formula pairs with it, so paired ranges keep one size (SUMIFS(A:A,B:B,…),
// SUMIFS(One!B:B,Two!A:A,…)). Past that end every covered column is empty, so what a reference sums, counts or finds
// is unchanged; what reads Excel's full 1,048,576 rows (ROWS, blank counts, the last match) adds the empty rest
// itself (functions/plugin.ts wholeTail).

type Graph = HyperFormula["dependencyGraph"]

interface Address {
	readonly row: number
	readonly col: number
}

interface WholeRange {
	readonly sheet: number
	readonly start: Address
	readonly end: Address
}

// A sheet's covered columns (or rows) and where their last cell is, along one axis.
interface Axis {
	// Covered indices, ascending, as [first, last] pairs.
	spans: [number, number][]
	// One past the last cell of the covered indices; -1 until read.
	end: number
}

interface SheetState {
	columns: Axis
	rows: Axis
}

function covers(spans: readonly [number, number][], first: number, last: number): boolean {
	for (const [from, to] of spans) if (from <= first && last <= to) return true

	return false
}

function cover(spans: [number, number][], first: number, last: number): [number, number][] {
	const merged: [number, number][] = []
	let next: [number, number] = [first, last]

	for (const span of [...spans].sort((a, b) => a[0] - b[0])) {
		if (span[1] + 1 < next[0] || next[1] + 1 < span[0]) merged.push(span)
		else next = [Math.min(span[0], next[0]), Math.max(span[1], next[1])]
	}

	merged.push(next)

	return merged.sort((a, b) => a[0] - b[0])
}

// The engine's cell storage of one sheet (AddressMapping's strategies), read for where the last cell is: sparse
// keeps a map of rows per column, dense an array of columns per row.
interface Storage {
	readonly mapping: unknown
	getHeight(): number
}

function lastRowIn(storage: Storage, spans: readonly [number, number][]): number {
	if (spans.length === 0) return 0

	const mapping = storage.mapping
	let last = -1

	if (mapping instanceof Map) {
		for (const [first, end] of spans) {
			for (let col = first; col <= end; col++) {
				const rows: unknown = mapping.get(col)

				if (!(rows instanceof Map)) continue

				for (const row of rows.keys() as Iterable<number>) if (row > last) last = row
			}
		}

		return last + 1
	}

	if (!Array.isArray(mapping)) return storage.getHeight()

	for (let row = Math.min(mapping.length, storage.getHeight()) - 1; row >= 0; row--) {
		const line: unknown = mapping[row]

		if (!Array.isArray(line)) continue

		for (const [first, end] of spans) {
			for (let col = first; col <= Math.min(end, line.length - 1); col++) if (line[col] !== undefined) return row + 1
		}
	}

	return 0
}

function lastColumnIn(storage: Storage, spans: readonly [number, number][]): number {
	if (spans.length === 0) return 0

	const mapping = storage.mapping
	let last = -1

	if (mapping instanceof Map) {
		for (const [col, rows] of mapping as Map<number, unknown>) {
			if (col <= last || !(rows instanceof Map)) continue

			for (const [first, end] of spans) {
				for (let row = first; row <= end && col > last; row++) if (rows.has(row)) last = col
			}
		}

		return last + 1
	}

	if (!Array.isArray(mapping)) return Number.POSITIVE_INFINITY

	for (const [first, end] of spans) {
		for (let row = first; row <= Math.min(end, mapping.length - 1); row++) {
			const line: unknown = mapping[row]

			if (!Array.isArray(line)) continue

			for (let col = line.length - 1; col > last; col--) {
				if (line[col] !== undefined) {
					last = col
					break
				}
			}
		}
	}

	return last + 1
}

// One engine's whole-range ends, by engine sheet id.
export class WholeRanges {
	private graph: Graph | null = null
	private readonly sheets = new Map<number, SheetState>()
	// Each sheet's group's end (one past its last covered cell), by engine sheet id, as read last; cleared on a change.
	private readonly columnEnds = new Map<number, number>()
	private readonly rowEnds = new Map<number, number>()
	// Sheets whose whole columns (rows) one formula pairs (SUMIFS(One!B:B,Two!A:A,…)), by upper-case name: a union of
	// them, by each one's parent. Their ranges end in one place, so the pairs keep one size.
	private readonly links = new Map<string, string>()

	private changed(): void {
		this.columnEnds.clear()
		this.rowEnds.clear()
	}

	private use(graph: Graph): void {
		if (graph === this.graph) return

		this.graph = graph
		this.reset()
	}

	private state(graph: Graph, sheet: number): SheetState {
		this.use(graph)

		let state = this.sheets.get(sheet)

		if (state === undefined) {
			state = { columns: { spans: [], end: -1 }, rows: { spans: [], end: -1 } }
			this.sheets.set(sheet, state)
			this.seed(graph, sheet, state)
		}

		return state
	}

	// Every whole-column and whole-row reference the engine holds, as covered: ranges of one sheet then end at the
	// same place however they come to be read.
	private seed(graph: Graph, sheet: number, state: SheetState): void {
		for (const vertex of graph.graph.getInfiniteRanges()) {
			const range = (vertex as { range?: WholeRange }).range

			if (range?.sheet !== sheet) continue

			if (range.end.row === Number.POSITIVE_INFINITY) state.columns.spans = cover(state.columns.spans, range.start.col, range.end.col)
			else if (range.end.col === Number.POSITIVE_INFINITY) state.rows.spans = cover(state.rows.spans, range.start.row, range.end.row)
		}
	}

	// The sheet's cells, or null for a sheet the engine holds none for (one a formula names that the workbook lacks).
	private storage(graph: Graph, sheet: number): Storage | null {
		try {
			return graph.addressMapping.getStrategyForSheetOrThrow(sheet) as unknown as Storage
		} catch {
			return null
		}
	}

	private root(name: string): string {
		let at = name

		for (let parent = this.links.get(at); parent !== undefined && parent !== at; parent = this.links.get(at)) at = parent

		return at
	}

	// Sheets (by name, any case) that one formula reads whole columns or rows of together.
	link(names: readonly string[]): void {
		const roots = [...new Set(names.map(name => this.root(name.toUpperCase())))]
		const [first] = roots

		if (first === undefined || roots.length < 2) return

		for (const root of roots) this.links.set(root, first)

		this.changed()
	}

	rename(from: string, to: string): void {
		const before = from.toUpperCase()
		const after = to.toUpperCase()

		if (before === after) return

		for (const [name, parent] of [...this.links]) {
			this.links.delete(name)
			this.links.set(name === before ? after : name, parent === before ? after : parent)
		}
	}

	// The engine sheet ids whose whole ranges end together with this sheet's.
	private group(graph: Graph, sheet: number): number[] {
		const name = graph.sheetMapping.getSheetName(sheet)?.toUpperCase()

		if (name === undefined || this.links.size === 0) return [sheet]

		const root = this.root(name)
		const ids = new Set([sheet])

		for (const member of this.links.keys()) {
			if (this.root(member) !== root) continue

			const id = graph.sheetMapping.getSheetId(member)

			if (id !== undefined) ids.add(id)
		}

		return [...ids]
	}

	private localEnd(graph: Graph, sheet: number, columns: boolean): number {
		const state = this.state(graph, sheet)
		const axis = columns ? state.columns : state.rows

		if (axis.end < 0) {
			const storage = this.storage(graph, sheet)

			axis.end =
				storage === null || axis.spans.length === 0
					? 0
					: columns
						? lastRowIn(storage, axis.spans)
						: lastColumnIn(storage, axis.spans)
		}

		return axis.end
	}

	// One past the last covered cell of the sheet's group, along whole columns (`columns`) or whole rows.
	private groupEnd(graph: Graph, sheet: number, columns: boolean): number {
		const cache = columns ? this.columnEnds : this.rowEnds
		const known = cache.get(sheet)

		if (known !== undefined) return known

		let end = 0

		for (const member of this.group(graph, sheet)) end = Math.max(end, this.localEnd(graph, member, columns))

		cache.set(sheet, end)

		return end
	}

	private covering(graph: Graph, range: WholeRange, columns: boolean): void {
		const state = this.state(graph, range.sheet)
		const axis = columns ? state.columns : state.rows
		const first = columns ? range.start.col : range.start.row
		const last = columns ? range.end.col : range.end.row

		if (covers(axis.spans, first, last)) return

		axis.spans = cover(axis.spans, first, last)
		axis.end = -1
		this.changed()
	}

	// Where a whole-column range ends: one row past the last cell of the columns its group covers, so a search for a
	// blank finds one (MATCH(TRUE,ISBLANK(A:A),0)); every row from there down is empty.
	height(graph: Graph, range: WholeRange): number {
		this.covering(graph, range, true)

		return Math.min(MAX_ROWS, this.groupEnd(graph, range.sheet, true) + 1)
	}

	width(graph: Graph, range: WholeRange): number {
		this.covering(graph, range, false)

		return Math.min(MAX_COLUMNS, this.groupEnd(graph, range.sheet, false) + 1)
	}

	// Where the sheet's group's whole-column references end (`rows`) and its whole-row references (`cols`) as covered
	// now, without the blank row.
	ends(graph: Graph, sheet: number): { readonly rows: number; readonly cols: number } {
		return { rows: this.groupEnd(graph, sheet, true), cols: this.groupEnd(graph, sheet, false) }
	}

	// The sheets (upper-case names) whose whole ranges end with this sheet's.
	groupNames(graph: Graph, sheet: number): Set<string> {
		const names = new Set<string>()

		for (const id of this.group(graph, sheet)) {
			const name = graph.sheetMapping.getSheetName(id)

			if (name !== undefined) names.add(name.toUpperCase())
		}

		return names
	}

	// What the group's whole-column references read per row they reach (`rows`: each one's columns times the formulas
	// reading it), and its whole-row references per column (`cols`).
	load(graph: Graph, sheet: number): { readonly rows: number; readonly cols: number } {
		const members = new Set(this.group(graph, sheet))
		let rows = 0
		let cols = 0

		for (const vertex of graph.graph.getInfiniteRanges()) {
			const range = (vertex as { range?: WholeRange }).range

			if (range === undefined || !members.has(range.sheet)) continue

			const readers = graph.graph.adjacentNodesCount(vertex)

			if (range.end.row === Number.POSITIVE_INFINITY) rows += readers * (range.end.col - range.start.col + 1)
			else if (range.end.col === Number.POSITIVE_INFINITY) cols += readers * (range.end.row - range.start.row + 1)
		}

		return { rows, cols }
	}

	// A non-empty cell written (a held result's too): the ends move past it when its column (row) is covered.
	written(sheet: number, row: number, col: number): void {
		const state = this.sheets.get(sheet)

		if (state === undefined) return

		if (state.columns.end >= 0 && row >= state.columns.end && covers(state.columns.spans, col, col)) {
			state.columns.end = row + 1
			this.columnEnds.clear()
		}

		if (state.rows.end >= 0 && col >= state.rows.end && covers(state.rows.spans, row, row)) {
			state.rows.end = col + 1
			this.rowEnds.clear()
		}
	}

	// Cells moved or arrived other than one by one (rows or columns inserted or removed, a spilled array): every end and
	// what is covered read again. Linked sheets stay linked.
	reset(): void {
		this.sheets.clear()
		this.changed()
	}

	// What a cell written at the sheet's far edge makes whole-column (whole-row) references read: whether its column
	// (row) is one they cover.
	reads(sheet: number, row: number, col: number): { readonly rows: boolean; readonly cols: boolean } {
		const state = this.sheets.get(sheet)

		if (state === undefined) return { rows: true, cols: true }

		return { rows: covers(state.columns.spans, col, col), cols: covers(state.rows.spans, row, row) }
	}
}

interface SearchRange extends WholeRange {
	isFinite(): boolean
	effectiveEndRow(graph: unknown): number
	effectiveEndColumn(graph: unknown): number
}

// What a search reads: a range, or values alone (valuesFromTopLeftCorner).
interface SearchValues {
	readonly range?: SearchRange
	valuesFromTopLeftCorner(): unknown[]
}

interface SearchInternals {
	readonly dependencyGraph: GraphInternals & { getScalarValue(address: Address & { readonly sheet: number }): unknown }
}

type BasicFind = (
	this: SearchInternals,
	key: unknown,
	range: SearchValues,
	coordinate: string,
	options: { ordering: string; ifNoMatch?: string }
) => number
type AdvancedFind = (this: SearchInternals, matcher: (value: unknown) => boolean, range: SearchValues, options?: object) => number

interface SearchPrototype {
	basicFind: BasicFind
	advancedFind: AdvancedFind
}

// A whole range's stored cells as the values a search reads, in the order it reads them (row by row), each with its
// position in the range's values; null where the range is not whole or fills most of what it spans.
function storedValues(graph: SearchInternals["dependencyGraph"], range: SearchRange): { values: unknown[]; at: number[] } | null {
	const columns = range.end.row === Number.POSITIVE_INFINITY
	const endRow = range.effectiveEndRow(graph)
	const endCol = range.effectiveEndColumn(graph)
	const width = endCol - range.start.col + 1
	const height = endRow - range.start.row + 1
	let storage: Storage

	try {
		storage = graph.addressMapping.getStrategyForSheetOrThrow(range.sheet)
	} catch {
		return null
	}

	const found: { address: Address; at: number }[] = []

	for (const address of storedIn(storage, range, columns ? endRow : endCol, columns)) {
		found.push({ address, at: (address.row - range.start.row) * width + (address.col - range.start.col) })
	}

	// Most of the range filled: reading it whole costs no more.
	if (found.length * 4 > width * height) return null

	let sorted = true

	for (let k = 1; k < found.length && sorted; k++) sorted = (found[k - 1] as { at: number }).at < (found[k] as { at: number }).at

	if (!sorted) found.sort((a, b) => a.at - b.at)

	return {
		values: found.map(entry => graph.getScalarValue({ sheet: range.sheet, ...entry.address })),
		at: found.map(entry => entry.at)
	}
}

// An approximate search (VLOOKUP and HLOOKUP with range_lookup TRUE, MATCH with match_type 1 or -1): the last value at
// most the key in an ascending vector (descending: at least it), by binary search over the values of the key's class
// alone, as Excel compares (numbers, text without regard to case, logical values each among their own; empty cells and
// errors left out). The engine compared across classes, numbers before text, so a number among the text of a sorted
// row ended its search early. Reads O(log n) cells of a vector of one class. -1 when none.
function approximate(count: number, at: (index: number) => unknown, key: Lookup, descending: boolean): number {
	const read = (index: number): Lookup | null => {
		const value = lookupValue(at(index) as PluginScalar)

		return value !== null && sameClass(value, key) ? value : null
	}
	let low = 0
	let high = count - 1
	let best = -1
	let exact = false

	while (low <= high) {
		const mid = (low + high) >> 1
		let index = mid
		let value = read(index)

		// The first value of the key's class from mid on; none: what is left is below mid.
		while (value === null && index < high) value = read(++index)

		if (value === null) {
			high = mid - 1

			continue
		}

		const order = compareLookup(value, key)

		if (order === 0) {
			// The last of equal values, as a sorted search ends there.
			best = index
			exact = true
			low = index + 1
		} else if (descending ? order > 0 : order < 0) {
			if (!exact) best = index
			low = index + 1
		} else high = mid - 1
	}

	return best
}

// Searches (VLOOKUP, HLOOKUP, MATCH, XLOOKUP) through a whole column or row that reaches far past its cells read the
// cells stored there, not every address to the end: a match among them is where the full read finds it, empty cells
// never match a key that is not empty, and an unordered search for the nearest value skips them.
function installSparseSearch(prototype: SearchPrototype): void {
	const basic = prototype.basicFind
	const advanced = prototype.advancedFind

	prototype.basicFind = function (key, range, coordinate, options) {
		const whole = range.range
		const searched = key === EmptyValue ? null : lookupValue(key as PluginScalar)

		const ascending = options.ordering === "asc" && options.ifNoMatch === "returnLowerBound"
		const descending = options.ordering === "desc" && options.ifNoMatch === "returnUpperBound"

		if (searched !== null && (ascending || descending)) {
			if (whole === undefined) {
				const values = range.valuesFromTopLeftCorner()

				return approximate(values.length, index => values[index], searched, descending)
			}

			const graph = this.dependencyGraph
			const columns = coordinate === "col"
			const first = columns ? whole.start.col : whole.start.row
			const last = columns ? whole.effectiveEndColumn(graph) : whole.effectiveEndRow(graph)

			return approximate(
				Math.max(0, last - first + 1),
				index =>
					graph.getScalarValue(
						columns
							? { sheet: whole.sheet, row: whole.start.row, col: first + index }
							: { sheet: whole.sheet, row: first + index, col: whole.start.col }
					),
				searched,
				descending
			)
		}

		if (whole === undefined || whole.isFinite() || options.ordering !== "none" || key === EmptyValue)
			return basic.call(this, key, range, coordinate, options)

		const stored = storedValues(this.dependencyGraph, whole)

		if (stored === null) return basic.call(this, key, range, coordinate, options)

		const found = basic.call(this, key, { valuesFromTopLeftCorner: () => stored.values }, coordinate, options)

		return found < 0 ? found : (stored.at[found] ?? -1)
	}

	prototype.advancedFind = function (matcher, range, options) {
		const whole = range.range

		if (whole === undefined || whole.isFinite() || matcher(EmptyValue)) return advanced.call(this, matcher, range, options)

		const stored = storedValues(this.dependencyGraph, whole)

		if (stored === null) return advanced.call(this, matcher, range, options)

		const found = advanced.call(this, matcher, { valuesFromTopLeftCorner: () => stored.values }, options)

		return found < 0 ? found : (stored.at[found] ?? -1)
	}
}

interface ReadRange {
	readonly range?: SearchRange
	readonly dependencyGraph: { getCellValue(address: Address & { readonly sheet: number }): unknown }
	readonly data: unknown[][]
	width(): number
	height(): number
}

type Xlookup = (this: unknown, key: unknown, lookup: ReadRange, read: ReadRange, ...rest: unknown[]) => unknown

// XLOOKUP's result row read alone from a vertical return range (a whole column's too): the engine reads the range's
// every row for the one it returns, each call.
function installRowRead(prototype: { doXlookup: Xlookup }): void {
	const xlookup = prototype.doXlookup

	prototype.doXlookup = function (key, lookup, read, ...rest) {
		const whole = read.range

		if (whole === undefined || lookup.width() !== 1 || read.height() !== lookup.height())
			return xlookup.call(this, key, lookup, read, ...rest)

		const rowAt = (index: number): unknown[] =>
			Array.from({ length: read.width() }, (_, col) => {
				const value = read.dependencyGraph.getCellValue({
					sheet: whole.sheet,
					row: whole.start.row + index,
					col: whole.start.col + col
				})

				return value instanceof SimpleRangeValue ? read.data[index]?.[col] : value
			})
		const rows = new Proxy([] as unknown[][], {
			get: (target, property, receiver) =>
				typeof property === "string" && /^\d+$/.test(property) ? rowAt(Number(property)) : Reflect.get(target, property, receiver)
		})

		return xlookup.call(this, key, lookup, Object.create(read, { data: { get: () => rows } }) as ReadRange, ...rest)
	}
}

// The ends in force for the engine calculating now (FormulaEngine sets them around every call into it).
let active: WholeRanges | null = null

export function withWholeRanges<T>(ranges: WholeRanges | null, work: () => T): T {
	const previous = active

	active = ranges

	try {
		return work()
	} finally {
		active = previous
	}
}

let installed = false

interface GraphRangeVertex {
	idInGraph?: number
	bruteForce: boolean
}

interface GraphInternals {
	readonly addressMapping: { getStrategyForSheetOrThrow(sheet: number): Storage }
	readonly rangeMapping: { addOrUpdateVertex(vertex: GraphRangeVertex): void }
	readonly arrayMapping: { getArray(range: unknown): unknown }
	readonly graph: {
		addNodeIfNotExists(vertex: unknown): void
		addEdge(from: unknown, to: unknown): void
		markNodeAsInfiniteRange(id: number): void
	}
	getRange(start: Address, end: Address): GraphRangeVertex | undefined
	fetchCellOrCreateEmpty(address: Address & { readonly sheet: number }): { vertex: unknown; id?: number }
}

type ProcessDependencies = (this: GraphInternals, dependencies: unknown[], end: { idInGraph?: number }) => void

// The stored cells of a whole-column (whole-row) range up to its end.
function* storedIn(storage: Storage, range: WholeRange, end: number, columns: boolean): Generator<Address> {
	const mapping = storage.mapping

	if (mapping instanceof Map) {
		for (const [col, rows] of mapping as Map<number, unknown>) {
			if (!(rows instanceof Map)) continue
			if (columns ? col < range.start.col || col > range.end.col : col > end) continue

			for (const row of rows.keys() as Iterable<number>) {
				if (columns ? row <= end : row >= range.start.row && row <= range.end.row) yield { row, col }
			}
		}

		return
	}

	if (!Array.isArray(mapping)) return

	const [first, last] = columns ? [0, Math.min(end, mapping.length - 1)] : [range.start.row, Math.min(range.end.row, mapping.length - 1)]

	for (let row = first; row <= last; row++) {
		const line: unknown = mapping[row]

		if (!Array.isArray(line)) continue

		const [from, to] = columns ? [range.start.col, Math.min(range.end.col, line.length - 1)] : [0, Math.min(end, line.length - 1)]

		for (let col = from; col <= to; col++) if (line[col] !== undefined) yield { row, col }
	}
}

type EffectiveExtent = (this: WholeRange, graph: Graph) => number

// Ends the engine's whole-column and whole-row ranges as above. Its range classes are not exported: they are found
// from the ranges of a throwaway engine, and their extent methods replaced once (HyperFormula is pinned exactly).
export function installWholeRanges(licenseKey: string): void {
	if (installed) return

	installed = true

	const probe = HyperFormula.buildFromArray([[], [null, null, "=SUM(1:1)"], [null, "=SUM(A:A)"]], { licenseKey })

	try {
		const graphPrototype = Object.getPrototypeOf(probe.dependencyGraph) as { processCellDependencies: ProcessDependencies }
		const process = graphPrototype.processCellDependencies
		let RangeVertex: (new (range: WholeRange) => GraphRangeVertex) | null = null

		for (const vertex of probe.dependencyGraph.graph.getInfiniteRanges()) {
			RangeVertex = (vertex as object).constructor as new (range: WholeRange) => GraphRangeVertex

			break
		}

		const Vertex = RangeVertex

		// A whole-column (whole-row) range reads the cells stored in it, not every address to its end: HyperFormula
		// would make an empty cell of each (a million for a column a cell in the last row ends), and walk them again for
		// every formula reading the range. A cell written into it later is joined to it as it is written (the engine's
		// correctInfiniteRangesDependency), so the empty addresses need no vertex.
		if (Vertex !== null) {
			const joined = new WeakSet<GraphRangeVertex>()

			graphPrototype.processCellDependencies = function (dependencies, endVertex) {
				const rest: unknown[] = []
				const endId = endVertex.idInGraph

				for (const dependency of dependencies) {
					const range = dependency as Partial<WholeRange> & {
						isFinite?: () => boolean
						effectiveEndRow?: (graph: unknown) => number
						effectiveEndColumn?: (graph: unknown) => number
					}

					if (
						endId === undefined ||
						typeof range.isFinite !== "function" ||
						range.isFinite() ||
						range.start === undefined ||
						range.end === undefined ||
						range.sheet === undefined
					) {
						rest.push(dependency)

						continue
					}

					const whole = range as WholeRange
					const columns = whole.end.row === Number.POSITIVE_INFINITY
					let vertex = this.getRange(whole.start, whole.end)

					if (vertex === undefined) {
						vertex = new Vertex(whole)
						this.rangeMapping.addOrUpdateVertex(vertex)
					}

					this.graph.addNodeIfNotExists(vertex)

					const id = vertex.idInGraph

					if (id === undefined) throw new Error("spreadsheet: a range vertex is not in the graph")

					this.graph.markNodeAsInfiniteRange(id)

					if (!joined.has(vertex)) {
						joined.add(vertex)
						vertex.bruteForce = true

						const array = this.arrayMapping.getArray(whole)

						if (array !== undefined) {
							this.graph.addEdge(array, id)
						} else {
							const end = columns ? (range.effectiveEndRow?.(this) ?? -1) : (range.effectiveEndColumn?.(this) ?? -1)
							const storage = this.addressMapping.getStrategyForSheetOrThrow(whole.sheet)

							for (const address of storedIn(storage, whole, end, columns)) {
								const cell = this.fetchCellOrCreateEmpty({ sheet: whole.sheet, ...address })

								this.graph.addEdge(cell.id ?? cell.vertex, id)
							}
						}
					}

					this.graph.addEdge(id, endId)
				}

				if (rest.length > 0) process.call(this, rest, endVertex)
			}
		}

		installSparseSearch(Object.getPrototypeOf(Object.getPrototypeOf(probe.columnSearch)) as SearchPrototype)

		const lookups = HyperFormula.getFunctionPlugin("XLOOKUP")?.prototype as { doXlookup?: Xlookup } | undefined

		if (lookups?.doXlookup !== undefined) installRowRead(lookups as { doXlookup: Xlookup })

		for (const vertex of probe.dependencyGraph.graph.getInfiniteRanges()) {
			const range = (vertex as { range?: WholeRange }).range

			if (range === undefined) continue

			const prototype = Object.getPrototypeOf(range) as { effectiveHeight?: EffectiveExtent; effectiveWidth?: EffectiveExtent }

			if (range.end.row === Number.POSITIVE_INFINITY) {
				prototype.effectiveHeight = function (graph) {
					return active === null ? graph.getSheetHeight(this.sheet) : active.height(graph, this)
				}
			} else if (range.end.col === Number.POSITIVE_INFINITY) {
				prototype.effectiveWidth = function (graph) {
					return active === null ? graph.getSheetWidth(this.sheet) : active.width(graph, this)
				}
			}
		}
	} finally {
		probe.destroy()
	}
}
