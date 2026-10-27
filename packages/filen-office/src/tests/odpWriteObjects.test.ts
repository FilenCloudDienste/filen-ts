import { describe, expect, it } from "vitest"
import { insertedImage, pictureFillOf } from "../core/presentation/edit/apply/picture"
import type { ShapeNode, TableModel } from "../core/presentation/model"
import { odpBytes } from "./odpFixtures"
import { changes, entriesOf, odpApplier, openOdpDeck, saveDeck, shapeNamed, slideAt, text } from "./odpWriteFixtures"
import { image, png } from "./presentationObjectsFixtures"
import { freshFromPptx } from "./odpWriteFreshFixtures"
import { body, buildPptx, sp, xfrm } from "./pptxFixtures"

// Tables and pictures in an ODP deck: a table op rewrites the frame's table:table from the model (columns and rows
// sized by automatic styles, each cell's properties in a table-cell style, covered cells kept covered), a new table
// and an inserted picture are written whole (the image as a Pictures/ entry with its manifest entry), and each reads
// back as the session holds it.

const TABLE =
	'<draw:frame draw:name="Table" svg:x="2cm" svg:y="4cm" svg:width="12cm" svg:height="2cm">' +
	'<table:table table:template-name="default" table:use-first-row-styles="true">' +
	'<table:table-column table:style-name="co1" table:number-columns-repeated="3"/>' +
	'<table:table-row table:style-name="ro1"><table:table-cell table:style-name="ce1"><text:p>A1</text:p></table:table-cell><table:table-cell><text:p>B1</text:p></table:table-cell><table:table-cell><text:p>C1</text:p></table:table-cell></table:table-row>' +
	'<table:table-row table:style-name="ro1"><table:table-cell><text:p>A2</text:p></table:table-cell><table:table-cell><text:p>B2</text:p></table:table-cell><table:table-cell><text:p>C2</text:p></table:table-cell></table:table-row>' +
	"</table:table></draw:frame>"

const AUTOMATIC =
	'<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="4cm"/></style:style>' +
	'<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="1cm"/></style:style>' +
	'<style:style style:name="ce1" style:family="table-cell"><style:table-cell-properties fo:background-color="#ffcc00"/></style:style>'

function deck(): Uint8Array {
	return odpBytes({
		automatic: AUTOMATIC,
		body: `<draw:page draw:name="One" draw:master-page-name="M">${TABLE}</draw:page>`
	})
}

function tableOf(shape: ShapeNode): TableModel {
	if (shape.frame?.kind !== "table") throw new Error("not a table")

	return shape.frame.table
}

function texts(table: TableModel): string[][] {
	return table.rows.map(row =>
		row.cells.map(cell => cell.text.paragraphs.map(p => p.runs.map(run => (run.kind === "br" ? "" : run.text)).join("")).join("|"))
	)
}

describe("odp tables and pictures", () => {
	it("writes a table op into the frame's table:table and reads it back", async () => {
		const opened = await openOdpDeck(deck())
		const apply = odpApplier(opened)
		const node = slideAt(opened, 0)
		const shape = shapeNamed(node, "Table")
		const target = { slide: node.ref, id: shape.id }

		expect(apply({ family: "table", kind: "insertRows", target, at: 2, count: 1 })).toBeUndefined()
		expect(apply({ family: "table", kind: "merge", target, range: { row: 0, col: 1, rows: 1, cols: 2 } })).toBeUndefined()
		expect(
			apply({
				family: "table",
				kind: "setCellProps",
				target,
				range: { row: 2, col: 0, rows: 1, cols: 1 },
				props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "00FF00" } }, anchor: "b" }
			})
		).toBeUndefined()

		const { outcome, bytes } = await saveDeck(opened, changes())

		expect(outcome).toMatchObject({ kind: "written" })

		const content = text((await entriesOf(bytes)).get("content.xml"))

		expect(content).toContain('table:number-columns-spanned="2"')
		expect(content).toContain("<table:covered-table-cell/>")
		expect(content).toContain('table:template-name="default"')
		expect(content).toMatch(/fo:background-color="#00ff00"/u)
		expect(content).toMatch(/style:vertical-align="bottom"/u)

		const reopened = await openOdpDeck(bytes)
		const table = tableOf(shapeNamed(slideAt(reopened, 0), "Table"))

		expect(texts(table)).toEqual([
			["A1", "B1|C1", ""],
			["A2", "B2", "C2"],
			["", "", ""]
		])
		expect(table.rows[0]?.cells[0]?.props?.fill).toEqual({ kind: "solid", color: { kind: "srgb", rgb: "FFCC00" } })
		expect(table.rows[2]?.cells[0]?.props).toMatchObject({ anchor: "b" })
		expect(table.grid.map(width => Math.round(width / 3600))).toEqual([400, 400, 400])
	})

	it("inserts a picture as a Pictures/ entry with its manifest entry", async () => {
		const opened = await openOdpDeck(deck())
		const apply = odpApplier(opened)
		const node = slideAt(opened, 0)

		expect(
			apply({
				family: "picture",
				kind: "insert",
				slide: node.ref,
				shape: {
					id: 0,
					name: "Photo",
					hidden: false,
					kind: "pic",
					alt: { descr: "A photo" },
					xfrm: { x: 360_000, y: 360_000, cx: 720_000, cy: 360_000, rot: 0, flipH: false, flipV: false }
				},
				image: image()
			})
		).toBeUndefined()

		const fill = pictureFillOf(node.shapes[node.shapes.length - 1] as ShapeNode)

		expect(insertedImage(opened.deck, fill?.inserted ?? 0)).toBeDefined()

		const { outcome, bytes } = await saveDeck(opened, changes())

		expect(outcome).toMatchObject({ kind: "written" })

		const entries = await entriesOf(bytes)
		const picture = [...entries.keys()].find(name => name.startsWith("Pictures/inserted-"))

		expect(picture).toBeDefined()
		expect(text(entries.get("META-INF/manifest.xml"))).toContain(picture)
		expect(text(entries.get("content.xml"))).toContain(`xlink:href="${picture ?? ""}"`)

		const reopened = await openOdpDeck(bytes)
		const photo = shapeNamed(slideAt(reopened, 0), "Photo")

		expect(photo.kind).toBe("pic")
		expect(photo.alt?.descr).toBe("A photo")
		expect(photo.xfrm).toMatchObject({ x: 360_000, y: 360_000, cx: 720_000, cy: 360_000 })
	})

	it("converts a picture bullet into a Pictures/ entry its list level names", async () => {
		const bullet = '<a:pPr marL="342900" indent="-342900"><a:buBlip><a:blip r:embed="rId9"/></a:buBlip></a:pPr>'
		const pptx = buildPptx({
			slides: [
				{
					shapes: sp(
						3,
						"Box",
						undefined,
						`${xfrm(100, 100, 3000000, 1000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
						body(`<a:p>${bullet}<a:r><a:rPr lang="en-GB"/><a:t>Pictured</a:t></a:r></a:p>`)
					),
					rels: [["rId9", "image", "../media/bullet.png"]]
				}
			],
			parts: { "ppt/media/bullet.png": { data: png(), type: "image/png" } }
		})
		const fresh = await freshFromPptx(pptx)

		if ("kind" in fresh) throw new Error(fresh.reason)

		const entries = await entriesOf(fresh.bytes)
		const content = text(entries.get("content.xml"))
		const picture = [...entries.keys()].find(name => name.startsWith("Pictures/"))

		expect(fresh.report.approximated["picture bullet"]).toBeUndefined()
		expect(content).toContain(`<text:list-level-style-image text:level="1" xlink:href="${picture ?? "?"}"`)

		const reopened = await openOdpDeck(fresh.bytes)
		const paragraph = slideAt(reopened, 0).shapes[0]?.text?.paragraphs[0]

		expect(paragraph?.pPr.bullet).toEqual({ kind: "blip", part: `/${picture ?? ""}` })
	})
})
