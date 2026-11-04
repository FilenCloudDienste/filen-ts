import { describe, expect, it } from "vitest"
import { applyOp, type ApplyContext } from "../core/presentation/edit/apply"
import type { DeckOp } from "../core/presentation/edit/ops"
import { DECK_HISTORY_LIMITS } from "../core/presentation/edit/history"
import { nextShapeId } from "../core/presentation/ids"
import { refused, slideRef, type Deck } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { editDeck, editHarness } from "./presentationEditFixtures"
import { budget, cpuMs } from "./timing"

// Applying 10,000 shape ops and their inverses on the model takes at most 200 ms of CPU; the history holds at most
// 64 MiB and 500 steps however many ops went through it.

function contextOf(deck: Deck): ApplyContext {
	const parts = pptxParts(deck)

	if (parts === undefined) throw new Error("no parts")

	let ref = 1 << 30

	return {
		sourceBytes: src => {
			const document = parts.document(src.part)

			return document === undefined || src.epoch !== parts.epoch ? refused("stale") : document.raw(src.node)
		},
		newShapeId: slide => nextShapeId(deck.nodes.get(slide)?.shapes ?? []),
		newSlideRef: () => slideRef(ref++)
	}
}

function opAt(slide: ReturnType<typeof slideRef>, index: number): DeckOp {
	const id = [3, 4, 5, 9][index % 4] ?? 3

	switch (index % 5) {
		case 0:
			return {
				family: "shape",
				kind: "setXfrm",
				target: { slide, id },
				xfrm: { x: index, y: index * 2, cx: 1000, cy: 500, rot: 0, flipH: false, flipV: false }
			}
		case 1:
			return {
				family: "shape",
				kind: "setProps",
				target: { slide, id },
				props: { fill: { kind: "solid", color: { kind: "scheme", slot: "accent1" } } }
			}
		case 2:
			return { family: "shape", kind: "setAlt", target: { slide, id }, alt: { descr: `shape ${String(index)}` } }
		case 3:
			return { family: "shape", kind: "zOrder", slide, shapes: [id], to: "front" }
		default:
			return { family: "shape", kind: "align", slide, shapes: [3, 4, 5], edge: "left", relativeTo: "selection" }
	}
}

describe("presentation edit performance", () => {
	it("presentationEditPerf: apply and inverse of 10,000 shape ops within 200 ms CPU", async ({ task }) => {
		const harness = await editHarness(editDeck())
		const slide = await harness.slide(0)
		const deck = harness.session.deck
		const context = contextOf(deck)
		let best = Infinity

		for (let run = 0; run < 3; run++) {
			const start = cpuMs()

			for (let index = 0; index < 10_000; index++) {
				const result = applyOp(deck, opAt(slide.ref, index), context)

				if (result.kind === "refused") throw new Error(result.reason)

				for (const back of result.inverse.ops) {
					const undone = applyOp(deck, back, context)

					if (undone.kind === "refused") throw new Error(undone.reason)
				}
			}

			best = Math.min(best, cpuMs() - start)
		}

		Object.assign(task.meta, { perf: { presentationEditApplyCpuMs: { value: best, budget: 200 } } })
		expect(best).toBeLessThanOrEqual(budget(200))
		harness.close()
	}, 60_000)

	it("presentationEditPerf: the history stays within 64 MiB and 500 steps over 10,000 commands", async ({ task }) => {
		const harness = await editHarness(editDeck())
		const slide = await harness.slide(0)
		const edits = sessionEdits(harness.session)
		const start = cpuMs()

		for (let index = 0; index < 10_000; index++) {
			const result = await harness.command(opAt(slide.ref, index))

			if (!result.ok) throw new Error(result.refusal)
		}

		const spent = cpuMs() - start

		Object.assign(task.meta, {
			perf: {
				presentationEditCommandsCpuMs: { value: spent },
				presentationEditHistorySteps: { value: edits.history.size.steps, budget: DECK_HISTORY_LIMITS.maxSteps },
				presentationEditHistoryBytes: { value: edits.history.size.bytes, budget: DECK_HISTORY_LIMITS.maxBytes }
			}
		})
		expect(edits.history.size.steps).toBeLessThanOrEqual(DECK_HISTORY_LIMITS.maxSteps)
		expect(edits.history.size.bytes).toBeLessThanOrEqual(DECK_HISTORY_LIMITS.maxBytes)
		expect(edits.history.dirty).toBe(true)
		harness.close()
	}, 120_000)
})
