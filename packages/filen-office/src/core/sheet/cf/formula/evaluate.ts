import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetId } from "../../protocol"
import { sheetFunction } from "../../functions/catalogue"
import { FUNCTIONS, refKey, type FunctionContext } from "./functions"
import { parseFormula, type AreaRef, type FormulaNode, type ParsedFormula } from "./syntax"
import {
	FormulaError,
	Unsupported,
	arrayAt,
	compareNumbers,
	compareValues,
	isArray,
	isRef,
	refCols,
	refRows,
	storedCols,
	storedRows,
	toNumber,
	toText,
	type FormulaArray,
	type FormulaRef,
	type FormulaValue,
	type Scalar
} from "./values"

// Evaluates a rule's formula for one cell: references move with the cell from the formula's anchor (the top-left
// cell of the rectangle around the rule's ranges), as Excel applies conditional formats and validations. Calculated as an array
// formula; the result is the top-left value of an array or of a reference.

export interface FormulaHost {
	value(sheet: SheetId, row: number, col: number): Scalar
	// The cells of `ref` that hold something, row by row (a whole column costs what it holds).
	forEach(ref: FormulaRef, visit: (row: number, col: number, value: Scalar) => void): void
	// Rows and columns up to the last one holding something.
	extent(sheet: SheetId): { readonly rows: number; readonly cols: number }
	sheetByName(name: string): SheetId | null
	// A defined name as written, local to `sheet` first (localSheetId), then workbook-wide; null when none.
	definedName(name: string, sheet: SheetId): string | null
	// The serial of today and of now in the workbook's date system.
	today(): number
	now(): number
	readonly date1904: boolean
}

export interface FormulaPosition {
	readonly sheet: SheetId
	// Where the formula is written as for (relative parts are read from here).
	readonly anchorRow: number
	readonly anchorCol: number
	// The cell evaluated.
	readonly row: number
	readonly col: number
}

const MAX_ARRAY_CELLS = 1_000_000
// The most cells of arrays one pass keeps (FormulaEvaluator.pass).
const MAX_KEPT_CELLS = 1_000_000
// What kept holds for a use asked for once.
const ASKED = Symbol("asked")
const MAX_NAME_DEPTH = 8

function wrap(value: number, size: number): number {
	const moved = value % size

	return moved < 0 ? moved + size : moved
}

export class FormulaEvaluator implements FunctionContext {
	readonly host: FormulaHost
	position: FormulaPosition = { sheet: 0, anchorRow: 0, anchorCol: 0, row: 0, col: 0 }
	private names = 0
	// Within a pass: what was made of each reference (refKey) and of each array, by what it was made for (kept); null
	// outside one. Arrays weakly: one read for a single cell (a relative range, one past MAX_KEPT_CELLS) is let go with
	// its cell, not held to the pass's end.
	private made: Map<string, Map<string, unknown>> | null = null
	private madeOf: WeakMap<object, Map<string, unknown>> | null = null
	// The cells of the arrays a pass keeps, bounded by MAX_KEPT_CELLS.
	private keptCells = 0

	constructor(host: FormulaHost) {
		this.host = host
	}

	// Runs `work` with what the formulas read kept for it: a range the rule reads for every cell of a tile is read once.
	// One synchronous pass over cells whose host holds still (a tile's build), so nothing kept can go stale; not for a
	// host that substitutes a cell (data validation's entry), which a kept read would not see.
	pass<T>(work: () => T): T {
		if (this.made !== null) return work()

		this.made = new Map()
		this.madeOf = new WeakMap()
		this.keptCells = 0

		try {
			return work()
		} finally {
			this.made = null
			this.madeOf = null
		}
	}

	// What `build` makes of `owner` (refKey of a reference, an array) for `use`, kept for the rest of a pass once a second
	// cell asks for it (a range only one cell reads, a relative one, is never kept); undefined until then, and outside
	// a pass.
	kept<T>(owner: object | string, use: string, build: () => T): T | undefined {
		const made = this.made
		const madeOf = this.madeOf

		if (made === null || madeOf === null) return undefined

		let uses = typeof owner === "string" ? made.get(owner) : madeOf.get(owner)

		if (uses === undefined) {
			uses = new Map()

			if (typeof owner === "string") made.set(owner, uses)
			else madeOf.set(owner, uses)
		}

		const known = uses.get(use)

		if (known === undefined) {
			uses.set(use, ASKED)

			return undefined
		}

		if (known !== ASKED) return known as T

		const value = build()

		uses.set(use, value)

		return value
	}

	// The formula's value for one cell. Throws Unsupported when it cannot be calculated here.
	evaluate(formula: ParsedFormula | string, position: FormulaPosition): FormulaValue {
		const parsed = typeof formula === "string" ? parseFormula(formula) : formula
		const previous = this.position

		this.position = position

		try {
			return this.node(parsed.root)
		} finally {
			this.position = previous
		}
	}

	// The top-left scalar of a value (a reference is read).
	scalar(value: FormulaValue): Scalar {
		if (isRef(value)) return this.host.value(value.sheet, value.startRow, value.startCol)
		if (isArray(value)) return arrayAt(value, 0, 0)

		return value
	}

	area(ref: AreaRef): FormulaRef {
		const position = this.position
		const sheet = ref.sheet === null ? position.sheet : this.host.sheetByName(ref.sheet)

		if (sheet === null) throw new Unsupported(`the sheet ${ref.sheet ?? ""}`)

		const dRow = position.row - position.anchorRow
		const dCol = position.col - position.anchorCol
		const r1 = ref.startRowAbs ? ref.startRow : wrap(ref.startRow + dRow, SHEET_MAX_ROWS)
		const r2 = ref.endRowAbs ? ref.endRow : wrap(ref.endRow + dRow, SHEET_MAX_ROWS)
		const c1 = ref.startColAbs ? ref.startCol : wrap(ref.startCol + dCol, SHEET_MAX_COLS)
		const c2 = ref.endColAbs ? ref.endCol : wrap(ref.endCol + dCol, SHEET_MAX_COLS)

		return {
			kind: "ref",
			sheet,
			startRow: Math.min(r1, r2),
			startCol: Math.min(c1, c2),
			endRow: Math.max(r1, r2),
			endCol: Math.max(c1, c2)
		}
	}

	// A reference or array as an array of the reference's shape: what lies past the sheet's used area is held as
	// its blank rest (FormulaArray.stored).
	array(value: FormulaValue): FormulaArray {
		if (isArray(value)) return value
		if (!isRef(value)) return { kind: "array", rows: 1, cols: 1, values: [value] }

		const key = refKey(value)
		// Asked for again in the pass (null): read and kept, within bounds.
		const known = this.kept<FormulaArray | null>(key, "array", () => null)

		if (known !== undefined && known !== null) return known

		const array = this.read(value)

		if (known === null && this.keptCells + array.values.length <= MAX_KEPT_CELLS) {
			this.keptCells += array.values.length
			this.made?.get(key)?.set("array", array)
		}

		return array
	}

	private read(value: FormulaRef): FormulaArray {
		const extent = this.host.extent(value.sheet)
		const fullRows = refRows(value)
		const fullCols = refCols(value)
		const rows = Math.max(0, Math.min(fullRows, extent.rows - value.startRow))
		const cols = Math.max(0, Math.min(fullCols, extent.cols - value.startCol))

		if (rows * cols > MAX_ARRAY_CELLS) throw new Unsupported("a range too large to read as an array")

		const values: Scalar[] = new Array<Scalar>(rows * cols).fill(null)

		if (rows > 0 && cols > 0)
			this.host.forEach({ ...value, endRow: value.startRow + rows - 1, endCol: value.startCol + cols - 1 }, (row, col, cell) => {
				values[(row - value.startRow) * cols + (col - value.startCol)] = cell
			})

		return rows === fullRows && cols === fullCols
			? { kind: "array", rows, cols, values }
			: { kind: "array", rows: fullRows, cols: fullCols, values, stored: { rows, cols }, fill: null }
	}

	node(node: FormulaNode): FormulaValue {
		switch (node.kind) {
			case "value":
				return node.value
			case "missing":
				return null
			case "array":
				return { kind: "array", rows: node.rows, cols: node.cols, values: node.values }
			case "area":
				return this.area(node.ref)
			case "name":
				return this.name(node.sheet, node.name)
			case "call": {
				const fn = FUNCTIONS.get(node.name)

				if (fn !== undefined) return fn(this, node.args)

				// A name that is no worksheet function is #NAME? in Excel; a real one this evaluator lacks is not guessed.
				if (sheetFunction(node.name) === undefined) return FormulaError.NAME

				throw new Unsupported(`the function ${node.name}`)
			}
			case "unary": {
				const operand = this.node(node.operand)

				return node.op === "+"
					? operand
					: this.map1(operand, value => {
							const number = toNumber(value)

							return number instanceof FormulaError ? number : -number
						})
			}
			case "percent":
				return this.map1(this.node(node.operand), value => {
					const number = toNumber(value)

					return number instanceof FormulaError ? number : number / 100
				})
			case "binary":
				return this.binary(node.op, node.left, node.right)
		}
	}

	private name(sheetName: string | null, name: string): FormulaValue {
		const sheet = sheetName === null ? this.position.sheet : this.host.sheetByName(sheetName)

		if (sheet === null) throw new Unsupported(`the sheet ${sheetName ?? ""}`)

		const formula = this.host.definedName(name, sheet)

		if (formula === null) return FormulaError.NAME
		if (this.names >= MAX_NAME_DEPTH) throw new Unsupported("names nested too deep")

		this.names++

		try {
			// A name's references are as written for the cell the formula is in, absolute in practice; relative parts
			// are read from A1 (Excel's names are defined relative to the active cell when created).
			const previous = this.position

			this.position = { sheet, anchorRow: 0, anchorCol: 0, row: previous.row, col: previous.col }

			try {
				return this.node(parseFormula(formula).root)
			} finally {
				this.position = previous
			}
		} finally {
			this.names--
		}
	}

	private binary(op: string, leftNode: FormulaNode, rightNode: FormulaNode): FormulaValue {
		if (op === ":") {
			const left = this.node(leftNode)
			const right = this.node(rightNode)

			if (!isRef(left) || !isRef(right)) return FormulaError.VALUE
			if (left.sheet !== right.sheet) return FormulaError.REF

			return {
				kind: "ref",
				sheet: left.sheet,
				startRow: Math.min(left.startRow, right.startRow),
				startCol: Math.min(left.startCol, right.startCol),
				endRow: Math.max(left.endRow, right.endRow),
				endCol: Math.max(left.endCol, right.endCol)
			}
		}

		const left = this.node(leftNode)
		const right = this.node(rightNode)

		return this.map2(left, right, (a, b) => operate(op, a, b))
	}

	map1(value: FormulaValue, apply: (value: Scalar) => Scalar): FormulaValue {
		if (!isRef(value) && !isArray(value)) return apply(value)
		if (isRef(value) && refRows(value) === 1 && refCols(value) === 1) return apply(this.scalar(value))

		const array = this.array(value)

		return array.stored === undefined
			? { kind: "array", rows: array.rows, cols: array.cols, values: array.values.map(apply) }
			: {
					kind: "array",
					rows: array.rows,
					cols: array.cols,
					values: array.values.map(apply),
					stored: array.stored,
					fill: apply(array.fill ?? null)
				}
	}

	// Two values combined cell by cell, a single row or column repeated against the other side (array formulas).
	map2(left: FormulaValue, right: FormulaValue, apply: (a: Scalar, b: Scalar) => Scalar): FormulaValue {
		const leftScalar = !isArray(left) && (!isRef(left) || (refRows(left) === 1 && refCols(left) === 1))
		const rightScalar = !isArray(right) && (!isRef(right) || (refRows(right) === 1 && refCols(right) === 1))

		if (leftScalar && rightScalar) return apply(this.scalar(left), this.scalar(right))

		const a = this.array(left)
		const b = this.array(right)
		const rows = a.rows === 1 ? b.rows : b.rows === 1 ? a.rows : Math.min(a.rows, b.rows)
		const cols = a.cols === 1 ? b.cols : b.cols === 1 ? a.cols : Math.min(a.cols, b.cols)
		// The part where either side holds something; past it both are their fills. A row or column repeated against a
		// longer side differs along it, so that side is stored whole.
		let keepRows = 0
		let keepCols = 0

		for (const side of [a, b]) {
			if (side.rows === 1 && side.cols === 1) continue

			keepRows = Math.max(keepRows, side.rows === 1 ? (side.cols > 1 ? rows : 1) : storedRows(side))
			keepCols = Math.max(keepCols, side.cols === 1 ? (side.rows > 1 ? cols : 1) : storedCols(side))
		}

		keepRows = Math.min(rows, Math.max(1, keepRows))
		keepCols = Math.min(cols, Math.max(1, keepCols))

		if (keepRows * keepCols > MAX_ARRAY_CELLS) throw new Unsupported("an array too large")

		const values: Scalar[] = []

		for (let r = 0; r < keepRows; r++)
			for (let c = 0; c < keepCols; c++)
				values.push(
					apply(arrayAt(a, a.rows === 1 ? 0 : r, a.cols === 1 ? 0 : c), arrayAt(b, b.rows === 1 ? 0 : r, b.cols === 1 ? 0 : c))
				)

		if (keepRows === rows && keepCols === cols) return { kind: "array", rows, cols, values }

		// Past the kept part, each side is its fill (or its one value).
		const fill = apply(
			arrayAt(a, a.rows === 1 ? 0 : rows - 1, a.cols === 1 ? 0 : cols - 1),
			arrayAt(b, b.rows === 1 ? 0 : rows - 1, b.cols === 1 ? 0 : cols - 1)
		)

		return { kind: "array", rows, cols, values, stored: { rows: keepRows, cols: keepCols }, fill }
	}
}

function operate(op: string, a: Scalar, b: Scalar): Scalar {
	if (a instanceof FormulaError) return a
	if (b instanceof FormulaError) return b

	switch (op) {
		case "&": {
			const x = toText(a)
			const y = toText(b)

			return x instanceof FormulaError ? x : y instanceof FormulaError ? y : x + y
		}
		case "=":
			return compareValues(a, b) === 0
		case "<>":
			return compareValues(a, b) !== 0
		case "<":
			return compareValues(a, b) < 0
		case ">":
			return compareValues(a, b) > 0
		case "<=":
			return compareValues(a, b) <= 0
		case ">=":
			return compareValues(a, b) >= 0
	}

	const x = toNumber(a)
	const y = toNumber(b)

	if (x instanceof FormulaError) return x
	if (y instanceof FormulaError) return y

	switch (op) {
		// A sum or difference zero to 15 significant digits is zero, as the session's engine has it (0.1+0.2-0.3).
		case "+":
			return compareNumbers(x, -y) === 0 ? 0 : finite(x + y)
		case "-":
			return compareNumbers(x, y) === 0 ? 0 : finite(x - y)
		case "*":
			return finite(x * y)
		case "/":
			return y === 0 ? FormulaError.DIV0 : finite(x / y)
		case "^":
			if (x === 0 && y === 0) return FormulaError.NUM
			if (x === 0 && y < 0) return FormulaError.DIV0

			return finite(x ** y)
	}

	return FormulaError.VALUE
}

export function finite(value: number): number | FormulaError {
	return Number.isFinite(value) ? value : FormulaError.NUM
}

// The value a rule takes as its result: true only for TRUE or a non-zero number (text, blank and errors are not).
export function ruleTruth(value: Scalar): boolean {
	if (typeof value === "boolean") return value
	if (typeof value === "number") return value !== 0

	return false
}

// The sheets a formula reads, names followed (a list's source named "Items" standing for Lists!$A$1:$A$9); `all` when
// it reads a sheet only known when it runs (INDIRECT, OFFSET).
export function formulaSheets(
	formula: string,
	sheet: SheetId,
	host: Pick<FormulaHost, "definedName">
): { all: boolean; names: Set<string> } {
	const names = new Set<string>()
	let all = false
	const walk = (node: FormulaNode, depth: number): void => {
		switch (node.kind) {
			case "area":
				if (node.ref.sheet !== null) names.add(node.ref.sheet)
				break
			case "name": {
				if (node.sheet !== null) names.add(node.sheet)

				const text = depth < MAX_NAME_DEPTH ? host.definedName(node.name, sheet) : null

				if (text === null) break

				try {
					walk(parseFormula(text).root, depth + 1)
				} catch (error) {
					if (!(error instanceof Unsupported)) throw error
				}
				break
			}
			case "call":
				if (node.name === "INDIRECT" || node.name === "OFFSET") all = true

				for (const arg of node.args) walk(arg, depth)
				break
			case "unary":
			case "percent":
				walk(node.operand, depth)
				break
			case "binary":
				walk(node.left, depth)
				walk(node.right, depth)
				break
			default:
				break
		}
	}

	try {
		walk(parseFormula(formula).root, 0)
	} catch (error) {
		if (!(error instanceof Unsupported)) throw error
	}

	return { all, names }
}
