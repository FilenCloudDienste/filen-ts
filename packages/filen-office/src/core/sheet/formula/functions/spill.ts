import {
	CellError,
	EmptyValue,
	ErrorType,
	FunctionArgumentType,
	SimpleRangeValue,
	type ImplementedFunctions,
	type SimpleCellAddress
} from "hyperformula"
import { ANCHOR_FUNCTION, SPILL_FUNCTION } from "../../functions/engineNames"
import { MAX_COLUMNS, MAX_ROWS } from "../../model/model"
import { MAX_ARRAY_CELLS } from "../../refs/formulaRefs"
import { cellRange, recordRead } from "./indirect"
import { refError, SheetFunctionPlugin, type PluginAst, type PluginCall, type PluginScalar, type PluginState } from "./plugin"

// Dynamic arrays (support.microsoft.com "Dynamic array formulas and spilled array behavior"). A dynamic-array formula
// reaches the engine as FILEN.SPILL(formula): evaluated as an array, its values are kept for the cells beside and below
// it (SpillHost.spilled), which the engine running it then writes as values (formulaEngine.ts), and the formula's own
// cell takes the first. A cell in the way that is not one of its values makes it #SPILL!. A spill range reference (A1#,
// stored as _xlfn.ANCHORARRAY(A1)) reaches it as FILEN.ANCHOR(A1): the cells the formula at A1 spills over now.

// The cells a dynamic-array formula spills over, from its own cell: rows and columns.
export interface SpillSize {
	readonly rows: number
	readonly cols: number
}

export interface SpillHost {
	// What the formula at `anchor` spills over now (the file's ref, or what it last spilled), and the values it last
	// spilled there (undefined before it first calculated here: whatever the cells hold then is its).
	owned(
		anchor: SimpleCellAddress
	): { readonly size: SpillSize; readonly values: readonly (readonly PluginScalar[])[] | undefined } | undefined
	// The formula at `anchor` calculated: its values, row by row, or (blocked) the size it wanted and #SPILL!.
	spilled(anchor: SimpleCellAddress, values: readonly (readonly PluginScalar[])[], blocked: boolean): void
	// Whether the block from `anchor` holds what no dynamic array spills over: a merged cell, or a table
	// (support.microsoft.com "How to correct a #SPILL! error").
	blocks(anchor: SimpleCellAddress, rows: number, cols: number): boolean
}

let host: SpillHost | null = null

export function withSpill<T>(next: SpillHost | null, work: () => T): T {
	const previous = host

	host = next

	try {
		return work()
	} finally {
		host = previous
	}
}

export function spillError(): CellError {
	return new CellError(ErrorType.SPILL)
}

export class SpillFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		[SPILL_FUNCTION]: {
			method: "spill",
			parameters: [{ argumentType: FunctionArgumentType.ANY }],
			enableArrayArithmeticForArguments: true,
			vectorizationForbidden: true,
			isDependentOnSheetStructureChange: true
		},
		[ANCHOR_FUNCTION]: {
			method: "anchor",
			parameters: [{ argumentType: FunctionArgumentType.ANY }],
			vectorizationForbidden: true,
			isDependentOnSheetStructureChange: true
		}
	}

	spill(ast: PluginCall, state: PluginState): unknown {
		const [arg] = ast.args
		const spilling = host

		if (arg === undefined || ast.args.length !== 1 || spilling === null) return refError()

		const anchor = state.formulaAddress
		const value = this.evaluateAst(arg, state)
		const rows: PluginScalar[][] =
			value instanceof SimpleRangeValue
				? value.data.map(row => row.map(cell => (cell === EmptyValue ? 0 : cell)))
				: [[value === EmptyValue ? 0 : value]]
		const height = rows.length
		const width = rows[0]?.length ?? 0

		if (height === 0 || width === 0) return refError()

		const owned = spilling.owned(anchor)
		const size = owned?.size ?? { rows: 1, cols: 1 }
		// What it reads besides its formula: the cells it would spill over and those it spilled over, so a value
		// written there, or cleared, calculates it again.
		const reach = {
			sheet: anchor.sheet,
			startRow: anchor.row,
			startCol: anchor.col,
			endRow: Math.min(MAX_ROWS - 1, anchor.row + Math.max(height, size.rows) - 1),
			endCol: Math.min(MAX_COLUMNS - 1, anchor.col + Math.max(width, size.cols) - 1)
		}

		recordRead(anchor, reach)

		const blocked =
			height * width > MAX_ARRAY_CELLS ||
			anchor.row + height > MAX_ROWS ||
			anchor.col + width > MAX_COLUMNS ||
			(height * width > 1 && spilling.blocks(anchor, height, width)) ||
			this.inTheWay(anchor, height, width, size, owned?.values)

		spilling.spilled(anchor, rows, blocked)

		return blocked ? spillError() : (rows[0]?.[0] ?? 0)
	}

	// Whether a cell of the block the formula at `anchor` would spill over holds something of its own: a formula, or a
	// value other than what the formula last spilled there (the cells it spills over now hold its values).
	private inTheWay(
		anchor: SimpleCellAddress,
		height: number,
		width: number,
		owned: SpillSize,
		values: readonly (readonly PluginScalar[])[] | undefined
	): boolean {
		const graph = this.dependencyGraph

		for (let row = 0; row < height; row++) {
			for (let col = 0; col < width; col++) {
				if (row === 0 && col === 0) continue

				const address = { sheet: anchor.sheet, row: anchor.row + row, col: anchor.col + col }
				const vertex = graph.addressMapping.getCell(address)

				if (vertex === undefined) continue
				if (typeof (vertex as { getFormula?: unknown }).getFormula === "function") return true

				const held = graph.getScalarValue(address)

				if (held === EmptyValue) continue

				const ours = row < owned.rows && col < owned.cols

				if (!ours) return true
				if (values === undefined) continue

				const last = values[row]?.[col]

				if (last === undefined || !sameValue(last, held)) return true
			}
		}

		return false
	}

	// FILEN.ANCHOR(cell): the cells the dynamic-array formula at the cell spills over now; #REF! when none is there.
	anchor(ast: PluginCall, state: PluginState): unknown {
		const [arg] = ast.args
		const spilling = host

		if (arg === undefined || ast.args.length !== 1 || spilling === null) return refError()

		const node = arg as PluginAst & { reference?: { toSimpleCellAddress(base: SimpleCellAddress): SimpleCellAddress } }

		if (node.type !== ("CELL_REFERENCE" as PluginAst["type"]) || node.reference === undefined) return refError()

		const anchor = node.reference.toSimpleCellAddress(state.formulaAddress)
		const owned = spilling.owned(anchor)

		if (owned === undefined) return refError()

		const value = this.dependencyGraph.getScalarValue(anchor)

		if (value instanceof CellError) return value

		const read = {
			sheet: anchor.sheet,
			startRow: anchor.row,
			startCol: anchor.col,
			endRow: anchor.row + owned.size.rows - 1,
			endCol: anchor.col + owned.size.cols - 1
		}

		recordRead(state.formulaAddress, read)

		const range = cellRange(read)

		return range === null ? refError() : SimpleRangeValue.onlyRange(range, this.dependencyGraph)
	}
}

// Whether a value the cell holds is the one spilled there (a number as the engine rounds it may differ in its last
// bits from the array's).
function sameValue(spilled: PluginScalar, held: PluginScalar): boolean {
	if (spilled === held) return true

	const a = typeof spilled === "object" && spilled !== null && "val" in spilled ? spilled.val : spilled
	const b = typeof held === "object" && held !== null && "val" in held ? held.val : held

	if (typeof a === "number" && typeof b === "number") return a === b || Math.abs(a - b) <= Math.abs(a) * 1e-14
	if (a instanceof CellError && b instanceof CellError) return a.type === b.type

	return a === b
}
