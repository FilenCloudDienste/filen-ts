import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { viewCapability } from "../dom/presentation/engine/view"
import type { ApplyContext } from "../core/presentation/edit/apply"
import { applyTable, areasOf } from "../core/presentation/edit/apply/table"
import { canSplit, tableCommandOps, tableShapeOf, tableStyleOp, wholeTable } from "../core/presentation/edit/commands/table"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, TableModel, TextBody } from "../core/presentation/model"
import { tableDeck, tableFrame } from "./presentationObjectsFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { differingParts, partsOf, saveEdits, text } from "./pptxWriteFixtures"

// Table edits end to end in the worker: each op changes the table as PowerPoint does (merged areas kept whole, the
// frame following its grid), undo puts the source table back exactly, and the pptx writer rewrites only the edited
// slide, keeping what it does not model (column ids, cell extensions) and every untouched cell as its source span.

const EDIT = { emit: emitPptx } as never

function tableOf(shape: ShapeNode | undefined): TableModel {
	if (shape?.frame?.kind !== "table") throw new Error("not a table")

	return shape.frame.table
}

function cellText(textBody: TextBody): string {
	return textBody.paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join("")).join("|")
}

function texts(table: TableModel): string[][] {
	return table.rows.map(row => row.cells.map(entry => cellText(entry.text)))
}

const TARGET = (h: Awaited<ReturnType<typeof editHarness>>) => ({ slide: h.session.deck.slides[0] as never, id: 3 })

describe("table edits", () => {
	it("inserts rows formatted like the row before them, the frame growing with them", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const result = await h.command({ family: "table", kind: "insertRows", target: TARGET(h), at: 1, count: 2 })

		expect(result.ok).toBe(true)

		const shape = shapeById((await h.slide(0)).shapes, 3)
		const table = tableOf(shape)

		expect(texts(table)).toEqual([
			["A1", "B1", "C1"],
			["", "", ""],
			["", "", ""],
			["A2", "B2", "C2"]
		])
		expect(table.rows.map(row => row.h)).toEqual([400, 400, 400, 400])
		expect(shape?.xfrm?.cy).toBe(1600)
	})

	it("undoes a row insert back to the source frame and saves only the edited slide", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const before = tableOf(shapeById((await h.slide(0)).shapes, 3))
		const inserted = await h.command({ family: "table", kind: "insertColumns", target: TARGET(h), at: 3, count: 1 })

		expect(inserted.ok).toBe(true)

		const saved = await saveEdits(h, (inserted as { revision: number }).revision)

		// The edited slide, and the tableStyles part the deck lacked for the built-in style its table names.
		expect((await differingParts(tableDeck(), saved)).sort()).toEqual(
			["[Content_Types].xml", "ppt/_rels/presentation.xml.rels", "ppt/slides/slide1.xml", "ppt/tableStyles.xml"].sort()
		)

		const slide = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

		expect(slide.match(/<a:gridCol /gu)?.length).toBe(4)
		// Untouched cells stay as their source spans; the new column's cells carry their formatting only.
		expect(slide).toContain("<a:t>B2</a:t>")
		expect(slide).not.toContain("a16:colId")

		const undone = await h.undo()

		expect(undone.ok).toBe(true)
		expect(texts(tableOf(shapeById((await h.slide(0)).shapes, 3)))).toEqual(texts(before))
	})

	it("merges a range into one cell holding every cell's text, and splits it back", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const merged = await h.command({ family: "table", kind: "merge", target: TARGET(h), range: { row: 0, col: 0, rows: 2, cols: 2 } })

		expect(merged.ok).toBe(true)

		let table = tableOf(shapeById((await h.slide(0)).shapes, 3))

		expect(table.rows[0]?.cells[0]).toMatchObject({ gridSpan: 2, rowSpan: 2 })
		expect(cellText(table.rows[0]?.cells[0]?.text as TextBody)).toBe("A1|B1|A2|B2")
		expect(table.rows[0]?.cells[1]).toMatchObject({ hMerge: true })
		expect(table.rows[1]?.cells[0]).toMatchObject({ vMerge: true })
		expect(table.rows[1]?.cells[1]).toMatchObject({ hMerge: true, vMerge: true })
		expect(areasOf(table)?.length).toBe(3)

		const saved = await saveEdits(h, (merged as { revision: number }).revision)
		const slide = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

		expect(slide).toContain('<a:tc gridSpan="2" rowSpan="2">')
		expect(slide).toContain('<a:tc hMerge="1" vMerge="1">')

		const split = await h.command({ family: "table", kind: "split", target: TARGET(h), row: 0, col: 0 })

		expect(split.ok).toBe(true)
		table = tableOf(shapeById((await h.slide(0)).shapes, 3))
		expect(areasOf(table)?.length).toBe(6)
	})

	it("splits a single cell into two columns, the column's other cells spanning both halves", async () => {
		const h = await editHarness(tableDeck(), EDIT)

		expect((await h.command({ family: "table", kind: "split", target: TARGET(h), row: 1, col: 1 })).ok).toBe(true)

		const table = tableOf(shapeById((await h.slide(0)).shapes, 3))

		expect(table.grid).toEqual([1000, 500, 500, 1000])
		expect(table.rows[0]?.cells[1]).toMatchObject({ gridSpan: 2 })
		expect(table.rows[0]?.cells[2]).toMatchObject({ hMerge: true })
		expect(table.rows[1]?.cells[1]?.gridSpan).toBeUndefined()
		expect(table.rows[1]?.cells[2]?.hMerge).toBeUndefined()
	})

	it("deletes rows through a vertical merge, the area shrinking and keeping its text", async () => {
		const h = await editHarness(tableDeck(), EDIT)

		await h.command({ family: "table", kind: "insertRows", target: TARGET(h), at: 2, count: 1 })
		await h.command({ family: "table", kind: "merge", target: TARGET(h), range: { row: 0, col: 2, rows: 3, cols: 1 } })
		expect((await h.command({ family: "table", kind: "deleteRows", target: TARGET(h), at: 0, count: 1 })).ok).toBe(true)

		const table = tableOf(shapeById((await h.slide(0)).shapes, 3))

		expect(table.rows.length).toBe(2)
		expect(table.rows[0]?.cells[2]).toMatchObject({ rowSpan: 2 })
		expect(cellText(table.rows[0]?.cells[2]?.text as TextBody)).toBe("C1|C2")
		expect(table.rows[1]?.cells[2]).toMatchObject({ vMerge: true })
	})

	it("refuses deleting every row, a covered cell's text and a range outside the table", async () => {
		const h = await editHarness(tableDeck(' gridSpan="2"'), EDIT)

		expect(await h.command({ family: "table", kind: "deleteRows", target: TARGET(h), at: 0, count: 2 })).toMatchObject({
			ok: false,
			refusal: "unsupported"
		})
		expect(
			await h.command({
				family: "table",
				kind: "setCellText",
				target: TARGET(h),
				row: 0,
				col: 1,
				body: { bodyPr: {}, paragraphs: [] }
			})
		).toMatchObject({ ok: false, refusal: "unsupported" })
		expect(
			await h.command({ family: "table", kind: "merge", target: TARGET(h), range: { row: 1, col: 1, rows: 3, cols: 1 } })
		).toMatchObject({
			ok: false,
			refusal: "malformed"
		})
	})

	it("sets a cell's text, properties, the style and sizes, and saves them", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const target = TARGET(h)

		await h.command({
			family: "table",
			kind: "setCellText",
			target,
			row: 1,
			col: 2,
			body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "New & <x>", rPr: { b: true } }] }] }
		})
		await h.command({
			family: "table",
			kind: "setCellProps",
			target,
			range: { row: 0, col: 0, rows: 1, cols: 3 },
			props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } }, anchor: "ctr", borders: { b: "none" } }
		})
		await h.command({
			family: "table",
			kind: "setStyle",
			target,
			styleId: "{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}",
			flags: { bandRow: false }
		})
		await h.command({ family: "table", kind: "setColumnWidth", target, col: 0, width: 2000 })
		const last = await h.command({ family: "table", kind: "setRowHeight", target, row: 1, height: 800 })
		const saved = await saveEdits(h, (last as { revision: number }).revision)
		const slide = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

		expect(slide).toContain("New &amp; &lt;x&gt;")
		expect(slide).toContain(
			'<a:tcPr anchor="ctr"><a:lnB><a:noFill/></a:lnB><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:tcPr>'
		)
		expect(slide).toContain("{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}")
		expect(slide).toContain('<a:tblPr firstRow="1">')
		expect(slide).toContain('<a:gridCol w="2000">')
		expect(slide).toContain('<a:tr h="800">')
		expect(slide).toContain('<a:ext cx="4000" cy="1200"/>')

		const reopened = await editHarness(saved, EDIT)
		const table = tableOf(shapeById((await reopened.slide(0)).shapes, 3))

		expect(texts(table)[1]?.[2]).toBe("New & <x>")
		expect(table.rows[0]?.cells[1]?.props).toMatchObject({ anchor: "ctr", borders: { b: "none" } })
	})

	it("keeps a table edit when the same save also rewrites the slide's shape tree", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never

		await h.command({ family: "table", kind: "insertRows", target: TARGET(h), at: 2, count: 1 })

		const added = await h.command({
			family: "shape",
			kind: "insert",
			slide,
			shape: {
				id: 0,
				name: "Box",
				hidden: false,
				kind: "sp",
				xfrm: { x: 0, y: 0, cx: 100, cy: 100, rot: 0, flipH: false, flipV: false },
				props: { geometry: { kind: "preset", preset: "rect", guides: [] } }
			}
		})
		const saved = await saveEdits(h, (added as { revision: number }).revision)
		const reopened = await editHarness(saved, EDIT)

		expect(tableOf(shapeById((await reopened.slide(0)).shapes, 3)).rows.length).toBe(3)
	})

	it("keeps a cell text edit when the same save also inserts a shape on the slide", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never

		await h.command({
			family: "table",
			kind: "setCellText",
			target: TARGET(h),
			row: 0,
			col: 1,
			body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "Edited", rPr: {} }] }] }
		})

		const added = await h.command({
			family: "shape",
			kind: "insert",
			slide,
			shape: {
				id: 0,
				name: "Box",
				hidden: false,
				kind: "sp",
				xfrm: { x: 0, y: 0, cx: 100, cy: 100, rot: 0, flipH: false, flipV: false },
				props: { geometry: { kind: "preset", preset: "rect", guides: [] } }
			}
		})
		const saved = await saveEdits(h, (added as { revision: number }).revision)
		const reopened = await editHarness(saved, EDIT)

		expect(texts(tableOf(shapeById((await reopened.slide(0)).shapes, 3)))[0]).toEqual(["A1", "Edited", "C1"])
	})

	it("keeps a cell text edit made on a duplicated slide", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const duplicated = await h.command({ family: "slide", kind: "duplicate", slide: h.session.deck.slides[0] as never })

		expect(duplicated.ok).toBe(true)

		const edited = await h.command({
			family: "table",
			kind: "setCellText",
			target: { slide: h.session.deck.slides[1] as never, id: 3 },
			row: 1,
			col: 0,
			body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "Copy", rPr: {} }] }] }
		})
		const saved = await saveEdits(h, (edited as { revision: number }).revision)
		const reopened = await editHarness(saved, EDIT)

		expect(texts(tableOf(shapeById((await reopened.slide(0)).shapes, 3)))[1]).toEqual(["A2", "B2", "C2"])
		expect(texts(tableOf(shapeById((await reopened.slide(1)).shapes, 3)))[1]).toEqual(["Copy", "B2", "C2"])
	})

	it("saves an edit to a cell read without a text body, and a split whose covered cell has none", async () => {
		// The table deck with the cell B1 as <a:tc…><a:tcPr/></a:tc> (CT_TableCell's a:txBody is optional).
		const bodiless = (merge = ""): Uint8Array => {
			const frame = tableFrame(
				3,
				[
					["A1", "B1", "C1"],
					["A2", "B2", "C2"]
				],
				merge
			)
			const at = frame.indexOf(">B1<")
			const start = frame.lastIndexOf("<a:tc", at)
			const end = frame.indexOf("</a:tc>", at) + "</a:tc>".length
			const open = frame.slice(start, frame.indexOf(">", start) + 1)

			return buildPptx({
				slides: [
					{
						shapes:
							sp(2, "Title 1", 'type="title"', "", body(para("Tables"))) +
							frame.slice(0, start) +
							`${open}<a:tcPr/></a:tc>` +
							frame.slice(end)
					}
				]
			})
		}
		const filled = await editHarness(bodiless(), EDIT)
		const fill = await filled.command({
			family: "table",
			kind: "setCellProps",
			target: TARGET(filled),
			range: { row: 0, col: 1, rows: 1, cols: 1 },
			props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "00FF00" } } }
		})

		expect(fill.ok).toBe(true)

		const reopened = await editHarness(await saveEdits(filled, (fill as { revision: number }).revision), EDIT)

		expect(tableOf(shapeById((await reopened.slide(0)).shapes, 3)).rows[0]?.cells[1]?.props).toMatchObject({
			fill: { kind: "solid", color: { kind: "srgb", rgb: "00FF00" } }
		})

		const merged = await editHarness(bodiless(' gridSpan="2"'), EDIT)
		const split = await merged.command({ family: "table", kind: "split", target: TARGET(merged), row: 0, col: 0 })

		expect(split.ok).toBe(true)

		const after = await editHarness(await saveEdits(merged, (split as { revision: number }).revision), EDIT)
		const cells = tableOf(shapeById((await after.slide(0)).shapes, 3)).rows[0]?.cells

		expect(cells?.[0]?.gridSpan).toBeUndefined()
		expect(cells?.[1]?.hMerge).toBeUndefined()
	})

	it("writes a link set, changed or cleared on a cell's text that is otherwise unchanged", async () => {
		type Link = NonNullable<TextBody["paragraphs"][number]["runs"][number] & { kind: "r" }>["rPr"]["hlinkClick"]

		// The cell B1's body with its first run linked to `link` (none: unlinked), saved and reopened.
		const linked = async (bytes: Uint8Array, link: (h: Awaited<ReturnType<typeof editHarness>>) => Link): Promise<Uint8Array> => {
			const h = await editHarness(bytes, EDIT)
			const cell = tableOf(shapeById((await h.slide(0)).shapes, 3)).rows[0]?.cells[1]

			if (cell === undefined) throw new Error("no cell")

			const action = link(h)
			const body: TextBody = {
				...cell.text,
				paragraphs: cell.text.paragraphs.map(paragraph => ({
					...paragraph,
					runs: paragraph.runs.map(run => {
						if (run.kind !== "r") return run

						const { hlinkClick: _old, ...rPr } = run.rPr

						return { ...run, rPr: action === undefined ? rPr : { ...rPr, hlinkClick: action } }
					})
				}))
			}
			const result = await h.command({ family: "table", kind: "setCellText", target: TARGET(h), row: 0, col: 1, body })

			if (!result.ok) throw new Error(result.refusal)

			return saveEdits(h, result.revision)
		}
		const linkOf = async (bytes: Uint8Array): Promise<unknown> => {
			const h = await editHarness(bytes, EDIT)
			const run = tableOf(shapeById((await h.slide(0)).shapes, 3)).rows[0]?.cells[1]?.text.paragraphs[0]?.runs[0]

			expect(texts(tableOf(shapeById((await h.slide(0)).shapes, 3)))[0]).toEqual(["A1", "B1", "C1"])

			return run?.kind === "r" ? run.rPr.hlinkClick : undefined
		}

		const set = await linked(tableDeck(), () => ({ kind: "url", href: "https://example.com/a" }))

		expect(await linkOf(set)).toEqual({ kind: "url", href: "https://example.com/a" })

		const changed = await linked(set, () => ({ kind: "url", href: "https://example.com/b" }))

		expect(await linkOf(changed)).toEqual({ kind: "url", href: "https://example.com/b" })

		const slide = await linked(changed, h => ({ kind: "slide", slide: h.session.deck.slides[0] as never }))
		const reopened = await editHarness(slide, EDIT)

		expect(await linkOf(slide)).toEqual({ kind: "slide", slide: reopened.session.deck.slides[0] })
		expect(await linkOf(await linked(slide, () => undefined))).toBeUndefined()
	})

	it("replaces in table cells and a text body as one step, one undo putting both back", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const slide = h.session.deck.slides[0] as never
		const result = await h.command({
			family: "text",
			kind: "replace",
			query: "1",
			replacement: "one",
			targets: [{ target: { slide, id: 3 } }, { target: { slide, id: 2 } }]
		})

		expect(result.ok).toBe(true)
		expect(texts(tableOf(shapeById((await h.slide(0)).shapes, 3)))[0]).toEqual(["Aone", "Bone", "Cone"])

		const single = await h.command({
			family: "text",
			kind: "replace",
			query: "2",
			replacement: "two",
			targets: [{ target: { slide, id: 3 }, match: [4, 1, 2] }]
		})

		expect(single.ok).toBe(true)
		expect(texts(tableOf(shapeById((await h.slide(0)).shapes, 3)))[1]).toEqual(["A2", "Btwo", "C2"])

		const saved = await saveEdits(h, (single as { revision: number }).revision)

		expect(text((await partsOf(saved)).get("ppt/slides/slide1.xml"))).toContain("<a:t>Btwo</a:t>")

		await h.undo()
		await h.undo()
		expect(texts(tableOf(shapeById((await h.slide(0)).shapes, 3)))).toEqual([
			["A1", "B1", "C1"],
			["A2", "B2", "C2"]
		])
	})

	it("renders a table frame's structure on its layer for the page: edges and merged areas", async () => {
		const h = await editHarness(tableDeck(' gridSpan="2"'), EDIT)
		const [render] = await viewCapability.render(h.context, [h.session.deck.slides[0] as never])
		const layer = render?.layers.find(each => each.role === "table" && each.table !== undefined)

		expect(layer?.table?.columnEdges.length).toBe(4)
		expect(layer?.table?.rowEdges.length).toBe(3)
		expect([...(layer?.table?.areas ?? [])]).toEqual([0, 0, 1, 2, 0, 2, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1])
	})

	it("splits any one cell, a merged one spanning the whole table too, and no range of several", () => {
		const shape = (rows: number, cols: number, merged: boolean) =>
			tableShapeOf({
				grid: Array.from({ length: cols }, () => 1000),
				rows: Array.from({ length: rows }, (_, r) => ({
					h: 400,
					cells: Array.from({ length: cols }, (_, c) => ({
						text: { bodyPr: {}, paragraphs: [] },
						...(merged && r === 0 && c === 0 ? { rowSpan: rows, gridSpan: cols } : {}),
						...(merged && c > 0 ? { hMerge: true } : {}),
						...(merged && r > 0 && c === 0 ? { vMerge: true } : {})
					}))
				}))
			} as unknown as TableModel)
		const whole = shape(2, 2, true)
		const plain = shape(2, 2, false)

		if (whole === undefined || plain === undefined) throw new Error("no shape")

		expect(canSplit(whole, wholeTable(whole))).toBe(true)
		expect(canSplit(plain, { row: 1, col: 1, rows: 1, cols: 1 })).toBe(true)
		expect(canSplit(plain, wholeTable(plain))).toBe(false)
	})

	it("keeps the style on a flag toggle, removes it on null, sets a string, and undoes each", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const target = TARGET(h)
		const table = async (): Promise<TableModel> => tableOf(shapeById((await h.slide(0)).shapes, 3))
		const source = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"
		const gallery = "{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}"

		expect(await table()).toMatchObject({ styleId: source, flags: { bandRow: true } })
		expect(tableStyleOp(target, { flag: "bandRow", on: false })).not.toHaveProperty("styleId")

		expect((await h.command(tableStyleOp(target, { flag: "bandRow", on: false }))).ok).toBe(true)
		expect(await table()).toMatchObject({ styleId: source, flags: { bandRow: false } })

		expect((await h.command(tableStyleOp(target, { styleId: gallery }))).ok).toBe(true)
		expect(await table()).toMatchObject({ styleId: gallery, flags: { bandRow: false } })

		expect((await h.command(tableStyleOp(target, { styleId: null }))).ok).toBe(true)
		expect(await table()).not.toHaveProperty("styleId")

		await h.undo()
		expect((await table()).styleId).toBe(gallery)
		await h.undo()
		expect((await table()).styleId).toBe(source)
		await h.undo()
		expect(await table()).toMatchObject({ styleId: source, flags: { bandRow: true } })
	})

	it("a flag toggle keeps the style through a save; null takes it out of the saved slide", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const target = TARGET(h)
		const source = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"
		const toggled = await h.command(tableStyleOp(target, { flag: "bandRow", on: false }))

		expect(toggled.ok).toBe(true)

		const kept = text((await partsOf(await saveEdits(h, (toggled as { revision: number }).revision))).get("ppt/slides/slide1.xml"))

		expect(kept).toContain(`<a:tableStyleId>${source}</a:tableStyleId>`)
		expect(kept).not.toMatch(/<a:tblPr [^>]*bandRow="1"/u)

		const cleared = await h.command(tableStyleOp(target, { styleId: null }))

		expect(cleared.ok).toBe(true)
		expect(
			text((await partsOf(await saveEdits(h, (cleared as { revision: number }).revision))).get("ppt/slides/slide1.xml"))
		).not.toContain("a:tableStyleId")
	})

	it("distributes the selected rows evenly, the sizes summing to their total, and the whole table for one cell", () => {
		const target = { slide: 256 as never, id: 3 }
		const heights = [100, 200, 401, 50]
		const shape = {
			grid: [1000],
			heights,
			areas: heights.map((_, r) => ({ r, c: 0, rows: 1, cols: 1 }))
		}
		const some = tableCommandOps(target, shape, { row: 1, col: 0, rows: 2, cols: 1 }, "distributeRows")

		expect(some).toEqual([{ family: "table", kind: "setRowHeights", target, row: 1, heights: [301, 300] }])

		const all = tableCommandOps(target, shape, { row: 2, col: 0, rows: 1, cols: 1 }, "distributeRows")

		expect(all).toEqual([{ family: "table", kind: "setRowHeights", target, row: 0, heights: [188, 188, 188, 187] }])
		expect([188, 188, 188, 187].reduce((sum, h) => sum + h, 0)).toBe(heights.reduce((sum, h) => sum + h, 0))
		// Lines already even emit no op.
		expect(
			tableCommandOps(target, { ...shape, heights: [100, 300, 300, 50] }, { row: 1, col: 0, rows: 2, cols: 1 }, "distributeRows")
		).toEqual([])
	})

	it("distributes rows and columns as one op each, whose undo holds one copy of the frame", async () => {
		const h = await editHarness(tableDeck(), EDIT)
		const target = TARGET(h)
		const table = async (): Promise<TableModel> => tableOf(shapeById((await h.slide(0)).shapes, 3))

		expect((await h.command({ family: "table", kind: "setRowHeights", target, row: 0, heights: [400, 1200] })).ok).toBe(true)
		expect((await h.command({ family: "table", kind: "setColumnWidths", target, col: 0, widths: [500, 1000, 1500] })).ok).toBe(true)

		const shape = tableShapeOf(await table())

		if (shape === undefined) throw new Error("no table")

		const cell = { row: 0, col: 0, rows: 1, cols: 1 }
		const rows = tableCommandOps(target, shape, cell, "distributeRows")
		const columns = tableCommandOps(target, shape, cell, "distributeColumns")

		expect(rows).toEqual([{ family: "table", kind: "setRowHeights", target, row: 0, heights: [800, 800] }])
		expect(columns).toEqual([{ family: "table", kind: "setColumnWidths", target, col: 0, widths: [1000, 1000, 1000] }])

		for (const op of [...rows, ...columns]) expect((await h.command(op)).ok).toBe(true)

		expect((await table()).rows.map(row => row.h)).toEqual([800, 800])
		expect((await table()).grid).toEqual([1000, 1000, 1000])

		await h.undo()
		await h.undo()
		expect((await table()).rows.map(row => row.h)).toEqual([400, 1200])
		expect((await table()).grid).toEqual([500, 1000, 1500])
		expect(tableCommandOps(target, tableShapeOf(await table()) ?? shape, cell, "distributeRows")).toEqual(rows)

		// Lines already even: nothing to do.
		await h.command(rows[0] as DeckOp)
		expect(tableCommandOps(target, tableShapeOf(await table()) ?? shape, cell, "distributeRows")).toEqual([])

		// The inverse of a frame that is no source's: one delete and one insert (one copy of the frame) for every line.
		const bare = await editHarness(tableDeck(), EDIT)
		const node = await bare.slide(0)
		const frame = shapeById(node.shapes, 3)

		if (frame === undefined) throw new Error("no frame")

		delete frame.src

		const context: ApplyContext = {
			sourceBytes: () => {
				throw new Error("no source")
			},
			newShapeId: () => 99,
			newSlideRef: () => node.ref
		}
		const applied = applyTable.apply(
			bare.session.deck,
			{ family: "table", kind: "setRowHeights", target: TARGET(bare), row: 0, heights: [300, 500] },
			context
		)

		if (applied.kind !== "applied") throw new Error(`${applied.reason} ${applied.detail ?? ""}`)

		expect(applied.inverse.ops.map(op => op.kind)).toEqual(["delete", "insert"])
		expect(tableOf(frame).rows.map(row => row.h)).toEqual([300, 500])
	})
})
