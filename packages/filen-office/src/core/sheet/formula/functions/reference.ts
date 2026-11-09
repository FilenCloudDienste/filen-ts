import {
	CellError,
	EmptyValue,
	FunctionArgumentType,
	SimpleRangeValue,
	type FunctionArgument,
	type FunctionMetadata,
	type ImplementedFunctions,
	type SimpleCellAddress
} from "hyperformula"
import { INDEX_REFERENCE_FUNCTION, INTERSECT_FUNCTION } from "../../functions/engineNames"
import { cellRange, recordRead, shownFormulaAt } from "./indirect"
import { MAX_COLUMNS, MAX_ROWS } from "../../model/model"
import { columnName } from "../../refs/cellRef"
import { sheetNameNeedsQuotes } from "../../refs/formulaRefs"
import {
	naError,
	refError,
	SheetFunctionPlugin,
	valueError,
	type PluginAst,
	type PluginCall,
	type PluginRange,
	type PluginScalar,
	type PluginState,
	type PluginValue
} from "./plugin"

// A reference's rows and columns as Excel counts them: a whole column has the grid's every row, wherever the engine
// ends reading it (formula/wholeRanges.ts).
function heightOf(value: SimpleRangeValue, range: PluginRange | undefined): number {
	return range !== undefined && range.end.row === Number.POSITIVE_INFINITY ? MAX_ROWS - range.start.row : value.height()
}

function widthOf(value: SimpleRangeValue, range: PluginRange | undefined): number {
	return range !== undefined && range.end.col === Number.POSITIVE_INFINITY ? MAX_COLUMNS - range.start.col : value.width()
}

// The engine's evaluation before a one-cell result is read out of its range (private to the engine).
interface RawEvaluation {
	evaluateAstWithoutPostprocessing(ast: PluginAst, state: PluginState): PluginValue
}

// INDEX's row_num, column_num and area_num, read after its array (INDEX_REFERENCE_FUNCTION reads that itself).
const INDEX_NUMBERS: FunctionArgument[] = [
	{ argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
	{ argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
	{ argumentType: FunctionArgumentType.NUMBER, optionalArg: true }
]
const INDEX_REFERENCE: FunctionMetadata = {
	method: "indexReference",
	parameters: [{ argumentType: FunctionArgumentType.ANY }, ...INDEX_NUMBERS]
}
const INDEX_REFERENCE_NUMBERS: FunctionMetadata = { method: "indexReference", parameters: INDEX_NUMBERS }

// References as Excel reads them where the engine differs.
export class ReferenceFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		[INTERSECT_FUNCTION]: { method: "intersect", parameters: [{ argumentType: FunctionArgumentType.ANY }] },
		INDEX: { method: "index", parameters: [{ argumentType: FunctionArgumentType.RANGE }, ...INDEX_NUMBERS] },
		[INDEX_REFERENCE_FUNCTION]: INDEX_REFERENCE,
		ADDRESS: {
			method: "address",
			parameters: [
				{ argumentType: FunctionArgumentType.NUMBER },
				{ argumentType: FunctionArgumentType.NUMBER },
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 1, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: true, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.STRING, optionalArg: true }
			]
		},
		HYPERLINK: {
			method: "hyperlink",
			parameters: [{ argumentType: FunctionArgumentType.STRING }, { argumentType: FunctionArgumentType.SCALAR, optionalArg: true }]
		},
		// The reference is no dependency (its own cell is no circle, as in Excel): the cell it names is a read
		// (indirect.ts), so a change there calculates it again.
		FORMULATEXT: {
			method: "formulatext",
			parameters: [{ argumentType: FunctionArgumentType.NOERROR }],
			doesNotNeedArgumentsToBeComputed: true,
			isDependentOnSheetStructureChange: true,
			vectorizationForbidden: true
		}
	}

	// FORMULATEXT(reference) (support.microsoft.com "FORMULATEXT function"): the formula of the reference's top-left
	// cell as the formula bar shows it, #N/A for a cell without one. The engine's own gave its rewritten text
	// (FILEN.* calls, INDEX wrappers, _xlpm. names). A function giving a reference (INDIRECT, OFFSET) is followed.
	formulatext(ast: PluginCall, state: PluginState): unknown {
		const at = (address: SimpleCellAddress): string | CellError => {
			recordRead(state.formulaAddress, {
				sheet: address.sheet,
				startRow: address.row,
				startCol: address.col,
				endRow: address.row,
				endCol: address.col
			})

			return shownFormulaAt(address) ?? naError()
		}

		let arg = ast.args.length === 1 ? ast.args[0] : undefined

		while (arg?.type === ("PARENTHESIS" as PluginAst["type"])) arg = (arg as PluginAst & { expression: PluginAst }).expression

		if (arg?.type === ("FUNCTION_CALL" as PluginAst["type"])) {
			// Unwrapped: evaluateAst gives a one-cell reference's value, no longer the reference.
			const value = (this.interpreter as unknown as RawEvaluation).evaluateAstWithoutPostprocessing(arg, state)

			if (value instanceof CellError) return value

			return value instanceof SimpleRangeValue && value.range !== undefined ? at(value.range.start) : naError()
		}

		return this.runFunctionWithReferenceArgument(ast.args, state, this.metadata("FORMULATEXT"), naError, at)
	}

	// A range where one value is wanted: its cell in the formula's row (a column of cells) or column (a row of cells),
	// or in both (a block); #VALUE! when the formula's row or column misses it. The engine does this only on the
	// formula's own sheet; Excel on any.
	intersect(ast: PluginCall, state: PluginState): unknown {
		const [arg] = ast.args

		if (arg === undefined) return naError()

		const value = this.evaluateAst(arg, state)

		if (!(value instanceof SimpleRangeValue)) return value

		const range = value.range

		if (range === undefined) return value.data[0]?.[0] ?? valueError()

		const { row, col } = state.formulaAddress
		const height = heightOf(value, range)
		const width = widthOf(value, range)
		const rowOffset = height === 1 ? 0 : row - range.start.row
		const colOffset = width === 1 ? 0 : col - range.start.col

		if (rowOffset < 0 || rowOffset >= height || colOffset < 0 || colOffset >= width) return valueError()

		// The one cell, read alone: the range's values are not gathered (a whole column is a million).
		const cell = this.cellOf(range, rowOffset, colOffset)

		return cell === EmptyValue ? 0 : cell
	}

	// The value of the cell `row` and `col` into a reference, which the engine has calculated by now (the formula
	// depends on its every cell).
	private cellOf(range: PluginRange, row: number, col: number): PluginScalar {
		return this.dependencyGraph.getScalarValue({ sheet: range.sheet, row: range.start.row + row, col: range.start.col + col })
	}

	// The cell `row` and `col` into a reference, as a reference.
	private cellReference(range: PluginRange, row: number, col: number): PluginValue {
		const cell = cellRange({
			sheet: range.sheet,
			startRow: range.start.row + row,
			startCol: range.start.col + col,
			endRow: range.start.row + row,
			endCol: range.start.col + col
		})

		return cell === null ? refError() : SimpleRangeValue.onlyRange(cell, this.dependencyGraph)
	}

	// INDEX(array, row_num, [column_num], [area_num]) (support.microsoft.com "INDEX function"): over one row or
	// column a single number counts along it; 0 (or nothing) for the row or column gives the whole column or row; a
	// number outside the array is #REF!. The engine knew neither the single number along a row nor 0. Only the one
	// area a reference here can have is 1.
	index(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("INDEX"), this.pick(false))
	}

	// INDEX at an end of a range (A1:INDEX(A:A,3)): the reference it gives, a single cell's too; #VALUE! for a cell of
	// an array.
	indexReference(ast: PluginCall, state: PluginState): unknown {
		const [first, ...rest] = ast.args

		if (first === undefined) return valueError()

		// The reference as it is: a one-cell one the engine would read out as its value.
		const array = this.referenceOf(first, state)

		if (!(array instanceof SimpleRangeValue)) return array

		const pick = this.pick(true)

		return this.runFunction(rest, state, INDEX_REFERENCE_NUMBERS, (row?: number, col?: number, area?: number) =>
			pick(array, row, col, area)
		)
	}

	// A reference argument as a reference, a one-cell one's too; #VALUE! for none.
	private referenceOf(ast: PluginAst, state: PluginState): SimpleRangeValue | CellError {
		const node = ast as PluginAst & { reference?: { toSimpleCellAddress(base: SimpleCellAddress): SimpleCellAddress } }

		if (node.type === ("CELL_REFERENCE" as PluginAst["type"]) && node.reference !== undefined) {
			const at = node.reference.toSimpleCellAddress(state.formulaAddress)
			const cell = cellRange({ sheet: at.sheet, startRow: at.row, startCol: at.col, endRow: at.row, endCol: at.col })

			return at.row < 0 || at.col < 0 || cell === null ? refError() : SimpleRangeValue.onlyRange(cell, this.dependencyGraph)
		}

		const value = (this.interpreter as unknown as RawEvaluation).evaluateAstWithoutPostprocessing(ast, state)

		if (value instanceof CellError) return value

		return value instanceof SimpleRangeValue && value.range !== undefined ? value : valueError()
	}

	// INDEX's choice of the array's cells, rows or columns; `reference`: a cell as a reference.
	private pick(
		reference: boolean
	): (array: SimpleRangeValue, rowArg: number | undefined, colArg: number | undefined, area: number | undefined) => PluginValue {
		return (array, rowArg, colArg, area) => {
			if (area !== undefined && Math.trunc(area) !== 1) return area < 1 ? valueError() : refError()

			const range = array.range
			const height = heightOf(array, range)
			const width = widthOf(array, range)
			// One cell of the array, a reference's read alone (or, as a reference, that cell).
			const at = (row: number, col: number): PluginValue | undefined =>
				range === undefined
					? reference
						? valueError()
						: array.data[row]?.[col]
					: reference
						? this.cellReference(range, row, col)
						: this.cellOf(range, row, col)
			let row = Math.trunc(rowArg ?? 0)
			let col = Math.trunc(colArg ?? 0)

			if (colArg === undefined && height === 1 && width > 1) {
				col = row
				row = 0
			} else if (colArg === undefined && width === 1) col = 1

			if (row < 0 || col < 0) return valueError()
			if (row > height || col > width) return refError()

			if (row > 0 && col > 0) return at(row - 1, col - 1) ?? refError()
			if (row === 0 && col === 0) return array
			if (height === 1 && row === 0 && col > 0) return at(0, col - 1) ?? refError()
			if (width === 1 && col === 0 && row > 0) return at(row - 1, 0) ?? refError()

			if (range !== undefined) {
				const part =
					row === 0
						? range.rangeWithSameHeight(range.start.col + col - 1, 1)
						: range.rangeWithSameWidth(range.start.row + row - 1, 1)

				return SimpleRangeValue.onlyRange(part, this.dependencyGraph)
			}

			const data = array.data

			return SimpleRangeValue.onlyValues(row === 0 ? data.map(line => [line[col - 1] ?? EmptyValue]) : [data[row - 1] ?? []])
		}
	}

	// ADDRESS(row_num, column_num, [abs_num], [a1], [sheet_text]) (support.microsoft.com "ADDRESS function"): abs_num 1
	// absolute (also when left empty), 2 absolute row, 3 absolute column, 4 relative; R1C1 style when a1 is FALSE (A1
	// when left empty). A sheet name that needs them is quoted ('EXCEL SHEET'!R2C3), which the engine's own did not do.
	address(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("ADDRESS"),
			(rowArg: number, colArg: number, absArg: number, a1: boolean, sheet: string | undefined) => {
				const row = Math.trunc(rowArg)
				const col = Math.trunc(colArg)
				const abs = Math.trunc(absArg)

				if (row < 1 || row > MAX_ROWS || col < 1 || col > MAX_COLUMNS || abs < 1 || abs > 4) return valueError()

				const rowAbs = abs === 1 || abs === 2
				const colAbs = abs === 1 || abs === 3
				const cell = a1
					? `${colAbs ? "$" : ""}${columnName(col - 1)}${rowAbs ? "$" : ""}${String(row)}`
					: `R${rowAbs ? String(row) : `[${String(row)}]`}C${colAbs ? String(col) : `[${String(col)}]`}`

				if (sheet === undefined) return cell

				return `${sheet !== "" && sheetNameNeedsQuotes(sheet) ? `'${sheet.replaceAll("'", "''")}'` : sheet}!${cell}`
			}
		)
	}

	// HYPERLINK(link_location, [friendly_name]): the friendly name as it is (a number stays one, an empty cell is 0),
	// else the link (support.microsoft.com "HYPERLINK function"). The engine made every result text. The link is kept
	// where the engine keeps it for the cell.
	hyperlink(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("HYPERLINK"), (url: string, label: PluginScalar | undefined) => {
			;(ast as { hyperlink?: string }).hyperlink = url

			if (label instanceof CellError) return label

			return label === undefined ? url : label === EmptyValue ? 0 : label
		})
	}
}
