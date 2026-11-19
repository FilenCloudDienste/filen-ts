import { CellError, EmptyValue, HyperFormula, SimpleRangeValue } from "hyperformula"

// Large finite blocks (SUM(L1:AO69000)) as the engine reads them. HyperFormula joins every address of a finite range
// to the range's vertex and makes an empty cell of each one the sheet holds nothing at: two million of them for that
// block over twenty rows of data, a second and half a gigabyte to build. A block of more than THRESHOLD cells that has
// no range one row shorter to chain onto is joined here to the cells the sheet stores in it alone, as wholeRanges.ts
// does for whole columns, and kept in a registry of its engine's graph by vertex (which the engine moves with
// inserted and removed rows and columns). A cell written into it later is joined as it is written (the engine's
// correctInfiniteRangesDependency, called for every value, formula and parse error it writes), an array formula
// spilling into it as it spills, and rows or columns inserted into it add what the sheet stores there (nothing,
// unless an array moved in) instead of an empty cell for each address. What the engine's empty cells did besides is
// done for the block itself: its far corner keeps an empty cell (the sheet's height and width reach it, as the
// engine's structural edits and whole ranges read them); rows or columns inserted into it or removed from it, a cell
// of it cleared, and its sheet cleared, mark it for recalculation; and what reads one of its cells (getCellDependents)
// includes it. A block under a whole column or row, or on a placeholder sheet merged into a renamed one, is left to
// the engine's own join, which those join to every cell of it. An address with no cell reads as an empty
// value whether or not it has a vertex, so every function reads what it read before: the aggregations of the
// engine's reduce (SUM, COUNT, AVERAGE, …) read the stored cells alone, in the row-by-row order the engine reads
// addresses in, the empty values they leave out (or count as 0) left aside. What reads a block whole
// (SimpleRangeValue: SUMPRODUCT, COUNTIF, COUNTBLANK, INDEX) still reads every address, at no build cost.
//
// A defined name whose value is a block has its value exported at each recalculation, every address of it twice
// (ContentChanges.add, Exporter.exportChange), though nothing reads a name's change: it is read only if asked for.

// The size past which a block is joined to its stored cells alone.
const THRESHOLD = 65_536

let threshold = THRESHOLD

// Sets the size past which a block is joined to its stored cells alone (Infinity: none is), returning the one in force
// before; for tests that compare the two ways of reading a block. It applies to ranges the engine adds from then on.
export function sparseRangeThreshold(cells: number): number {
	const previous = threshold

	threshold = cells

	return previous
}

interface Address {
	readonly sheet: number
	readonly row: number
	readonly col: number
}

interface CellRange {
	readonly start: Address
	readonly end: Address
	isFinite(): boolean
	addressInRange(address: Address): boolean
	includesRow(row: number): boolean
	includesColumn(col: number): boolean
	rangeWithSameWidth(row: number, count: number): CellRange
	rangeWithSameHeight(col: number, count: number): CellRange
	intersectionWith(other: CellRange): CellRange | undefined
	addresses(graph: unknown): Address[]
}

interface RangeVertex {
	readonly range: CellRange
	idInGraph?: number
	bruteForce: boolean
	getFunctionValue(name: string): unknown
}

interface ArrayVertex {
	getRangeOrUndef(): CellRange | undefined
}

interface Storage {
	readonly mapping: unknown
}

type Node = object

interface DependencyGraph {
	readonly graph: {
		hasNode(node: Node): boolean
		addNodeIfNotExists(node: Node): number
		addEdge(from: Node | number, to: Node | number): void
		existsEdge(from: Node, to: Node): boolean
		markNodeAsDirty(node: Node): void
		getInfiniteRanges(): RangeVertex[]
	}
	readonly addressMapping: {
		getStrategyForSheetOrThrow(sheet: number): Storage
		sheetEntries(sheet: number): Iterable<[Address, Node]>
	}
	readonly rangeMapping: RangeMapping
	readonly arrayMapping: { getArray(range: CellRange): unknown }
	getRange(start: Address, end: Address): RangeVertex | undefined
	isPlaceholder(sheet: number): boolean
	getScalarValue(address: Address): unknown
	fetchCellOrCreateEmpty(address: Address): { vertex: Node; id?: number }
	isThereSpaceForArray(vertex: Node): boolean
}

interface RangeMapping {
	addOrUpdateVertex(vertex: RangeVertex): void
	findSmallerRange(range: CellRange): { smallerRangeVertex?: RangeVertex; restRange: CellRange }
	rangesInSheet(sheet: number): Iterable<RangeVertex>
}

interface GraphPrototype {
	processCellDependencies(this: DependencyGraph, dependencies: readonly unknown[], end: { readonly idInGraph?: number }): void
	correctInfiniteRangesDependency(this: DependencyGraph, address: Address): void
	exchangeOrAddFormulaVertex(this: DependencyGraph, vertex: Node): void
	rangeDirectDependenciesToArray(this: DependencyGraph, vertex: RangeVertex, array: { getRange(): CellRange }): Iterable<[Address, Node]>
	fixRangesWhenAddingRows(this: DependencyGraph, sheet: number, row: number, count: number): void
	fixRangesWhenAddingColumns(this: DependencyGraph, sheet: number, col: number, count: number): void
	removeRows(this: DependencyGraph, span: { readonly sheet: number; readonly rowStart: number; readonly rowEnd: number }): unknown
	removeColumns(
		this: DependencyGraph,
		span: { readonly sheet: number; readonly columnStart: number; readonly columnEnd: number }
	): unknown
	clearSheet(this: DependencyGraph, sheet: number): void
	setCellEmpty(this: DependencyGraph, address: Address): unknown
	mergeSheets(this: DependencyGraph, keep: number, placeholder: number): void
}

// Each engine's blocks joined to their stored cells, by its dependency graph, then by sheet. A block keeps its sheet:
// the one way the engine moves a range to another sheet (a placeholder sheet merged into a renamed one) is preceded by
// the full join of every block there (mergeSheets below).
const registries = new WeakMap<object, Map<number, Set<RangeVertex>>>()

// Visits the graph's blocks of one sheet still in it (a block nothing reads any more is dropped from the graph by the
// engine, and from the registry here as it is met).
function eachBlock(graph: DependencyGraph, sheet: number, visit: (vertex: RangeVertex) => void): void {
	const registry = registries.get(graph)?.get(sheet)

	if (registry === undefined || registry.size === 0) return

	for (const vertex of registry) {
		if (!graph.graph.hasNode(vertex)) registry.delete(vertex)
		else visit(vertex)
	}
}

// The graph's blocks still in it, of one sheet when `sheet` is given.
function blocks(graph: DependencyGraph, sheet?: number): RangeVertex[] {
	const live: RangeVertex[] = []
	const registry = registries.get(graph)

	if (registry === undefined) return live

	for (const at of sheet === undefined ? [...registry.keys()] : [sheet]) eachBlock(graph, at, vertex => live.push(vertex))

	return live
}

function tracked(graph: DependencyGraph, vertex: RangeVertex): boolean {
	return registries.get(graph)?.get(vertex.range.start.sheet)?.has(vertex) === true && graph.graph.hasNode(vertex)
}

function register(graph: DependencyGraph, vertex: RangeVertex): void {
	let registry = registries.get(graph)

	if (registry === undefined) {
		registry = new Map()
		registries.set(graph, registry)
	}

	const sheet = vertex.range.start.sheet
	let set = registry.get(sheet)

	if (set === undefined) {
		set = new Set()
		registry.set(sheet, set)
	}

	set.add(vertex)
}

// The block's far corner as a cell of the sheet, joined to it. The engine's sheet height and width are the furthest
// cell it ever stored (AddressMapping's strategies keep them as counters): with an empty cell at every address of a
// block, they reached the block's corner, and the engine applies a row or column inserted or removed only where it
// starts inside them (Operations.rowEffectivelyNotInSheet). The corner's empty cell, which the full join makes too,
// keeps them where they were, and is made again where rows or columns removed take it.
function joinCorner(graph: DependencyGraph, vertex: RangeVertex): void {
	const id = vertex.idInGraph

	if (id === undefined) return

	const cell = graph.fetchCellOrCreateEmpty(vertex.range.end)

	graph.graph.addEdge(cell.id ?? cell.vertex, id)
}

// The engine's own join of a block, every address an empty cell joined to it, as if it had never been joined sparsely:
// where a whole column or row comes to cover it, or a placeholder sheet is merged with its sheet, what the engine
// does with those cells (joins them to the whole range, reroutes the placeholder's to them, marks them) is not
// repeated here.
function densify(graph: DependencyGraph, vertex: RangeVertex): void {
	registries.get(graph)?.get(vertex.range.start.sheet)?.delete(vertex)

	const id = vertex.idInGraph

	if (id === undefined || !graph.graph.hasNode(vertex)) return

	for (const address of vertex.range.addresses(graph)) {
		const cell = graph.fetchCellOrCreateEmpty(address)

		graph.graph.addEdge(cell.id ?? cell.vertex, id)
	}
}

function isWhole(range: Partial<CellRange>): range is CellRange {
	return typeof range.isFinite === "function" && range.start !== undefined && range.end !== undefined && !range.isFinite()
}

// Where a sheet's tracked blocks in the columns `spans` cover (`columns`) end, one row past the last (in the rows
// they cover, one column past): the engine's empty cells of a block stood in every column and row of it, and
// wholeRanges.ts ends a whole column (row) one past the last cell stored in the columns (rows) covered. 0 for none.
export function blockReach(
	dependencyGraph: object,
	sheet: number,
	spans: readonly (readonly [number, number])[],
	columns: boolean
): number {
	let reach = 0

	eachBlock(dependencyGraph as DependencyGraph, sheet, vertex => {
		const { start, end } = vertex.range
		const first = columns ? start.col : start.row
		const last = columns ? end.col : end.row

		for (const [from, to] of spans) {
			if (from <= last && first <= to) {
				reach = Math.max(reach, (columns ? end.row : end.col) + 1)

				break
			}
		}
	})

	return reach
}

// The cells a sheet stores in `range`, each with its vertex. In no particular order: the sparse storage keeps a map of
// rows per column (one storing more rows than the range has is looked up at the range's rows), the dense one an array
// of columns per row.
function eachStored(storage: Storage, range: CellRange, visit: (row: number, col: number, vertex: Node) => void): void {
	const { start, end } = range
	const mapping = storage.mapping

	if (mapping instanceof Map) {
		const height = end.row - start.row + 1

		for (const [col, rows] of mapping as Map<number, unknown>) {
			if (col < start.col || col > end.col || !(rows instanceof Map)) continue

			const column = rows as Map<number, unknown>

			if (column.size > height) {
				for (let row = start.row; row <= end.row; row++) {
					const vertex = column.get(row)

					if (typeof vertex === "object" && vertex !== null) visit(row, col, vertex)
				}

				continue
			}

			for (const [row, vertex] of column) {
				if (row >= start.row && row <= end.row && typeof vertex === "object" && vertex !== null) visit(row, col, vertex)
			}
		}

		return
	}

	if (!Array.isArray(mapping)) return

	for (let row = start.row, last = Math.min(end.row, mapping.length - 1); row <= last; row++) {
		const line: unknown = mapping[row]

		if (!Array.isArray(line)) continue

		for (let col = start.col, lastCol = Math.min(end.col, line.length - 1); col <= lastCol; col++) {
			const vertex: unknown = line[col]

			if (typeof vertex === "object" && vertex !== null) visit(row, col, vertex)
		}
	}
}

function storage(graph: DependencyGraph, sheet: number): Storage | null {
	try {
		return graph.addressMapping.getStrategyForSheetOrThrow(sheet)
	} catch {
		return null
	}
}

// Joins the cells the sheet stores in `part` to `vertex`.
function joinStored(graph: DependencyGraph, vertex: RangeVertex, part: CellRange): void {
	const id = vertex.idInGraph
	const cells = storage(graph, part.start.sheet)

	if (id === undefined || cells === null) return

	eachStored(cells, part, (_row, _col, cell) => graph.graph.addEdge(cell, id))
}

// Joins the block a formula reads to the cells stored in it, in place of the engine's every address; false where the
// engine joins it itself: a block in reach of THRESHOLD, one row longer than a range in the graph (it reads that
// range's result and its own last row), an array's own cells, of a sheet the workbook lacks, or under a whole column
// or row (in the graph, or read by the same formula: `wholes`), whose range the engine joins to every cell of the
// block it holds.
function joinSparse(
	graph: DependencyGraph,
	dependency: unknown,
	endId: number,
	wholes: readonly CellRange[],
	RangeVertexClass: new (range: CellRange) => RangeVertex
): boolean {
	const range = dependency as Partial<CellRange>

	if (typeof range.isFinite !== "function" || range.start === undefined || range.end === undefined || !range.isFinite()) return false

	const { start, end } = range

	if (!((end.row - start.row + 1) * (end.col - start.col + 1) > threshold)) return false

	const block = range as CellRange
	const held = graph.getRange(start, end)

	// Read twice by one formula, or held: the range keeps its inputs as joined.
	if (held !== undefined) {
		if (!graph.graph.hasNode(held)) return false

		graph.graph.addEdge(held, endId)

		return true
	}

	if (graph.rangeMapping.findSmallerRange(block).smallerRangeVertex !== undefined) return false
	if (graph.arrayMapping.getArray(block) !== undefined || graph.isPlaceholder(start.sheet)) return false

	for (const whole of wholes) if (block.intersectionWith(whole) !== undefined) return false

	for (const whole of graph.graph.getInfiniteRanges()) if (block.intersectionWith(whole.range) !== undefined) return false

	const cells = storage(graph, start.sheet)

	if (cells === null) return false

	const vertex = new RangeVertexClass(block)

	graph.rangeMapping.addOrUpdateVertex(vertex)

	const id = graph.graph.addNodeIfNotExists(vertex)

	vertex.bruteForce = true
	joinCorner(graph, vertex)
	eachStored(cells, block, (_row, _col, cell) => graph.graph.addEdge(cell, id))
	register(graph, vertex)
	graph.graph.addEdge(id, endId)

	return true
}

// The ranges of a sheet, the blocks aside, while `work` runs: what the engine does to every range of the sheet at an
// insert is done to the blocks here.
function withoutBlocks(mapping: RangeMapping, hidden: ReadonlySet<RangeVertex>, work: () => void): void {
	const own = Object.getOwnPropertyDescriptor(mapping, "rangesInSheet")
	const ranges = mapping.rangesInSheet.bind(mapping)

	Object.defineProperty(mapping, "rangesInSheet", {
		configurable: true,
		writable: true,
		value: function* (sheet: number): Generator<RangeVertex> {
			for (const vertex of ranges(sheet)) if (!hidden.has(vertex)) yield vertex
		}
	})

	try {
		work()
	} finally {
		if (own === undefined) Reflect.deleteProperty(mapping, "rangesInSheet")
		else Object.defineProperty(mapping, "rangesInSheet", own)
	}
}

interface AggregationPrototype {
	readonly dependencyGraph: DependencyGraph
	getRangeValues(
		this: AggregationPrototype,
		functionName: string,
		range: CellRange,
		rangeVertex: RangeVertex,
		mapFunction: (value: unknown) => unknown,
		coercionFunction: (value: unknown) => unknown
	): unknown[]
}

// The functions of the engine's reduce whose coercion counts an empty value as 0, summed: one left out adds nothing.
const COUNTING = new Set(["COUNT", "COUNTA"])

// A vertex of the address mapping other than an array formula's: its value is the cell's.
interface CellVertex {
	getCellValue(): unknown
}

// The read walks what a block's columns store (and sorts it into the engine's order) while that is fewer than one in
// WALK_COST of the addresses it would otherwise look up: the two cost the same at about 30 % of the block stored.
const WALK_COST = 3

// What an aggregation reads of a block, in the order the engine reads its addresses (row by row): the coerced value of
// each stored cell, an error as it is, what the coercion leaves out (undefined) left out. The engine's read makes an
// address object for every address of the block and looks each up through the sheet's mapping; this one looks up the
// block's addresses in its columns' maps (or rows' arrays) as they are, or, where its columns store few of its rows,
// walks what they store and sorts it: neither does more than the engine's. False where the sheet's storage is not
// one of the engine's two.
function blockValues(
	graph: DependencyGraph,
	range: CellRange,
	into: unknown[],
	mapFunction: (value: unknown) => unknown,
	coercionFunction: (value: unknown) => unknown,
	ArrayVertexClass: abstract new (...args: never[]) => ArrayVertex
): boolean {
	const cells = storage(graph, range.start.sheet)

	if (cells === null) return false

	const { start, end } = range
	const sheet = start.sheet
	const mapping = cells.mapping

	const read = (row: number, col: number, vertex: unknown): void => {
		let value: unknown = vertex instanceof ArrayVertexClass ? undefined : (vertex as CellVertex).getCellValue()

		// An array formula's cell, or a value that is not one: the engine's own lookup.
		if (value === undefined || value instanceof SimpleRangeValue) value = graph.getScalarValue({ sheet, row, col })

		value = coercionFunction(value)

		if (value instanceof CellError) into.push(value)
		else if (value !== undefined) into.push(mapFunction(value))
	}

	if (Array.isArray(mapping)) {
		for (let row = start.row, last = Math.min(end.row, mapping.length - 1); row <= last; row++) {
			const line: unknown = mapping[row]

			if (!Array.isArray(line)) continue

			for (let col = start.col, lastCol = Math.min(end.col, line.length - 1); col <= lastCol; col++) {
				const vertex: unknown = line[col]

				if (vertex !== undefined) read(row, col, vertex)
			}
		}

		return true
	}

	if (!(mapping instanceof Map)) return false

	const width = end.col - start.col + 1
	const height = end.row - start.row + 1
	const columns: (Map<number, unknown> | undefined)[] = []
	let walked = 0
	let looked = 0

	for (let at = 0; at < width; at++) {
		const column: unknown = (mapping as Map<number, unknown>).get(start.col + at)

		if (column instanceof Map && column.size > 0) {
			columns.push(column as Map<number, unknown>)
			walked += Math.min(column.size, height)
			looked += height
		} else columns.push(undefined)
	}

	if (walked === 0) return true

	if (walked * WALK_COST >= looked) {
		for (let row = start.row; row <= end.row; row++) {
			for (let at = 0; at < width; at++) {
				const vertex = columns[at]?.get(row)

				if (vertex !== undefined) read(row, start.col + at, vertex)
			}
		}

		return true
	}

	// Where in the block each stored cell is, row by row: its row's offset times the width, plus its column's.
	const found = new Float64Array(walked)
	let count = 0

	for (let at = 0; at < width; at++) {
		const column = columns[at]

		if (column === undefined) continue

		if (column.size > height) {
			for (let row = start.row; row <= end.row; row++)
				if (column.get(row) !== undefined) found[count++] = (row - start.row) * width + at

			continue
		}

		for (const [row, vertex] of column) {
			if (row >= start.row && row <= end.row && vertex !== undefined) found[count++] = (row - start.row) * width + at
		}
	}

	// A column's map keeps its rows in the order they were stored, not by row.
	const order = found.subarray(0, count)
	let sorted = true

	for (let at = 1; at < count && sorted; at++) sorted = (order[at - 1] ?? 0) < (order[at] ?? 0)

	if (!sorted) order.sort()

	for (const index of order) {
		const offset = Math.floor(index / width)
		const at = index - offset * width

		read(start.row + offset, start.col + at, columns[at]?.get(start.row + offset))
	}

	return true
}

function installAggregation(prototype: AggregationPrototype, ArrayVertexClass: abstract new (...args: never[]) => ArrayVertex): void {
	const read = prototype.getRangeValues

	prototype.getRangeValues = function (functionName, range, rangeVertex, mapFunction, coercionFunction) {
		const graph = this.dependencyGraph
		const empty = coercionFunction(EmptyValue)

		if (
			!registries.has(graph) ||
			(empty !== undefined && !(empty === 0 && COUNTING.has(functionName))) ||
			graph.isPlaceholder(range.start.sheet)
		)
			return read.call(this, functionName, range, rangeVertex, mapFunction, coercionFunction)

		const { smallerRangeVertex, restRange } = graph.rangeMapping.findSmallerRange(range)
		const chained = smallerRangeVertex !== undefined && graph.graph.existsEdge(smallerRangeVertex, rangeVertex)

		if (chained) {
			// The shorter range's result, or (not read for this function yet) its cells, then the last row.
			if (!tracked(graph, smallerRangeVertex) || smallerRangeVertex.getFunctionValue(functionName) !== undefined)
				return read.call(this, functionName, range, rangeVertex, mapFunction, coercionFunction)

			const values: unknown[] = []

			if (!blockValues(graph, smallerRangeVertex.range, values, mapFunction, coercionFunction, ArrayVertexClass))
				return read.call(this, functionName, range, rangeVertex, mapFunction, coercionFunction)

			for (const address of restRange.addresses(graph)) {
				const value = coercionFunction(graph.getScalarValue(address))

				if (value instanceof CellError) values.push(value)
				else if (value !== undefined) values.push(mapFunction(value))
			}

			return values
		}

		if (!tracked(graph, rangeVertex)) return read.call(this, functionName, range, rangeVertex, mapFunction, coercionFunction)

		const values: unknown[] = []

		return blockValues(graph, range, values, mapFunction, coercionFunction, ArrayVertexClass)
			? values
			: read.call(this, functionName, range, rangeVertex, mapFunction, coercionFunction)
	}
}

interface ChangesPrototype {
	readonly changes: Map<string, unknown>
	add(this: ChangesPrototype, address: Address, change: { readonly value: unknown }): void
}

interface ExporterPrototype {
	exportChange(this: ExporterPrototype, change: { readonly address: Address; readonly value: unknown }): unknown
	exportScalarOrRange(this: ExporterPrototype, value: unknown): unknown
}

// The engine's address for workbook and sheet names (NamedExpressions.SHEET_FOR_WORKBOOK_EXPRESSIONS).
const NAMES_SHEET = -1

// A named expression's change kept as one, its range value read only if its exported value is.
function installNameChanges(changes: ChangesPrototype, exporter: ExporterPrototype): void {
	const add = changes.add
	const exportChange = exporter.exportChange

	// The engine drops each change its range value spills over: a name's value spills over no cell, so only the name's
	// own change is set, under the engine's key (Cell.addressKey).
	changes.add = function (address, change) {
		if (address.sheet !== NAMES_SHEET || !(change.value instanceof SimpleRangeValue)) {
			add.call(this, address, change)

			return
		}

		this.changes.set(`${String(address.sheet)},${String(address.row)},${String(address.col)}`, change)
	}

	exporter.exportChange = function (change) {
		const value = change.value

		if (change.address.sheet !== NAMES_SHEET || !(value instanceof SimpleRangeValue)) return exportChange.call(this, change)

		const exported = exportChange.call(this, { address: change.address, value: EmptyValue })

		if (typeof exported !== "object" || exported === null) return exported

		let read: { value: unknown } | null = null

		Object.defineProperty(exported, "newValue", {
			configurable: true,
			enumerable: true,
			get: () => (read ??= { value: this.exportScalarOrRange(value) }).value
		})

		return exported
	}
}

let installed = false

// Installs the above once, inside sharedRanges.ts (a block in the graph already is joined to the formula alone) and
// over wholeRanges.ts. HyperFormula is pinned exactly; its classes are found from a throwaway engine.
export function installSparseRanges(licenseKey: string): void {
	if (installed) return

	installed = true

	const probe = HyperFormula.buildFromArray([[1, 2, "=SUM(A1:B1)", "=TRANSPOSE(A1:B1)"]], { licenseKey })

	try {
		const dependencyGraph = probe.dependencyGraph as unknown as DependencyGraph
		const graphPrototype = Object.getPrototypeOf(dependencyGraph) as GraphPrototype
		const [sample] = dependencyGraph.rangeMapping.rangesInSheet(0)
		const array = dependencyGraph.fetchCellOrCreateEmpty({ sheet: 0, row: 0, col: 3 }).vertex

		if (sample === undefined || typeof (array as Partial<ArrayVertex>).getRangeOrUndef !== "function")
			throw new Error("spreadsheet: the engine's range and array vertices were not found")

		const RangeVertexClass = (sample as object).constructor as new (range: CellRange) => RangeVertex
		const ArrayVertexClass = array.constructor as abstract new (...args: never[]) => ArrayVertex
		const process = graphPrototype.processCellDependencies

		graphPrototype.processCellDependencies = function (dependencies, endVertex) {
			const endId = endVertex.idInGraph

			if (endId === undefined || threshold === Number.POSITIVE_INFINITY) {
				process.call(this, dependencies, endVertex)

				return
			}

			const wholes = dependencies.filter((dependency): dependency is CellRange => isWhole(dependency as Partial<CellRange>))

			// A whole column or row over a block joined sparsely: the block is joined in full first, as the engine would
			// have it when the whole range is joined to the cells stored in it.
			for (const whole of wholes) {
				for (const vertex of blocks(this, whole.start.sheet))
					if (vertex.range.intersectionWith(whole) !== undefined) densify(this, vertex)
			}

			let rest: unknown[] | null = null

			for (let index = 0; index < dependencies.length; index++) {
				const dependency = dependencies[index]

				if (joinSparse(this, dependency, endId, wholes, RangeVertexClass)) {
					rest ??= dependencies.slice(0, index)

					continue
				}

				rest?.push(dependency)
			}

			if (rest === null) process.call(this, dependencies, endVertex)
			else if (rest.length > 0) process.call(this, rest, endVertex)
		}

		const correct = graphPrototype.correctInfiniteRangesDependency

		graphPrototype.correctInfiniteRangesDependency = function (address) {
			correct.call(this, address)

			let cell: { vertex: Node; id?: number } | null = null

			eachBlock(this, address.sheet, vertex => {
				if (!vertex.range.addressInRange(address)) return

				cell ??= this.fetchCellOrCreateEmpty(address)
				this.graph.addEdge(cell.id ?? cell.vertex, vertex)
			})
		}

		// A cell of a block cleared: the engine's empty cell there was exchanged for a new one and marked, its block
		// with it, whether the address held anything or not.
		const setEmpty = graphPrototype.setCellEmpty

		graphPrototype.setCellEmpty = function (address) {
			const changes = setEmpty.call(this, address)

			eachBlock(this, address.sheet, vertex => {
				if (vertex.range.addressInRange(address)) this.graph.markNodeAsDirty(vertex)
			})

			return changes
		}

		// A placeholder sheet (one formulas name that the workbook lacked) merged into a sheet renamed to its name: the
		// engine reroutes the placeholder's ranges and cells to the vertices at their addresses on the sheet, and moves
		// whole ranges over. The blocks either side that it touches are joined in full first.
		const merge = graphPrototype.mergeSheets

		graphPrototype.mergeSheets = function (keep, placeholder) {
			for (const vertex of blocks(this, placeholder)) densify(this, vertex)

			const kept = blocks(this, keep)

			if (kept.length > 0) {
				const touched = new Set<RangeVertex>()

				for (const { range } of this.rangeMapping.rangesInSheet(placeholder)) {
					for (const vertex of kept) {
						const { start, end } = vertex.range

						if (
							range.start.row <= end.row &&
							start.row <= range.end.row &&
							range.start.col <= end.col &&
							start.col <= range.end.col
						)
							touched.add(vertex)
					}
				}

				for (const [address] of this.addressMapping.sheetEntries(placeholder)) {
					for (const vertex of kept) if (vertex.range.addressInRange({ ...address, sheet: keep })) touched.add(vertex)
				}

				for (const vertex of touched) densify(this, vertex)
			}

			merge.call(this, keep, placeholder)
		}

		// An array formula spilling into a block: the engine joins it there through the empty cells it takes over.
		const exchange = graphPrototype.exchangeOrAddFormulaVertex

		graphPrototype.exchangeOrAddFormulaVertex = function (vertex) {
			exchange.call(this, vertex)

			if (!(vertex instanceof ArrayVertexClass)) return

			const live = blocks(this)

			if (live.length === 0) return

			const range = vertex.getRangeOrUndef()

			if (range === undefined || !this.isThereSpaceForArray(vertex)) return

			for (const block of live) if (block.range.intersectionWith(range) !== undefined) this.graph.addEdge(vertex, block)
		}

		// The cells of a block under an array cut to its corner: the engine walks the block's every address for them.
		const underArray = graphPrototype.rangeDirectDependenciesToArray

		graphPrototype.rangeDirectDependenciesToArray = function* (vertex, array) {
			if (!tracked(this, vertex)) {
				yield* underArray.call(this, vertex, array)

				return
			}

			const part = this.rangeMapping.findSmallerRange(vertex.range).restRange.intersectionWith(array.getRange())

			if (part === undefined) return

			for (const address of part.addresses(this)) yield [address, this.fetchCellOrCreateEmpty(address).vertex]
		}

		const addRows = graphPrototype.fixRangesWhenAddingRows

		graphPrototype.fixRangesWhenAddingRows = function (sheet, row, count) {
			const live = blocks(this, sheet)

			if (live.length === 0) {
				addRows.call(this, sheet, row, count)

				return
			}

			withoutBlocks(this.rangeMapping, new Set(live), () => addRows.call(this, sheet, row, count))

			for (const vertex of live) {
				if (!vertex.range.includesRow(row + count)) continue

				joinStored(this, vertex, vertex.range.rangeWithSameWidth(row, count))
				this.graph.markNodeAsDirty(vertex)
			}
		}

		const addColumns = graphPrototype.fixRangesWhenAddingColumns

		graphPrototype.fixRangesWhenAddingColumns = function (sheet, col, count) {
			const live = blocks(this, sheet)

			if (live.length === 0) {
				addColumns.call(this, sheet, col, count)

				return
			}

			withoutBlocks(this.rangeMapping, new Set(live), () => addColumns.call(this, sheet, col, count))

			for (const vertex of live) {
				if (!vertex.range.includesColumn(col + count)) continue

				joinStored(this, vertex, vertex.range.rangeWithSameHeight(col, count))
				this.graph.markNodeAsDirty(vertex)
			}
		}

		// Rows or columns removed from a block, and a sheet cleared (removed): the engine's empty cells there would mark
		// the block for recalculation as they go.
		const removeRows = graphPrototype.removeRows

		graphPrototype.removeRows = function (span) {
			for (const vertex of blocks(this, span.sheet)) {
				if (vertex.range.start.row <= span.rowEnd && vertex.range.end.row >= span.rowStart) this.graph.markNodeAsDirty(vertex)
			}

			const removed = removeRows.call(this, span)

			for (const vertex of blocks(this, span.sheet)) joinCorner(this, vertex)

			return removed
		}

		const removeColumns = graphPrototype.removeColumns

		graphPrototype.removeColumns = function (span) {
			for (const vertex of blocks(this, span.sheet)) {
				if (vertex.range.start.col <= span.columnEnd && vertex.range.end.col >= span.columnStart) this.graph.markNodeAsDirty(vertex)
			}

			const removed = removeColumns.call(this, span)

			for (const vertex of blocks(this, span.sheet)) joinCorner(this, vertex)

			return removed
		}

		const clearSheet = graphPrototype.clearSheet

		graphPrototype.clearSheet = function (sheet) {
			for (const vertex of blocks(this, sheet)) this.graph.markNodeAsDirty(vertex)

			clearSheet.call(this, sheet)
		}

		// What reads a cell of a block: the block, as the engine's empty cell there was joined to it (no whole column or
		// row covers a block joined sparsely).
		const engine = HyperFormula.prototype as unknown as {
			getCellDependents(this: { readonly dependencyGraph: unknown }, address: unknown): unknown[]
		}
		const dependents = engine.getCellDependents
		const rangeKey = (start: Address, end: Address): string =>
			`${String(start.sheet)},${String(start.row)},${String(start.col)}:${String(end.row)},${String(end.col)}`

		engine.getCellDependents = function (address) {
			const found = dependents.call(this, address)
			const graph = this.dependencyGraph as DependencyGraph
			const cell = address as Partial<Address>

			if (cell.sheet === undefined || cell.row === undefined || cell.col === undefined) return found

			const at = cell as Address
			const reading = blocks(graph, at.sheet).filter(vertex => vertex.range.addressInRange(at))

			if (reading.length === 0) return found

			const known = new Set(
				found.flatMap(entry => {
					const range = entry as Partial<{ start: Address; end: Address }>

					return range.start === undefined || range.end === undefined ? [] : [rangeKey(range.start, range.end)]
				})
			)
			const added = reading
				.filter(vertex => !known.has(rangeKey(vertex.range.start, vertex.range.end)))
				.map(vertex => ({ start: vertex.range.start, end: vertex.range.end }))

			return added.length === 0 ? found : [...found, ...added]
		}

		const plugin = HyperFormula.getFunctionPlugin("SUMSQ") as { prototype: object } | undefined
		let owner: object | null = plugin?.prototype ?? null

		while (owner !== null && !Object.hasOwn(owner, "getRangeValues")) owner = Object.getPrototypeOf(owner) as object | null

		if (owner === null) throw new Error("spreadsheet: the engine's aggregation read was not found")

		installAggregation(owner as AggregationPrototype, ArrayVertexClass)

		const changes = Object.getPrototypeOf(probe.dependencyGraph.getAndClearContentChanges()) as ChangesPrototype
		const exporter = Object.getPrototypeOf(Reflect.get(probe, "_exporter")) as ExporterPrototype

		installNameChanges(changes, exporter)
	} finally {
		probe.destroy()
	}
}

// How many blocks an engine's graph holds joined to their stored cells alone (tests).
export function sparseBlockCount(dependencyGraph: object): number {
	return blocks(dependencyGraph as DependencyGraph).length
}
