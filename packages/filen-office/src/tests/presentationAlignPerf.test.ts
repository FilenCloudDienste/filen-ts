import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { alignOp, distributeOp } from "../core/presentation/edit/commands/align"
import { moveOp } from "../core/presentation/edit/commands/shape"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { Xfrm } from "../core/presentation/model"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { buildPptx, sp, xfrm } from "./pptxFixtures"
import { cpuMs } from "./timing"

// Arranging a busy slide in the worker: aligning, distributing or dragging 500 shapes is one command of at most
// 30 ms CPU (the least of 3 runs), proof gate 1 of the slide already paid by an earlier edit.

const SHAPES = 500
const RUNS = 3
const BUDGET_MS = 30

function busyDeck(): Uint8Array {
	let shapes = ""

	for (let k = 0; k < SHAPES; k++) {
		shapes += sp(
			k + 2,
			`Box ${String(k)}`,
			undefined,
			`${xfrm((k % 25) * 300000 + (k % 7) * 1000, Math.floor(k / 25) * 300000, 200000 + (k % 5) * 10000, 150000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
		)
	}

	return buildPptx({ slides: [{ shapes }] })
}

async function measure(h: EditHarness, op: () => DeckOp | undefined): Promise<number> {
	let least = Infinity

	for (let run = 0; run < RUNS; run++) {
		const command = op()

		if (command === undefined) throw new Error("no op")

		const start = cpuMs()
		const result = await h.command(command)

		least = Math.min(least, cpuMs() - start)
		expect(result).toMatchObject({ ok: true })
		expect(await h.undo()).toMatchObject({ ok: true })
	}

	return least
}

describe("presentation arrange performance", () => {
	it(
		`align, distribute and a drag of ${String(SHAPES)} shapes each take at most ${String(BUDGET_MS)} ms CPU in the worker`,
		{ timeout: 60_000 },
		async () => {
			const h = await editHarness(busyDeck(), { emit: emitPptx } as never)
			const slide = await h.slide(0)
			const ids = slide.shapes.map(shape => shape.id)
			const placed = slide.shapes.map(shape => ({ id: shape.id, xfrm: shape.xfrm as Xfrm }))

			// The slide's first edit proves it (gate 1); arranging is measured after.
			expect(
				await h.command({ family: "shape", kind: "setAlt", target: { slide: slide.ref, id: 2 }, alt: { descr: "first" } })
			).toMatchObject({ ok: true })

			const align = await measure(h, () => alignOp(slide.ref, ids, "top", "selection"))
			const distribute = await measure(h, () => distributeOp(slide.ref, ids, "horizontal", "slide"))
			const drag = await measure(h, () => moveOp(slide.ref, placed, 9525, 9525))

			h.close()

			expect(align).toBeLessThanOrEqual(BUDGET_MS)
			expect(distribute).toBeLessThanOrEqual(BUDGET_MS)
			expect(drag).toBeLessThanOrEqual(BUDGET_MS)
		}
	)
})
