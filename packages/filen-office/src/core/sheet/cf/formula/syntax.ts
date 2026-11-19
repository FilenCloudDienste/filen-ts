import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../../protocol"
import { columnIndex } from "../../refs/cellRef"
import { CELL, COLUMN, ROW, isWordChar, readWord } from "../../refs/scan"
import { FormulaError, Unsupported, type Scalar } from "./values"

// A rule's formula (as the file stores it: en-US syntax, "," between arguments, no "=") read into a tree once,
// then evaluated for every cell of the rule's range. A reference keeps its relative parts as written: evaluated
// for another cell, they move by that cell's distance from the formula's anchor, wrapping round the grid as Excel's
// relative references in conditional formats do.

export interface AreaRef {
	// The sheet named before "!", null for the formula's own.
	readonly sheet: string | null
	readonly startRow: number
	readonly startCol: number
	readonly endRow: number
	readonly endCol: number
	readonly startRowAbs: boolean
	readonly startColAbs: boolean
	readonly endRowAbs: boolean
	readonly endColAbs: boolean
	// A whole-column (A:C) or whole-row (1:3) area: the other axis spans the grid.
	readonly whole: "cols" | "rows" | null
}

export type FormulaNode =
	| { readonly kind: "value"; readonly value: Scalar }
	| { readonly kind: "array"; readonly rows: number; readonly cols: number; readonly values: readonly Scalar[] }
	| { readonly kind: "area"; readonly ref: AreaRef }
	| { readonly kind: "name"; readonly sheet: string | null; readonly name: string }
	| { readonly kind: "call"; readonly name: string; readonly args: readonly FormulaNode[] }
	| { readonly kind: "unary"; readonly op: "-" | "+"; readonly operand: FormulaNode }
	| { readonly kind: "percent"; readonly operand: FormulaNode }
	| { readonly kind: "binary"; readonly op: BinaryOperator; readonly left: FormulaNode; readonly right: FormulaNode }
	// An omitted argument (IF(A1,,1)).
	| { readonly kind: "missing" }

export type BinaryOperator = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=" | ":"

export interface ParsedFormula {
	readonly root: FormulaNode
	// Whether any reference moves with the cell (its result can differ cell by cell), or the formula reads the
	// cell's position (ROW() and COLUMN() without arguments), or reads a defined name (evaluated at the cell).
	readonly relative: boolean
	// Whether it calls a function whose result changes without its inputs changing (TODAY, NOW, RAND).
	readonly volatile: boolean
}

type Token =
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "error"; readonly value: FormulaError }
	| { readonly kind: "area"; readonly ref: AreaRef }
	| { readonly kind: "word"; readonly sheet: string | null; readonly text: string }
	| { readonly kind: "function"; readonly name: string }
	| { readonly kind: "op"; readonly text: string }
	| { readonly kind: "space" }

const MAX_FORMULA = 8_192
const MAX_DEPTH = 64

const ERRORS = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#SPILL!", "#CALC!", "#GETTING_DATA"]

const VOLATILE = new Set(["TODAY", "NOW", "RAND", "RANDBETWEEN", "RANDARRAY", "OFFSET", "INDIRECT", "CELL", "INFO"])
const POSITIONAL = new Set(["ROW", "COLUMN"])

function cellPart(text: string): { row: number; col: number; rowAbs: boolean; colAbs: boolean } | null {
	const match = CELL.exec(text)

	if (match === null) return null

	const col = columnIndex((match[2] ?? "").toUpperCase())
	const row = Number(match[4]) - 1

	if (col < 0 || col >= SHEET_MAX_COLS || row < 0 || row >= SHEET_MAX_ROWS) return null

	return { row, col, rowAbs: match[3] === "$", colAbs: match[1] === "$" }
}

function columnPart(text: string): { col: number; abs: boolean } | null {
	const match = COLUMN.exec(text)

	if (match === null) return null

	const col = columnIndex((match[2] ?? "").toUpperCase())

	return col >= 0 && col < SHEET_MAX_COLS ? { col, abs: match[1] === "$" } : null
}

function rowPart(text: string): { row: number; abs: boolean } | null {
	const match = ROW.exec(text)

	if (match === null) return null

	const row = Number(match[2]) - 1

	return row >= 0 && row < SHEET_MAX_ROWS ? { row, abs: match[1] === "$" } : null
}

// "A1", "A1:B2", "A:C" or "1:3" as an area, or null.
function areaOf(text: string, sheet: string | null): AreaRef | null {
	const colon = text.indexOf(":")

	if (colon < 0) {
		const cell = cellPart(text)

		return cell === null
			? null
			: {
					sheet,
					startRow: cell.row,
					startCol: cell.col,
					endRow: cell.row,
					endCol: cell.col,
					startRowAbs: cell.rowAbs,
					startColAbs: cell.colAbs,
					endRowAbs: cell.rowAbs,
					endColAbs: cell.colAbs,
					whole: null
				}
	}

	const first = text.slice(0, colon)
	const last = text.slice(colon + 1)
	const a = cellPart(first)
	const b = cellPart(last)

	if (a !== null && b !== null) {
		return {
			sheet,
			startRow: Math.min(a.row, b.row),
			startCol: Math.min(a.col, b.col),
			endRow: Math.max(a.row, b.row),
			endCol: Math.max(a.col, b.col),
			startRowAbs: a.row <= b.row ? a.rowAbs : b.rowAbs,
			startColAbs: a.col <= b.col ? a.colAbs : b.colAbs,
			endRowAbs: a.row <= b.row ? b.rowAbs : a.rowAbs,
			endColAbs: a.col <= b.col ? b.colAbs : a.colAbs,
			whole: null
		}
	}

	const c1 = columnPart(first)
	const c2 = columnPart(last)

	if (c1 !== null && c2 !== null) {
		return {
			sheet,
			startRow: 0,
			startCol: Math.min(c1.col, c2.col),
			endRow: SHEET_MAX_ROWS - 1,
			endCol: Math.max(c1.col, c2.col),
			startRowAbs: true,
			startColAbs: c1.col <= c2.col ? c1.abs : c2.abs,
			endRowAbs: true,
			endColAbs: c1.col <= c2.col ? c2.abs : c1.abs,
			whole: "cols"
		}
	}

	const r1 = rowPart(first)
	const r2 = rowPart(last)

	if (r1 !== null && r2 !== null) {
		return {
			sheet,
			startRow: Math.min(r1.row, r2.row),
			startCol: 0,
			endRow: Math.max(r1.row, r2.row),
			endCol: SHEET_MAX_COLS - 1,
			startRowAbs: r1.row <= r2.row ? r1.abs : r2.abs,
			startColAbs: true,
			endRowAbs: r1.row <= r2.row ? r2.abs : r1.abs,
			endColAbs: true,
			whole: "rows"
		}
	}

	return null
}

class Lexer {
	private readonly text: string
	private index = 0
	readonly tokens: Token[] = []

	constructor(text: string) {
		this.text = text
	}

	run(): Token[] {
		const text = this.text

		while (this.index < text.length) {
			const code = text.charCodeAt(this.index)

			if (code === 32 || code === 10 || code === 13 || code === 9 || code === 0xa0) {
				while (this.index < text.length && /\s/u.test(text[this.index] ?? "")) this.index++
				this.tokens.push({ kind: "space" })
			} else if (code === 34) {
				this.string()
			} else if (code === 35) {
				this.error()
			} else if (code === 39) {
				this.quotedSheet()
			} else if ((code >= 48 && code <= 57) || (code === 46 && /\d/u.test(text[this.index + 1] ?? ""))) {
				this.numberOrRows()
			} else if (isWordChar(code)) {
				this.word(null)
			} else if (code === 91) {
				throw new Unsupported("an external or structured reference")
			} else {
				const two = text.slice(this.index, this.index + 2)

				if (two === "<>" || two === "<=" || two === ">=") {
					this.tokens.push({ kind: "op", text: two })
					this.index += 2
				} else if ("+-*/^&=<>%(),;:{}".includes(text[this.index] ?? "")) {
					this.tokens.push({ kind: "op", text: text[this.index] ?? "" })
					this.index++
				} else {
					throw new Unsupported(`the character ${text[this.index] ?? ""}`)
				}
			}
		}

		return this.tokens
	}

	private string(): void {
		const text = this.text
		let value = ""
		let index = this.index + 1

		for (;;) {
			if (index >= text.length) throw new Unsupported("an unclosed string")

			if (text.charCodeAt(index) === 34) {
				if (text.charCodeAt(index + 1) === 34) {
					value += '"'
					index += 2

					continue
				}

				break
			}

			value += text[index]
			index++
		}

		this.index = index + 1
		this.tokens.push({ kind: "string", value })
	}

	private error(): void {
		const rest = this.text.slice(this.index).toUpperCase()
		const name = ERRORS.find(candidate => rest.startsWith(candidate))

		if (name === undefined) throw new Unsupported("an unknown error literal")

		this.index += name.length
		this.tokens.push({ kind: "error", value: FormulaError.of(name === "#GETTING_DATA" ? "#N/A" : name) })
	}

	private quotedSheet(): void {
		const text = this.text
		let name = ""
		let index = this.index + 1

		for (;;) {
			if (index >= text.length) throw new Unsupported("an unclosed sheet name")

			if (text.charCodeAt(index) === 39) {
				if (text.charCodeAt(index + 1) === 39) {
					name += "'"
					index += 2

					continue
				}

				break
			}

			name += text[index]
			index++
		}

		if (text[index + 1] !== "!") throw new Unsupported("a quoted name without a reference")

		this.index = index + 2
		this.reference(name)
	}

	// A number, or a row range (1:3) that starts like one.
	private numberOrRows(): void {
		const text = this.text
		const rows = /^\$?\d{1,7}:\$?\d{1,7}/u.exec(text.slice(this.index))

		if (rows !== null && !/^[A-Za-z\d_.]/u.test(text.slice(this.index + rows[0].length))) {
			const area = areaOf(rows[0], null)

			if (area !== null) {
				this.index += rows[0].length
				this.tokens.push({ kind: "area", ref: area })

				return
			}
		}

		const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(text.slice(this.index))

		if (match === null) throw new Unsupported("a number")

		this.index += match[0].length
		this.tokens.push({ kind: "number", value: Number(match[0]) })
	}

	// After a sheet prefix: the area it names, or a sheet-scoped name.
	private reference(sheet: string): void {
		const start = this.index
		const text = this.text
		let end = start

		while (end < text.length && (isWordChar(text.charCodeAt(end)) || text[end] === ":")) end++

		const raw = text.slice(start, end)
		const area = areaOf(raw, sheet)

		this.index = end

		if (area !== null) {
			this.tokens.push({ kind: "area", ref: area })

			return
		}

		if (raw.includes(":") || raw === "") throw new Unsupported("a reference")

		if (text[end] === "(") throw new Unsupported("a function after a sheet name")

		this.tokens.push({ kind: "word", sheet, text: raw })
	}

	private word(sheet: string | null): void {
		const text = this.text
		const start = this.index
		const end = readWord(text, start)
		const word = text.slice(start, end)

		if (text[end] === "!") {
			this.index = end + 1
			this.reference(word)

			return
		}

		if (text[end] === "(") {
			this.index = end
			this.tokens.push({ kind: "function", name: word })

			return
		}

		if (text[end] === "[") throw new Unsupported("a structured reference")

		// A cell range "A1:B2" or a column range "A:C".
		if (text[end] === ":") {
			const next = readWord(text, end + 1)
			const area = areaOf(text.slice(start, next), sheet)

			if (area !== null) {
				this.index = next
				this.tokens.push({ kind: "area", ref: area })

				return
			}
		}

		this.index = end

		const area = areaOf(word, sheet)

		this.tokens.push(area !== null ? { kind: "area", ref: area } : { kind: "word", sheet, text: word })
	}
}

class Parser {
	private readonly tokens: Token[]
	private index = 0
	private depth = 0
	relative = false
	volatile = false

	constructor(tokens: Token[]) {
		this.tokens = tokens
	}

	private peek(): Token | undefined {
		while (this.tokens[this.index]?.kind === "space") this.index++

		return this.tokens[this.index]
	}

	private isOp(text: string): boolean {
		const token = this.peek()

		return token?.kind === "op" && token.text === text
	}

	private expect(text: string): void {
		if (!this.isOp(text)) throw new Unsupported(`"${text}" expected`)

		this.index++
	}

	parse(): FormulaNode {
		if (this.isOp("=")) this.index++

		const node = this.comparison()

		if (this.peek() !== undefined) throw new Unsupported("text after the formula")

		return node
	}

	private nested<T>(work: () => T): T {
		if (++this.depth > MAX_DEPTH) throw new Unsupported("a formula nested too deep")

		try {
			return work()
		} finally {
			this.depth--
		}
	}

	private comparison(): FormulaNode {
		let left = this.concatenation()

		for (;;) {
			const token = this.peek()

			if (token?.kind !== "op" || !["=", "<>", "<", ">", "<=", ">="].includes(token.text)) return left

			this.index++
			left = { kind: "binary", op: token.text as BinaryOperator, left, right: this.concatenation() }
		}
	}

	private concatenation(): FormulaNode {
		let left = this.additive()

		while (this.isOp("&")) {
			this.index++
			left = { kind: "binary", op: "&", left, right: this.additive() }
		}

		return left
	}

	private additive(): FormulaNode {
		let left = this.multiplicative()

		for (;;) {
			const token = this.peek()

			if (token?.kind !== "op" || (token.text !== "+" && token.text !== "-")) return left

			this.index++
			left = { kind: "binary", op: token.text, left, right: this.multiplicative() }
		}
	}

	private multiplicative(): FormulaNode {
		let left = this.power()

		for (;;) {
			const token = this.peek()

			if (token?.kind !== "op" || (token.text !== "*" && token.text !== "/")) return left

			this.index++
			left = { kind: "binary", op: token.text, left, right: this.power() }
		}
	}

	private power(): FormulaNode {
		let left = this.percent()

		while (this.isOp("^")) {
			this.index++
			left = { kind: "binary", op: "^", left, right: this.percent() }
		}

		return left
	}

	private percent(): FormulaNode {
		let operand = this.unary()

		while (this.isOp("%")) {
			this.index++
			operand = { kind: "percent", operand }
		}

		return operand
	}

	// Negation binds tighter than "^" in Excel (-2^2 is 4).
	private unary(): FormulaNode {
		const token = this.peek()

		if (token?.kind === "op" && (token.text === "-" || token.text === "+")) {
			this.index++

			return this.nested(() => ({ kind: "unary", op: token.text as "-" | "+", operand: this.unary() }))
		}

		return this.range()
	}

	// The range operator between references (A1:INDEX(A:A,5)).
	private range(): FormulaNode {
		let left = this.primary()

		while (this.isOp(":")) {
			this.index++
			left = { kind: "binary", op: ":", left, right: this.primary() }
		}

		return left
	}

	private primary(): FormulaNode {
		const token = this.peek()

		if (token === undefined) throw new Unsupported("an operand expected")

		this.index++

		switch (token.kind) {
			case "number":
				return { kind: "value", value: token.value }
			case "string":
				return { kind: "value", value: token.value }
			case "error":
				return { kind: "value", value: token.value }
			case "area":
				if (!token.ref.startRowAbs || !token.ref.startColAbs || !token.ref.endRowAbs || !token.ref.endColAbs) this.relative = true

				return { kind: "area", ref: token.ref }
			case "word": {
				const upper = token.text.toUpperCase()

				if (token.sheet === null && (upper === "TRUE" || upper === "FALSE")) return { kind: "value", value: upper === "TRUE" }

				// A name is evaluated at each cell, and its formula may read relative to it.
				this.relative = true

				return { kind: "name", sheet: token.sheet, name: token.text }
			}
			case "function":
				return this.nested(() => this.call(token.name))
			case "op":
				if (token.text === "(") {
					const inner = this.nested(() => this.comparison())

					this.expect(")")

					return inner
				}

				if (token.text === "{") return this.arrayConstant()

				throw new Unsupported(`an operator "${token.text}" where an operand belongs`)
			case "space":
				throw new Unsupported("a space")
		}
	}

	private call(raw: string): FormulaNode {
		const name = raw.toUpperCase().replace(/^_XLFN\._XLWS\.|^_XLFN\.|^_XLWS\./u, "")

		if (name.startsWith("_XLUDF.")) throw new Unsupported(`the user function ${raw}`)
		if (VOLATILE.has(name)) this.volatile = true

		this.expect("(")

		const args: FormulaNode[] = []

		if (this.isOp(")")) {
			this.index++
		} else {
			for (;;) {
				if (this.isOp(",") || this.isOp(")")) args.push({ kind: "missing" })
				else args.push(this.comparison())

				if (this.isOp(",")) {
					this.index++

					continue
				}

				this.expect(")")
				break
			}
		}

		if (POSITIONAL.has(name) && args.length === 0) this.relative = true

		return { kind: "call", name, args }
	}

	private arrayConstant(): FormulaNode {
		const rows: Scalar[][] = [[]]

		for (;;) {
			const token = this.peek()
			let sign = 1

			if (token?.kind === "op" && token.text === "-") {
				sign = -1
				this.index++
			}

			const item = this.peek()

			if (item === undefined) throw new Unsupported("an unclosed array")

			this.index++

			const row = rows[rows.length - 1] as Scalar[]

			if (item.kind === "number") row.push(sign * item.value)
			else if (sign < 0) throw new Unsupported("an array item")
			else if (item.kind === "string") row.push(item.value)
			else if (item.kind === "error") row.push(item.value)
			else if (item.kind === "word" && /^(TRUE|FALSE)$/iu.test(item.text)) row.push(item.text.toUpperCase() === "TRUE")
			else throw new Unsupported("an array item")

			if (this.isOp(",")) {
				this.index++
			} else if (this.isOp(";")) {
				this.index++
				rows.push([])
			} else {
				this.expect("}")
				break
			}
		}

		const cols = rows[0]?.length ?? 0

		if (rows.some(row => row.length !== cols)) throw new Unsupported("a ragged array")

		return { kind: "array", rows: rows.length, cols, values: rows.flat() }
	}
}

const cache = new Map<string, ParsedFormula | Unsupported>()
const MAX_CACHE = 4096

// The tree of a formula as stored (with or without "="). Throws Unsupported for what is not calculated here.
// Formulas are read once each.
export function parseFormula(text: string): ParsedFormula {
	let parsed = cache.get(text)

	if (parsed === undefined) {
		try {
			if (text.length > MAX_FORMULA) throw new Unsupported("a formula longer than Excel allows")

			const parser = new Parser(new Lexer(text).run())
			const root = parser.parse()

			parsed = { root, relative: parser.relative, volatile: parser.volatile }
		} catch (error) {
			if (!(error instanceof Unsupported)) throw error

			parsed = error
		}

		if (cache.size >= MAX_CACHE) cache.clear()

		cache.set(text, parsed)
	}

	if (parsed instanceof Unsupported) throw parsed

	return parsed
}
