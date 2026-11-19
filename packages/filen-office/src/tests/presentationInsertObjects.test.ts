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
import { insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import type { DeckOp, FileLike } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, TableModel } from "../core/presentation/model"
import { mediaCapability } from "../dom/presentation/engine/media"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { smartArtRenderer } from "../dom/presentation/engine/smartart"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
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
			insertPictureOp(deck, slide, image(400, 300), 0),
			insertPictureOp(deck, slide, image(40, 30), 0, "A sunset over the bay"),
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
		expect(xml).toContain('<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>')

		const reopened = await openDeck(saved)
		const shapes = slideNode(reopened, 0).shapes

		expect(shapes.length).toBe(2 + presets.length + 4)

		const table = lastShape(shapes)

		expect(table.frame?.kind === "table" ? table.frame.table.rows.length : 0).toBe(3)

		const picture = shapes[shapes.length - 3] as ShapeNode
		const described = shapes[shapes.length - 2] as ShapeNode

		// No alt text unless the user typed one: the Alt Text dialog shows it as missing.
		expect(picture.kind).toBe("pic")
		expect(picture.alt?.descr).toBeUndefined()
		expect(picture.xfrm).toMatchObject({ cx: 400 * 9525, cy: 300 * 9525 })
		expect(described).toMatchObject({ kind: "pic", alt: { descr: "A sunset over the bay" } })
		expect(xml.match(/descr="/g)?.length).toBe(1)
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

// A new element's p:cNvPr is the shape family's: a link and the decorative flag set before any save gave the element a
// source are written and read back, so the save passes its proof.
describe("new elements' non-visual properties", () => {
	const BOX = { x: 1_000_000, y: 1_000_000, cx: 3_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }
	const VIDEO = new Uint8Array(4096)

	VIDEO.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31], 0)

	const video: FileLike = {
		size: VIDEO.length,
		name: "clip.mp4",
		type: "video/mp4",
		slice: (start = 0, end = VIDEO.length) => ({ arrayBuffer: () => Promise.resolve(VIDEO.slice(start, end).buffer) })
	}

	type Drive = Awaited<ReturnType<typeof driveSession>>

	const insertOps: Readonly<Record<string, (d: Drive, slide: SlideRef) => Promise<DeckOp>>> = {
		picture: d => Promise.resolve(insertPictureOp(d.session.deck, d.session.deck.slides[0] as never, image(40, 30), 0, "photo.png")),
		table: d => Promise.resolve(insertTableOp(d.session.deck, d.session.deck.slides[0] as never, 2, 2, 0) as DeckOp),
		chart: (d, slide) =>
			Promise.resolve(insertChartOp(d.session.deck, slide, 0, "column", sampleChartCells({ categories: ["A"], series: ["S"] }))),
		smartart: (_d, slide) =>
			Promise.resolve({
				family: "smartart",
				kind: "insert",
				slide,
				shape: { id: 0, name: "Diagram", hidden: false, kind: "frame", xfrm: BOX } as ShapeNode,
				layout: { uniqueId: "urn:filen:smartart:layout:list-basic", source: "gallery" },
				texts: ["Alpha", "Beta"]
			}),
		media: async (d, slide) => {
			const registered = await mediaCapability.registerMedia({ ...d.context, lane: "background" }, { kind: "file", file: video })

			if ("reason" in registered) throw new Error(registered.reason)

			return {
				family: "media",
				kind: "insert",
				slide,
				shape: { id: 0, name: "clip.mp4", hidden: false, kind: "pic", xfrm: BOX },
				media: { ...registered, poster: image(16, 9), durationMs: 1000 }
			}
		}
	}

	for (const [family, insertOp] of Object.entries(insertOps)) {
		it(`writes a new ${family}'s link and decorative flag`, async () => {
			const d = await driveSession(
				buildPptx({
					slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("P"))) }]
				}),
				"pptx"
			)
			const slide = d.session.deck.slides[0] as SlideRef

			smartArtRenderer(d.session, {
				services: {
					xml: part => pptxParts(d.session.deck)?.document(part),
					relationship: () => undefined,
					contentType: () => undefined
				}
			})
			expect((await d.command(await insertOp(d, slide))).ok).toBe(true)

			const id = lastShape((d.session.deck.nodes.get(slide) as SlideNode).shapes).id
			const target = { slide, id }

			expect((await d.command({ family: "shape", kind: "setAlt", target, alt: { decorative: true } })).ok).toBe(true)
			expect(
				(
					await d.command({
						family: "shape",
						kind: "setAction",
						target,
						trigger: "hover",
						action: { kind: "url", href: "https://example.com/" }
					})
				).ok
			).toBe(true)

			const { result, bytes } = await d.save()

			expect(result.kind).toBe("written")

			const shape = lastShape(slideNode(await openDeck(bytes ?? new Uint8Array()), 0).shapes)

			expect(shape.alt?.decorative).toBe(true)
			expect(shape.actions?.hover).toEqual({ kind: "url", href: "https://example.com/" })
		})
	}
})
