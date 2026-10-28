import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { chartWorkbookOp, insertChartOp } from "../core/presentation/edit/commands/chart"
import type { SlideNode, SlideRef } from "../core/presentation/model"
import { textWorkbookXlsx } from "../core/xlsx/convert/text"
import { viewCapability } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { cpuMs } from "./timing"

// presentationChartPerf: an Edit Data commit on a chart over a 10,000-cell workbook (2,000 categories, four series)
// reads the workbook, refreshes the chart's caches from its cells and re-renders the slide within 150 ms of worker
// CPU, the best of three.

const ROWS = 2000
const SERIES = 4

function rows(scale: number): string[][] {
	const out: string[][] = [["", ...Array.from({ length: SERIES }, (_, k) => `Series ${String(k + 1)}`)]]

	for (let row = 1; row < ROWS; row++)
		out.push([`C${String(row)}`, ...Array.from({ length: SERIES }, (_, k) => String(((row * (k + 3)) % 97) * scale))])

	return out
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

describe("presentation chart performance", () => {
	it("presentationChartPerf: an Edit Data commit on a 10,000-cell workbook within 150 ms CPU", { timeout: 120_000 }, async ({ task }) => {
		const deck = buildPptx({
			slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("Data"))) }]
		})
		const d = await driveSession(deck, "pptx")
		const slide = d.session.deck.slides[0] as SlideRef
		const cells = rows(1).map((row, r) => row.map((cell, c) => (r > 0 && c > 0 ? Number(cell) : cell)))

		expect(await d.command(insertChartOp(d.session.deck, slide, 0, "line", cells))).toMatchObject({ ok: true })

		await viewCapability.render(d.context, [slide])

		const target = {
			slide,
			id: ((d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.frame?.kind === "chart") as { id: number }).id
		}
		let best = Infinity

		for (let run = 0; run < 3; run++) {
			const workbook = await textWorkbookXlsx(rows(run + 2), "Sheet1")

			if (!workbook.ok) throw new Error("no workbook")

			const start = cpuMs()
			const result = await d.command(chartWorkbookOp(target, workbook.bytes))

			await viewCapability.render(d.context, [slide])
			best = Math.min(best, cpuMs() - start)
			expect(result).toMatchObject({ ok: true })
		}

		Object.assign(task.meta, { perf: { presentationChartEditDataCpuMs: { value: best, budget: 150 } } })
		expect(best).toBeLessThanOrEqual(150)
	})
})
