import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetRange } from "../../sheet/protocol"
import { FormulaTable } from "../model/formulas"
import { StoreBuilder } from "../model/store"
import { SheetStrings } from "../model/strings"
import { CellKind, FormulaFlag, FormulaKind, RowFlag } from "../model/types"
import { XlsxReadError } from "./errors"
import { MAX_SHEET_STRINGS, type XlsxReadLease } from "./limits"
import { AMP, BANG, COLON, GT, LT, QUESTION, SLASH, Scanner, bytesAre, isSpace, localIs, nameEnd, parseNumber, parseUint } from "./scan"

// The cells of <sheetData> (ECMA-376 Part 1 §18.3.1.80) read straight from the part's bytes into the columnar
// store: one pass, no node per element, each row's byte span kept for the splice writer. Values are read as the
// file writes them (§18.3.1.4 c, §18.18.11 ST_CellType); formulas as written, with their ids.

const T_NUMBER = 0
const T_SHARED = 1
const T_BOOLEAN = 2
const T_ERROR = 3
const T_STRING = 4
const T_INLINE = 5
const T_DATE = 6

export interface SheetDataContext {
	readonly part: string
	// Entries of the workbook's shared strings: an index past them reads as no value.
	readonly sharedStrings: number
	// Cells this sheet may hold.
	readonly cellBudget: number
	// The workbook's budget the cells are taken from as they are read.
	readonly lease?: XlsxReadLease
}

// Where the A1 reference [start, end) points, or false (then `refRow`/`refCol` are unset).
function readReference(bytes: Uint8Array, start: number, end: number, out: Int32Array): boolean {
	let i = start
	let col = 0

	while (i < end) {
		const b = bytes[i] ?? 0
		const upper = b & 0xdf

		if (upper < 65 || upper > 90) break

		col = col * 26 + upper - 64
		i++

		if (i - start > 3) return false
	}

	if (i === start) return false

	let row = 0
	const digits = i

	while (i < end) {
		const d = (bytes[i] ?? 0) - 48

		if (d < 0 || d > 9 || i - digits > 7) return false

		row = row * 10 + d
		i++
	}

	if (i === digits || row === 0) return false

	out[0] = row - 1
	out[1] = col - 1

	return true
}

// A range ("A1:C3", or one cell; "$" and surrounding white space allowed), or null.
export function parseRange(text: string): SheetRange | null {
	const bytes = new Uint8Array(text.length)

	for (let k = 0; k < text.length; k++) {
		const code = text.charCodeAt(k)

		bytes[k] = code > 255 ? 0 : code
	}

	const out = new Uint32Array(4)

	return rangeAt(bytes, 0, bytes.length, out)
		? { startRow: out[0] ?? 0, startCol: out[1] ?? 0, endRow: out[2] ?? 0, endCol: out[3] ?? 0 }
		: null
}

const referenceOut = new Int32Array(2)
const referenceBytes = new Uint8Array(16)

// The reference [from, to) without its "$" and spaces (a longer one is no reference).
function referenceAt(bytes: Uint8Array, from: number, to: number): boolean {
	let length = 0

	for (let k = from; k < to; k++) {
		const code = bytes[k] ?? 0

		if (code === 36 || code === 32) continue
		if (length === referenceBytes.length) return false

		referenceBytes[length++] = code
	}

	return readReference(referenceBytes, 0, length, referenceOut)
}

// parseRange over the bytes [start, end), into `out` (start row, start column, end row, end column).
export function rangeAt(bytes: Uint8Array, start: number, end: number, out: Uint32Array): boolean {
	let colon = -1

	for (let k = start; k < end; k++) {
		if (bytes[k] === COLON) {
			colon = k

			break
		}
	}

	if (!referenceAt(bytes, start, colon < 0 ? end : colon)) return false

	const startRow = referenceOut[0] ?? 0
	const startCol = referenceOut[1] ?? 0

	if (colon < 0) {
		out[0] = out[2] = startRow
		out[1] = out[3] = startCol

		return true
	}

	if (!referenceAt(bytes, colon + 1, end)) return false

	const endRow = referenceOut[0] ?? 0
	const endCol = referenceOut[1] ?? 0

	out[0] = Math.min(startRow, endRow)
	out[1] = Math.min(startCol, endCol)
	out[2] = Math.max(startRow, endRow)
	out[3] = Math.max(startCol, endCol)

	return true
}

function isTrue(bytes: Uint8Array, start: number, end: number): boolean {
	while (start < end && isSpace(bytes[start])) start++
	while (end > start && isSpace(bytes[end - 1])) end--

	return bytesAre(bytes, start, end, "1") || bytesAre(bytes, start, end, "true")
}

export class SheetDataReader {
	readonly builder = new StoreBuilder()
	readonly strings = new SheetStrings()
	readonly formulas = new FormulaTable()
	private readonly scanner: Scanner
	private readonly bytes: Uint8Array
	private readonly context: SheetDataContext
	private readonly reference = new Int32Array(2)
	// The next unread byte, and the end of sheetData once read.
	private at: number
	end = -1
	private previousRow = -1
	// Cells taken from the lease so far.
	private taken = 0

	// `start`: just after the <sheetData> start tag.
	constructor(scanner: Scanner, start: number, context: SheetDataContext) {
		this.scanner = scanner
		this.bytes = scanner.bytes
		this.at = start
		this.context = context
	}

	// Reads up to `rows` children (rows or anything else) or until `cells` cells were read; true once
	// </sheetData> was read.
	step(rows: number, cells: number): boolean {
		const done = this.read(rows, cells)
		const lease = this.context.lease

		if (lease !== undefined) {
			lease.take("cells", this.builder.totalCells - this.taken)
			this.taken = this.builder.totalCells
		}

		return done
	}

	private read(rows: number, cells: number): boolean {
		const bytes = this.bytes
		const scanner = this.scanner
		const until = this.builder.totalCells + cells

		for (let read = 0; read < rows && this.builder.totalCells < until; read++) {
			const lt = bytes.indexOf(LT, this.at)

			if (lt < 0) scanner.fail("sheetData is not closed", this.at)

			const next = bytes[lt + 1]

			if (next === SLASH) {
				const close = bytes.indexOf(GT, lt)

				if (close < 0 || !localIs(bytes, lt + 2, nameEnd(bytes, lt + 2), "sheetData")) scanner.fail("sheetData is not closed", lt)

				this.end = close + 1

				return true
			}

			if (next === BANG || next === QUESTION) {
				this.at = scanner.markupEnd(lt)

				continue
			}

			const name = nameEnd(bytes, lt + 1)

			if (localIs(bytes, lt + 1, name, "row")) {
				this.row(lt, name)
			} else {
				this.at = scanner.elementEnd(lt)
			}

			if (this.builder.totalCells > this.context.cellBudget) {
				throw new XlsxReadError("tooLarge", "The workbook holds more cells than the limit", this.context.part)
			}
		}

		return false
	}

	private row(start: number, name: number): void {
		const bytes = this.bytes
		const scanner = this.scanner
		let tagEnd = -1
		let empty = false
		let row = -1
		let flags = 0
		let height = Number.NaN
		let style = -1

		// <row r="N">, the usual spelling, without the general path (r read as parseUint reads it).
		if (bytes[name] === 32 && bytes[name + 1] === 114 && bytes[name + 2] === 61 && bytes[name + 3] === 34) {
			const digits = name + 4
			let k = digits
			let value = 0

			for (; k - digits < 15; k++) {
				const digit = (bytes[k] as number) - 48

				if (digit < 0 || digit > 9) break

				value = value * 10 + digit
			}

			if (k > digits && bytes[k] === 34 && bytes[k + 1] === GT) {
				tagEnd = k + 2

				if (value >= 1) row = value - 1
			}
		}

		if (tagEnd < 0) {
			tagEnd = scanner.tagEnd(start)
			empty = scanner.selfClosing

			scanner.attributes(start, tagEnd, (nameStart, nameStop, valueStart, valueEnd) => {
				switch (nameStop - nameStart) {
					case 1:
						if (bytes[nameStart] === 114) {
							const value = parseUint(bytes, valueStart, valueEnd)

							if (value >= 1) row = value - 1
						} else if (bytes[nameStart] === 115) {
							style = parseUint(bytes, valueStart, valueEnd)
						}

						break
					case 2:
						if (bytesAre(bytes, nameStart, nameStop, "ht")) {
							const value = parseNumber(bytes, valueStart, valueEnd)

							if (Number.isFinite(value)) height = value
						}

						break
					case 6:
						if (bytesAre(bytes, nameStart, nameStop, "hidden") && isTrue(bytes, valueStart, valueEnd)) flags |= RowFlag.HIDDEN

						break
					case 8:
						if (bytesAre(bytes, nameStart, nameStop, "thickBot") && isTrue(bytes, valueStart, valueEnd))
							flags |= RowFlag.THICK_BOTTOM
						else if (bytesAre(bytes, nameStart, nameStop, "thickTop") && isTrue(bytes, valueStart, valueEnd))
							flags |= RowFlag.THICK_TOP

						break
					case 9:
						if (bytesAre(bytes, nameStart, nameStop, "collapsed") && isTrue(bytes, valueStart, valueEnd))
							flags |= RowFlag.COLLAPSED

						break
					case 12:
						if (bytesAre(bytes, nameStart, nameStop, "customFormat") && isTrue(bytes, valueStart, valueEnd)) {
							flags |= RowFlag.CUSTOM_FORMAT
						} else if (bytesAre(bytes, nameStart, nameStop, "customHeight") && isTrue(bytes, valueStart, valueEnd)) {
							flags |= RowFlag.CUSTOM_HEIGHT
						} else if (bytesAre(bytes, nameStart, nameStop, "outlineLevel")) {
							const level = parseUint(bytes, valueStart, valueEnd)

							if (level > 0) flags |= Math.min(7, level) << RowFlag.OUTLINE_SHIFT
						}

						break
				}
			})
		}

		if (row >= SHEET_MAX_ROWS) scanner.fail("A row lies outside the grid", start)

		const builder = this.builder

		builder.beginRow()

		let at = tagEnd
		let lastCol = -1

		if (!empty) {
			for (;;) {
				const lt = bytes[at] === LT ? at : bytes.indexOf(LT, at)

				if (lt < 0) scanner.fail("A row is not closed", start)

				const next = bytes[lt + 1]

				if (next === SLASH) {
					const end = nameEnd(bytes, lt + 2)

					if (end - (lt + 2) !== name - (start + 1) || !sameName(bytes, lt + 2, start + 1, name - start - 1)) {
						scanner.fail("An end tag does not match its row", lt)
					}

					const close = bytes.indexOf(GT, end)

					if (close < 0) scanner.fail("A row is not closed", lt)

					at = close + 1

					break
				}

				if (next === BANG || next === QUESTION) {
					at = scanner.markupEnd(lt)

					continue
				}

				const after = bytes[lt + 2]
				// <c followed by white space, ">" or "/": the usual spelling, named without the general path.
				const cellName =
					next === 99 && (after === 32 || after === GT || after === SLASH || after === 9 || after === 10 || after === 13)
						? lt + 2
						: nameEnd(bytes, lt + 1)

				if ((next === 99 && cellName === lt + 2) || localIs(bytes, lt + 1, cellName, "c")) {
					at = this.cell(lt, cellName, lastCol)
					lastCol = this.lastCol

					if (row < 0 && this.cellRow >= 0) row = this.cellRow
				} else {
					at = scanner.elementEnd(lt)
				}
			}
		} else {
			at = tagEnd
		}

		if (row < 0) row = this.previousRow + 1
		if (row >= SHEET_MAX_ROWS) scanner.fail("A row lies outside the grid", start)

		// The row's shared masters placed, now its index is known: a child moves from its master's own cell.
		if (this.masterCols.length > 0) {
			for (let i = 0; i + 1 < this.masterCols.length; i += 2)
				this.formulas.placeMaster(this.masterCols[i] ?? -1, row, this.masterCols[i + 1] ?? 0)

			this.masterCols.length = 0
		}

		builder.endRow(row, start, at, flags, height, style)
		this.previousRow = row
		this.at = at
	}

	// Set by cell(): the column it read, and its reference's row (-1 for none).
	private lastCol = -1
	private cellRow = -1
	// The cell holds markup the model does not (StoreBuilder.cell's `marked`).
	private marked = false
	private valueStart = -1
	private valueEnd = -1
	private valueText: string | null = null
	private inline: string | null = null
	private formula = -1
	// The shared masters of the row being read: formula id, column pairs.
	private readonly masterCols: number[] = []

	private cell(start: number, name: number, previousCol: number): number {
		const bytes = this.bytes
		const scanner = this.scanner
		const length = bytes.length
		let col = -1
		let style = 0
		let type = T_NUMBER
		let metadata = -1
		let tagEnd = -1
		let empty = false

		this.cellRow = -1
		this.marked = false

		// The start tag, attribute by attribute up to its ">": this is the hottest loop of the reader.
		let j = name

		for (;;) {
			let b = bytes[j]

			while (b === 32 || b === 10 || b === 13 || b === 9) b = bytes[++j]

			if (b === GT) {
				tagEnd = j + 1

				break
			}

			if (b === SLASH) {
				if (bytes[j + 1] !== GT) scanner.fail("A tag is not closed", start)

				tagEnd = j + 2
				empty = true

				break
			}

			if (j >= length || b === LT) scanner.fail("A tag is not closed", start)

			const attributeStart = j
			let attributeEnd: number

			if (b !== 61 && bytes[j + 1] === 61) {
				// A one-letter name and "=", the usual spelling (r, s, t).
				attributeEnd = ++j
			} else {
				j = nameEnd(bytes, j)
				attributeEnd = j

				while (isSpace(bytes[j])) j++

				if (bytes[j] !== 61) scanner.fail("An attribute has no value", attributeStart)
			}

			j++

			while (isSpace(bytes[j])) j++

			const quote = bytes[j]

			if (quote !== 34 && quote !== 39) return scanner.fail("An attribute value is not quoted", j)

			const valueStart = j + 1
			const nameLength = attributeEnd - attributeStart
			const first = bytes[attributeStart]

			if (nameLength === 1 && first === 114) {
				// r: a plain reference (as readReference reads it) read as it is scanned.
				let k = valueStart
				let letters = 0

				for (; k - valueStart < 3; k++) {
					const upper = (bytes[k] ?? 0) & 0xdf

					if (upper < 65 || upper > 90) break

					letters = letters * 26 + upper - 64
				}

				const digits = k
				let number = 0

				for (; k - digits < 8; k++) {
					const digit = (bytes[k] ?? 0) - 48

					if (digit < 0 || digit > 9) break

					number = number * 10 + digit
				}

				if (bytes[k] === quote && k > digits && digits > valueStart && number > 0) {
					col = letters - 1
					this.cellRow = number - 1
					j = k + 1

					continue
				}
			}

			let valueEnd = valueStart

			while (valueEnd < length && bytes[valueEnd] !== quote) {
				if (bytes[valueEnd] === LT) scanner.fail("An attribute value holds <", valueEnd)

				valueEnd++
			}

			if (valueEnd >= length) scanner.fail("An attribute value is not closed", j)

			j = valueEnd + 1

			if (nameLength === 1) {
				if (first === 114) {
					if (readReference(bytes, valueStart, valueEnd, this.reference)) {
						col = this.reference[1] ?? 0
						this.cellRow = this.reference[0] ?? 0
					}
				} else if (first === 115) {
					const value = parseUint(bytes, valueStart, valueEnd)

					style = value < 0 ? 0 : value
				} else if (first === 116) {
					type = cellType(bytes, valueStart, valueEnd)
				}
			} else if (nameLength === 2 && first === 99 && bytes[attributeStart + 1] === 109) {
				metadata = parseUint(bytes, valueStart, valueEnd)
			} else {
				// vm, ph or an attribute the model does not hold.
				this.marked = true
			}
		}

		if (col < 0) col = previousCol + 1
		if (col >= SHEET_MAX_COLS) scanner.fail("A cell lies outside the grid", start)

		this.lastCol = col
		this.valueStart = -1
		this.valueEnd = -1
		this.valueText = null
		this.inline = null
		this.formula = -1

		let at = tagEnd

		if (!empty) at = this.cellContent(start, name, tagEnd, metadata)

		let kind: number = CellKind.EMPTY
		let value = 0
		const hasValue = this.valueStart >= 0
		const valueText = this.readText()

		switch (type) {
			case T_NUMBER: {
				if (hasValue) {
					value = valueText !== null ? Number(valueText) : parseNumber(bytes, this.valueStart, this.valueEnd)

					if (valueText !== null && valueText.trim() === "") value = Number.NaN
					if (!Number.isNaN(value)) kind = CellKind.NUMBER
					else value = 0
				}

				break
			}
			case T_SHARED: {
				if (hasValue) {
					const index = valueText !== null ? Number(valueText) : parseNumber(bytes, this.valueStart, this.valueEnd)

					if (Number.isInteger(index) && index >= 0 && index < this.context.sharedStrings) {
						kind = CellKind.SHARED_STRING
						value = index
					}
				}

				break
			}
			case T_BOOLEAN: {
				// "0" and "1", the usual spellings, without a string.
				if (hasValue && valueText === null && this.valueEnd - this.valueStart === 1) {
					const digit = bytes[this.valueStart]

					if (digit === 48 || digit === 49) {
						kind = CellKind.BOOLEAN
						value = digit - 48

						break
					}
				}

				const text = hasValue ? this.value() : ""

				if (text !== "") {
					const trimmed = text.trim()

					kind = CellKind.BOOLEAN
					value = trimmed === "1" || trimmed === "true" ? 1 : 0
				}

				break
			}
			case T_ERROR: {
				const text = hasValue ? this.value() : ""

				if (text !== "") {
					kind = CellKind.ERROR
					value = this.intern(text.trim())
				}

				break
			}
			case T_STRING:
				if (hasValue) {
					kind = CellKind.FORMULA_STRING
					value = this.intern(this.value())
				}

				break
			case T_INLINE:
				if (this.inline !== null) {
					kind = CellKind.INLINE_STRING
					value = this.intern(this.inline)
				}

				break
			case T_DATE: {
				const text = hasValue ? this.value() : ""

				if (text !== "") {
					kind = CellKind.DATE
					value = this.intern(text)
				}

				break
			}
		}

		this.builder.cell(col, kind, value, style, this.formula, this.marked)

		if (this.formula >= 0 && this.formulas.kind(this.formula) === FormulaKind.SHARED_MASTER) this.masterCols.push(this.formula, col)

		return at
	}

	private intern(text: string): number {
		const index = this.strings.intern(text)

		if (index >= MAX_SHEET_STRINGS)
			throw new XlsxReadError("tooLarge", "The sheet holds more distinct texts than the limit", this.context.part)

		return index
	}

	// The <v> text cellContent decoded (entities, CDATA), or null when it is the plain span.
	private readText(): string | null {
		return this.valueText
	}

	// The <v> text read by cellContent.
	private value(): string {
		return this.valueText ?? this.scanner.characters(this.valueStart, this.valueEnd)
	}

	// Reads the children of a cell whose start tag ends at `tagEnd`; returns after its end tag.
	private cellContent(start: number, name: number, tagEnd: number, metadata: number): number {
		const bytes = this.bytes
		const scanner = this.scanner
		let at = tagEnd

		const short = name === start + 2

		for (;;) {
			const lt = bytes[at] === LT ? at : bytes.indexOf(LT, at)

			if (lt < 0) scanner.fail("A cell is not closed", start)

			const next = bytes[lt + 1]

			// </c> and <v>...</v>, the usual spelling, without the general paths.
			if (short && next === SLASH && bytes[lt + 2] === 99 && bytes[lt + 3] === GT) return lt + 4

			if (next === 118 && bytes[lt + 2] === GT) {
				const contentStart = lt + 3
				let contentEnd = contentStart
				let plain = true

				for (;;) {
					const b = bytes[contentEnd]

					if (b === LT || b === undefined) break
					if (b === AMP || b === 13) plain = false

					contentEnd++
				}

				if (bytes[contentEnd + 1] === SLASH && bytes[contentEnd + 2] === 118 && bytes[contentEnd + 3] === GT) {
					this.valueStart = contentStart
					this.valueEnd = contentEnd
					this.valueText = plain ? null : scanner.characters(contentStart, contentEnd)
					at = contentEnd + 4

					continue
				}
			}

			if (next === SLASH) {
				const end = nameEnd(bytes, lt + 2)

				if (end - (lt + 2) !== name - (start + 1) || !sameName(bytes, lt + 2, start + 1, name - start - 1)) {
					scanner.fail("An end tag does not match its cell", lt)
				}

				const close = bytes.indexOf(GT, end)

				if (close < 0) scanner.fail("A cell is not closed", lt)

				return close + 1
			}

			if (next === BANG || next === QUESTION) {
				at = scanner.markupEnd(lt)

				continue
			}

			const childName = nameEnd(bytes, lt + 1)

			if (localIs(bytes, lt + 1, childName, "v")) {
				const childTagEnd = scanner.tagEnd(lt)

				if (scanner.selfClosing) {
					this.valueStart = childTagEnd
					this.valueEnd = childTagEnd
					this.valueText = null
					at = childTagEnd

					continue
				}

				const contentEnd = bytes.indexOf(LT, childTagEnd)

				if (contentEnd >= 0 && bytes[contentEnd + 1] === SLASH && hasByte(bytes, AMP, childTagEnd, contentEnd)) {
					this.valueStart = childTagEnd
					this.valueEnd = contentEnd
					this.valueText = scanner.characters(childTagEnd, contentEnd)
					at = this.closeAfter(contentEnd)
				} else if (contentEnd >= 0 && bytes[contentEnd + 1] === SLASH) {
					this.valueStart = childTagEnd
					this.valueEnd = contentEnd
					this.valueText = null
					at = this.closeAfter(contentEnd)
				} else {
					this.valueText = scanner.text(childTagEnd, false)
					this.valueStart = childTagEnd
					this.valueEnd = childTagEnd
					at = scanner.textEnd
				}
			} else if (localIs(bytes, lt + 1, childName, "f")) {
				at = this.readFormula(lt, metadata)
			} else if (localIs(bytes, lt + 1, childName, "is")) {
				const childTagEnd = scanner.tagEnd(lt)

				if (scanner.selfClosing) {
					this.inline = ""
					at = childTagEnd
				} else {
					at = this.readInline(childTagEnd)
				}
			} else {
				// extLst or a child the model does not hold.
				this.marked = true
				at = scanner.elementEnd(lt)
			}
		}
	}

	// After the end tag starting at `lt` (its name is not checked: the caller found it ends simple content).
	private closeAfter(lt: number): number {
		const close = this.bytes.indexOf(GT, lt)

		if (close < 0) this.scanner.fail("An end tag is not closed", lt)

		return close + 1
	}

	private readFormula(start: number, metadata: number): number {
		const bytes = this.bytes
		const scanner = this.scanner
		const tagEnd = scanner.tagEnd(start)
		const empty = scanner.selfClosing
		let type = "normal"
		let ref: string | null = null
		let shared = -1
		let flags = 0
		let r1: string | undefined
		let r2: string | undefined

		// <f>, the usual spelling, has none to visit.
		if (bytes[start + 2] !== GT)
			scanner.attributes(start, tagEnd, (nameStart, nameStop, valueStart, valueEnd) => {
				const length = nameStop - nameStart

				if (length === 1 && bytes[nameStart] === 116) type = scanner.attributeValue(valueStart, valueEnd)
				else if (bytesAre(bytes, nameStart, nameStop, "ref")) ref = scanner.attributeValue(valueStart, valueEnd)
				else if (bytesAre(bytes, nameStart, nameStop, "si")) shared = parseUint(bytes, valueStart, valueEnd)
				else if (bytesAre(bytes, nameStart, nameStop, "ca")) flags |= isTrue(bytes, valueStart, valueEnd) ? FormulaFlag.ALWAYS : 0
				else if (bytesAre(bytes, nameStart, nameStop, "aca"))
					flags |= isTrue(bytes, valueStart, valueEnd) ? FormulaFlag.ALWAYS_ARRAY : 0
				else if (bytesAre(bytes, nameStart, nameStop, "bx"))
					flags |= isTrue(bytes, valueStart, valueEnd) ? FormulaFlag.ASSIGNS_NAME : 0
				else if (bytesAre(bytes, nameStart, nameStop, "dt2D")) flags |= isTrue(bytes, valueStart, valueEnd) ? FormulaFlag.TWO_D : 0
				else if (bytesAre(bytes, nameStart, nameStop, "dtr"))
					flags |= isTrue(bytes, valueStart, valueEnd) ? FormulaFlag.ROW_INPUT : 0
				else if (bytesAre(bytes, nameStart, nameStop, "del1"))
					flags |= isTrue(bytes, valueStart, valueEnd) ? FormulaFlag.DELETED_1 : 0
				else if (bytesAre(bytes, nameStart, nameStop, "del2"))
					flags |= isTrue(bytes, valueStart, valueEnd) ? FormulaFlag.DELETED_2 : 0
				else if (bytesAre(bytes, nameStart, nameStop, "r1")) r1 = scanner.attributeValue(valueStart, valueEnd)
				else if (bytesAre(bytes, nameStart, nameStop, "r2")) r2 = scanner.attributeValue(valueStart, valueEnd)
			})

		let text = ""
		let at = tagEnd

		if (!empty) {
			const contentEnd = bytes.indexOf(LT, tagEnd)

			if (contentEnd >= 0 && bytes[contentEnd + 1] === SLASH) {
				text = scanner.characters(tagEnd, contentEnd)
				at = this.closeAfter(contentEnd)
			} else {
				text = scanner.text(tagEnd, false)
				at = scanner.textEnd
			}
		}

		const range = ref === null ? null : parseRange(ref)
		let kind: FormulaKind = FormulaKind.NORMAL

		if (type === "shared") kind = range !== null || shared < 0 ? FormulaKind.SHARED_MASTER : FormulaKind.SHARED_CHILD
		else if (type === "array") kind = FormulaKind.ARRAY
		else if (type === "dataTable") kind = FormulaKind.DATA_TABLE

		this.formula = this.formulas.addRead(kind, text, shared, range, flags, metadata, r1, r2)

		return at
	}

	// An inline string's text: its <t> and its runs' <t>, phonetic runs left out. Returns after </is>.
	private readInline(contentStart: number): number {
		const bytes = this.bytes
		const scanner = this.scanner
		let text = ""
		let at = contentStart
		let depth = 0

		for (;;) {
			const lt = bytes[at] === LT ? at : bytes.indexOf(LT, at)

			if (lt < 0) scanner.fail("An inline string is not closed", contentStart)

			const next = bytes[lt + 1]

			if (next === SLASH) {
				at = this.closeAfter(lt)

				if (depth === 0) break

				depth--

				continue
			}

			if (next === BANG || next === QUESTION) {
				at = scanner.markupEnd(lt)

				continue
			}

			const childName = nameEnd(bytes, lt + 1)

			if (localIs(bytes, lt + 1, childName, "t")) {
				const tagEnd = scanner.tagEnd(lt)

				if (scanner.selfClosing) {
					at = tagEnd

					continue
				}

				text += scanner.text(tagEnd, false)
				at = scanner.textEnd
			} else if (depth === 0 && localIs(bytes, lt + 1, childName, "r")) {
				const tagEnd = scanner.tagEnd(lt)

				// Rich runs: the model holds their text only.
				this.marked = true
				at = tagEnd

				if (!scanner.selfClosing) depth++
			} else {
				if (depth === 0) this.marked = true

				at = scanner.elementEnd(lt)
			}
		}

		this.inline = text

		return at
	}
}

function hasByte(bytes: Uint8Array, byte: number, start: number, end: number): boolean {
	for (let i = start; i < end; i++) if (bytes[i] === byte) return true

	return false
}

function sameName(bytes: Uint8Array, a: number, b: number, length: number): boolean {
	for (let k = 0; k < length; k++) if (bytes[a + k] !== bytes[b + k]) return false

	return true
}

// ST_CellType (§18.18.11) from the bytes of t; anything unknown reads as a number, as Excel's default.
function cellType(bytes: Uint8Array, start: number, end: number): number {
	switch (end - start) {
		case 1:
			switch (bytes[start]) {
				case 115:
					return T_SHARED
				case 98:
					return T_BOOLEAN
				case 101:
					return T_ERROR
				case 100:
					return T_DATE
			}

			return T_NUMBER
		case 3:
			return bytesAre(bytes, start, end, "str") ? T_STRING : T_NUMBER
		case 9:
			return bytesAre(bytes, start, end, "inlineStr") ? T_INLINE : T_NUMBER
	}

	return T_NUMBER
}
