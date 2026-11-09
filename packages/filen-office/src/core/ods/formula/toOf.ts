import { SHEET_MAX_FORMULA_TEXT } from "../../sheet/protocol"
import { referenceSpans, referenceText, withoutPrefix, type RefArea, type ReferenceSpan } from "../../sheet/refs/formulaRefs"
import { OPENFORMULA_NAMES } from "./functions.generated"
import { translateFormula, type Translated } from "./toXlsx"

// The store's formula grammar (SpreadsheetML file syntax without "=") as OpenFormula (ODF 1.3 Part 4), the inverse of
// toXlsx: references A1 Sheet!A1:B2 become [.A1] [$Sheet.A1:.B2], "," between arguments ";", array rows "|", Excel's
// union "," inside parentheses "~" and its intersection (a space) "!", and functions take OpenFormula's names
// (functions.generated.ts). A formula is written only when reading it back gives what it was: anything else is
// refused with a reason (structured, external and 3-D references among them, which an .ods cannot hold).

const PREFIX = /^_xlfn\.(?:_xlws\.)?/i
// The sign guard toXlsx writes for Part 4's CEILING and FLOOR (§6.17.1, §6.17.3), the mode's error guard optional.
const SIGNED = new Map([
	["_XLFN.CEILING.MATH", "CEILING"],
	["_XLFN.FLOOR.MATH", "FLOOR"]
])

function isSpace(c: string): boolean {
	return c === " " || c === "\n" || c === "\r" || c === "\t"
}

function isWord(c: string): boolean {
	const code = c.charCodeAt(0)

	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		c === "_" ||
		c === "." ||
		c === "\\" ||
		c === "?" ||
		code >= 128
	)
}

// A sheet name as OpenFormula writes it: bare when it holds letters, digits and "_" alone, else quoted.
function sheetName(name: string): string {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`
}

function column(index: number): string {
	let text = ""

	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + ((n - 1) % 26)) + text

	return text
}

// One end of an area as OpenFormula writes it after the sheet's "." (§5.8).
function end(area: RefArea, start: boolean): string {
	const row = start ? area.startRow : area.endRow
	const col = start ? area.startCol : area.endCol
	const rowAbs = start ? area.startRowAbs : area.endRowAbs
	const colAbs = start ? area.startColAbs : area.endColAbs
	const colText = `${colAbs ? "$" : ""}${column(col)}`
	const rowText = `${rowAbs ? "$" : ""}${String(row + 1)}`

	if (area.kind === "cols") return colText
	if (area.kind === "rows") return rowText

	return colText + rowText
}

export function openFormulaReference(span: { readonly sheet: string | null; readonly area: RefArea }): string {
	const sheet = span.sheet === null ? "" : `$${sheetName(span.sheet)}`
	const area = span.area
	const range = area.kind !== "cell" || area.range

	return range ? `[${sheet}.${end(area, true)}:.${end(area, false)}]` : `[${sheet}.${end(area, true)}]`
}

// The formula with every reference spelled one way (sheet names quoted only where needed, letters upper case) and
// every function name upper case: two spellings of one formula compare equal.
export function canonicalFormula(text: string): string {
	const spans = referenceSpans(text)
	let out = ""
	let at = 0
	let span = 0

	while (at < text.length) {
		const next = spans[span]

		if (next !== undefined && next.start === at) {
			out += referenceText(next.area, next.sheet)
			at = next.end
			span++

			continue
		}

		const c = text[at] ?? ""

		if (c === '"') {
			let j = at + 1

			while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1

			out += text.slice(at, j + 1)
			at = j + 1
		} else if (isWord(c) && !(at > 0 && isWord(text[at - 1] ?? ""))) {
			let j = at

			while (j < text.length && isWord(text[j] ?? "") && (next === undefined || j < next.start)) j++

			const word = text.slice(at, j)

			out += text[j] === "(" ? word.toUpperCase() : word
			at = j
		} else {
			out += c
			at++
		}
	}

	return out.trim()
}

interface Frame {
	readonly call: boolean
}

interface Options {
	// Excel's CEILING.MATH and FLOOR.MATH as Part 4's CEILING and FLOOR (else under COM.MICROSOFT).
	readonly native: boolean
}

// The text of a balanced call starting at `open` (its "("): the arguments' spans at the top level, and past its ")".
function callArguments(text: string, open: number): { args: [number, number][]; end: number } | null {
	const args: [number, number][] = []
	let depth = 0
	let start = open + 1

	for (let k = open; k < text.length; k++) {
		const c = text[k]

		if (c === '"' || c === "'") {
			let j = k + 1

			while (j < text.length && !(text[j] === c && text[j + 1] !== c)) j += text[j] === c ? 2 : 1

			k = j
		} else if (c === "(" || c === "{") {
			depth++
		} else if (c === ")" || c === "}") {
			depth--

			if (depth === 0) {
				args.push([start, k])

				return { args, end: k + 1 }
			}
		} else if (c === "," && depth === 1) {
			args.push([start, k])
			start = k + 1
		}
	}

	return null
}

// A mode the reader knows the value of (a number, a logical or nothing), for which it writes no guard term
// (toXlsx.ts signGuarded).
const KNOWN_MODE = /^\s*(?:[+-]?\s*(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|(?:TRUE|FALSE)(?:\(\s*\))?)?\s*$/i
const GUARD = /^SIGN\((.*?)\)\*SIGN\((.*?)\)(?:\*\(\((.*?)\)\*0\+1\))?<0$/s

class Writer {
	private readonly text: string
	private readonly spans: readonly ReferenceSpan[]
	private readonly options: Options

	constructor(text: string, options: Options) {
		this.text = text
		this.spans = referenceSpans(text)
		this.options = options
	}

	// The span starting at `at`, if any (spans are few and ordered).
	private spanAt(at: number): ReferenceSpan | undefined {
		for (const span of this.spans) {
			if (span.start === at) return span
			if (span.start > at) return undefined
		}

		return undefined
	}

	// Whether a reference or name starts at `at`, after white space.
	private startsOperand(at: number): boolean {
		const c = this.text[at] ?? ""

		return this.spanAt(at) !== undefined || c === "(" || c === "'" || (isWord(c) && !/[0-9.]/.test(c))
	}

	// [from, to) of the source as OpenFormula.
	write(from: number, to: number): Translated {
		const text = this.text
		const frames: Frame[] = []
		let out = ""
		let braces = 0
		// Whether what came last ends an operand an intersection may follow (a reference, a name, a ")").
		let operandEnd = false
		let at = from

		while (at < to) {
			const span = this.spanAt(at)

			if (span !== undefined) {
				if (span.end > to) return { refused: "reference" }

				out += openFormulaReference(span)
				at = span.end
				operandEnd = true

				continue
			}

			const c = text[at] ?? ""

			if (c === '"') {
				let j = at + 1

				while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1

				if (j >= to) return { refused: "unterminated string" }

				out += text.slice(at, j + 1)
				at = j + 1
				operandEnd = false
			} else if (isSpace(c)) {
				let j = at

				while (j < to && isSpace(text[j] ?? "")) j++

				const run = text.slice(at, j)

				// Between two operands, a space is Excel's intersection.
				if (operandEnd && j < to && braces === 0 && this.startsOperand(j)) {
					out += `${run.slice(1)}!`
					operandEnd = false
				} else {
					out += run
				}

				at = j
			} else if (c === "{") {
				braces++
				out += c
				at++
				operandEnd = false
			} else if (c === "}") {
				braces--
				out += c
				at++
				operandEnd = false
			} else if (c === "," || c === ";") {
				if (braces > 0) {
					out += c === "," ? ";" : "|"
				} else if (c === ";") {
					return { refused: "separator" }
				} else {
					const frame = frames[frames.length - 1]

					if (frame === undefined) return { refused: "union" }

					out += frame.call ? ";" : "~"
				}

				at++
				operandEnd = false
			} else if (c === "(") {
				frames.push({ call: false })
				out += c
				at++
				operandEnd = false
			} else if (c === ")") {
				if (frames.pop() === undefined) return { refused: "unbalanced parentheses" }

				out += c
				at++
				operandEnd = true
			} else if (c === "[" || c === "@" || c === "!" || c === "'") {
				// Structured, external, 3-D and spill references, sheet-scoped names and the implicit intersection: none
				// has an OpenFormula form an .ods reads back.
				return { refused: "reference" }
			} else if (c === "#") {
				const match = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA)/.exec(text.slice(at, to))

				if (match === null) return { refused: "reference" }

				out += match[0]
				at += match[0].length
				operandEnd = false
			} else if (isWord(c)) {
				let j = at

				while (j < to && isWord(text[j] ?? "") && this.spanAt(j) === undefined) j++

				// A LET or LAMBDA name bare, as OpenFormula holds it (_xlpm. is SpreadsheetML's file syntax).
				const word = withoutPrefix(text.slice(at, j))
				let k = j

				while (k < to && text[k] === " ") k++

				if (text[k] === "(") {
					const call = this.call(word, k, to)

					if ("refused" in call) return call

					out += call.text
					at = call.end
					operandEnd = true

					continue
				}

				const upper = word.toUpperCase()

				if (/^[0-9.]/.test(word)) {
					// A number, with its exponent's sign.
					let n = j

					if (/[eE]$/.test(word) && (text[n] === "+" || text[n] === "-")) {
						n++

						while (n < to && /[0-9]/.test(text[n] ?? "")) n++
					}

					out += text.slice(at, n)
					at = n
					operandEnd = false
				} else {
					out += upper === "TRUE" || upper === "FALSE" ? `${upper}()` : word
					at = j
					operandEnd = upper !== "TRUE" && upper !== "FALSE"
				}
			} else {
				out += c
				at++
				operandEnd = false
			}
		}

		if (frames.length !== 0 || braces !== 0) return { refused: "unbalanced parentheses" }

		return { text: out }
	}

	// A call: name and arguments, the sign guard of CEILING and FLOOR read as the call it guards.
	private call(word: string, open: number, to: number): { text: string; end: number } | { refused: string } {
		const parsed = callArguments(this.text, open)

		if (parsed === null || parsed.end > to) return { refused: "unbalanced parentheses" }

		const upper = word.toUpperCase()
		const bare = upper.replace(PREFIX, "")
		const args = parsed.args.map(([a, b]) => this.text.slice(a, b))

		if (upper === "IF" && args.length === 3) {
			const guarded = this.guard(args)

			if (guarded !== null) return { ...guarded, end: parsed.end }
		}

		let name: string

		if (this.options.native && SIGNED.has(upper)) name = SIGNED.get(upper) ?? bare
		else name = OPENFORMULA_NAMES.get(bare) ?? bare

		const written: string[] = []

		// An argument left empty stays empty.
		for (const [a, b] of parsed.args) {
			if (this.text.slice(a, b).trim() === "") {
				written.push(this.text.slice(a, b))

				continue
			}

			const argument = this.write(a, b)

			if ("refused" in argument) return argument

			written.push(argument.text)
		}

		return { text: `${name}(${written.join(";")})`, end: parsed.end }
	}

	// IF(SIGN(a)*SIGN(b)[*((m)*0+1)]<0,#VALUE!,NAME(a,b[,m])) as Part 4's CEILING(a;b[;m]) or FLOOR.
	private guard(args: readonly string[]): { text: string } | { refused: string } | null {
		const condition = GUARD.exec(args[0] ?? "")

		if (condition === null || (args[1] ?? "").trim() !== "#VALUE!") return null

		const inner = (args[2] ?? "").trim()
		const open = inner.indexOf("(")
		const name = open < 0 ? "" : inner.slice(0, open).toUpperCase()
		const native = SIGNED.get(name)

		if (native === undefined) return null

		const writer = new Writer(inner, this.options)
		const parsed = callArguments(inner, open)

		if (parsed === null || parsed.end !== inner.length) return null

		const callArgs = parsed.args.map(([a, b]) => inner.slice(a, b))
		const mode = condition[3]

		if (
			callArgs[0] !== condition[1] ||
			callArgs[1] !== condition[2] ||
			(mode === undefined
				? callArgs.length !== 2 && !(callArgs.length === 3 && KNOWN_MODE.test(callArgs[2] ?? ""))
				: callArgs[2] !== mode)
		)
			return null

		const written: string[] = []

		for (const [a, b] of parsed.args) {
			const argument = writer.write(a, b)

			if ("refused" in argument) return argument

			written.push(argument.text)
		}

		return { text: `${native}(${written.join(";")})` }
	}
}

// The OpenFormula of a stored formula, as table:formula holds it ("of:=SUM([.A1:.A3])"): written only when the
// reader takes it back to the same formula (canonicalFormula).
export function openFormula(text: string): Translated {
	const formula = text.trim()

	if (formula.length > SHEET_MAX_FORMULA_TEXT) return { refused: "formula too long" }

	const expected = canonicalFormula(formula)
	let reason = "syntax"

	for (const native of [true, false]) {
		const written = new Writer(formula, { native }).write(0, formula.length)

		if ("refused" in written) return written

		const source = `of:=${written.text}`
		const back = translateFormula(source)

		if ("text" in back && canonicalFormula(back.text) === expected) return { text: source }

		reason = "refused" in back ? back.refused : "round trip"
	}

	return { refused: reason }
}
