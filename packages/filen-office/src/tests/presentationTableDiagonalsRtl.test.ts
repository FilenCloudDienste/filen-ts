import { describe, expect, it } from "vitest"
import { drawingTheme } from "../core/drawingml/color"
import { DrawingList } from "../core/drawingml/displayList"
import { D, drawingReader } from "../core/drawingml/reader"
import { emitPptx } from "../core/pptx/write/emit"
import { cellAt, columnsBox } from "../core/presentation/edit/commands/table"
import type { ShapeNode, TableCell, TableModel } from "../core/presentation/model"
import { renderTable } from "../core/presentation/render/table"
import { NS, THEME, THEME_PART, body, renderServices } from "./fixtures/presentation/renderDeck"
import { buildPptx, body as slideBody, para, sp } from "./pptxFixtures"
import { tableFrame } from "./presentationObjectsFixtures"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { partsOf, saveEdits, text } from "./pptxWriteFixtures"

// Diagonal cell lines (a:lnTlToBr / a:lnBlToTr, §21.1.3.17; a:tl2br / a:tr2bl in a style's a:tcBdr) and right-to-left
// tables (a:tblPr@rtl, §21.1.3.15): the first grid column on the right, hit tests and the selection mirrored with it.

const EMU = 9525
const SLIDE_PART = "/ppt/slides/slide1.xml"
const STYLES_PART = "/ppt/tableStyles.xml"
const LINE = { w: 12700, fill: { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } } } as const
const NO_FLAGS = { firstRow: false, lastRow: false, firstCol: false, lastCol: false, bandRow: false, bandCol: false }

const DIAGONAL_STYLE = `<a:tblStyleLst ${NS} def="{S}"><a:tblStyle styleId="{S}" styleName="T"><a:wholeTbl><a:tcStyle><a:tcBdr>
	<a:tl2br><a:ln w="12700"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln></a:tl2br>
	<a:tr2bl><a:ln w="12700"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln></a:tr2bl>
</a:tcBdr></a:tcStyle></a:wholeTbl></a:tblStyle></a:tblStyleLst>`

function render(table: TableModel, parts: Record<string, string> = {}, part?: string) {
	const fixture = renderServices({ parts: { [THEME_PART]: THEME, ...parts } }, { textHeight: 0 })
	const styles = fixture.services.xml(STYLES_PART)

	return renderTable({
		table,
		context: { list: new DrawingList(), theme: drawingTheme(undefined, () => undefined), images: () => undefined, effects: false },
		services: fixture.services,
		part,
		tableStyles: styles === undefined ? undefined : { document: styles, part: STYLES_PART },
		textHeight: () => 0
	})
}

// Every line the table drew (no fills here): x1, y1, x2, y2 rounded.
function segments(list: DrawingList): number[][] {
	const out: number[][] = []

	for (let k = 0; k + 3 < list.coordCount; k += 4) out.push([0, 1, 2, 3].map(offset => Math.round(list.coords[k + offset] ?? Number.NaN)))

	return out
}

function tableOf(rows: TableCell[][], grid: number[], flags: TableModel["flags"] = NO_FLAGS, styleId?: string): TableModel {
	return {
		grid: grid.map(px => px * EMU),
		rows: rows.map(cells => ({ h: 10 * EMU, cells })),
		flags,
		...(styleId === undefined ? {} : { styleId })
	}
}

describe("table cell diagonals", () => {
	it("draws typed diagonals across a merged cell's whole box", () => {
		const table = tableOf(
			[
				[
					{ text: body(""), gridSpan: 2, props: { borders: { tl2br: LINE, bl2tr: LINE } } },
					{ text: body(""), hMerge: true }
				]
			],
			[10, 10]
		)
		const rendered = render(table)

		expect(segments(rendered.list)).toEqual([
			[0, 0, 20, 10],
			[0, 10, 20, 0]
		])
	})

	it("draws a cell's a:lnTlToBr and a:lnBlToTr from its a:tcPr, a none line drawing nothing", () => {
		const slide =
			'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:tbl><a:tr><a:tc><a:tcPr>' +
			'<a:lnTlToBr w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnTlToBr><a:lnBlToTr><a:noFill/></a:lnBlToTr>' +
			"</a:tcPr></a:tc></a:tr></a:tbl></p:sld>"
		const fixture = renderServices({ parts: { [SLIDE_PART]: slide } })
		const document = fixture.services.xml(SLIDE_PART)

		if (document === undefined) throw new Error("no slide")

		const reader = drawingReader(document)
		const tc = reader.child(reader.child(reader.child(document.documentElement(), D.A, "tbl"), D.A, "tr"), D.A, "tc")
		const table = tableOf([[{ text: body(""), src: { format: "pptx", part: SLIDE_PART, node: tc, epoch: 0 } }]], [20])

		expect(segments(render(table, { [SLIDE_PART]: slide }, SLIDE_PART).list)).toEqual([[0, 0, 20, 10]])
	})

	it("draws the style's a:tl2br and a:tr2bl, the cell's own line overriding the style's", () => {
		const table = tableOf([[{ text: body("") }, { text: body(""), props: { borders: { bl2tr: "none" } } }]], [10, 10], NO_FLAGS, "{S}")
		const rendered = render(table, { [STYLES_PART]: DIAGONAL_STYLE })

		expect(segments(rendered.list)).toEqual([
			[0, 0, 10, 10],
			[0, 10, 10, 0],
			[10, 0, 20, 10]
		])
	})
})

describe("right-to-left tables", () => {
	const RTL = { ...NO_FLAGS, rtl: true as const }

	it("lays the first grid column out on the right, its start line on its right edge", () => {
		const table = tableOf([[{ text: body(""), props: { borders: { l: LINE } } }, { text: body("") }]], [10, 30], RTL)
		const rendered = render(table)

		expect(rendered.cells.map(cell => [cell.column, cell.x, cell.width])).toEqual([
			[0, 30, 10],
			[1, 0, 30]
		])
		expect(segments(rendered.list)).toEqual([[40, 0, 40, 10]])
		// Column edges stay distances from the table's start.
		expect(rendered.columnEdges).toEqual([0, 10, 40])
	})

	it("keeps a left-to-right table as laid out", () => {
		const rendered = render(tableOf([[{ text: body(""), props: { borders: { l: LINE } } }, { text: body("") }]], [10, 30]))

		expect(rendered.cells.map(cell => [cell.column, cell.x])).toEqual([
			[0, 0],
			[1, 10]
		])
		expect(segments(rendered.list)).toEqual([[0, 0, 0, 10]])
	})

	it("hit-tests and boxes columns mirrored", () => {
		const shape = { columnEdges: [0, 10, 40], rowEdges: [0, 10], flags: RTL }
		const ltr = { columnEdges: shape.columnEdges, rowEdges: shape.rowEdges, flags: NO_FLAGS }
		const areas = [
			{ r: 0, c: 0, rows: 1, cols: 1 },
			{ r: 0, c: 1, rows: 1, cols: 1 }
		]

		expect(cellAt(shape, areas, 35, 5)?.col).toBe(0)
		expect(cellAt(shape, areas, 5, 5)?.col).toBe(1)
		// Past the table's end (its left in a right-to-left table) is no cell, as past a left-to-right table's right.
		expect(cellAt(shape, areas, -5, 5)).toBeUndefined()
		expect(cellAt(ltr, areas, 45, 5)).toBeUndefined()
		expect(columnsBox(shape, 0, 1)).toEqual({ x: 30, width: 10 })
		expect(columnsBox(shape, 0, 2)).toEqual({ x: 0, width: 40 })
		expect(columnsBox(ltr, 1, 1)).toEqual({ x: 10, width: 30 })
		expect(cellAt(ltr, areas, 5, 5)?.col).toBe(0)
	})

	it("reads a:tblPr@rtl and writes it back when the table's properties are rewritten", async () => {
		const frame = tableFrame(3, [["A", "B"]]).replace(
			'<a:tblPr firstRow="1" bandRow="1">',
			'<a:tblPr rtl="1" firstRow="1" bandRow="1">'
		)
		const deck = buildPptx({ slides: [{ shapes: sp(2, "Title 1", 'type="title"', "", slideBody(para("T"))) + frame }] })
		const edit = { emit: emitPptx } as never
		const h = await editHarness(deck, edit)
		const shape: ShapeNode | undefined = shapeById((await h.slide(0)).shapes, 3)

		if (shape?.frame?.kind !== "table") throw new Error("not a table")

		expect(shape.frame.table.flags.rtl).toBe(true)

		const last = await h.command({
			family: "table",
			kind: "setStyle",
			target: { slide: h.session.deck.slides[0] as never, id: 3 },
			styleId: "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}",
			flags: { bandRow: false }
		})
		const saved = await saveEdits(h, (last as { revision: number }).revision)

		expect(text((await partsOf(saved)).get("ppt/slides/slide1.xml"))).toContain('<a:tblPr rtl="1" firstRow="1">')
	})
})
