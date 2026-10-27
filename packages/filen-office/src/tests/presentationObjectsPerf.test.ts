import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { insertPictureOp, insertTableOp } from "../core/presentation/edit/commands/insert"
import type { DeckOp } from "../core/presentation/edit/ops"
import { presentationTextServices, viewCapability } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { pictureDeck } from "./presentationObjectsFixtures"
import { editHarness } from "./presentationEditFixtures"
import { budget, cpuMs } from "./timing"

// presentationObjectsPerf: a 24-megapixel picture is taken into the deck by the worker (header checked, registered,
// inserted) within 400 ms of CPU, and an edit of one cell of a 20 × 20 table (the command and its slide's re-render)
// takes at most 15 ms, the slowest of nine.

// A baseline JPEG header (SOI, SOF0 6000 × 4000) followed by 8 MiB of entropy-coded-looking bytes.
function jpeg24mp(): Uint8Array {
	const bytes = new Uint8Array(8 * 1024 * 1024)
	const header = [
		0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0f, 0xa0, 0x17, 0x70, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01
	]

	for (let k = header.length; k < bytes.length; k++) bytes[k] = (k * 2654435761) >>> 24

	bytes.set(header)

	return bytes
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

describe("presentation objects performance", () => {
	it("presentationObjectsPerf: a 24-megapixel picture inserted within 400 ms CPU", { timeout: 60_000 }, async ({ task }) => {
		let best = Infinity

		for (let run = 0; run < 3; run++) {
			const h = await editHarness(pictureDeck(), { emit: emitPptx } as never)
			const deck = h.session.deck
			const image = { bytes: jpeg24mp(), contentType: "image/jpeg", width: 6000, height: 4000 }
			const op = insertPictureOp(deck, deck.slides[0] as never, image, 0)
			const start = cpuMs()
			const result = await h.command(op)

			best = Math.min(best, cpuMs() - start)
			expect(result.ok).toBe(true)
		}

		Object.assign(task.meta, { perf: { presentationObjectsPicturePerf: { value: best, budget: 400 } } })
		expect(best).toBeLessThanOrEqual(400)
	})

	it(
		"presentationObjectsPerf: a cell edit of a 20 × 20 table of two-paragraph cells, command and re-render, within 15 ms CPU",
		{ timeout: 120_000 },
		async ({ task }) => {
			const h = await editHarness(pictureDeck(), { emit: emitPptx } as never, { text: presentationTextServices })
			const deck = h.session.deck
			const slide = deck.slides[0] as never
			const inserted = await h.command(insertTableOp(deck, slide, 20, 20, 50) as DeckOp)
			const target = { slide, id: 50 }

			expect(inserted.ok).toBe(true)

			// Every cell holds two paragraphs of three runs, bold and italic among them, as a filled table does.
			for (let row = 0; row < 20; row++) {
				for (let col = 0; col < 20; col++) {
					const filled = await h.command({
						family: "table",
						kind: "setCellText",
						target,
						row,
						col,
						body: {
							bodyPr: {},
							paragraphs: [
								{
									pPr: {},
									runs: [
										{ kind: "r", text: `Quarterly revenue ${String(row)} `, rPr: { b: true } },
										{ kind: "r", text: `region ${String(col)} grew strongly`, rPr: {} }
									]
								},
								{ pPr: {}, runs: [{ kind: "r", text: "see notes", rPr: { i: true } }] }
							]
						}
					})

					expect(filled.ok).toBe(true)
				}
			}

			await viewCapability.render(h.context, [slide])

			const runs: number[] = []

			// Two edits first settle the engine (and the collector after the test before); the next nine are measured.
			for (let run = 0; run < 11; run++) {
				const start = cpuMs()
				const edited = await h.command({
					family: "table",
					kind: "setCellText",
					target,
					row: 7,
					col: 7,
					body: {
						bodyPr: {},
						paragraphs: [
							{ pPr: {}, runs: [{ kind: "r", text: `edited value number ${String(run)} with more words`, rPr: {} }] }
						]
					}
				})

				await viewCapability.render(h.context, [slide])
				if (run >= 2) runs.push(cpuMs() - start)
				expect(edited.ok).toBe(true)
			}

			const sorted = [...runs].sort((a, b) => a - b)
			const worst = sorted[sorted.length - 1] ?? Infinity

			Object.assign(task.meta, {
				perf: {
					presentationObjectsCellEditPerf: { value: worst, budget: 15 },
					presentationObjectsCellEditMedian: { value: sorted[Math.floor(sorted.length / 2)] ?? Infinity, budget: 15 }
				}
			})
			expect(worst).toBeLessThanOrEqual(budget(15))
		}
	)
})
