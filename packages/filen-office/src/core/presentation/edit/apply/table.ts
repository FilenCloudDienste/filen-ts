import { DEFAULT_PRESENTATION_BUDGETS } from "../../budget"
import {
	refused,
	type Deck,
	type Paragraph,
	type Refused,
	type ShapeNode,
	type ShapeRef,
	type SlideNode,
	type TableCell,
	type TableCellProps,
	type TableModel,
	type TextBody
} from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Inverse, Touch } from "../apply"
import { cloneModel, digestOf, findShape } from "../changes"
import { replaceInBody, type Matcher } from "../find"
import type { CellRange, DeckOp, OpOf, TableOp } from "../ops"
import { xmlSafeText } from "../xmlText"
import { isRefused, type SourceReading } from "./shape"

// The table ops on the model (a:tbl, ECMA-376 Part 1 §21.1.3; ODF table:table in a draw:frame), in place. A table is
// read as its merged areas (an origin cell with gridSpan/rowSpan, the cells it covers flagged hMerge/vMerge, as
// PowerPoint writes them, §21.1.3.16): every op edits the areas and the rows, then flags the cells from the areas
// again, so the covered cells are always the ones the origins name. A frame's box follows its grid (the column widths)
// and its rows' heights, as PowerPoint keeps them.
//
// Inverses: a frame still exactly as its source bytes read is put back by shape.restore with those bytes (ops.ts);
// one an op made, or already edited (its table, its box…), by its prior typed state (the frame deleted and inserted again, with its source bytes
// when it has a source), as the shape family undoes its content ops.

type Op<K extends TableOp["kind"]> = OpOf<"table"> & { kind: K }

const BUDGETS = DEFAULT_PRESENTATION_BUDGETS

// A merged area: its origin and its extent in grid cells.
export interface CellArea {
	r: number
	c: number
	rows: number
	cols: number
}

interface Found {
	readonly node: SlideNode
	readonly shape: ShapeNode
	readonly parent: number
	readonly index: number
	readonly table: TableModel
}

function found(deck: Deck, target: ShapeRef): Found | Refused {
	const node = deck.nodes.get(target.slide)

	if (node === undefined) return refused("notFound", `slide ${String(target.slide)} is not parsed`)

	const at = findShape(node.shapes, target.id)

	if (at === undefined) return refused("notFound", `shape ${String(target.id)}`)
	if (at.shape.frame?.kind !== "table") return refused("unsupported", `shape ${String(target.id)} is not a table`)
	if (at.shape.lock !== undefined) return refused("locked", at.shape.lock)

	return { node, shape: at.shape, parent: at.parent, index: at.index, table: at.shape.frame.table }
}

// An empty cell body: one paragraph whose mark has the properties of `like`'s text.
export function emptyBody(like?: TextBody): TextBody {
	const end = like?.paragraphs[0]?.endRPr ?? firstRunProps(like)

	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [], ...(end === undefined ? {} : { endRPr: end }) }] }
}

function firstRunProps(body: TextBody | undefined): Paragraph["endRPr"] {
	for (const paragraph of body?.paragraphs ?? []) {
		for (const run of paragraph.runs) if (run.kind !== "opaque") return run.rPr
	}

	return undefined
}

export function cellHasText(body: TextBody): boolean {
	return body.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind !== "br" && run.text !== ""))
}

// The merged areas of a table, origins in row-major order; undefined when its rows are not one cell per grid column
// or its spans overlap or leave the grid (a table the ops would have to guess at).
export function areasOf(table: TableModel): CellArea[] | undefined {
	const cols = table.grid.length
	const rows = table.rows.length
	const owner = new Uint8Array(rows * cols)
	const areas: CellArea[] = []

	for (let r = 0; r < rows; r++) {
		const cells = table.rows[r]?.cells ?? []

		if (cells.length !== cols) return undefined

		for (let c = 0; c < cols; c++) {
			const cell = cells[c] as TableCell

			if (owner[r * cols + c] === 1) continue

			// A covered cell no origin covers stands on its own (PowerPoint shows it as a cell).
			const area: CellArea = { r, c, rows: Math.max(1, cell.rowSpan ?? 1), cols: Math.max(1, cell.gridSpan ?? 1) }

			if (area.r + area.rows > rows || area.c + area.cols > cols) return undefined

			for (let y = area.r; y < area.r + area.rows; y++) {
				for (let x = area.c; x < area.c + area.cols; x++) {
					if (owner[y * cols + x] === 1) return undefined

					owner[y * cols + x] = 1
				}
			}

			areas.push(area)
		}
	}

	return areas
}

// The cells flagged from the areas: an origin carries its spans, a covered cell hMerge (not in the origin's column)
// and vMerge (not in its row), with no spans of its own.
export function reflag(table: TableModel, areas: readonly CellArea[]): void {
	for (const area of areas) {
		for (let y = area.r; y < area.r + area.rows; y++) {
			for (let x = area.c; x < area.c + area.cols; x++) {
				const row = table.rows[y]
				const cell = row?.cells[x]

				if (row === undefined || cell === undefined) continue

				const { gridSpan: _g, rowSpan: _r, hMerge: _h, vMerge: _v, ...rest } = cell
				const next: TableCell = rest

				if (y === area.r && x === area.c) {
					if (area.cols > 1) next.gridSpan = area.cols
					if (area.rows > 1) next.rowSpan = area.rows
				} else {
					if (x > area.c) next.hMerge = true
					if (y > area.r) next.vMerge = true
				}

				// A cell that keeps its flags keeps its object (and its source ref).
				const same =
					cell.gridSpan === next.gridSpan &&
					cell.rowSpan === next.rowSpan &&
					cell.hMerge === next.hMerge &&
					cell.vMerge === next.vMerge

				row.cells[x] = same ? cell : next
			}
		}
	}
}

export function areaAt(areas: readonly CellArea[], row: number, col: number): CellArea | undefined {
	return areas.find(area => row >= area.r && row < area.r + area.rows && col >= area.c && col < area.c + area.cols)
}

function sum(values: readonly number[]): number {
	let total = 0

	for (const value of values) total += value

	return total
}

// The frame's box follows the table's size.
function fitFrame(shape: ShapeNode, table: TableModel): void {
	if (shape.xfrm === undefined) return

	shape.xfrm = { ...shape.xfrm, cx: Math.round(sum(table.grid)), cy: Math.round(sum(table.rows.map(row => row.h))) }
}

// A new cell like `like` (its properties, an empty paragraph with its text's properties).
function cellLike(like: TableCell | undefined): TableCell {
	return {
		text: emptyBody(like?.text),
		...(like?.props === undefined ? {} : { props: cloneModel(like.props) })
	}
}

function checkSize(rows: number, cols: number): Refused | undefined {
	if (cols > BUDGETS.gridColumns) return refused("tooLarge", `${String(cols)} grid columns`)
	if (rows * cols > BUDGETS.cellsPerTable) return refused("tooLarge", `${String(rows * cols)} table cells`)

	return undefined
}

function checkCount(at: number, count: number, limit: number): Refused | undefined {
	if (!Number.isInteger(at) || !Number.isInteger(count) || count < 1 || at < 0 || at > limit)
		return refused("malformed", `${String(count)} at ${String(at)}`)

	return undefined
}

// --- Row and column insertion and deletion (one axis, written once for both) ---

interface Axis {
	readonly length: (table: TableModel) => number
	readonly start: (area: CellArea) => number
	readonly span: (area: CellArea) => number
	readonly set: (area: CellArea, start: number, span: number) => void
	readonly across: (area: CellArea) => readonly [number, number]
	readonly area: (start: number, from: number, extent: number) => CellArea
	insert(table: TableModel, at: number, count: number, reference: number): void
	remove(table: TableModel, at: number, count: number): void
	// The cell at (along, across).
	cell(table: TableModel, along: number, across: number): TableCell | undefined
	put(table: TableModel, along: number, across: number, cell: TableCell): void
}

const ROWS: Axis = {
	length: table => table.rows.length,
	start: area => area.r,
	span: area => area.rows,
	set: (area, start, span) => {
		area.r = start
		area.rows = span
	},
	across: area => [area.c, area.cols],
	area: (start, from, extent) => ({ r: start, c: from, rows: 1, cols: extent }),
	insert(table, at, count, reference) {
		const like = table.rows[reference]
		const rows = Array.from({ length: count }, () => ({ h: like?.h ?? 0, cells: table.grid.map((_, c) => cellLike(like?.cells[c])) }))

		table.rows.splice(at, 0, ...rows)
	},
	remove(table, at, count) {
		table.rows.splice(at, count)
	},
	cell: (table, along, across) => table.rows[along]?.cells[across],
	put(table, along, across, cell) {
		const row = table.rows[along]

		if (row !== undefined) row.cells[across] = cell
	}
}

const COLUMNS: Axis = {
	length: table => table.grid.length,
	start: area => area.c,
	span: area => area.cols,
	set: (area, start, span) => {
		area.c = start
		area.cols = span
	},
	across: area => [area.r, area.rows],
	area: (start, from, extent) => ({ r: from, c: start, rows: extent, cols: 1 }),
	insert(table, at, count, reference) {
		const width = table.grid[reference] ?? 0

		table.grid.splice(at, 0, ...Array.from({ length: count }, () => width))

		for (const row of table.rows) row.cells.splice(at, 0, ...Array.from({ length: count }, () => cellLike(row.cells[reference])))
	},
	remove(table, at, count) {
		table.grid.splice(at, count)

		for (const row of table.rows) row.cells.splice(at, count)
	},
	cell: (table, along, across) => table.rows[across]?.cells[along],
	put(table, along, across, cell) {
		const row = table.rows[across]

		if (row !== undefined) row.cells[along] = cell
	}
}

function insertLines(table: TableModel, areas: CellArea[], axis: Axis, at: number, count: number): CellArea[] {
	// The line the new ones are formatted like: the one before them, else the first.
	const reference = at > 0 ? at - 1 : 0
	const added: CellArea[] = []

	for (const area of areas) {
		const start = axis.start(area)
		const span = axis.span(area)

		if (start >= at) {
			axis.set(area, start + count, span)
		} else if (start + span > at) {
			// Inserted inside a merged area: the area grows over the new lines.
			axis.set(area, start, span + count)
		} else if (start + span > reference) {
			// A merge across the reference line is repeated on each new line.
			const [from, extent] = axis.across(area)

			if (extent > 1) for (let k = 0; k < count; k++) added.push(axis.area(at + k, from, extent))
		}
	}

	axis.insert(table, at, count, reference)

	return [...areas, ...added]
}

function deleteLines(table: TableModel, areas: CellArea[], axis: Axis, at: number, count: number): CellArea[] {
	const end = at + count
	const kept: CellArea[] = []

	for (const area of areas) {
		const start = axis.start(area)
		const stop = start + axis.span(area)
		const overlap = Math.max(0, Math.min(stop, end) - Math.max(start, at))
		const span = stop - start - overlap

		if (span <= 0) continue

		if (start >= end) {
			axis.set(area, start - count, span)
		} else if (start >= at) {
			// Its origin goes: the first line left of the area takes the origin's text and properties.
			const [from] = axis.across(area)
			const origin = axis.cell(table, start, from)
			const heir = axis.cell(table, end, from)

			if (origin !== undefined && heir !== undefined) {
				const { props: _props, ...rest } = heir

				axis.put(table, end, from, { ...rest, text: origin.text, ...(origin.props === undefined ? {} : { props: origin.props }) })
			}

			axis.set(area, at, span)
		} else {
			axis.set(area, start, span)
		}

		kept.push(area)
	}

	axis.remove(table, at, count)

	return kept
}

// --- The ops ---

// A copy of the table to work on (rows copied shallowly; changed cells become new objects).
function working(table: TableModel): TableModel {
	return {
		...table,
		grid: [...table.grid],
		rows: table.rows.map(row => ({ ...row, cells: [...row.cells] })),
		flags: { ...table.flags }
	}
}

function areasOrRefuse(table: TableModel): CellArea[] | Refused {
	const areas = areasOf(table)

	return areas === undefined ? refused("unsupported", "a table whose rows do not follow its grid") : areas
}

function lines(table: TableModel, op: Op<"insertRows" | "deleteRows" | "insertColumns" | "deleteColumns">): TableModel | Refused {
	const axis = op.kind === "insertRows" || op.kind === "deleteRows" ? ROWS : COLUMNS
	const length = axis.length(table)
	const inserting = op.kind === "insertRows" || op.kind === "insertColumns"
	const bad = checkCount(op.at, op.count, inserting ? length : length - 1)

	if (bad !== undefined) return bad
	if (!inserting && op.at + op.count > length) return refused("malformed", `${String(op.count)} at ${String(op.at)}`)
	if (!inserting && op.count >= length) return refused("unsupported", "a table keeps one row and one column")
	if (inserting && length === 0) return refused("unsupported", "an empty table")

	const size = inserting
		? axis === ROWS
			? checkSize(table.rows.length + op.count, table.grid.length)
			: checkSize(table.rows.length, table.grid.length + op.count)
		: undefined

	if (size !== undefined) return size

	const next = working(table)
	const areas = areasOrRefuse(next)

	if (isRefused(areas)) return areas

	reflag(next, inserting ? insertLines(next, areas, axis, op.at, op.count) : deleteLines(next, areas, axis, op.at, op.count))

	return next
}

function inRange(table: TableModel, range: CellRange): boolean {
	return (
		Number.isInteger(range.row) &&
		Number.isInteger(range.col) &&
		Number.isInteger(range.rows) &&
		Number.isInteger(range.cols) &&
		range.row >= 0 &&
		range.col >= 0 &&
		range.rows >= 1 &&
		range.cols >= 1 &&
		range.row + range.rows <= table.rows.length &&
		range.col + range.cols <= table.grid.length
	)
}

// The range grown until no merged area crosses its edge (PowerPoint merges whole merged cells).
export function coveringRange(areas: readonly CellArea[], range: CellRange): CellRange {
	let r0 = range.row
	let c0 = range.col
	let r1 = range.row + range.rows
	let c1 = range.col + range.cols
	let grown = true

	while (grown) {
		grown = false

		for (const area of areas) {
			const meets = area.r < r1 && area.r + area.rows > r0 && area.c < c1 && area.c + area.cols > c0

			if (!meets) continue

			if (area.r < r0 || area.c < c0 || area.r + area.rows > r1 || area.c + area.cols > c1) {
				r0 = Math.min(r0, area.r)
				c0 = Math.min(c0, area.c)
				r1 = Math.max(r1, area.r + area.rows)
				c1 = Math.max(c1, area.c + area.cols)
				grown = true
			}
		}
	}

	return { row: r0, col: c0, rows: r1 - r0, cols: c1 - c0 }
}

function merge(table: TableModel, op: Op<"merge">): TableModel | Refused {
	if (!inRange(table, op.range)) return refused("malformed", "a range outside the table")

	const next = working(table)
	const areas = areasOrRefuse(next)

	if (isRefused(areas)) return areas

	const range = coveringRange(areas, op.range)

	if (range.rows === 1 && range.cols === 1) return next

	const inside = (area: CellArea): boolean =>
		area.r >= range.row &&
		area.c >= range.col &&
		area.r + area.rows <= range.row + range.rows &&
		area.c + area.cols <= range.col + range.cols
	// The merged cell holds the paragraphs of every cell that had text, in reading order (as PowerPoint merges).
	const texts = areas
		.filter(inside)
		.map(area => next.rows[area.r]?.cells[area.c]?.text)
		.filter((text): text is TextBody => text !== undefined && cellHasText(text))
	const origin = next.rows[range.row]?.cells[range.col] as TableCell
	const text: TextBody =
		texts.length < 2 ? (texts[0] ?? origin.text) : { ...(texts[0] as TextBody), paragraphs: texts.flatMap(body => body.paragraphs) }

	for (const area of areas.filter(inside)) {
		const cell = next.rows[area.r]?.cells[area.c]
		const row = next.rows[area.r]

		if (cell === undefined || row === undefined || (area.r === range.row && area.c === range.col)) continue

		const { src: _src, ...rest } = cell

		row.cells[area.c] = { ...rest, text: emptyBody(cell.text) }
	}

	const row = next.rows[range.row]

	if (row !== undefined && text !== origin.text) row.cells[range.col] = { ...origin, text }

	reflag(next, [...areas.filter(area => !inside(area)), { r: range.row, c: range.col, rows: range.rows, cols: range.cols }])

	return next
}

// A merged cell splits back into its grid cells (its text stays in the first); a single cell splits into two
// columns, its column halved and the column's other cells spanning both halves (PowerPoint's 2 × 1 split).
function split(table: TableModel, op: Op<"split">): TableModel | Refused {
	if (!inRange(table, { row: op.row, col: op.col, rows: 1, cols: 1 })) return refused("malformed", "a cell outside the table")

	const next = working(table)
	const areas = areasOrRefuse(next)

	if (isRefused(areas)) return areas

	const area = areaAt(areas, op.row, op.col) as CellArea

	if (area.rows > 1 || area.cols > 1) {
		const singles: CellArea[] = []

		for (let y = area.r; y < area.r + area.rows; y++)
			for (let x = area.c; x < area.c + area.cols; x++) singles.push({ r: y, c: x, rows: 1, cols: 1 })

		reflag(next, [...areas.filter(other => other !== area), ...singles])

		return next
	}

	const size = checkSize(next.rows.length, next.grid.length + 1)

	if (size !== undefined) return size

	const col = area.c
	const width = next.grid[col] ?? 0
	const half = Math.round(width / 2)

	next.grid.splice(col + 1, 0, width - half)
	next.grid[col] = half

	for (const row of next.rows) row.cells.splice(col + 1, 0, cellLike(row.cells[col]))

	const out: CellArea[] = [{ r: area.r, c: col + 1, rows: 1, cols: 1 }]

	for (const other of areas) {
		if (other === area) out.push(other)
		else if (other.c > col) out.push({ ...other, c: other.c + 1 })
		else if (other.c + other.cols > col) out.push({ ...other, cols: other.cols + 1 })
		else out.push(other)
	}

	reflag(next, out)

	return next
}

// A cell body over the budgets or holding text XML cannot carry is refused before it enters the model.
export function checkCellBody(body: TextBody): Refused | undefined {
	let runs = 0

	for (const paragraph of body.paragraphs) {
		runs += paragraph.runs.length

		if (runs > BUDGETS.runsPerBody) return refused("tooLarge", `${String(runs)} runs in one body`)

		for (const run of paragraph.runs) {
			if (run.kind !== "br" && xmlSafeText(run.text) !== run.text) return refused("malformed", "text holds a character XML cannot")
		}
	}

	return undefined
}

// A body's source refs, live: a paragraph whose ref is of another epoch is written from the model; content kept as
// source of another epoch cannot be written and refuses.
function liveBody(body: TextBody, context: ApplyContext): TextBody | Refused {
	const paragraphs: Paragraph[] = []

	for (const paragraph of body.paragraphs) {
		for (const run of paragraph.runs) {
			if (run.kind === "opaque" && isRefused(context.sourceBytes(run.src)))
				return refused("stale", "content kept as source of another epoch")
		}

		if (paragraph.src !== undefined && isRefused(context.sourceBytes(paragraph.src))) {
			const { src: _stale, ...rest } = paragraph

			paragraphs.push(rest)
		} else {
			paragraphs.push(paragraph)
		}
	}

	return { ...body, paragraphs }
}

function originCell(table: TableModel, row: number, col: number): TableCell | Refused {
	const cell = table.rows[row]?.cells[col]

	if (cell === undefined) return refused("notFound", `cell ${String(row)}, ${String(col)}`)
	if (cell.hMerge === true || cell.vMerge === true) return refused("unsupported", "a cell another cell covers")

	return cell
}

function setCellText(table: TableModel, op: Op<"setCellText">, context: ApplyContext): TableModel | Refused {
	const cell = originCell(table, op.row, op.col)

	if (isRefused(cell)) return cell

	const checked = checkCellBody(op.body)

	if (checked !== undefined) return checked

	const body = liveBody(cloneModel(op.body), context)

	if (isRefused(body)) return body

	const next = working(table)
	const row = next.rows[op.row]

	if (row !== undefined) row.cells[op.col] = { ...cell, text: body.paragraphs.length === 0 ? emptyBody(cell.text) : body }

	return next
}

// Present keys replace (an undefined value removes the property); borders merge side by side.
function mergeProps(prior: TableCellProps | undefined, change: TableCellProps): TableCellProps | undefined {
	const out: Record<string, unknown> = { ...prior }

	for (const key of Object.keys(change) as (keyof TableCellProps)[]) {
		const value = change[key]

		if (key === "borders" && value !== undefined && typeof value === "object") {
			const borders: Record<string, unknown> = { ...prior?.borders }

			for (const [side, line] of Object.entries(value)) {
				if (line === undefined) delete borders[side]
				else borders[side] = cloneModel(line)
			}

			if (Object.keys(borders).length === 0) delete out["borders"]
			else out["borders"] = borders

			continue
		}

		if (value === undefined) delete out[key]
		else out[key] = cloneModel(value)
	}

	return Object.keys(out).length === 0 ? undefined : (out as TableCellProps)
}

function setCellProps(table: TableModel, op: Op<"setCellProps">): TableModel | Refused {
	if (!inRange(table, op.range)) return refused("malformed", "a range outside the table")

	const next = working(table)

	for (let r = op.range.row; r < op.range.row + op.range.rows; r++) {
		const row = next.rows[r]

		for (let c = op.range.col; c < op.range.col + op.range.cols; c++) {
			const cell = row?.cells[c]

			if (row === undefined || cell === undefined || cell.hMerge === true || cell.vMerge === true) continue

			const { props: _props, ...rest } = cell
			const props = mergeProps(cell.props, op.props)

			row.cells[c] = props === undefined ? rest : { ...rest, props }
		}
	}

	return next
}

function setStyle(table: TableModel, op: Op<"setStyle">): TableModel {
	const next = working(table)

	if (op.styleId === undefined) delete next.styleId
	else next.styleId = op.styleId

	for (const [flag, value] of Object.entries(op.flags ?? {})) {
		if (value !== undefined) next.flags[flag as keyof TableModel["flags"]] = value
	}

	return next
}

// 0..56 inches (ST_Coordinate32 keeps a table on any slide size).
function validLength(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= 51_206_400
}

function resize(table: TableModel, op: Op<"setColumnWidth" | "setRowHeight">): TableModel | Refused {
	const value = op.kind === "setColumnWidth" ? op.width : op.height
	const index = op.kind === "setColumnWidth" ? op.col : op.row
	const limit = op.kind === "setColumnWidth" ? table.grid.length : table.rows.length

	if (!validLength(value) || !Number.isInteger(index) || index < 0 || index >= limit)
		return refused("malformed", `${op.kind} ${String(index)}`)

	const next = working(table)

	if (op.kind === "setColumnWidth") {
		next.grid[index] = Math.round(value)
	} else {
		const row = next.rows[index]

		if (row !== undefined) next.rows[index] = { ...row, h: Math.round(value) }
	}

	return next
}

function nextTable(table: TableModel, op: TableOp, context: ApplyContext): TableModel | Refused {
	switch (op.kind) {
		case "insertRows":
		case "deleteRows":
		case "insertColumns":
		case "deleteColumns":
			return lines(table, op)
		case "merge":
			return merge(table, op)
		case "split":
			return split(table, op)
		case "setCellText":
			return setCellText(table, op, context)
		case "setCellProps":
			return setCellProps(table, op)
		case "setStyle":
			return setStyle(table, op)
		case "setColumnWidth":
		case "setRowHeight":
			return resize(table, op)
	}
}

// --- Inverses ---

function rawOf(shape: ShapeNode, context: ApplyContext): Uint8Array | Refused | undefined {
	if (shape.src === undefined) return undefined

	const bytes = context.sourceBytes(shape.src)

	return isRefused(bytes) ? bytes : bytes.slice()
}

// Whether the frame is exactly what its source bytes read as (no edit since: restoring them puts it back whole).
function asSource(at: Found, raw: Uint8Array, context: ApplyContext): boolean {
	const reader = "readShape" in context ? (context as SourceReading) : undefined
	const read = reader?.readShape(at.node, raw)

	if (read === undefined || isRefused(read)) return false

	return digestOf({ ...read, id: at.shape.id, sourceId: undefined }) === digestOf({ ...at.shape, sourceId: undefined })
}

// The ops that put the frame back as it is now.
function frameInverse(at: Found, context: ApplyContext): Inverse | Refused {
	const raw = rawOf(at.shape, context)

	if (isRefused(raw)) return raw

	const target = { slide: at.node.ref, id: at.shape.id }

	if (raw !== undefined && asSource(at, raw, context))
		return { ops: [{ family: "shape", kind: "restore", target, raw }], bytes: raw.length }

	const ops: DeckOp[] = [
		{ family: "shape", kind: "delete", slide: at.node.ref, shapes: [at.shape.id] },
		{
			family: "shape",
			kind: "insert",
			slide: at.node.ref,
			shape: cloneModel(at.shape),
			index: at.index,
			...(at.parent === 0 ? {} : { parent: at.parent }),
			...(raw === undefined ? {} : { raw })
		}
	]

	return { ops, bytes: raw?.length ?? 0 }
}

// The table put on its frame (a new frame object: the old table stays what an inverse cloned).
function putTable(at: Found, table: TableModel): void {
	at.shape.frame = { kind: "table", table }
	fitFrame(at.shape, table)
	at.node.revision++
}

function applyOne(deck: Deck, op: TableOp, context: ApplyContext): ApplyResult<TableOp> {
	const at = found(deck, op.target)

	if (isRefused(at)) return at

	const table = nextTable(at.table, op, context)

	if (isRefused(table)) return table

	const back = frameInverse(at, context)

	if (isRefused(back)) return back

	putTable(at, table)

	return { kind: "applied", inverse: back, op }
}

// --- Replace in cells (find and replace over a table's paragraphs) ---

// The table with `matcher`'s matches replaced in its cells (only `match` when given: flat paragraph index across the
// cells in row-major order, start, end), and the count; undefined when `match` no longer holds there.
export function replaceInTable(
	table: TableModel,
	matcher: Matcher,
	replacement: string,
	match?: readonly [number, number, number]
): { readonly table: TableModel; readonly count: number } | undefined {
	const next = working(table)
	let count = 0
	let base = 0

	for (const row of next.rows) {
		for (let c = 0; c < row.cells.length; c++) {
			const cell = row.cells[c] as TableCell
			const paragraphs = cell.text.paragraphs.length

			if (match === undefined) {
				const replaced = replaceInBody(cell.text, matcher, replacement)

				if (replaced !== undefined && replaced.count > 0) {
					row.cells[c] = { ...cell, text: replaced.body }
					count += replaced.count
				}
			} else if (match[0] >= base && match[0] < base + paragraphs) {
				const replaced = replaceInBody(cell.text, matcher, replacement, [match[0] - base, match[1], match[2]])

				if (replaced === undefined) return undefined

				row.cells[c] = { ...cell, text: replaced.body }

				return { table: next, count: 1 }
			}

			base += paragraphs
		}
	}

	return match === undefined ? { table: next, count } : undefined
}

// A text replace on a table frame: the table with its matches replaced, the inverse that puts the frame back, and a
// `put` that writes it (called once every target of the replace is known to apply); undefined when `match` no longer
// holds.
export function replaceInFrame(
	deck: Deck,
	target: ShapeRef,
	matcher: Matcher,
	replacement: string,
	match: readonly [number, number, number] | undefined,
	context: ApplyContext
): { readonly inverse: Inverse; readonly put: () => void; readonly count: number } | Refused | undefined {
	const at = found(deck, target)

	if (isRefused(at)) return at

	const replaced = replaceInTable(at.table, matcher, replacement, match)

	if (replaced === undefined) return undefined
	if (replaced.count === 0) return { inverse: { ops: [], bytes: 0 }, put: () => undefined, count: 0 }

	for (const row of replaced.table.rows) {
		for (const cell of row.cells) {
			const checked = checkCellBody(cell.text)

			if (checked !== undefined) return checked
		}
	}

	const back = frameInverse(at, context)

	if (isRefused(back)) return back

	return { inverse: back, put: () => putTable(at, replaced.table), count: replaced.count }
}

export const applyTable: ApplyFamily<TableOp> = {
	apply: (deck, op, context) => applyOne(deck, op, context),
	touches: (op): readonly Touch[] => [{ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "node" } }]
}
