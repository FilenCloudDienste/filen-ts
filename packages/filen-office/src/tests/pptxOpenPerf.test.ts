import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openPptx } from "../core/pptx/package"
import { CORPUS_DIR } from "./corpusDir"
import { budget, cpuMs } from "./timing"

// Opening govuk Shaping (16.7 MB, 81 slides, 4 masters, 44 layouts) into the model with slides read lazily: the
// package policy, presentation, masters, layouts, themes and every slide's hidden flag. The least CPU of three
// warm runs.

const SHAPING = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")

describe.skipIf(!existsSync(SHAPING))("pptxOpenPerf", () => {
	it("opens govuk Shaping into the model in at most 250 ms CPU, slides lazy", { timeout: budget(60_000) }, async ({ task }) => {
		const bytes = new Uint8Array(readFileSync(SHAPING))
		let best = Number.POSITIVE_INFINITY
		let firstSlide = Number.POSITIVE_INFINITY

		await openPptx(bytesSource(bytes))

		for (let run = 0; run < 3; run++) {
			const start = cpuMs()
			const open = await openPptx(bytesSource(bytes))

			best = Math.min(best, cpuMs() - start)

			if (open.kind !== "opened") throw new Error(open.reason)

			const [first] = open.deck.slides

			if (first === undefined) throw new Error("no slides")

			expect(open.deck.nodes.has(first)).toBe(false)

			const parse = cpuMs()

			await open.parts.slide(first)
			firstSlide = Math.min(firstSlide, cpuMs() - parse)
		}

		Object.assign(task.meta, {
			perf: { pptxOpenCpuMs: { value: best, budget: 250 }, pptxFirstSlideCpuMs: { value: firstSlide } }
		})
		expect(best).toBeLessThanOrEqual(budget(250))
	})
})
