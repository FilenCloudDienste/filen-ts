import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import type { ShapeRef, TableModel, TextBody } from "../core/presentation/model"
import { layoutShapeText, textSeedOf } from "../dom/presentation/engine/text"
import { presentationTextServices } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { tableDeck } from "./presentationObjectsFixtures"

// A table cell's text in the editor: the text editor seeds on a cell (ShapeRef.cell) with that cell's body, its
// layout in the cell's own box and the matrix of the cell's text (the table's layer and the cell's box for an empty
// cell), and its setText writes the cell through the table family, undone as one step.

interface Harness extends EditHarness {
	readonly cell: (row: number, col: number) => ShapeRef
}

async function harness(): Promise<Harness> {
	const h = await editHarness(tableDeck(), { emit: emitPptx }, { text: presentationTextServices })
	const slide = h.session.deck.slides[0] as ShapeRef["slide"]

	return { ...h, cell: (row, col) => ({ slide, id: 3, cell: { row, col } }) }
}

function words(body: TextBody): string {
	return body.paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join("")).join("|")
}

beforeAll(() => {
	installPresentationRealm({
		text: {
			fontHost: nodeFontHost,
			replayFonts: true,
			fontAssets: nodeFontAssets,
			measurer: new HmtxMeasurer(),
			yield: () => Promise.resolve()
		},
		canvas: {
			canvas: () => undefined,
			decode: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(undefined),
			fontsReady: () => Promise.resolve()
		}
	})
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe("table cell text", () => {
	it("seeds the editor on a cell with that cell's body, laid out in the cell's box", async () => {
		const h = await harness()
		const seed = await textSeedOf(h.context, h.cell(1, 2))
		const first = await textSeedOf(h.context, h.cell(0, 0))
		const below = await textSeedOf(h.context, h.cell(1, 0))
		const px = (emu: number): number => emu / 9525
		// The default cell margins: 0.1 in left and right, 0.05 in top and bottom (91440 and 45720 EMU).
		const marL = px(91_440)
		const marT = px(45_720)

		expect(words(seed.body)).toBe("C2")
		// The cell's text box: column 2's left edge plus the left margin; the columns are only 1000 EMU (about 0.1 px)
		// apart, so the seeds of the cells in column 0 tell a wrong column apart.
		expect(seed.matrix[4]).toBeCloseTo(px(100 + 2000) + marL, 2)
		expect(first.matrix[4]).toBeCloseTo(px(100) + marL, 2)
		expect(below.matrix[4]).toBeCloseTo(px(100) + marL, 2)
		expect(seed.matrix[4] ?? 0).toBeGreaterThan(below.matrix[4] ?? 0)

		// Row 0 starts at the frame's top; it grows to hold its text, so row 1 starts below row 0's laid text and both of
		// its vertical margins. Row 1's cells share that top whatever their column.
		const firstLaid = await layoutShapeText(h.context.session, h.cell(0, 0), first.body, h.context.slicing)

		expect(first.matrix[5]).toBeCloseTo(px(200) + marT, 2)
		expect(below.matrix[5]).toBeCloseTo(px(200) + firstLaid.page.page.height + 3 * marT, 2)
		expect(seed.matrix[5]).toBeCloseTo(below.matrix[5] ?? 0, 6)
		expect(seed.matrix[5] ?? 0).toBeGreaterThan(first.matrix[5] ?? 0)

		const laid = await layoutShapeText(
			h.context.session,
			h.cell(1, 2),
			{ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "Longer text", rPr: {} }] }] },
			h.context.slicing
		)

		// The column's width less both margins, never below zero (the fixture's 1000 EMU column is narrower than them).
		expect(laid.page.page.width).toBeCloseTo(Math.max(0, px(1000) - 2 * marL), 6)
		h.close()
	})

	it("writes the cell through setText and undoes it in one step", async () => {
		const h = await harness()
		const target = h.cell(0, 1)
		const result = await h.edit.command(h.context, {
			family: "text",
			kind: "setText",
			target,
			body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "Typed", rPr: {} }] }] }
		})

		expect(result.ok).toBe(true)

		const table = (h.context.session.deck.nodes.get(target.slide)?.shapes.find(shape => shape.id === 3)?.frame as { table: TableModel })
			.table

		expect(words(table.rows[0]?.cells[1]?.text as TextBody)).toBe("Typed")
		expect((await h.edit.undo(h.context)).ok).toBe(true)

		const back = (h.context.session.deck.nodes.get(target.slide)?.shapes.find(shape => shape.id === 3)?.frame as { table: TableModel })
			.table

		expect(words(back.rows[0]?.cells[1]?.text as TextBody)).toBe("B1")
		h.close()
	})

	it("refuses a lone surrogate and a link the deck cannot carry, but not what the cell already held", async () => {
		const h = await harness()
		const target = h.cell(0, 1)
		const run = (text: string, href?: string): TextBody["paragraphs"][number]["runs"][number] => ({
			kind: "r",
			text,
			rPr: href === undefined ? {} : { hlinkClick: { kind: "url", href } }
		})
		const of = (...runs: TextBody["paragraphs"][number]["runs"]): TextBody => ({ bodyPr: {}, paragraphs: [{ pPr: {}, runs }] })
		const setText = (body: TextBody) => h.edit.command(h.context, { family: "text", kind: "setText", target, body })

		expect(await setText(of(run("half \ud83d of an emoji")))).toMatchObject({ ok: false, refusal: "malformed" })
		expect(await setText(of(run("link", "javascript:alert(1)")))).toMatchObject({ ok: false, refusal: "malformed" })

		// A cell that already holds a lone surrogate (as a file read by another path might): editing another of its runs
		// re-sends that run as it is, and is accepted.
		const table = (h.context.session.deck.nodes.get(target.slide)?.shapes.find(shape => shape.id === 3)?.frame as { table: TableModel })
			.table
		const row = table.rows[0]

		if (row?.cells[1] !== undefined) row.cells[1] = { ...row.cells[1], text: of(run("kept \ude00"), run(" edited")) }

		expect(await setText(of(run("kept \ude00"), run(" typed")))).toMatchObject({ ok: true })
		expect(await setText(of(run("new \ude00")))).toMatchObject({ ok: false, refusal: "malformed" })
		h.close()
	})

	it("refuses a cell another cell covers and a frame without a cell", async () => {
		const h = await harness()

		await expect(textSeedOf(h.context, { ...h.cell(0, 0), cell: { row: 9, col: 0 } })).rejects.toMatchObject({ reason: "unsupported" })
		await expect(textSeedOf(h.context, { slide: h.cell(0, 0).slide, id: 3 })).rejects.toMatchObject({ reason: "unsupported" })
		h.close()
	})
})
