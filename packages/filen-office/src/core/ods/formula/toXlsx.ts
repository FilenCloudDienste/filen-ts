import { functionPrefix } from "../../sheet/functions/catalogue"
import { SHEET_MAX_COLS, SHEET_MAX_FORMULA_TEXT, SHEET_MAX_ROWS } from "../../sheet/protocol"
import { prefixParameters, sheetNameNeedsQuotes, wellFormedFormula } from "../../sheet/refs/formulaRefs"

// OpenFormula (ODF 1.3 Part 4) as the store's formula grammar (SpreadsheetML file syntax without "="): references
// [.A1] [Sheet.A1:.B2] become A1 Sheet!A1:B2, ";" separates arguments as ",", inline arrays {1;2|3;4} become
// {1,2;3,4}, the union "~" becomes Excel's "," inside parentheses and the intersection "!" a space, and function
// names take Excel's spelling and file prefix (_xlfn.). What has no Excel equivalent is refused with a reason, never
// guessed: the cell then keeps its cached result.
export type Translated = { readonly text: string } | { readonly refused: string }

// Part 4 names Excel spells otherwise (§6 and the LEGACY.* names of §6.18); COM.MICROSOFT.* are Excel's own.
const RENAMED: ReadonlyMap<string, string> = new Map([
	["LEGACY.CHIDIST", "CHIDIST"],
	["LEGACY.CHIINV", "CHIINV"],
	["LEGACY.CHITEST", "CHITEST"],
	["LEGACY.FDIST", "FDIST"],
	["LEGACY.FINV", "FINV"],
	["LEGACY.NORMSDIST", "NORMSDIST"],
	["LEGACY.NORMSINV", "NORMSINV"],
	["LEGACY.TDIST", "TDIST"],
	["LEGACY.TINV", "TINV"],
	["CHISQINV", "CHISQ.INV"],
	["ERRORTYPE", "ERROR.TYPE"],
	// Part 4's FDIST and FINV are the left tail with a Cumulative flag (§6.18.22, §6.18.24), Excel's F.DIST and F.INV;
	// LEGACY.FDIST and LEGACY.FINV are Excel's FDIST and FINV. SKEWP is SKEW.P (§6.18.68).
	["FDIST", "F.DIST"],
	["FINV", "F.INV"],
	["SKEWP", "SKEW.P"],
	// Part 4 §6.17.1, §6.17.3: an optional significance and a Mode. LibreOffice writes them as these in SpreadsheetML
	// (Excel's own CEILING and FLOOR come as COM.MICROSOFT.CEILING and COM.MICROSOFT.FLOOR). Their arguments' signs
	// are read apart (signGuarded): Part 4's are an error where they differ, Excel's take the significance's size.
	["CEILING", "CEILING.MATH"],
	["FLOOR", "FLOOR.MATH"]
])

// Part 4 functions with no Excel counterpart of the same meaning.
const NO_EQUIVALENT: ReadonlySet<string> = new Set([
	"MULTIPLE.OPERATIONS",
	// Its text is the formula in OpenFormula's syntax; Excel's FORMULATEXT gives its own.
	"FORMULA",
	"CHISQDIST",
	"B",
	"DDE",
	"STYLE",
	"CURRENT",
	"EASTERSUNDAY",
	"DAYSINMONTH",
	"DAYSINYEAR",
	"WEEKSINYEAR",
	"WEEKS",
	"MONTHS",
	"YEARS",
	"ISLEAPYEAR",
	"ROT13",
	"ORG.OPENOFFICE.EASTERSUNDAY"
])

// Error literals both grammars share (§5.12; ECMA-376 Part 1 §18.17.2.4), matched where the scan stands.
const ERRORS = /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA)/y

// Source text past this is refused before it is read: a formula Excel's grammar could hold is never this long.
const MAX_SOURCE = 4 * SHEET_MAX_FORMULA_TEXT

// A column's letters as its index, -1 past the grid.
function columnIndex(letters: string): number {
	let index = 0

	for (let k = 0; k < letters.length; k++) index = index * 26 + (letters.charCodeAt(k) - 64)

	return index <= SHEET_MAX_COLS ? index - 1 : -1
}

// Whether an address's column and row (either may be absent) are on the grid.
function inGrid(address: Address): boolean {
	const column = address.column.replace("$", "")
	const row = address.row.replace("$", "")

	return (column === "" || columnIndex(column) >= 0) && (row === "" || Number(row) <= SHEET_MAX_ROWS)
}

function columnText(column: number): string {
	let text = ""

	for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + ((n - 1) % 26)) + text

	return text
}

export function sheetRef(name: string): string {
	return sheetNameNeedsQuotes(name) ? `'${name.replaceAll("'", "''")}'!` : `${name}!`
}

interface Address {
	readonly sheet: string | null
	readonly column: string
	readonly row: string
	readonly error: boolean
}

// One end of a reference: [$]Sheet.[$]COL[$]ROW, the sheet quoted ('a.b') or bare, either of column and row absent.
function readAddress(text: string): Address | null {
	let at = 0
	let sheet: string | null = null

	if (text[at] === "$") at++

	if (text[at] === "'") {
		let name = ""
		let k = at + 1

		for (; k < text.length; k++) {
			if (text[k] === "'") {
				if (text[k + 1] === "'") {
					name += "'"
					k++
				} else {
					break
				}
			} else {
				name += text[k]
			}
		}

		if (k >= text.length) return null

		sheet = name
		at = k + 1
	} else {
		const dot = text.lastIndexOf(".")

		if (dot < 0) return null
		if (dot > at) sheet = text.slice(at, dot)

		at = dot
	}

	if (text[at] !== ".") return null

	const rest = text.slice(at + 1)

	if (sheet === "#REF!" || rest.startsWith("#REF!")) return { sheet, column: "", row: "", error: true }

	const match = /^(\$?[A-Za-z]{1,3})?(\$?[1-9][0-9]{0,6})?$/.exec(rest)

	if (match === null || (match[1] === undefined && match[2] === undefined)) return null

	return { sheet, column: (match[1] ?? "").toUpperCase(), row: match[2] ?? "", error: false }
}

// How far an expression's relative references move: from the cell they are relative to in the source (a condition's
// base cell, ODF 1.3 Part 3 §19.584) to the one the target resolves them against (the top-left of its range).
export interface ReferenceShift {
	readonly rows: number
	readonly cols: number
}

// An address with its relative column and row moved by `shift`, null when either leaves the grid.
function shifted(address: Address, shift: ReferenceShift): Address | null {
	let column = address.column
	let row = address.row

	if (column !== "" && !column.startsWith("$")) {
		const index = columnIndex(column) + shift.cols

		if (index < 0 || index >= SHEET_MAX_COLS) return null

		column = columnText(index)
	}

	if (row !== "" && !row.startsWith("$")) {
		const index = Number(row) + shift.rows

		if (index < 1 || index > SHEET_MAX_ROWS) return null

		row = String(index)
	}

	return { sheet: address.sheet, column, row, error: false }
}

// A cell address of table:base-cell-address (§19.584) as its zero-based row and column, null when it names no cell.
export function cellAddress(address: string): { readonly row: number; readonly col: number } | null {
	const read = readAddress(address.trim())

	if (read === null || read.error || read.column === "" || read.row === "" || !inGrid(read)) return null

	return { row: Number(read.row.replace("$", "")) - 1, col: columnIndex(read.column.replace("$", "")) }
}

// The text of a reference in brackets (§5.8), without them; `shift` moves its relative parts.
function reference(body: string, shift?: ReferenceShift): Translated {
	const trimmed = body.trim()

	if (trimmed.startsWith("'") && /^'[^']*(?:''[^']*)*'#/.test(trimmed)) return { refused: "external reference" }
	if (/^\$?#REF!/.test(trimmed)) return { text: "#REF!" }

	let quoted = false
	let cut = -1

	for (let k = 0; k < trimmed.length; k++) {
		if (trimmed[k] === "'") quoted = !quoted
		else if (!quoted && trimmed[k] === ":") {
			cut = k

			break
		}
	}

	const read = readAddress(cut < 0 ? trimmed : trimmed.slice(0, cut))
	const readSecond = cut < 0 ? null : readAddress(trimmed.slice(cut + 1))

	if (read === null || (cut >= 0 && readSecond === null)) return { refused: "reference" }
	if (read.error || readSecond?.error === true) return { text: "#REF!" }
	if (!inGrid(read) || (readSecond !== null && !inGrid(readSecond))) return { refused: "reference" }
	if (readSecond !== null && readSecond.sheet !== null && readSecond.sheet !== read.sheet) return { refused: "3D reference" }

	const first = shift === undefined ? read : shifted(read, shift)
	const second = shift === undefined || readSecond === null ? readSecond : shifted(readSecond, shift)

	if (first === null || (readSecond !== null && second === null)) return { refused: "shifted reference" }

	const prefix = first.sheet === null ? "" : sheetRef(first.sheet)

	if (second === null) {
		if (first.column === "" || first.row === "") return { refused: "reference" }

		return { text: prefix + first.column + first.row }
	}

	// Whole columns and whole rows carry the same part on both ends.
	if ((first.column === "") !== (second.column === "") || (first.row === "") !== (second.row === "")) return { refused: "reference" }

	return { text: `${prefix}${first.column}${first.row}:${second.column}${second.row}` }
}

// A function's Excel name as a file stores it, null when it has none.
export function excelFunction(name: string): string | null {
	const upper = name.toUpperCase()

	if (/^(ORG\.OPENOFFICE\.|ORG\.LIBREOFFICE\.|COM\.SUN\.|ORG\.GNUMERIC\.)/.test(upper) || NO_EQUIVALENT.has(upper)) return null

	const bare = upper.startsWith("COM.MICROSOFT.") ? upper.slice("COM.MICROSOFT.".length) : (RENAMED.get(upper) ?? upper)

	return (functionPrefix(bare) ?? "") + bare
}

// A CEILING or FLOOR call under way: its Excel name, where that starts in the output, and where each argument starts
// in the output and in the source.
interface SignedCall {
	readonly name: string
	readonly at: number
	readonly outputs: number[]
	readonly sources: number[]
}

interface Frame {
	// Whether it is a function's argument list (else a group, or the formula itself).
	readonly call: boolean
	// FDIST's call: Part 4's Cumulative defaults to TRUE (§6.18.22), Excel's F.DIST has no default. Its arguments so far.
	readonly cumulative: boolean
	args: number
	readonly signed: SignedCall | null
	// Where its content starts in the output, and where the reference expression under way starts: a union's
	// operands are references, joined tighter than any other operator (Part 4 §5.5, Table 1).
	readonly start: number
	chainStart: number
	union: boolean
}

// A formula as table:formula holds it ("of:=SUM([.A1:.A3])"): the namespace prefix names the grammar (§19.642).
export function translateFormula(formula: string): Translated {
	let source = formula
	const colon = /^([A-Za-z][A-Za-z0-9.-]*):/.exec(source)

	if (colon !== null && !source.startsWith("=")) {
		const namespace = colon[1] ?? ""

		source = source.slice(colon[0].length)

		// A formula LibreOffice keeps in Excel's own grammar.
		if (namespace === "msoxl") {
			const text = source.replace(/^=/, "").trim()

			return text.length > SHEET_MAX_FORMULA_TEXT ? { refused: "formula too long" } : { text }
		}

		if (namespace !== "of" && namespace !== "oooc") return { refused: `formula grammar ${namespace}` }
	}

	if (source.startsWith("=")) source = source.slice(1)

	return translateExpression(source)
}

// Characters that end a reference expression: every operator but the reference ones (":", "!", "~").
function endsReference(c: string): boolean {
	return c === "+" || c === "-" || c === "*" || c === "/" || c === "^" || c === "&" || c === "=" || c === "<" || c === ">" || c === "%"
}

// Whether the character before "(" makes it a call: a function name's last character.
function namesFunction(c: string): boolean {
	const code = c.charCodeAt(0)

	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || c === "_" || c === "."
}

// An OpenFormula expression (no "="), translated in one pass over its text; `shift` moves its relative references.
export function translateExpression(source: string, shift?: ReferenceShift): Translated {
	if (source.length > MAX_SOURCE) return { refused: "formula too long" }

	const out: string[] = []
	let last = ""
	const push = (text: string): void => {
		if (text === "") return

		out.push(text)
		length += text.length
		last = text[text.length - 1] ?? ""
	}
	// An operand or operator pushed: `reference` when a union may join it. Spaces between them change neither.
	const operand = (text: string, reference: boolean): boolean => {
		if (unionOpen && !reference && text !== "(") return false

		unionOpen = false
		push(text)
		referenceEnd = reference

		return true
	}
	let braces = 0
	const frames: Frame[] = [{ call: false, cumulative: false, args: 1, signed: null, start: 0, chainStart: 0, union: false }]
	// The output so far, in characters: a guard repeats arguments, so its length is checked as it grows.
	let length = 0
	// Whether the output ends with what a union may join (a reference, a name, or a parenthesis closed), and whether
	// a union's "~" waits for its right operand.
	let referenceEnd = false
	let unionOpen = false
	// The CEILING or FLOOR whose "(" comes next, and whether the call whose "(" comes next is FDIST.
	let signedNext: { name: string; at: number } | null = null
	let cumulativeNext = false
	// Excel's union is "," and needs parentheses of its own around its operands, unless a group's are exactly those.
	const endChain = (frame: Frame, closing: boolean): void => {
		if (!frame.union) return

		frame.union = false

		if (closing && !frame.call && frame.chainStart === frame.start) return

		out.splice(frame.chainStart, 0, "(")
		length++
		push(")")
		referenceEnd = true
	}
	let i = 0

	while (i < source.length) {
		const c = source[i] ?? ""

		if (c === '"') {
			let j = i + 1

			for (; j < source.length; j++) {
				if (source[j] === '"') {
					if (source[j + 1] === '"') j++
					else break
				}
			}

			if (j >= source.length) return { refused: "unterminated string" }
			if (!operand(source.slice(i, j + 1), false)) return { refused: "union" }

			i = j + 1
		} else if (c === "[") {
			let j = i + 1
			let quoted = false

			for (; j < source.length; j++) {
				if (source[j] === "'") quoted = !quoted
				else if (!quoted && source[j] === "]") break
			}

			if (j >= source.length) return { refused: "unterminated reference" }

			const translated = reference(source.slice(i + 1, j), shift)

			if ("refused" in translated) return translated
			if (!operand(translated.text, true)) return { refused: "union" }

			i = j + 1
		} else if (c === "{") {
			braces++

			if (!operand(c, false)) return { refused: "union" }

			i++
		} else if (c === "}") {
			braces--
			push(c)
			i++
		} else if (c === ";") {
			const frame = frames[frames.length - 1]

			if (unionOpen) return { refused: "union" }

			if (braces === 0 && frame !== undefined) {
				endChain(frame, false)
				frame.args++
				push(",")
				frame.chainStart = out.length
				frame.signed?.outputs.push(out.length)
				frame.signed?.sources.push(i + 1)
			} else {
				push(",")
			}

			referenceEnd = false
			i++
		} else if (c === "|") {
			if (braces === 0) return { refused: "row separator outside an array" }

			push(";")
			i++
		} else if (c === "(") {
			const call = namesFunction(last)
			const signed = call && signedNext !== null ? { ...signedNext, outputs: [out.length + 1], sources: [i + 1] } : null

			const cumulative = call && cumulativeNext

			signedNext = null
			cumulativeNext = false

			if (!operand(c, false)) return { refused: "union" }

			frames.push({ call, cumulative, args: 1, signed, start: out.length, chainStart: out.length, union: false })
			i++
		} else if (c === ")") {
			const frame = frames[frames.length - 1]

			if (frame === undefined || frames.length === 1) return { refused: "unbalanced parentheses" }
			if (unionOpen) return { refused: "union" }

			endChain(frame, true)
			frames.pop()

			const signed = frame.signed === null ? null : signGuarded(frame.signed, source, i, out)

			if (signed !== null && "refused" in signed) return signed

			if (signed === null) {
				if (frame.cumulative && frame.args === 3) push(",TRUE")

				push(c)
			} else {
				for (let k = frame.signed?.at ?? out.length; k < out.length; k++) length -= out[k]?.length ?? 0

				out.length = frame.signed?.at ?? out.length
				push(signed.text)

				if (length > SHEET_MAX_FORMULA_TEXT) return { refused: "formula too long" }
			}

			referenceEnd = true
			i++
		} else if (c === "~") {
			const frame = frames[frames.length - 1]

			// Part 4 §5.5: "~" joins references, and binds tighter than every operator but ":" and "!", so its left
			// operand is the reference before it: a postfix "%" there ends a number, which no union takes.
			if (braces > 0 || !referenceEnd || unionOpen) return { refused: "union" }
			if (frame !== undefined) frame.union = true

			push(",")
			referenceEnd = false
			unionOpen = true
			i++
		} else if (c === "!") {
			if (unionOpen) return { refused: "union" }

			push(" ")
			referenceEnd = false
			i++
		} else if (c === "#") {
			ERRORS.lastIndex = i

			const match = ERRORS.exec(source)

			if (match === null) return { refused: `error literal ${source.slice(i, i + 12)}` }
			if (!operand(match[0], false)) return { refused: "union" }

			i += match[0].length
		} else if (/[A-Za-z_\\À-￿]/.test(c)) {
			let j = i

			while (j < source.length && /[A-Za-z0-9_.\\À-￿]/.test(source[j] ?? "")) j++

			const word = source.slice(i, j)
			let k = j

			while (source[k] === " ") k++

			if (source[k] === "(") {
				const upper = word.toUpperCase()

				if ((upper === "TRUE" || upper === "FALSE") && source[k + 1] === ")") {
					if (!operand(upper, false)) return { refused: "union" }

					i = k + 2

					continue
				}

				const name = excelFunction(word)

				if (name === null) return { refused: `function ${word}` }
				if (braces === 0 && (upper === "CEILING" || upper === "FLOOR")) signedNext = { name, at: out.length }

				cumulativeNext = upper === "FDIST"
				// A call may give a reference (INDEX, OFFSET): the ")" it ends with is one a union takes.
				if (!operand(name, true)) return { refused: "union" }

				i = k
			} else {
				if (!operand(word, true)) return { refused: "union" }

				i = j
			}
		} else if (c === "$" && source[i + 1] === "$") {
			return { refused: "quoted name" }
		} else {
			const frame = frames[frames.length - 1]

			if (c === " " || c === "\n" || c === "\r" || c === "\t") {
				push(c)
			} else if (braces === 0 && frame !== undefined && endsReference(c)) {
				if (unionOpen) return { refused: "union" }

				endChain(frame, false)
				push(c)
				referenceEnd = false
				frame.chainStart = out.length
			} else if (!operand(c, false)) {
				return { refused: "union" }
			}

			i++
		}
	}

	if (frames.length !== 1 || braces !== 0) return { refused: "unbalanced parentheses" }
	if (unionOpen) return { refused: "union" }

	const top = frames[0]

	if (top !== undefined) endChain(top, false)

	// OpenFormula writes LET and LAMBDA names bare; the store holds them as SpreadsheetML does (_xlpm.x).
	const text = prefixParameters(out.join("").trim())

	if (text.length > SHEET_MAX_FORMULA_TEXT) return { refused: "formula too long" }

	// What the source's grammar does not hold (an operator with no operand, say) is not written in the store's.
	return wellFormedFormula(text) ? { text } : { refused: "syntax" }
}

// A literal number, signed (§5.10).
const NUMBER = /^\s*([+-]?)\s*((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*$/

// Source text a guard may read twice: one-cell references, numbers and arithmetic, no calls (a volatile one would
// give another value) and no ranges (SIGN over one would make an array).
function repeatable(text: string): boolean {
	let k = 0

	while (k < text.length) {
		const c = text[k] ?? ""

		if (c === "[") {
			let quoted = false
			let j = k + 1

			for (; j < text.length; j++) {
				if (text[j] === "'") quoted = !quoted
				else if (!quoted && text[j] === "]") break
				else if (!quoted && text[j] === ":") return false
			}

			k = j + 1
		} else if (/[\s0-9.+\-*/^%()]/.test(c) || ((c === "e" || c === "E") && /[0-9.]/.test(text[k - 1] ?? ""))) {
			k++
		} else {
			return false
		}
	}

	return text.trim() !== ""
}

// A CEILING or FLOOR call closed at `end` in the source, as Excel's CEILING.MATH or FLOOR.MATH with Part 4's error
// where its number and significance have opposite signs (§6.17.1, §6.17.3; LibreOffice's Err:502, which it writes
// to SpreadsheetML as #VALUE!). Null when the call is written as it is: one argument, or the number or significance
// a literal 0. A literal pair is decided here; arguments a guard may read twice are guarded, in LibreOffice's order:
// the number's error, the significance's, the mode's, then the signs'. Anything else is refused: the signs cannot
// be told without calculating an argument twice.
function signGuarded(call: SignedCall, source: string, end: number, out: readonly string[]): Translated | null {
	const count = call.sources.length

	if (count === 1 || count > 3) return null

	const sources = call.sources.map((from, k) => source.slice(from, (call.sources[k + 1] ?? end + 1) - 1))
	const args = call.outputs.map((from, k) =>
		out
			.slice(from, (call.outputs[k + 1] ?? out.length + 1) - 1)
			.join("")
			.trim()
	)
	const [number, significance, mode] = sources.map(text => NUMBER.exec(text))
	const modeText = sources[2] ?? ""

	// Left out, the significance takes the number's sign (LibreOffice reads an empty one so too); the engine reads an
	// empty argument as 0, so it is written as 1, which Excel's functions take the same as -1.
	if ((sources[1] ?? "").trim() === "") return { text: `${call.name}(${[args[0] ?? "", "1", ...args.slice(2)].join(",")})` }

	const value = (match: RegExpExecArray | null | undefined): number | null =>
		match === null || match === undefined ? null : Number(`${match[1] ?? ""}${match[2] ?? ""}`)
	const n = value(number)
	const s = value(significance)

	if (n === 0 || s === 0) return null
	if (n !== null && s !== null && Math.sign(n) === Math.sign(s)) return null

	const modeKnown = count === 2 || mode !== null || /^\s*(?:(?:TRUE|FALSE)\(\s*\))?\s*$/i.test(modeText)

	if (n !== null && s !== null && modeKnown) return { text: "#VALUE!" }

	const reason = { refused: `${call.name.endsWith("CEILING.MATH") ? "CEILING" : "FLOOR"} sign` }

	if (!repeatable(sources[0] ?? "") || !repeatable(sources[1] ?? "") || !(modeKnown || repeatable(modeText))) return reason

	const modeError = modeKnown ? "" : `*((${args[2] ?? ""})*0+1)`

	return { text: `IF(SIGN(${args[0] ?? ""})*SIGN(${args[1] ?? ""})${modeError}<0,#VALUE!,${call.name}(${args.join(",")}))` }
}

// A cell range address of table:cell-range-address or table:target-range-address (§19.595, no brackets): one or
// more ranges separated by spaces, as Excel references (`absolute`: every part $-anchored as the source wrote it).
export function rangeAddress(address: string): Translated {
	const translated = rangeAddresses(address)

	return "refused" in translated ? translated : { text: translated.parts.join(",") }
}

// The same, each range on its own (a sheet name may hold the "," that joins them).
export function rangeAddresses(address: string): { readonly parts: readonly string[] } | { readonly refused: string } {
	const parts: string[] = []
	let quoted = false
	let start = 0

	for (let k = 0; k <= address.length; k++) {
		const c = address[k]

		if (c === "'") quoted = !quoted
		else if (!quoted && (c === " " || c === undefined)) {
			if (k > start) parts.push(address.slice(start, k))

			start = k + 1
		}
	}

	const out: string[] = []

	for (const part of parts) {
		const translated = reference(part)

		if ("refused" in translated) return translated

		out.push(translated.text)
	}

	return { parts: out }
}

// A reference's cells without its sheet ("'a, b'!$A$1:$B$2" as "$A$1:$B$2"): past the last "!" outside quotes.
export function withoutSheet(reference: string): string {
	let quoted = false
	let bang = -1

	for (let k = 0; k < reference.length; k++) {
		const c = reference[k]

		if (c === "'") quoted = !quoted
		else if (c === "!" && !quoted) bang = k
	}

	return reference.slice(bang + 1)
}

export { columnText }
