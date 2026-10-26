import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { renderSlide } from "../core/presentation/render/slide"
import type { Slicing } from "../core/slicing"
import { CORPUS_DIR } from "./corpusDir"
import { openRenderDeck } from "./fixtures/presentation/renderDeck"
import { cpuMs } from "./timing"

// A slide model to its SlideRender (drawings, no text layout), cold: every run builds the slide's resolved elements
// and theme anew. Per slide the least CPU of three runs; the budget is on the median and p99 over the deck.

const SHAPING = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")
const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }

function quantile(values: readonly number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b)

	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

describe.skipIf(!existsSync(SHAPING))("renderSlidePerf", () => {
	it("renders each slide of govuk Shaping (81 slides) in at most 15 ms median and 60 ms p99 CPU", async ({ task }) => {
		const opened = await openRenderDeck(readFileSync(SHAPING))

		if (opened === undefined) throw new Error("The deck did not open")

		const { deck, services } = opened
		const times: number[] = []

		// Warm the code paths once.
		for (const ref of deck.slides) await renderSlide(deck, ref, { ...services }, SLICING)

		for (const ref of deck.slides) {
			let best = Number.POSITIVE_INFINITY

			for (let run = 0; run < 3; run++) {
				const fresh = { ...services }
				const start = cpuMs()

				await renderSlide(deck, ref, fresh, SLICING)
				best = Math.min(best, cpuMs() - start)
			}

			times.push(best)
		}

		const median = quantile(times, 0.5)
		const p99 = quantile(times, 0.99)

		Object.assign(task.meta, {
			perf: { renderSlideMedianCpuMs: { value: median, budget: 15 }, renderSlideP99CpuMs: { value: p99, budget: 60 } }
		})

		expect(times).toHaveLength(81)
		expect(median).toBeLessThanOrEqual(15)
		expect(p99).toBeLessThanOrEqual(60)
	}, 120_000)
})
