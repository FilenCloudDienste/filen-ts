import { Relationships } from "../../../opc/index"
import { DeckTally, DEFAULT_PRESENTATION_BUDGETS } from "../../../presentation/budget"
import {
	refused,
	type LineProps,
	type Refused,
	type ShapeNode,
	type TableCell,
	type TableCellProps,
	type TableModel,
	type TableRow
} from "../../../presentation/model"
import { builtinTableStyleXml } from "../../../presentation/render/tableStyles"
import { escapeAttribute, escapeText } from "../../../xml/index"
import { readTable, type ReadContext } from "../../read/drawing"
import { G, type PartReader } from "../../read/xml"
import type { EmitPiece, EmitResult, PptxEmitFamily } from "../types"
import {
	Pieces,
	attr,
	endTag,
	fillMarkup,
	lineMarkup,
	readerOf,
	sameModel,
	shapeElement,
	sourceNode,
	splicing,
	startTag,
	unmodeledAttributes,
	xfrmXml,
	type EmitContext
} from "./shape"
import { textBodyXml } from "./text"

// The table family's PresentationML: p:graphicFrame holding a:tbl (ECMA-376 Part 1 §19.3.1.21, §21.1.3). The frame's
// non-visual properties and box are the shape family's; the table is written from the model, every part of it that
// reads back as the model holds it (the table, its properties, its grid, a row, a cell, a cell's properties) kept as
// its source span, and what the model does not hold (fills and effects of a:tblPr, a:cell3D, extension lists,
// unknown attributes) kept from the source element in its place. Gate 1 compares against the source read again.

export const TABLE_URI = "http://schemas.openxmlformats.org/drawingml/2006/table"

const CELL_BORDERS = [
	["l", "lnL"],
	["r", "lnR"],
	["t", "lnT"],
	["b", "lnB"],
	["tl2br", "lnTlToBr"],
	["bl2tr", "lnBlToTr"]
] as const

const FLAGS = ["firstRow", "firstCol", "lastRow", "lastCol", "bandRow", "bandCol"] as const

const FILL_LOCALS: ReadonlySet<string> = new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"])

type Take = (result: EmitResult | readonly EmitPiece[] | Refused | string) => readonly EmitPiece[]

// What the table is as its source reads (the pristine read in splice mode; read again in model mode), cells by node.
interface Basis {
	readonly table: TableModel
	readonly cells: ReadonlyMap<number, TableCell>
}

function basisOf(context: EmitContext, shape: ShapeNode, r: PartReader, tbl: number): Basis | undefined {
	let table: TableModel | undefined

	if (splicing(context)) {
		const frame = context.pristine?.shapes.get(sourceNode(context, shape.src))?.frame

		table = frame?.kind === "table" ? frame.table : undefined
	} else {
		const read: ReadContext = {
			reader: r,
			part: shape.src?.part ?? context.parts.owner,
			epoch: shape.src?.epoch ?? 0,
			relationships: context.relationships ?? new Relationships([]),
			tally: new DeckTally(DEFAULT_PRESENTATION_BUDGETS),
			action: () => undefined
		}

		try {
			table = readTable(read, tbl)
		} catch {
			table = undefined
		}
	}

	if (table === undefined) return undefined

	const cells = new Map<number, TableCell>()

	for (const row of table.rows) for (const cell of row.cells) if (cell.src?.format === "pptx") cells.set(cell.src.node, cell)

	return { table, cells }
}

// a:tcPr from the model: margins, anchor and vert, borders and fill; the source's other attributes (anchorCtr,
// horzOverflow), a:cell3D, a:headers and extLst kept.
function cellPropsXml(context: EmitContext, props: TableCellProps | undefined, source: number, take: Take): readonly EmitPiece[] {
	const r = readerOf(context)
	const out = new Pieces()
	const modeled = new Set(["marL", "marR", "marT", "marB", "anchor", "vert"])

	if (props === undefined && source < 0) return []

	out.text(
		`<a:tcPr${attr("marL", props?.marL)}${attr("marR", props?.marR)}${attr("marT", props?.marT)}${attr("marB", props?.marB)}` +
			`${attr("vert", props?.vert)}${attr("anchor", props?.anchor)}${unmodeledAttributes(context, source, modeled)}>`
	)

	for (const [side, local] of CELL_BORDERS) {
		const line: LineProps | "none" | undefined = props?.borders?.[side]

		if (line !== undefined) out.append(take(lineMarkup(context, line, `a:${local}`)))
	}

	const kept = (local: string): void => {
		const node = r === undefined || source < 0 ? -1 : r.child(source, G.A, local)

		if (node >= 0) out.hole(node)
	}

	kept("cell3D")

	if (props?.fill !== undefined) out.append(take(fillMarkup(context, props.fill)))

	kept("headers")
	kept("extLst")

	return out.text("</a:tcPr>").out
}

function cellXml(
	context: EmitContext,
	shape: ShapeNode,
	cell: TableCell,
	basis: Basis | undefined,
	r: PartReader | undefined,
	take: Take
): readonly EmitPiece[] {
	const node = cell.src === undefined ? -1 : sourceNode(context, cell.src)
	const before = node >= 0 ? basis?.cells.get(node) : undefined

	if (node >= 0 && before !== undefined && sameModel(cell, before)) return [{ hole: node }]

	const child = (local: string): number => (r === undefined || node < 0 ? -1 : r.child(node, G.A, local))
	const out = new Pieces().text(
		`<a:tc${attr("gridSpan", cell.gridSpan)}${attr("rowSpan", cell.rowSpan)}${cell.hMerge === true ? ' hMerge="1"' : ""}` +
			`${cell.vMerge === true ? ' vMerge="1"' : ""}${unmodeledAttributes(context, node, new Set(["gridSpan", "rowSpan", "hMerge", "vMerge"]))}>`
	)
	const txBody = child("txBody")

	if (txBody >= 0 && before !== undefined && sameModel(cell.text, before.text)) out.hole(txBody)
	else out.append(take(textBodyXml({ ...context, mode: "model" }, shape, cell.text, txBody, "a:txBody")))

	const tcPr = child("tcPr")

	if (tcPr >= 0 && before !== undefined && sameModel(cell.props, before.props)) out.hole(tcPr)
	else out.append(cellPropsXml(context, cell.props, tcPr, take))

	const extLst = child("extLst")

	if (extLst >= 0) out.hole(extLst)

	return out.text("</a:tc>").out
}

// The source a:tr of a row: the parent of its cells' source a:tc (all of one row), else -1.
function sourceRow(context: EmitContext, r: PartReader | undefined, row: TableRow): number {
	if (r === undefined) return -1

	let tr = -1

	for (const cell of row.cells) {
		const node = cell.src === undefined ? -1 : sourceNode(context, cell.src)

		if (node < 0) continue

		const parent = r.document.parent(node)

		if (tr >= 0 && parent !== tr) return -1

		tr = parent
	}

	return tr
}

function rowsXml(
	context: EmitContext,
	shape: ShapeNode,
	table: TableModel,
	basis: Basis | undefined,
	r: PartReader | undefined,
	take: Take
): readonly EmitPiece[] {
	const out = new Pieces()
	const used = new Set<number>()

	for (const row of table.rows) {
		let tr = sourceRow(context, r, row)

		// A source row is written for one model row only (a row copied by an insert names none).
		if (tr >= 0 && used.has(tr)) tr = -1
		if (tr >= 0) used.add(tr)

		const cells = row.cells.map(cell => cellXml(context, shape, cell, basis, r, take))
		const kept = tr >= 0 && r !== undefined && (r.emu(tr, "h") ?? 0) === row.h && r.children(tr, G.A, "tc").length === row.cells.length

		if (
			kept &&
			cells.every(
				(pieces, index) =>
					pieces.length === 1 && (pieces[0] as { hole?: number }).hole === sourceNode(context, row.cells[index]?.src)
			)
		) {
			out.hole(tr)

			continue
		}

		out.text(`<a:tr${attr("h", row.h)}${unmodeledAttributes(context, tr, new Set(["h"]))}>`)

		for (const pieces of cells) out.append(pieces)

		const extLst = tr >= 0 && r !== undefined ? r.child(tr, G.A, "extLst") : -1

		if (extLst >= 0) out.hole(extLst)

		out.text("</a:tr>")
	}

	return out.out
}

// a:tblPr: the flags and style id from the model, its fill, effects and extLst kept.
function tablePropsXml(context: EmitContext, table: TableModel, r: PartReader | undefined, source: number): readonly EmitPiece[] {
	const out = new Pieces().text(
		`<a:tblPr${FLAGS.map(flag => (table.flags[flag] ? ` ${flag}="1"` : "")).join("")}` +
			`${unmodeledAttributes(context, source, new Set(FLAGS))}>`
	)

	if (r !== undefined && source >= 0) {
		for (let child = r.first(source); child >= 0; child = r.next(child)) {
			const local = r.local(child)

			if (r.group(child) === G.A && (FILL_LOCALS.has(local) || local === "effectLst" || local === "effectDag")) out.hole(child)
		}
	}

	if (table.styleId !== undefined) out.text(`<a:tableStyleId>${escapeText(table.styleId)}</a:tableStyleId>`)

	const extLst = r === undefined || source < 0 ? -1 : r.child(source, G.A, "extLst")

	if (extLst >= 0) out.hole(extLst)

	return out.text("</a:tblPr>").out
}

function gridXml(table: TableModel, basis: Basis | undefined, r: PartReader | undefined, source: number): readonly EmitPiece[] {
	if (source >= 0 && basis !== undefined && sameModel(table.grid, basis.table.grid)) return [{ hole: source }]

	const columns = r === undefined || source < 0 ? [] : r.children(source, G.A, "gridCol")
	// Column ids (a16:colId in extLst) stay only while the columns are the source's, one for one.
	const sameColumns = columns.length === table.grid.length
	const out = new Pieces().text("<a:tblGrid>")

	table.grid.forEach((width, index) => {
		const extLst = sameColumns && r !== undefined ? r.child(columns[index] ?? -1, G.A, "extLst") : -1

		if (extLst >= 0)
			out.text(`<a:gridCol${attr("w", width)}>`)
				.hole(extLst)
				.text("</a:gridCol>")
		else out.text(`<a:gridCol${attr("w", width)}/>`)
	})

	return out.text("</a:tblGrid>").out
}

// a:tbl of the model, its source a:tbl `tbl` (or -1).
export function tableXml(context: EmitContext, shape: ShapeNode, table: TableModel, tbl: number, take: Take): readonly EmitPiece[] {
	const r = readerOf(context)
	const basis = r === undefined || tbl < 0 ? undefined : basisOf(context, shape, r, tbl)

	if (tbl >= 0 && basis !== undefined && sameModel(table, basis.table)) return [{ hole: tbl }]

	const tblPr = r === undefined || tbl < 0 ? -1 : r.child(tbl, G.A, "tblPr")
	const grid = r === undefined || tbl < 0 ? -1 : r.child(tbl, G.A, "tblGrid")
	const out = new Pieces().append(tbl >= 0 ? [startTag(context, tbl)] : ["<a:tbl>"])
	const sameProps = basis !== undefined && sameModel(table.flags, basis.table.flags) && table.styleId === basis.table.styleId

	if (tblPr >= 0 && sameProps) out.hole(tblPr)
	else out.append(tablePropsXml(context, table, r, tblPr))

	out.append(gridXml(table, basis, r, grid)).append(rowsXml(context, shape, table, basis, r, take))

	const extLst = r === undefined || tbl < 0 ? -1 : r.child(tbl, G.A, "extLst")

	if (extLst >= 0) out.hole(extLst)

	return out.text(tbl >= 0 ? endTag(context, tbl) : "</a:tbl>").out
}

// p:cNvPr of a frame the model made.
function newFrameNv(shape: ShapeNode): string {
	const alt = shape.alt

	return (
		`<p:nvGraphicFramePr><p:cNvPr${attr("id", shape.id)}${attr("name", shape.name)}${attr("descr", alt?.descr)}` +
		`${shape.hidden ? ' hidden="1"' : ""}${attr("title", alt?.title)}/>` +
		'<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
	)
}

function frameElement(context: EmitContext, shape: ShapeNode, table: TableModel): EmitResult {
	let failure: Refused | undefined
	const take: Take = result => {
		if (typeof result === "string") return [result]
		if (Array.isArray(result)) return result as readonly EmitPiece[]

		const value = result as EmitResult

		if (value.kind === "markup") return value.pieces
		if (value.kind === "refused") failure ??= value

		return []
	}
	const r = readerOf(context)
	const source = sourceNode(context, shape.src)
	const graphic = r === undefined || source < 0 ? -1 : r.child(source, G.A, "graphic")
	const data = graphic < 0 || r === undefined ? -1 : r.child(graphic, G.A, "graphicData")
	const tbl = data < 0 || r === undefined ? -1 : r.child(data, G.A, "tbl")

	if (source < 0 || graphic < 0 || data < 0) {
		if (shape.xfrm === undefined) return refused("unsupported", "A new table frame without a box")

		const pieces = new Pieces()
			.text(`<p:graphicFrame>${newFrameNv(shape)}${xfrmXml("p:xfrm", shape.xfrm, false)}`)
			.text(`<a:graphic><a:graphicData uri="${escapeAttribute(TABLE_URI)}">`)
			.append(tableXml(context, shape, table, -1, take))
			.text("</a:graphicData></a:graphic></p:graphicFrame>")

		return failure ?? pieces.markup()
	}

	// The frame as the shape family writes it (non-visual properties, box), a:graphic as a hole; that hole becomes
	// the table's markup.
	const { lock: _lock, ...unlocked } = shape
	const frame = shapeElement(context, unlocked)

	if (frame.kind !== "markup") return frame

	const inner = new Pieces().append([startTag(context, graphic), startTag(context, data)])

	for (let child = r?.document.firstChild(data) ?? -1; child >= 0 && r !== undefined; child = r.document.nextSibling(child)) {
		if (child === tbl) inner.append(tableXml(context, shape, table, tbl, take))
		else inner.hole(child)
	}

	if (tbl < 0) inner.append(tableXml(context, shape, table, -1, take))

	inner.text(endTag(context, data)).text(endTag(context, graphic))

	const pieces = new Pieces()
	let replaced = false

	for (const piece of frame.pieces) {
		if (typeof piece === "object" && !(piece instanceof Uint8Array) && piece.hole === graphic) {
			pieces.append(inner.out)
			replaced = true
		} else {
			pieces.append([piece])
		}
	}

	if (!replaced) return refused("failed", "The table frame's a:graphic was not where the shape family wrote it")

	return failure ?? pieces.markup()
}

export const emitPptxTable: PptxEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		if (shape === undefined) return refused("failed", "A table emit without a shape")
		if (shape.frame?.kind !== "table") return refused("unsupported", "a table emit for a shape that is not a table")

		return frameElement(context, shape, shape.frame.table)
	}
}

// PowerPoint's default style for an inserted table (Medium Style 2, Accent 1): the tableStyles part's `def`.
const DEFAULT_TABLE_STYLE = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"
const A_MAIN = "http://schemas.openxmlformats.org/drawingml/2006/main"

// A tableStyles part (§19.3.3.1, a:tblStyleLst) for a deck that has none, holding the built-in styles `ids` names
// (PowerPoint's default as `def`); undefined when none of them is built in.
export function builtinTableStylesPart(ids: Iterable<string>): string | undefined {
	const definitions = [...new Set(ids)].map(id => builtinTableStyleXml(id)).filter(xml => xml !== undefined)

	if (definitions.length === 0) return undefined

	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<a:tblStyleLst xmlns:a="${A_MAIN}" def="${DEFAULT_TABLE_STYLE}">${definitions.join("")}</a:tblStyleLst>`
}

// The built-in styles the tables of these shapes name (groups entered); `only`: just the shapes with these ids.
export function builtinTableStyleIds(
	shapes: readonly ShapeNode[],
	out = new Set<string>(),
	only?: { has(id: number): boolean }
): Set<string> {
	for (const shape of shapes) {
		if (shape.children !== undefined) builtinTableStyleIds(shape.children, out, only)
		if (only !== undefined && !only.has(shape.id)) continue

		const id = shape.frame?.kind === "table" ? shape.frame.table.styleId : undefined

		if (id !== undefined && builtinTableStyleXml(id) !== undefined) out.add(id)
	}

	return out
}
