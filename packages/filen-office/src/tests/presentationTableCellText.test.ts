import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { emitPptx } from "../core/pptx/write/emit"
import type { ShapeRef, TableModel, TextBody } from "../core/presentation/model"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { createEditCapability } from "../dom/presentation/engine/edit"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { layoutShapeText, textSeedOf } from "../dom/presentation/engine/text"
import { presentationTextServices } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { tableDeck } from "./presentationObjectsFixtures"

// A table cell's text in the editor: the text editor seeds on a cell (ShapeRef.cell) with that cell's body, its
// layout in the cell's own box and the matrix of the cell's text (the table's layer and the cell's box for an empty
// cell), and its setText writes the cell through the table family, undone as one step.

interface Harness {
	readonly context: CallContext
	readonly edit: ReturnType<typeof createEditCapability>
	readonly cell: (row: number, col: number) => ShapeRef
}

async function harness(): Promise<Harness> {
	const outcome = await openPptxCapability.open({
		source: bytesSource(tableDeck()),
		sourceKind: "bytes",
		options: { format: "pptx", fileName: "deck.pptx" }
	})

	if (outcome.kind !== "opened") throw new Error(outcome.kind)

	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "deck.pptx" },
		services: { ...SERVICES, text: presentationTextServices },
		rangeSource: undefined,
		schedule: () => undefined,
		emit: () => undefined,
		onClose: () => undefined
	}
	const context: CallContext = {
		session,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "priority",
		slicing: { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }
	}
	const slide = outcome.deck.slides[0] as ShapeRef["slide"]

	return { context, edit: createEditCapability({ emit: emitPptx }), cell: (row, col) => ({ slide, id: 3, cell: { row, col } }) }
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

		expect(words(seed.body)).toBe("C2")
		// The cell's text box: column 2's left edge plus the default 0.1 in margin, row 1's top plus 0.05 in.
		expect(seed.matrix[4]).toBeCloseTo((100 + 2000) / 9525 + 9.6, 0)

		const laid = await layoutShapeText(
			h.context.session,
			h.cell(1, 2),
			{ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "Longer text", rPr: {} }] }] },
			h.context.slicing
		)

		expect(laid.page.page.lineCount).toBeGreaterThan(0)
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
	})

	it("refuses a cell another cell covers and a frame without a cell", async () => {
		const h = await harness()

		await expect(textSeedOf(h.context, { ...h.cell(0, 0), cell: { row: 9, col: 0 } })).rejects.toMatchObject({ reason: "unsupported" })
		await expect(textSeedOf(h.context, { slide: h.cell(0, 0).slide, id: 3 })).rejects.toMatchObject({ reason: "unsupported" })
	})
})
