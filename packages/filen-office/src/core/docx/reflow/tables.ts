import { Mark, type Node } from "prosemirror-model"
import { refItem, refPart } from "../layout/edits"
import { bottomEdge, cellFill, cellFormat, cellItems, endEdge, rowFormat, startEdge, tableRows, topEdge } from "../layout/table"
import type { DocxModel } from "../model/index"
import { Item, RevisionView } from "../model/kinds"
import type { StoryPart } from "../model/part"
import type { PropsStore, ResolvedBorder, ResolvedCellMargins, WidthProps } from "../props/index"
import type { CellFormat, PropertyResolver, TableFormat } from "../styles/index"
import { borderCss, shadingCss } from "./css"

// A table's look in the reflowed view as the pages resolve it (layout/table.ts): its style's and its own
// properties, each row's exceptions, each cell's conditional formatting and its own. Every edge is drawn once,
// by the cell the pages draw it with (the top of the first row, every cell's bottom, every cell's start edge
// and the last cell's end edge), where two borders meet the one the pages keep (`heavier`).

export interface TableLook {
	// The table's declarations (direction, shading behind its cells).
	readonly table: string
	// Per row, per cell (all of them, as the editing document holds them), the cell's declarations: as the
	// revision view shows the table (banding, first and last row and column count only the rows and cells it
	// shows, as on the pages; a row it hides is not drawn).
	readonly cells: readonly (readonly string[])[]
	// The item of each cell, per row, in the table's part (a table inside a cell is found among its children).
	readonly items: readonly (readonly number[])[]
	readonly part: StoryPart
	// Per row, the part its cells are items of when edits gave the table rows of their own (LayoutEdits.rows).
	readonly parts?: readonly StoryPart[] | undefined
}

interface Slot {
	readonly item: number
	readonly format: CellFormat
	// The grid column it starts at.
	readonly column: number
	readonly continued: boolean
}

// Per part, by item and revision view (item * VIEWS + view); for rows edits gave a table, per their list.
const looks = new WeakMap<StoryPart, Map<number, TableLook>>()
const listLooks = new WeakMap<Float64Array, Map<number, TableLook>>()
const VIEWS = 3

function px(twips: number): string {
	return `${String(Math.round((twips / 15) * 100) / 100)}px`
}

function margin(width: WidthProps): string {
	return width.type === "dxa" || width.type === "nil" ? px(width.value) : "0px"
}

function padding(margins: ResolvedCellMargins): string {
	return `padding: ${margin(margins.top)} ${margin(margins.end)} ${margin(margins.bottom)} ${margin(margins.start)}`
}

// The tables directly inside cell `cell` of `part`, in order.
export function cellTables(part: StoryPart, cell: number): number[] {
	const out: number[] = []

	for (let item = cell + 1; item < part.end(cell);) {
		const kind = part.kinds[item]

		if (kind === Item.Table) {
			out.push(item)
			item = part.end(item)
		} else if (kind === Item.Sdt || kind === Item.CustomXml) {
			item++
		} else {
			item = part.end(item)
		}
	}

	return out
}

// A cell's text direction (ST_TextDirection) as a CSS writing mode, "" for horizontal text: top to bottom with every
// glyph turned (tbRl) or East Asian characters upright (tbRlV, and tbLrV with lines left to right); bottom to top
// (btLr) as sideways-lr where the browser has it, top to bottom where it does not.
export function writingMode(value: string | undefined): string {
	switch (value) {
		case "tbRl":
		case "rl":
			return "writing-mode: vertical-rl; text-orientation: sideways"
		case "tbRlV":
		case "rlV":
			return "writing-mode: vertical-rl"
		case "tbLrV":
		case "lrV":
			return "writing-mode: vertical-lr"
		case "btLr":
		case "lr":
			return "writing-mode: vertical-rl; text-orientation: sideways; writing-mode: sideways-lr"
		default:
			return ""
	}
}

function edge(side: string, border: ResolvedBorder | undefined): string {
	return `border-${side}: ${border === undefined || border.style === "nil" ? "none" : (borderCss(border) ?? "none")}`
}

// The look of the table at `item` of `part` (`columns` grid columns) in revision view `view`, kept per part,
// item and view. `edited`: the rows edits gave it (LayoutEdits.rows: refs, some of overlay parts), with `partOf`
// for their parts.
export function tableLook(
	part: StoryPart,
	item: number,
	columns: number,
	resolver: PropertyResolver,
	store: PropsStore,
	view: RevisionView = RevisionView.Markup,
	edited?: { readonly rows: Float64Array; readonly partOf: (index: number) => StoryPart | undefined }
): TableLook {
	const key = item * VIEWS + view
	let byItem = edited === undefined ? looks.get(part) : listLooks.get(edited.rows)
	const cached = byItem?.get(key)

	if (cached !== undefined) return cached

	const document = part.document
	const tblPr = store.tableLook(document, part.tables.tblPr[part.aux[item] ?? -1] ?? -1)
	const direct = resolver.table(tblPr)
	const rows: number[] = []
	const rowParts: StoryPart[] = []

	if (edited === undefined) tableRows(part, item, RevisionView.Markup, rows)
	else {
		for (const value of edited.rows) {
			const from = Number.isNaN(value) ? undefined : edited.partOf(refPart(value))

			if (from === undefined) continue

			rows.push(refItem(value))
			rowParts.push(from)
		}
	}

	const partAt = (index: number): StoryPart => rowParts[index] ?? part
	const hidden = (index: number, at: number): boolean => view !== RevisionView.Markup && partAt(index).hidden(at, view)
	const rowCount = view === RevisionView.Markup ? rows.length : rows.filter((row, index) => !hidden(index, row)).length
	// The index among the rows shown of each row (a hidden row takes the next shown row's).
	let shownIndex = 0
	const infos: { table: TableFormat; slots: Slot[]; shown: boolean }[] = rows.map((row, index) => {
		const from = partAt(index)
		const shown = !hidden(index, row)
		const position = { rowIndex: Math.min(shownIndex, Math.max(0, rowCount - 1)), rowCount: Math.max(1, rowCount) }
		const { table, props } = rowFormat(resolver, store, part, item, row, direct, position, from)
		let column = props.gridBefore

		if (shown) shownIndex++

		return {
			table,
			shown,
			slots: cellItems(from, row, RevisionView.Markup).map(cell => {
				const own = store.cellLook(from.document, from.cells.tcPr[from.aux[cell] ?? -1] ?? -1)
				const { format, span } = cellFormat(resolver, table, own, position, column, columns)
				const slot = { item: cell, format, column, continued: format.props.vMerge === "continue" }

				if (!hidden(index, cell)) column += span

				return slot
			})
		}
	})
	// The rows shown after each row, and the first and last shown.
	const nextShown: (number | undefined)[] = []
	let following: number | undefined

	for (let index = infos.length - 1; index >= 0; index--) {
		nextShown[index] = following

		if (infos[index]?.shown === true) following = index
	}

	const firstShown = following
	const cells = infos.map((info, index) => {
		const tableBorders = info.table.props.borders
		const tableShading = info.table.props.shading
		const after = nextShown[index]
		const last = after === undefined
		const next = after === undefined ? undefined : infos[after]

		return info.slots.map((slot, k) => {
			const props = slot.format.props
			const borders = props.borders
			const out: string[] = [
				padding(props.margins),
				`vertical-align: ${props.vAlign === "center" ? "middle" : props.vAlign === "bottom" ? "bottom" : "top"}`
			]
			const mode = writingMode(props.textDirection)

			if (mode !== "") out.push(mode)
			const below = next?.slots.find(candidate => candidate.column === slot.column)

			out.push(
				edge(
					"top",
					(index === firstShown || firstShown === undefined) && !slot.continued ? topEdge(borders, tableBorders, true) : undefined
				)
			)
			out.push(
				edge("bottom", below?.continued === true ? undefined : bottomEdge(borders, tableBorders, last, below?.format.props.borders))
			)
			out.push(edge("inline-start", startEdge(borders, tableBorders, info.slots[k - 1]?.format.props.borders, k === 0)))
			out.push(edge("inline-end", k === info.slots.length - 1 ? endEdge(borders, tableBorders) : undefined))

			const fill = shadingCss(cellFill(props.shading, tableShading))

			if (fill !== undefined) out.push(`background-color: ${fill}`)

			return out.join("; ")
		})
	})
	const look: TableLook = {
		table: direct.props.bidiVisual ? "direction: rtl" : "",
		cells,
		items: infos.map(info => info.slots.map(slot => slot.item)),
		part,
		parts: edited === undefined ? undefined : rowParts
	}

	if (byItem === undefined) {
		byItem = new Map()

		if (edited === undefined) looks.set(part, byItem)
		else listLooks.set(edited.rows, byItem)
	}

	byItem.set(key, look)

	return look
}

// The part and item the layout lays a top-level table out from (a ref of the editor's block list), with the
// rows edits gave it (`rows`: LayoutEdits.rows).
export function laidTable(model: DocxModel, laid: number | undefined, rows?: ReadonlyMap<number, Float64Array>): LaidTable | undefined {
	if (laid === undefined || laid < 0) return undefined

	const part = model.parts[refPart(laid)]
	const item = refItem(laid)
	const edited = rows?.get(laid)

	if (part === undefined || part.kinds[item] !== Item.Table) return undefined

	return edited === undefined ? { part, item } : { part, item, edited: { rows: edited, partOf: index => model.parts[index] } }
}

// A table as tableLook reads it.
export interface LaidTable {
	readonly part: StoryPart
	readonly item: number
	readonly edited?: { readonly rows: Float64Array; readonly partOf: (index: number) => StoryPart | undefined } | undefined
}

// The source table a table node stands for in `part` (a story the editor keeps no block list for).
export function sourceTable(part: StoryPart, table: Node): { readonly part: StoryPart; readonly item: number } | undefined {
	const src = table.attrs["src"]

	return typeof src === "number" && src >= 0 && part.kinds[src] === Item.Table ? { part, item: src } : undefined
}

function sameProps(a: Node, b: Node): boolean {
	if (a.type !== b.type || !Mark.sameSet(a.marks, b.marks)) return false
	if (a.attrs === b.attrs) return true

	for (const key in a.attrs) if (a.attrs[key] !== b.attrs[key]) return false

	return true
}

// The tables in a cell (inside content controls too), in order.
function innerTables(cell: Node, out: Node[] = []): Node[] {
	cell.forEach(child => {
		if (child.type.name === "table") out.push(child)
		else if (!child.isTextblock && !child.isLeaf) innerTables(child, out)
	})

	return out
}

// Whether tables `a` and `b` look the same here (tableLook): the same rows and cells with the same properties
// (attributes and node marks), the tables in their cells too, whatever their text. Rows left as they were
// are the same nodes, so an edit inside one row compares that row only.
export function sameTableLook(a: Node, b: Node): boolean {
	if (a === b) return true
	if (!sameProps(a, b) || a.childCount !== b.childCount) return false

	for (let r = 0; r < a.childCount; r++) {
		const x = a.child(r)
		const y = b.child(r)

		if (x === y) continue
		if (!sameProps(x, y) || x.childCount !== y.childCount) return false

		for (let c = 0; c < x.childCount; c++) {
			const p = x.child(c)
			const q = y.child(c)

			if (p === q) continue
			if (!sameProps(p, q)) return false

			const inner = innerTables(p)
			const other = innerTables(q)

			if (inner.length !== other.length || inner.some((table, k) => !sameTableLook(table, other[k] as Node))) return false
		}
	}

	return true
}
