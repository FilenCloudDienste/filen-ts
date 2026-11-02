import { maxOf, minOf } from "../../arrays"
import { sliceClock, type SliceClock } from "../../slicing"
import {
	SHEET_MAX_COLS,
	SHEET_MAX_EDIT_CELLS,
	SHEET_MAX_ROWS,
	type SheetAbortSignal,
	type SheetCell,
	type SheetCommandOf,
	type SheetId,
	type SheetQueryRequest,
	type SheetQueryResult,
	type SheetRange
} from "../protocol"
import type { SheetChangeSink, SheetEditStep, SheetHandled, SheetReadContext } from "../registry"
import { findMatcher, type FindMatcher } from "./match"

// Find and Replace over a session's cells, whatever holds them (an xlsx document, a text file): the find query and
// the find.replace command. Cells are visited row by row from the cell after `from`, through the scope's other
// sheets in tab order, and round to `from` itself, as Excel's "Find Next" with "Search: By Rows" goes. A workbook
// search covers the visible worksheets. Values are matched as the cells show them, formulas as they are typed;
// Replace works on what is typed (Excel's Replace looks in formulas only) and writes each changed cell as if it was
// typed again, as Excel does. Replace All is one step of the history.

declare module "../protocol" {
	interface SheetCommandMap {
		// Replaces `text` with `replacement` in what the cells hold as typed: in `cells` (triples sheet, row, col: the
		// match Replace stands on) or, when absent, in every match of the scope (Replace All). One undoable step.
		"find.replace": {
			readonly scope: { readonly sheet: SheetId } | "workbook"
			readonly text: string
			readonly replacement: string
			readonly matchCase: boolean
			readonly wholeCell: boolean
			readonly cells?: Uint32Array
			// Only these ranges of the scope's sheet (a selection of more than one cell), as the find query's `within`.
			readonly within?: readonly SheetRange[]
		}
	}
}

// Cells scanned between two looks at the slice clock and the abort signal.
const SCAN_ROWS = 2048

// One sheet's cells as a search reads them.
export interface FindSheet {
	// Visits the cells of `range` holding a value or a formula, row by row; stops when `visit` answers true, and
	// answers whether it did.
	scan(range: SheetRange, visit: (row: number, col: number) => boolean): boolean
	// What the cell shows.
	shown(row: number, col: number): string
	// What editing the cell starts from; null when that is hidden (a protected sheet's hidden formula): such a cell
	// is matched by its value, and never replaced.
	typed(row: number, col: number): string | null
}

// A document's sheets as a search reads them.
export interface FindDocument {
	// The sheets a workbook search covers, in tab order.
	searched(): readonly SheetId[]
	// A sheet, parsed when it is not yet; null for one that holds no cells to search.
	sheet(sheet: SheetId, context: SheetReadContext<unknown>): Promise<FindSheet | null>
	// Writes typed entries into one sheet as one step (cells.set).
	write(
		sheet: SheetId,
		cells: { readonly rows: Uint32Array; readonly cols: Uint16Array; readonly inputs: readonly string[] },
		changes: SheetChangeSink
	): Promise<SheetHandled> | SheetHandled
}

class Aborted extends Error {
	constructor() {
		super("The find was aborted")
	}
}

function checked(signal: SheetAbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Aborted()
}

// The ranges a search walks in a sheet, in order, from `from` on: `from` itself first when `at`.
function after(from: { readonly row: number; readonly col: number }, at: boolean): SheetRange[] {
	const ranges: SheetRange[] = []
	const startCol = at ? from.col : from.col + 1

	if (startCol < SHEET_MAX_COLS) ranges.push({ startRow: from.row, startCol, endRow: from.row, endCol: SHEET_MAX_COLS - 1 })
	if (from.row + 1 < SHEET_MAX_ROWS)
		ranges.push({ startRow: from.row + 1, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 })

	return ranges
}

// The ranges before `from` in a sheet, in order, and `from` itself last when `at`.
function before(from: { readonly row: number; readonly col: number }, at: boolean): SheetRange[] {
	const ranges: SheetRange[] = []
	const endCol = at ? from.col : from.col - 1

	if (from.row > 0) ranges.push({ startRow: 0, startCol: 0, endRow: from.row - 1, endCol: SHEET_MAX_COLS - 1 })
	if (endCol >= 0) ranges.push({ startRow: from.row, startCol: 0, endRow: from.row, endCol })

	return ranges
}

const WHOLE: SheetRange = { startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }

interface Walk {
	readonly sheet: SheetId
	readonly ranges: readonly SheetRange[]
}

// The sheets and ranges a search walks, in order: once round from `from`, which comes first ("at", "before") or last.
function walks(
	document: FindDocument,
	scope: SheetQueryRequest<"find">["scope"],
	from: SheetCell | undefined,
	start: "after" | "at" | "before"
): Walk[] {
	const sheets = scope === "workbook" ? [...document.searched()] : [scope.sheet]

	if (from === undefined || !sheets.includes(from.sheet)) return sheets.map(sheet => ({ sheet, ranges: [WHOLE] }))

	const at = sheets.indexOf(from.sheet)
	const order = sheets.slice(at + 1).concat(sheets.slice(0, at))

	return [
		{ sheet: from.sheet, ranges: after(from, start !== "after") },
		...order.map(sheet => ({ sheet, ranges: [WHOLE] })),
		{ sheet: from.sheet, ranges: before(from, start === "after") }
	]
}

export interface FindVisit {
	readonly sheet: SheetId
	readonly row: number
	readonly col: number
	readonly cells: FindSheet
}

function inside(ranges: readonly SheetRange[], row: number, col: number): boolean {
	for (const range of ranges)
		if (row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol) return true

	return false
}

// Where a search is held to: the selection's ranges of a sheet search, none (the whole scope) otherwise.
function heldTo(scope: SheetQueryRequest<"find">["scope"], within: readonly SheetRange[] | undefined): readonly SheetRange[] | null {
	return scope === "workbook" || within === undefined || within.length === 0 ? null : within
}

// Visits every cell holding something in the walks, in order, until `visit` answers true; only cells of `within`,
// when given. Long walks give the in-thread host a turn between row runs, and stop when aborted.
async function walk(
	document: FindDocument,
	planned: readonly Walk[],
	context: SheetReadContext<unknown>,
	visit: (cell: FindVisit) => boolean,
	within: readonly SheetRange[] | null = null
): Promise<void> {
	const clock: SliceClock | undefined = context.slicing === undefined ? undefined : sliceClock(context.slicing)
	// The rows and columns the ranges span: nothing outside them is read.
	const bounds: SheetRange | null =
		within === null
			? null
			: {
					startRow: minOf(within.map(range => range.startRow)),
					startCol: minOf(within.map(range => range.startCol)),
					endRow: maxOf(within.map(range => range.endRow)),
					endCol: maxOf(within.map(range => range.endCol))
				}

	for (const { sheet, ranges } of planned) {
		checked(context.signal)

		const cells = await document.sheet(sheet, context)

		if (cells === null) continue

		for (const walked of ranges) {
			const range =
				bounds === null
					? walked
					: {
							startRow: Math.max(walked.startRow, bounds.startRow),
							startCol: Math.max(walked.startCol, bounds.startCol),
							endRow: Math.min(walked.endRow, bounds.endRow),
							endCol: Math.min(walked.endCol, bounds.endCol)
						}

			if (range.startCol > range.endCol) continue

			for (let startRow = range.startRow; startRow <= range.endRow; startRow += SCAN_ROWS) {
				const part = { ...range, startRow, endRow: Math.min(range.endRow, startRow + SCAN_ROWS - 1) }

				// A single row's range (the rest of `from`'s row) keeps its columns; whole rows span them all.
				if (
					cells.scan(part, (row, col) =>
						within !== null && !inside(within, row, col) ? false : visit({ sheet, row, col, cells })
					)
				)
					return

				if (clock?.due === true) await clock.pause()

				checked(context.signal)
			}
		}
	}
}

function text(cell: FindVisit, lookIn: "values" | "formulas"): string {
	return lookIn === "values"
		? cell.cells.shown(cell.row, cell.col)
		: (cell.cells.typed(cell.row, cell.col) ?? cell.cells.shown(cell.row, cell.col))
}

// The find query.
export async function findCells(
	document: FindDocument,
	request: SheetQueryRequest<"find">,
	context: SheetReadContext<unknown>
): Promise<SheetQueryResult<"find">> {
	const version = context.version
	const matcher = findMatcher(request.text, request)
	const limit = Math.max(0, Math.floor(request.limit))

	if (matcher === null || limit === 0) return { cells: new Uint32Array(0), more: false, version }

	const start = request.start ?? "after"
	const planned = walks(document, request.scope, request.from, start)
	const within = heldTo(request.scope, request.within)

	if (start === "before") {
		// The whole walk, keeping the last `limit` matches in a ring.
		const ring = new Uint32Array(limit * 3)
		let count = 0

		await walk(
			document,
			planned,
			context,
			cell => {
				if (!matcher.test(text(cell, request.lookIn))) return false

				const at = (count % limit) * 3

				ring[at] = cell.sheet
				ring[at + 1] = cell.row
				ring[at + 2] = cell.col
				count++

				return false
			},
			within
		)

		if (count <= limit) return { cells: ring.slice(0, count * 3), more: false, version }

		const split = (count % limit) * 3
		const cells = new Uint32Array(limit * 3)

		cells.set(ring.subarray(split), 0)
		cells.set(ring.subarray(0, split), ring.length - split)

		return { cells, more: true, version }
	}

	const found: number[] = []
	let more = false

	await walk(
		document,
		planned,
		context,
		cell => {
			if (!matcher.test(text(cell, request.lookIn))) return false

			if (found.length === limit * 3) {
				more = true

				return true
			}

			found.push(cell.sheet, cell.row, cell.col)

			return false
		},
		within
	)

	return { cells: Uint32Array.from(found), more, version }
}

interface Replaced {
	readonly rows: number[]
	readonly cols: number[]
	readonly inputs: string[]
}

function replaced(matcher: FindMatcher, cells: FindSheet, row: number, col: number, replacement: string): string | null {
	const typed = cells.typed(row, col)

	if (typed === null) return null

	const next = matcher.replace(typed, replacement)

	return next === null || next === typed ? null : next
}

// Steps of several sheets as one: undone in reverse.
function together(steps: readonly SheetEditStep[]): SheetEditStep {
	return {
		bytes: steps.reduce((sum, step) => sum + step.bytes, 0),
		undo: async changes => {
			for (let i = steps.length - 1; i >= 0; i--) await steps[i]?.undo(changes)
		},
		redo: async changes => {
			for (const step of steps) await step.redo(changes)
		}
	}
}

// The find.replace command.
export async function replaceCells(
	document: FindDocument,
	command: SheetCommandOf<"find.replace">,
	context: SheetReadContext<unknown> & { readonly changes: SheetChangeSink }
): Promise<SheetHandled> {
	const matcher = findMatcher(command.text, command)

	if (matcher === null) return null

	const bySheet = new Map<SheetId, Replaced>()
	let count = 0
	let tooMany = false
	const take = (sheet: SheetId, row: number, col: number, input: string): void => {
		let entry = bySheet.get(sheet)

		if (entry === undefined) {
			entry = { rows: [], cols: [], inputs: [] }
			bySheet.set(sheet, entry)
		}

		entry.rows.push(row)
		entry.cols.push(col)
		entry.inputs.push(input)
		count++
	}

	const held = heldTo(command.scope, command.within)

	if (command.cells !== undefined) {
		const scoped = command.scope === "workbook" ? new Set(document.searched()) : new Set([command.scope.sheet])

		for (let i = 0; i + 2 < command.cells.length; i += 3) {
			const sheet = command.cells[i] ?? 0
			const row = command.cells[i + 1] ?? 0
			const col = command.cells[i + 2] ?? 0

			if (!scoped.has(sheet) || row >= SHEET_MAX_ROWS || col >= SHEET_MAX_COLS) continue
			if (held !== null && !inside(held, row, col)) continue

			const cells = await document.sheet(sheet, context)

			if (cells === null) continue

			let holds = false

			cells.scan({ startRow: row, startCol: col, endRow: row, endCol: col }, () => {
				holds = true

				return true
			})

			const next = holds ? replaced(matcher, cells, row, col, command.replacement) : null

			if (next !== null) take(sheet, row, col, next)
		}
	} else {
		await walk(
			document,
			walks(document, command.scope, undefined, "after"),
			context,
			cell => {
				const next = replaced(matcher, cell.cells, cell.row, cell.col, command.replacement)

				if (next === null) return false

				if (count === SHEET_MAX_EDIT_CELLS) {
					tooMany = true

					return true
				}

				take(cell.sheet, cell.row, cell.col, next)

				return false
			},
			held
		)
	}

	if (tooMany) return { refused: { reason: "tooLarge" } }

	const steps: SheetEditStep[] = []

	for (const [sheet, entry] of bySheet) {
		const handled = await document.write(
			sheet,
			{ rows: Uint32Array.from(entry.rows), cols: Uint16Array.from(entry.cols), inputs: entry.inputs },
			context.changes
		)

		if (handled !== null && "refused" in handled) {
			// What earlier sheets took is taken back: the replace is one step or none.
			for (let i = steps.length - 1; i >= 0; i--) await steps[i]?.undo(context.changes)

			return handled
		}

		if (handled !== null) steps.push(handled)
	}

	if (steps.length === 0) return null

	return steps.length === 1 ? (steps[0] as SheetEditStep) : together(steps)
}
