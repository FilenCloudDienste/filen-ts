import { CellError, ErrorType, HyperFormula, type SimpleCellAddress } from "hyperformula"

// Circles in the engine's dependency graph as Excel calculates them, in place of the engine's #CYCLE!. Iterating
// (calcPr iterate, ECMA-376 Part 1 §18.2.2), a circle's formulas are calculated again and again, each from the
// others' latest values, until none changes by iterateDelta or more, or iterateCount times ("Change formula
// recalculation, iteration, or precision in Excel"). Not iterating, a circle's formulas show 0 and what reads them
// calculates from that ("Remove or allow a circular reference"). Only a run that meets a circle does any of it: the
// engine's own walk (Tarjan's) finds them, and every other vertex is calculated as it was.

export interface Iteration {
	// Iterations at most per recalculation (iterateCount, default 100).
	readonly count: number
	// The change below which every value of a circle counts as settled (iterateDelta, default 0.001).
	readonly delta: number
}

// A vertex of the engine's dependency graph, as this module sees it.
type Vertex = object

export interface CircleHost {
	// Null: not iterating.
	readonly iteration: Iteration | null
	// While the engine is first built: the value a circle's formula starts from (the result the file stored), or
	// undefined where it has none. Null otherwise: a formula starts from its current value (0 where it has none).
	readonly seed: ((address: SimpleCellAddress) => unknown) | null
	// Building, a circle whose every formula had a stored result keeps those results (Excel does not recalculate on
	// open) unless this is set (calcPr fullCalcOnLoad).
	readonly recalculateSeeded: boolean
	// The formula vertices on circles at the last run that met them: those calculated outside any circle since are
	// taken out here.
	readonly cycled: Set<Vertex>
	// The formula vertices of the circles a run met, in the order calculated.
	found(vertices: readonly Vertex[]): void
	// A vertex in `cycled` was calculated outside any circle.
	left(): void
}

// Evaluations of a circle's cells at most per recalculation, past which it stops short of iterateCount: a circle
// through thousands of cells would otherwise hold the engine for minutes.
const MAX_EVALUATIONS = 4_000_000

interface FormulaVertex {
	getFormula(service: unknown): unknown
	getAddress(service: unknown): SimpleCellAddress
	setCellValue(value: unknown): unknown
	valueOrUndef(): unknown
}

interface RangeVertex {
	clearCache(): void
}

interface ContentChanges {
	addChange(value: unknown, address: SimpleCellAddress): void
}

interface ColumnSearch {
	add(value: unknown, address: SimpleCellAddress): void
	change(previous: unknown, next: unknown, address: SimpleCellAddress): void
}

interface Evaluator {
	readonly lazilyTransformingAstService: unknown
	readonly columnSearch: ColumnSearch
	readonly dependencyGraph: {
		readonly graph: {
			getNodes(): Vertex[]
			getTopSortedWithSccSubgraphFrom(
				nodes: readonly Vertex[],
				operate: (vertex: Vertex) => boolean,
				onCycle: (vertex: Vertex) => void
			): unknown
		}
	}
	recomputeFormulaVertexValue(vertex: FormulaVertex): unknown
	recomputeVertex(vertex: Vertex, changes: ContentChanges): boolean
	processVertexOnCycle(vertex: Vertex, changes: ContentChanges): void
	recomputeFormulas(cycled: readonly Vertex[], sorted: readonly Vertex[]): void
	partialRun(vertices: readonly Vertex[]): ContentChanges
}

let host: CircleHost | null = null

// The circle vertices a run met and has not calculated yet (one circle, or circles one after another in the walk):
// calculated together before the next vertex outside them, or at the run's end.
const queued: Vertex[] = []
let queuedBy: Evaluator | null = null
let queuedChanges: ContentChanges | null = null

function isFormula(vertex: Vertex): vertex is FormulaVertex {
	return typeof (vertex as Partial<FormulaVertex>).getFormula === "function"
}

function isRange(vertex: Vertex): vertex is RangeVertex {
	return typeof (vertex as Partial<RangeVertex>).clearCache === "function"
}

// A value as the engine's lookups index it (its rich numbers as plain ones).
function raw(value: unknown): unknown {
	return typeof value === "object" && value !== null && "val" in value ? (value as { val: unknown }).val : value
}

// Whether a circle's formula settled: a number changed by less than delta (or not at all), anything else unchanged.
function settled(previous: unknown, next: unknown, delta: number): boolean {
	const a = raw(previous)
	const b = raw(next)

	if (typeof a === "number" && typeof b === "number") return a === b || Math.abs(b - a) < delta
	if (a instanceof CellError && b instanceof CellError) return a.type === b.type && a.message === b.message

	return a === b
}

// What a formula starts an iteration from: its current value, or 0 for one not calculated yet or the engine's own
// #CYCLE!, as Excel starts a new formula.
function start(value: unknown): unknown {
	return value === undefined || (value instanceof CellError && value.type === ErrorType.CYCLE) ? 0 : value
}

function queue(evaluator: Evaluator, vertex: Vertex, changes: ContentChanges | null): void {
	if (isRange(vertex)) vertex.clearCache()

	queuedBy = evaluator
	queuedChanges = changes
	queued.push(vertex)
}

// Calculates the queued circles: their formulas set to 0 (not iterating) or iterated, then reported changed.
function flush(): void {
	const evaluator = queuedBy
	const changes = queuedChanges
	const circle = host
	const vertices = queued.splice(0)

	queuedBy = null
	queuedChanges = null

	if (evaluator === null || circle === null) return

	const service = evaluator.lazilyTransformingAstService
	const formulas: FormulaVertex[] = []
	const ranges: RangeVertex[] = []

	for (const vertex of vertices) {
		if (isFormula(vertex)) formulas.push(vertex)
		else if (isRange(vertex)) ranges.push(vertex)
	}

	const before = formulas.map(vertex => vertex.valueOrUndef())
	const iteration = circle.iteration
	let seededAll = circle.seed !== null

	for (let i = 0; i < formulas.length; i++) {
		const vertex = formulas[i] as FormulaVertex
		let value: unknown = 0

		if (iteration !== null) {
			const seed = circle.seed === null ? undefined : circle.seed(vertex.getAddress(service))

			if (seed === undefined) seededAll = false

			value = seed ?? start(before[i])
		}

		vertex.setCellValue(value)
	}

	if (iteration !== null && (!seededAll || circle.recalculateSeeded)) {
		const rounds = Math.min(iteration.count, Math.floor(MAX_EVALUATIONS / Math.max(1, formulas.length)))

		for (let round = 0; round < rounds; round++) {
			let still = true

			for (const range of ranges) range.clearCache()

			for (const vertex of formulas) {
				const previous = vertex.valueOrUndef()
				const next = evaluator.recomputeFormulaVertexValue(vertex)

				if (still && !settled(previous, next, iteration.delta)) still = false
			}

			if (still) break
		}
	}

	// What reads the circle reads its last values.
	for (const range of ranges) range.clearCache()

	for (let i = 0; i < formulas.length; i++) {
		const vertex = formulas[i] as FormulaVertex
		const value = vertex.valueOrUndef()
		const address = vertex.getAddress(service)

		if (changes !== null) changes.addChange(value, address)
		if (before[i] === undefined) evaluator.columnSearch.add(raw(value), address)
		else evaluator.columnSearch.change(raw(before[i]), raw(value), address)
	}

	circle.found(formulas)
}

// A vertex calculated outside any circle: the circles before it are calculated first, and it is no longer on one.
function outside(vertex: Vertex): void {
	if (queued.length > 0) flush()

	const circle = host

	if (circle !== null && circle.cycled.size > 0 && circle.cycled.delete(vertex)) circle.left()
}

// Runs engine work with circles calculated for `circle` (the engine's own #CYCLE! outside it).
export function withCircles<T>(circle: CircleHost, work: () => T): T {
	const previous = host

	host = circle

	try {
		return work()
	} finally {
		host = previous
	}
}

let installed = false

// Puts the circle calculation in the engine's evaluator. Once, before the first engine is built.
export function installCircles(licenseKey: string): void {
	if (installed) return

	installed = true

	const probe = HyperFormula.buildEmpty({ licenseKey })

	try {
		const prototype = Object.getPrototypeOf(probe.evaluator) as Evaluator
		const { recomputeVertex, processVertexOnCycle, recomputeFormulas, partialRun } = prototype

		if (
			typeof recomputeVertex !== "function" ||
			typeof processVertexOnCycle !== "function" ||
			typeof recomputeFormulas !== "function" ||
			typeof partialRun !== "function"
		)
			throw new Error("spreadsheet: no engine evaluator")

		prototype.recomputeVertex = function (vertex, changes) {
			if (host !== null) outside(vertex)

			return recomputeVertex.call(this, vertex, changes)
		}

		prototype.processVertexOnCycle = function (vertex, changes) {
			if (host === null) {
				processVertexOnCycle.call(this, vertex, changes)

				return
			}

			queue(this, vertex, changes)
		}

		prototype.partialRun = function (vertices) {
			if (host === null) return partialRun.call(this, vertices)

			try {
				const changes = partialRun.call(this, vertices)

				if (queued.length > 0) flush()

				return changes
			} finally {
				queued.length = 0
			}
		}

		// A whole calculation (the engine built) meeting a circle: walked again with the circles in their place among
		// the rest, which the engine's own pass (circles first, as #CYCLE!) loses.
		prototype.recomputeFormulas = function (cycled, sorted) {
			if (host === null || cycled.length === 0) {
				recomputeFormulas.call(this, cycled, sorted)

				return
			}

			const graph = this.dependencyGraph.graph
			const service = this.lazilyTransformingAstService

			try {
				graph.getTopSortedWithSccSubgraphFrom(
					graph.getNodes(),
					vertex => {
						outside(vertex)

						if (isFormula(vertex))
							this.columnSearch.add(raw(this.recomputeFormulaVertexValue(vertex)), vertex.getAddress(service))
						else if (isRange(vertex)) vertex.clearCache()

						return true
					},
					vertex => {
						queue(this, vertex, null)
					}
				)

				if (queued.length > 0) flush()
			} finally {
				queued.length = 0
			}
		}
	} finally {
		probe.destroy()
	}
}
