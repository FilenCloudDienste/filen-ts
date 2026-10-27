import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { oneStep } from "../core/presentation/edit/commands/batch"
import {
	DEFAULT_TABLE_STYLE,
	SHAPE_GALLERY,
	insertPictureOp,
	insertShapeOp,
	insertTableOp,
	insertTextBoxOp,
	nextShapeIdOf,
	pictureBox
} from "../core/presentation/edit/commands/insert"
import {
	canMerge,
	cellAt,
	tableCommandOps,
	tableShapeOf,
	tableShapeOfLayer,
	type TableShape
} from "../core/presentation/edit/commands/table"
import type { ShapeNode, TableModel } from "../core/presentation/model"
import { odpBytes } from "./odpFixtures"
import { changes, entriesOf, odpApplier, openOdpDeck, saveDeck, slideAt, text as odpText } from "./odpWriteFixtures"
import { image, tableDeck } from "./presentationObjectsFixtures"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { openDeck, partsOf, saveEdits, slideNode, text } from "./pptxWriteFixtures"

// The Insert tab's objects: each command is one op whose shape the worker numbers, written by its family in pptx and
// ODP and read back as inserted: a preset shape in the theme's default shape style (its look as colours in ODP), a
// text box that grows with its text, a picture at its own size held to the slide, a table in PowerPoint's default
// style. The table commands on a selection of cells give the ops PowerPoint's Layout tab does.

const EDIT = { emit: emitPptx } as never

function lastShape(shapes: readonly ShapeNode[]): ShapeNode {
	return shapes[shapes.length - 1] as ShapeNode
}

describe("inserting objects", () => {
	it("inserts every gallery shape, a text box, a picture and a table into a pptx deck that reads them back", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const deck = h.session.deck
		const slide = deck.slides[0] as never
		let revision = 0
		const presets = Object.values(SHAPE_GALLERY).flat()

		for (const preset of presets) {
			const result = await h.command(insertShapeOp(deck, slide, preset, 0))

			expect(result.ok, preset).toBe(true)
			revision = (result as { revision: number }).revision
		}

		for (const op of [
			insertTextBoxOp(deck, slide, 0),
			insertPictureOp(deck, slide, image(400, 300), 0, "photo.png"),
			insertTableOp(deck, slide, 3, 4, 0)
		]) {
			const result = await h.command(op ?? (undefined as never))

			expect(result.ok).toBe(true)
			revision = (result as { revision: number }).revision
		}

		const saved = await saveEdits(h, revision)
		const xml = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

		expect(xml).toContain('<a:prstGeom prst="star5">')
		expect(xml).toContain('<p:cNvSpPr txBox="1"/>')
		expect(xml).toContain("<a:spAutoFit/>")
		expect(xml).toContain(`<a:tableStyleId>${DEFAULT_TABLE_STYLE}</a:tableStyleId>`)
		expect(xml).toContain('<a:fillRef idx="1"><a:schemeClr val="accent1"></a:schemeClr></a:fillRef>')

		const reopened = await openDeck(saved)
		const shapes = slideNode(reopened, 0).shapes

		expect(shapes.length).toBe(2 + presets.length + 3)

		const table = lastShape(shapes)

		expect(table.frame?.kind === "table" ? table.frame.table.rows.length : 0).toBe(3)

		const picture = shapes[shapes.length - 2] as ShapeNode

		expect(picture).toMatchObject({ kind: "pic", alt: { descr: "photo.png" } })
		expect(picture.xfrm).toMatchObject({ cx: 400 * 9525, cy: 300 * 9525 })
	})

	it("inserts the same objects into an ODP deck, written whole and read back", async () => {
		const opened = await openOdpDeck(odpBytes({ body: '<draw:page draw:name="One" draw:master-page-name="M"></draw:page>' }))
		const apply = odpApplier(opened)
		const node = slideAt(opened, 0)
		const deck = opened.deck

		for (const op of [
			insertShapeOp(deck, node.ref, "ellipse", 0),
			insertShapeOp(deck, node.ref, "line", 0),
			insertTextBoxOp(deck, node.ref, 0),
			insertPictureOp(deck, node.ref, image(40, 30), 0),
			insertTableOp(deck, node.ref, 2, 2, 0)
		])
			expect(apply(op ?? (undefined as never))).toBeUndefined()

		const { outcome, bytes } = await saveDeck(opened, changes())

		expect(JSON.stringify(outcome)).toContain("written")

		const content = odpText((await entriesOf(bytes)).get("content.xml"))

		expect(content).toContain('draw:type="ellipse"')
		expect(content).toContain("<draw:line")
		expect(content).toContain("<table:table")

		const reopened = await openOdpDeck(bytes)
		const shapes = slideAt(reopened, 0).shapes

		expect(shapes.map(shape => shape.kind)).toEqual(["sp", "cxnSp", "sp", "pic", "frame"])

		const table = lastShape(shapes)

		expect(table.frame?.kind === "table" ? table.frame.table.rows[0]?.cells[0]?.props?.fill : undefined).toEqual({
			kind: "solid",
			color: { kind: "srgb", rgb: "4472C4" }
		})
	})

	it("sizes a picture at 96 dpi held to the slide, and numbers new shapes after the slide's", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const deck = h.session.deck

		expect(pictureBox(deck, 100, 50)).toMatchObject({ cx: 952_500, cy: 476_250 })

		const huge = pictureBox(deck, 100_000, 1000)

		expect(huge.cx).toBeLessThanOrEqual(deck.size.cx)
		expect(huge.cx / huge.cy).toBeCloseTo(100, 0)
		expect(nextShapeIdOf([2, 3, 7])).toBe(8)
		expect(insertTableOp(deck, deck.slides[0] as never, 0, 3, 0)).toBeUndefined()
	})

	it("gives the Layout tab's ops for a selection: rows and columns beside it, merge, split, distribute, delete", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const target = { slide: h.session.deck.slides[0] as never, id: 3 }
		const shapeOf = async (): Promise<TableShape> =>
			tableShapeOf((shapeById((await h.slide(0)).shapes, 3)?.frame as { table: TableModel }).table) as TableShape
		const table = await shapeOf()
		const one = { row: 1, col: 1, rows: 1, cols: 1 }

		expect(tableCommandOps(target, table, one, "insertBelow")).toEqual([
			{ family: "table", kind: "insertRows", target, at: 2, count: 1 }
		])
		expect(tableCommandOps(target, table, { row: 0, col: 0, rows: 2, cols: 1 }, "deleteRows")).toEqual([
			{ family: "shape", kind: "delete", slide: target.slide, shapes: [3] }
		])
		expect(canMerge(table, one)).toBe(false)
		expect(canMerge(table, { row: 0, col: 0, rows: 1, cols: 2 })).toBe(true)

		await h.command({ family: "table", kind: "setColumnWidth", target, col: 0, width: 2000 })

		const distribute = oneStep(tableCommandOps(target, await shapeOf(), one, "distributeColumns"))

		expect(distribute).toHaveLength(1)
		expect((await h.command(distribute[0] as never)).ok).toBe(true)
		expect((await shapeOf()).grid).toEqual([1333, 1333, 1334])
	})

	it("reads a table's shape from its render layer and picks the cell under a point", () => {
		const layer = {
			columnEdges: [0, 10, 20, 30],
			rowEdges: [0, 5, 10],
			areas: Int32Array.from([0, 0, 1, 2, 0, 2, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1])
		}
		const shape = tableShapeOfLayer(layer)

		expect(shape.grid).toEqual([95_250, 95_250, 95_250])
		expect(shape.heights).toEqual([47_625, 47_625])
		expect(cellAt(layer, shape.areas, 15, 2)).toEqual({ row: 0, col: 0, rows: 1, cols: 2 })
		expect(cellAt(layer, shape.areas, 25, 7)).toEqual({ row: 1, col: 2, rows: 1, cols: 1 })
		expect(cellAt(layer, shape.areas, 35, 7)).toBeUndefined()
	})
})
