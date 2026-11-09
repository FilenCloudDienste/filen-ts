import { appendAll } from "../arrays"
import { decodeCharacterData, encodeUtf8, escapeAttribute } from "../xml/index"
import type { SourceAxis } from "./write/axis"
import { storeValue } from "./write/cells"
import type { SheetStore } from "../xlsx/model/store"
import type { XlsxSharedStrings } from "../xlsx/model/types"

// What an OpenDocument spreadsheet holds that names cells by address but that the model does not carry: formulas
// the engine's grammar cannot take (their cached results are shown), shapes anchored to a cell range, named
// expressions refused, database ranges other than an autofilter's, label ranges, DataPilot tables and
// consolidation. A row or column inserted or deleted moves the cells they name, so the writer moves their
// addresses as LibreOffice does (ODF 1.3 Part 4 §5.8 references, Part 3 §18.3.5-§18.3.7 address types); where it
// cannot be sure of the result the edit is refused (check.ts), and the save's proof compares them read back.

export type UnheldKind =
	// A cell's table:formula (OpenFormula), references relative to its cell's table.
	| "formula"
	// A cell-anchored shape's table:end-cell-address.
	| "shapeEnd"
	// A named expression's or range's address or expression: its relative parts are relative to a base cell, so
	// those are never moved.
	| "name"
	// A cell, range or range list address.
	| "address"
	// A range whose children name its columns or rows by position (filters, sorts, subtotals): moved only whole.
	| "fields"

export interface UnheldItem {
	readonly kind: UnheldKind
	// The table it is in (a cell's), "" for content.xml's own elements.
	readonly sheet: string
	// The cell's first source row and column and how many it repeats over; -1 outside a table.
	readonly row: number
	readonly rows: number
	readonly col: number
	readonly cols: number
	// Outside a table: which element and attribute it is, for the proof to find it again.
	readonly key: string
	readonly text: string
	// A formula's cell as the model held it at open (its result, cellPrint): while it holds that still, the cell's
	// formula is this one, and the save must keep it.
	readonly cached?: string
}

export interface OdsUnheld {
	readonly items: readonly UnheldItem[]
	// The formulas the engine's grammar did not take, as written.
	readonly formulas: ReadonlySet<string>
	// Per table, the first rows of the row elements holding items.
	readonly rows: ReadonlyMap<string, ReadonlySet<number>>
	// Why no row or column may move on any sheet (tracked changes, form controls bound to cells, rules a validation
	// cannot show, more of these than are followed), null for none.
	readonly opaque: string | null
	// Tables on which no row or column may move nor the name change, with why (detective marks, linked cell ranges,
	// scenarios, a print range kept as written).
	readonly pinned: ReadonlyMap<string, string>
}

export const NO_UNHELD: OdsUnheld = { items: [], formulas: new Set(), rows: new Map(), opaque: null, pinned: new Map() }

// Past these, a move anywhere is refused rather than followed (bounded memory).
const MAX_ITEMS = 20_000
const MAX_TEXT = 4 * 1024 * 1024

export class UnheldCollector {
	private readonly items: UnheldItem[] = []
	private readonly formulas = new Set<string>()
	private readonly rows = new Map<string, Set<number>>()
	private readonly pinned = new Map<string, string>()
	private opaque: string | null = null
	private text = 0

	add(item: UnheldItem): void {
		if (this.opaque !== null) return

		this.text += item.text.length + item.key.length

		if (this.items.length >= MAX_ITEMS || this.text > MAX_TEXT) {
			this.makeOpaque("references")

			return
		}

		this.items.push(item)

		if (item.kind === "formula") this.formulas.add(item.text)

		if (item.row >= 0) {
			let rows = this.rows.get(item.sheet)

			if (rows === undefined) this.rows.set(item.sheet, (rows = new Set()))

			rows.add(item.row)
		}
	}

	cell(kind: "formula" | "shapeEnd", sheet: string, row: number, rows: number, col: number, cols: number, text: string): void {
		this.add({ kind, sheet, row, rows, col, cols, key: "", text })
	}

	element(kind: "name" | "address" | "fields", key: string, text: string): void {
		this.add({ kind, sheet: "", row: -1, rows: 0, col: -1, cols: 0, key, text })
	}

	pin(sheet: string, reason: string): void {
		if (!this.pinned.has(sheet)) this.pinned.set(sheet, reason)
	}

	makeOpaque(reason: string): void {
		this.opaque ??= reason
		this.items.length = 0
		this.formulas.clear()
		this.rows.clear()
	}

	result(): OdsUnheld {
		if (this.items.length === 0 && this.opaque === null && this.pinned.size === 0) return NO_UNHELD

		return { items: this.items, formulas: this.formulas, rows: this.rows, opaque: this.opaque, pinned: this.pinned }
	}
}

// --- Moving addresses ---

// A sheet as it is now: its name and where its rows and columns came from; null for a sheet deleted.
export interface SheetMove {
	readonly name: string
	readonly rows: SourceAxis
	readonly cols: SourceAxis
}

export class Shifter {
	// By the sheet's name in the source.
	readonly moves: ReadonlyMap<string, SheetMove | null>
	// Some sheet's rows or columns moved.
	readonly axesMoved: boolean
	// That, or a sheet renamed or deleted: addresses may read otherwise.
	readonly changed: boolean

	constructor(moves: ReadonlyMap<string, SheetMove | null>) {
		this.moves = moves

		let axes = false
		let changed = false

		for (const [name, move] of moves) {
			if (move === null) {
				changed = true

				continue
			}

			if (!move.rows.identity || !move.cols.identity) axes = true
			if (move.name !== name) changed = true
		}

		this.axesMoved = axes
		this.changed = changed || axes
	}

	// A formula's text with its references moved; null where that cannot be told for sure. `own`: the table a
	// reference without a sheet is on ("" for none: a name's, relative to where it is used).
	formula(text: string, own: string, kind: "formula" | "name"): string | null {
		if (!this.changed) return text

		const prefix = /^([A-Za-z][\w.-]*):/.exec(text)

		// Another grammar than OpenFormula (msoxl:, a macro language's): its references are not found.
		if (prefix !== null && prefix[1] !== "of" && prefix[1] !== "oooc") return null

		let out = ""
		let at = 0

		for (let k = 0; k < text.length; k++) {
			const char = text[k]

			if (char === '"') {
				k++

				while (k < text.length && !(text[k] === '"' && text[k + 1] !== '"')) k += text[k] === '"' ? 2 : 1

				continue
			}

			if (char !== "[") continue

			const close = referenceEnd(text, k + 1)

			if (close < 0) return null

			const moved = this.reference(text.slice(k + 1, close), own, kind)

			if (moved === null) return null

			out += text.slice(at, k + 1) + moved
			at = close
			k = close
		}

		return out + text.slice(at)
	}

	// An attribute's cell, range or space-separated range list address (ODF 1.3 Part 3 §18.3.5-§18.3.7) moved; `own`:
	// the table a part without a sheet is on.
	address(text: string, kind: "formula" | "name" = "formula", own = ""): string | null {
		if (!this.changed) return text

		const parts = splitList(text)

		if (parts === null) return null

		const out: string[] = []

		for (const part of parts) {
			const moved = this.reference(part, own, kind)

			if (moved === null) return null

			out.push(moved)
		}

		return out.join(" ")
	}

	// Whether a range's rows and columns all stay together (none inserted or deleted inside it, none deleted).
	whole(text: string): boolean {
		if (!this.changed) return true

		const parts = splitList(text)

		if (parts === null) return false

		for (const part of parts) {
			const range = parseRange(part)

			if (range === null) return false
			if (range === "error" || range === "external") continue

			const move = this.moves.get(range.first.sheet?.name ?? "")

			if (move === undefined) continue
			if (move === null) return false

			for (const [axis, a, b] of [
				[move.cols, range.first.col, range.second?.col ?? range.first.col],
				[move.rows, range.first.row, range.second?.row ?? range.first.row]
			] as const) {
				if (a < 0 || b < 0) continue

				const low = Math.min(a, b)
				const high = Math.max(a, b)

				if (axis.target(low) < 0 || axis.runFrom(low) <= high - low) return false
			}
		}

		return true
	}

	private reference(body: string, own: string, kind: "formula" | "name"): string | null {
		const range = parseRange(body)

		if (range === null) return null
		// An error (#REF!) names no cell; another file's cells stay where they are.
		if (range === "error" || range === "external") return body

		const firstSheet = range.first.sheet?.name ?? own
		const secondSheet = range.second?.sheet?.name ?? firstSheet

		if (firstSheet === "") {
			// A name's sheetless reference is on whichever sheet uses it: any sheet's rows moving moves it.
			return this.axesMoved ? null : body
		}

		const firstMove = this.moves.get(firstSheet)
		const secondMove = this.moves.get(secondSheet)

		if (firstMove === null || secondMove === null) return null

		if (firstSheet !== secondSheet) {
			// Across sheets: their order decides which are inside; moved only by a rename.
			if (this.axesMoved) return null

			return format(range, firstMove, secondMove, range.first.col, range.first.row, range.second?.col ?? -1, range.second?.row ?? -1)
		}

		// A sheet not in the source (another document's or none): nothing of it moved.
		if (firstMove === undefined) return body

		const relative =
			(range.first.col >= 0 && !range.first.colAbsolute) ||
			(range.first.row >= 0 && !range.first.rowAbsolute) ||
			(range.second !== null &&
				((range.second.col >= 0 && !range.second.colAbsolute) || (range.second.row >= 0 && !range.second.rowAbsolute)))

		if (kind === "name" && relative && (!firstMove.rows.identity || !firstMove.cols.identity)) return null

		const cols = moved(firstMove.cols, range.first.col, range.second?.col ?? -1, range.second === null)
		const rows = moved(firstMove.rows, range.first.row, range.second?.row ?? -1, range.second === null)

		if (cols === null || rows === null) return null

		return format(range, firstMove, firstMove, cols[0], rows[0], cols[1], rows[1])
	}
}

// Positions on one axis moved: one (`single`, or a range's two ends), [first, second]; -1 for an absent part (a
// whole row's column). A deleted cell has no address; a range keeps the part of it that is left.
function moved(axis: SourceAxis, a: number, b: number, single: boolean): [number, number] | null {
	// No position on this axis (a whole row's column, a whole column's row).
	if (a < 0) return [a, b]

	if (single || b < 0) {
		const target = axis.target(a)

		return target < 0 ? null : [target, b]
	}

	const low = Math.min(a, b)
	const high = Math.max(a, b)
	const first = axis.nextKept(low)
	const last = axis.previousKept(high)

	if (first < 0 || last < 0 || first > last) return null

	const from = axis.target(first)
	const to = axis.target(last)

	return a <= b ? [from, to] : [to, from]
}

// --- Reading and writing addresses ---

interface SheetPart {
	readonly raw: string
	readonly name: string
	readonly absolute: boolean
	readonly quoted: boolean
}

interface Part {
	readonly sheet: SheetPart | null
	readonly col: number
	readonly row: number
	readonly colAbsolute: boolean
	readonly rowAbsolute: boolean
}

interface Range {
	readonly first: Part
	readonly second: Part | null
}

// The end of a bracketed reference started at `from` (its "]"), past quoted names; -1 for none.
function referenceEnd(text: string, from: number): number {
	for (let k = from; k < text.length; k++) {
		const char = text[k]

		if (char === "]") return k

		if (char === "'") {
			k++

			while (k < text.length && !(text[k] === "'" && text[k + 1] !== "'")) k += text[k] === "'" ? 2 : 1
		}
	}

	return -1
}

// Space-separated addresses, past quoted names; null where a quote is not closed.
export function splitList(text: string): string[] | null {
	const out: string[] = []
	let start = -1

	for (let k = 0; k <= text.length; k++) {
		const char = text[k]

		if (char === undefined || char === " " || char === "\t" || char === "\n" || char === "\r") {
			if (start >= 0) out.push(text.slice(start, k))

			start = -1

			continue
		}

		if (start < 0) start = k

		if (char === "'") {
			k++

			while (k < text.length && !(text[k] === "'" && text[k + 1] !== "'")) k += text[k] === "'" ? 2 : 1

			if (k >= text.length) return null
		}
	}

	return out
}

const LETTERS = /^\$?([A-Za-z]{1,3})/
const DIGITS = /^\$?(\d{1,7})/

function parseSheet(text: string, at: number): { sheet: SheetPart | null; end: number } | null {
	if (text[at] === ".") return { sheet: null, end: at + 1 }

	let k = at
	const absolute = text[k] === "$"

	if (absolute) k++

	if (text[k] === "'") {
		let name = ""

		k++

		for (;;) {
			if (k >= text.length) return null

			if (text[k] === "'") {
				if (text[k + 1] === "'") {
					name += "'"
					k += 2

					continue
				}

				break
			}

			name += text[k]
			k++
		}

		k++

		if (text[k] !== ".") return null

		return { sheet: { raw: text.slice(at, k), name, absolute, quoted: true }, end: k + 1 }
	}

	const dot = text.indexOf(".", k)

	if (dot < 0) return null

	const name = text.slice(k, dot)

	if (name === "" || /[\]'#$: ]/.test(name)) return null

	return { sheet: { raw: text.slice(at, dot), name, absolute, quoted: false }, end: dot + 1 }
}

function parsePart(text: string, at: number): { part: Part; end: number } | null {
	const sheet = parseSheet(text, at)

	if (sheet === null) return null

	let k = sheet.end
	const rest = text.slice(k)
	const letters = LETTERS.exec(rest)
	let col = -1
	let colAbsolute = false

	if (letters !== null) {
		col = columnIndex(letters[1] ?? "")
		colAbsolute = rest.startsWith("$")
		k += letters[0].length
	}

	const digits = DIGITS.exec(text.slice(k))
	let row = -1
	let rowAbsolute = false

	if (digits !== null) {
		row = Number(digits[1]) - 1
		rowAbsolute = text[k] === "$"
		k += digits[0].length
	}

	if ((col < 0 && row < 0) || row < -1) return null

	return { part: { sheet: sheet.sheet, col, row, colAbsolute, rowAbsolute }, end: k }
}

function parseRange(body: string): Range | "error" | "external" | null {
	const text = body.trim()

	if (text.includes("#REF!") || text.includes("#NAME?")) return "error"

	// 'iri'#Sheet.A1: another document's.
	if (/^'(?:[^']|'')*'#/.test(text)) return "external"

	const first = parsePart(text, 0)

	if (first === null) return null
	if (first.end === text.length) return { first: first.part, second: null }
	if (text[first.end] !== ":") return null

	const second = parsePart(text, first.end + 1)

	if (second === null || second.end !== text.length) return null

	// A whole column or row takes both ends so (".A:.B", ".1:.3").
	if (first.part.col < 0 !== second.part.col < 0 || first.part.row < 0 !== second.part.row < 0) return null

	return { first: first.part, second: second.part }
}

function columnIndex(letters: string): number {
	let index = 0

	for (const char of letters.toUpperCase()) index = index * 26 + char.charCodeAt(0) - 64

	return index - 1
}

function columnLetters(index: number): string {
	let text = ""

	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + ((n - 1) % 26)) + text

	return text
}

function sheetText(sheet: SheetPart, move: SheetMove | undefined): string {
	if (move === undefined || move.name === sheet.name) return sheet.raw

	const plain = !sheet.quoted && /^[A-Za-z0-9_]+$/.test(move.name)
	const name = plain ? move.name : `'${move.name.replaceAll("'", "''")}'`

	return `${sheet.absolute ? "$" : ""}${name}`
}

function partText(part: Part, move: SheetMove | undefined, col: number, row: number): string {
	const sheet = part.sheet === null ? "" : sheetText(part.sheet, move)
	const colText = part.col < 0 ? "" : `${part.colAbsolute ? "$" : ""}${columnLetters(col)}`
	const rowText = part.row < 0 ? "" : `${part.rowAbsolute ? "$" : ""}${row + 1}`

	return `${sheet}.${colText}${rowText}`
}

function format(
	range: Range,
	firstMove: SheetMove | undefined,
	secondMove: SheetMove | undefined,
	col1: number,
	row1: number,
	col2: number,
	row2: number
): string {
	const first = partText(range.first, firstMove, col1, row1)

	return range.second === null ? first : `${first}:${partText(range.second, secondMove, col2, row2)}`
}

// --- Patching markup ---

// The attributes holding addresses, by local name (their prefix the table namespace's), and how each is read.
export const ADDRESS_ATTRIBUTES: ReadonlyMap<string, "address" | "formula"> = new Map([
	["target-range-address", "address"],
	["cell-range-address", "address"],
	["target-cell-address", "address"],
	["source-cell-range-addresses", "address"],
	["label-cell-range-address", "address"],
	["data-cell-range-address", "address"],
	["condition-source-range-address", "address"],
	["buttons", "address"],
	["end-cell-address", "address"],
	["expression", "formula"]
])

const ATTRIBUTE = /(\s)([A-Za-z_][\w.-]*):([A-Za-z-]+)(\s*=\s*)("[^"]*"|'[^']*')/g

// Each attribute of `markup` that `pick` takes (by its local name and value) given the value `move` returns for it.
// `tablePrefix`: whether a prefix is the table namespace's. Throws `refuse` where move cannot tell.
export function patchAttributes(
	markup: string,
	tablePrefix: (prefix: string) => boolean,
	move: (local: string, value: string) => string | null | undefined
): string | null {
	let failed = false
	const out = markup.replace(ATTRIBUTE, (whole, space: string, prefix: string, local: string, equals: string, quoted: string) => {
		if (failed || !tablePrefix(prefix)) return whole

		const raw = quoted.slice(1, -1)
		const value = /[&\t\n\r]/.test(raw) ? decodeAttribute(raw) : raw
		const next = move(local, value)

		if (next === undefined || next === value) return whole

		if (next === null) {
			failed = true

			return whole
		}

		return `${space}${prefix}:${local}${equals}"${escapeAttribute(next)}"`
	})

	return failed ? null : out
}

function decodeAttribute(raw: string): string {
	const bytes = encodeUtf8(raw)

	return decodeCharacterData(bytes, 0, bytes.length, true)
}

// --- Sheets now ---

interface WorkbookNow {
	readonly sheets: readonly { readonly id: number; readonly name: string; readonly model: object | null }[]
}

// How each source table moved: renamed, its rows and columns inserted or deleted, or deleted.
export function shifterOf(workbook: WorkbookNow, tables: readonly { readonly id: number; readonly name: string }[]): Shifter {
	const moves = new Map<string, SheetMove | null>()

	for (const table of tables) {
		const entry = workbook.sheets.find(sheet => sheet.id === table.id)
		const model = entry?.model as { rowAxis?: SourceAxis; colAxis?: SourceAxis } | null | undefined

		if (entry === undefined || model === null || model === undefined || !("rowAxis" in model)) {
			moves.set(table.name, null)

			continue
		}

		moves.set(table.name, { name: entry.name, rows: model.rowAxis as SourceAxis, cols: model.colAxis as SourceAxis })
	}

	return new Shifter(moves)
}

// An item's text as the moves leave it, null where that cannot be told for sure.
export function movedText(item: UnheldItem, shifter: Shifter): string | null {
	switch (item.kind) {
		case "formula":
			return shifter.formula(item.text, item.sheet, "formula")
		case "shapeEnd":
			return shifter.address(item.text)
		case "name":
			return item.key.endsWith("\u0000expression") ? shifter.formula(item.text, "", "name") : shifter.address(item.text, "name")
		case "address":
			return shifter.address(item.text)
		case "fields":
			return shifter.whole(item.text) ? shifter.address(item.text) : null
	}
}

// --- The proof ---

function shownKey(key: string): string {
	return key.replaceAll("\u0000", " ").replaceAll("\u0001", "")
}

interface UnheldSource {
	readonly tables: readonly { readonly id: number; readonly name: string }[]
	readonly unheld: OdsUnheld
}

// An element's key with a sheet's index (a name's scope) given as the sheet's name, so keys read back compare.
function elementKey(key: string, sheetName: (index: number) => string | undefined): string {
	if (!key.startsWith("name\u0000")) return key

	const [, scope = "", ...rest] = key.split("\u0000")

	return ["name", scope === "" ? "" : `\u0001${sheetName(Number(scope)) ?? scope}`, ...rest].join("\u0000")
}

// Where what the model does not carry reads back otherwise than the moves leave it (an address left stale, a
// reference moved twice), null when it reads back so. Cells overwritten or deleted take theirs with them.
export function unheldDifference(
	workbook: WorkbookNow,
	before: UnheldSource,
	after: UnheldSource,
	// The cell now (cellPrint) on a sheet by its name now, to tell a formula's cell still holding its result.
	cellNow?: (sheet: string, row: number, col: number) => string | null
): string | null {
	if (before.unheld.opaque !== null || after.unheld.opaque !== null) return null

	const shifter = shifterOf(workbook, before.tables)
	const nowName = (index: number): string | undefined => {
		const table = before.tables[index]
		const move = table === undefined ? undefined : shifter.moves.get(table.name)

		return move === null || move === undefined ? undefined : move.name
	}
	const expected = new Map<string, string>()
	const cells = new Map<string, Map<number, UnheldItem[]>>()
	const tall: UnheldItem[] = []

	for (const item of before.unheld.items) {
		if (item.row < 0) {
			const text = movedText(item, shifter)

			if (text === null) return `${shownKey(item.key)}: not moved`

			expected.set(elementKey(item.key, nowName), text)

			continue
		}

		if (item.rows > 1) {
			tall.push(item)

			continue
		}

		let rows = cells.get(item.sheet)

		if (rows === undefined) cells.set(item.sheet, (rows = new Map()))

		const list = rows.get(item.row)

		if (list === undefined) rows.set(item.row, [item])
		else list.push(item)
	}

	const read = new Map<string, string>()

	for (const item of after.unheld.items) {
		if (item.row < 0) {
			read.set(
				elementKey(item.key, index => after.tables[index]?.name),
				item.text
			)

			continue
		}

		// The source sheet now named so, and the source cell now at this one.
		let sourceName: string | undefined
		let move: SheetMove | undefined

		for (const [name, candidate] of shifter.moves) {
			if (candidate !== null && candidate.name === item.sheet) {
				sourceName = name
				move = candidate
			}
		}

		const where = `${item.sheet} ${columnLetters(item.col)}${item.row + 1}`

		if (sourceName === undefined || move === undefined) return `${where}: ${item.kind} on a new sheet`

		const row = move.rows.source(item.row)
		const col = move.cols.source(item.col)
		const covers = (candidate: UnheldItem): boolean =>
			candidate.kind === item.kind &&
			candidate.sheet === sourceName &&
			row >= candidate.row &&
			row < candidate.row + candidate.rows &&
			col >= candidate.col &&
			col < candidate.col + candidate.cols
		const origin = row < 0 || col < 0 ? undefined : ((cells.get(sourceName)?.get(row) ?? []).find(covers) ?? tall.find(covers))

		if (origin === undefined) return `${where}: ${item.kind} the source does not have there`

		if (movedText(origin, shifter) !== item.text) return `${where}: ${item.kind} reads ${item.text}`
	}

	// A formula whose cell is still there, holding the result it held: it must read back there.
	if (cellNow !== undefined) {
		const found = new Set(
			after.unheld.items.filter(item => item.kind === "formula").map(item => `${item.sheet}\u0000${item.row}\u0000${item.col}`)
		)

		for (const item of before.unheld.items) {
			if (item.kind !== "formula" || item.cached === undefined) continue

			const move = shifter.moves.get(item.sheet)

			if (move === null || move === undefined) continue

			const row = move.rows.target(item.row)
			const col = move.cols.target(item.col)

			if (row < 0 || col < 0 || cellNow(move.name, row, col) !== item.cached) continue
			if (!found.has(`${move.name}\u0000${row}\u0000${col}`))
				return `${move.name} ${columnLetters(col)}${row + 1}: its formula ${item.text} is not read back`
		}
	}

	for (const [key, text] of expected) {
		if (read.get(key) !== text) return `${shownKey(key)}: reads ${read.get(key) ?? "nothing"}, not ${text}`
	}

	for (const key of read.keys()) if (!expected.has(key)) return `${shownKey(key)}: not in the source`

	return null
}

// A range list's ranges as boxes (whole rows and columns span the grid), null where one does not read; a range
// without a sheet is on `own`.
export function addressBoxes(
	text: string,
	own: string
): { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number }[] | null {
	const parts = splitList(text)

	if (parts === null) return null

	const out: { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number }[] = []

	for (const part of parts) {
		const range = parseRange(part)

		if (range === null || range === "error" || range === "external") return null

		const second = range.second ?? range.first
		const sheet = range.first.sheet?.name ?? own

		if ((second.sheet?.name ?? sheet) !== sheet) return null

		out.push({
			sheet,
			startRow: range.first.row < 0 ? 0 : Math.min(range.first.row, second.row),
			startCol: range.first.col < 0 ? 0 : Math.min(range.first.col, second.col),
			endRow: range.first.row < 0 ? 1_048_575 : Math.max(range.first.row, second.row),
			endCol: range.first.col < 0 ? 16_383 : Math.max(range.first.col, second.col)
		})
	}

	return out
}

// What a cell of a model holds as the proof compares it (its value; no formula of the model's), null for none.
export function cellPrint(
	model: { readonly store: unknown } | null | undefined,
	shared: XlsxSharedStrings,
	row: number,
	col: number
): string | null {
	const store = model?.store as SheetStore | undefined
	const slot = store === undefined || row < 0 || col < 0 ? -1 : store.locate(row, col)

	if (store === undefined || slot < 0) return null

	const cell = storeValue(store, shared, slot, store.style(slot), undefined)

	return cell.formula === null ? JSON.stringify([cell.value, cell.number, cell.text]) : null
}

// The formulas' cells as the models hold them at open.
export function withCached(unheld: OdsUnheld, print: (sheet: string, row: number, col: number) => string | null): OdsUnheld {
	if (unheld.formulas.size === 0) return unheld

	return {
		...unheld,
		items: unheld.items.map(item => {
			if (item.kind !== "formula") return item

			const cached = print(item.sheet, item.row, item.col)

			return cached === null ? item : { ...item, cached }
		})
	}
}

export interface NamedBox {
	// The sheet's name now; "" where a name's reference is on whichever sheet uses it.
	readonly sheet: string
	readonly startRow: number
	readonly startCol: number
	readonly endRow: number
	readonly endCol: number
}

// The cells an item names, where they are now; null where that cannot be read (taken as every cell).
export function namedBoxes(item: UnheldItem, shifter: Shifter): NamedBox[] | null {
	const text = movedText(item, shifter)

	if (text === null) return null

	const own = shifter.moves.get(item.sheet)?.name ?? item.sheet

	if (item.kind !== "formula" && !(item.kind === "name" && item.key.endsWith("\u0000expression")))
		return addressBoxes(text, item.kind === "name" ? "" : own)

	const out: NamedBox[] = []

	for (let k = 0; k < text.length; k++) {
		if (text[k] === '"') {
			k++

			while (k < text.length && !(text[k] === '"' && text[k + 1] !== '"')) k += text[k] === '"' ? 2 : 1

			continue
		}

		if (text[k] !== "[") continue

		const close = referenceEnd(text, k + 1)

		if (close < 0) return null

		const body = text.slice(k + 1, close)
		const range = parseRange(body)

		k = close

		if (range === "error" || range === "external") continue
		if (range === null) return null

		const boxes = addressBoxes(body, item.kind === "name" ? "" : own)

		if (boxes === null) return null

		appendAll(out, boxes)
	}

	return out
}
