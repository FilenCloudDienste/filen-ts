import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { findInDeck } from "../dom/presentation/engine/find"
import { PRESENTATION_FIND_INTS } from "../dom/presentation/protocol"
import { CORPUS_DIR } from "./corpusDir"
import { editHarness } from "./presentationEditFixtures"
import { budget, cpuMs } from "./timing"

// Find over govuk Shaping (81 slides with notes, tables and groups): the least CPU of three runs over parsed slides,
// and the first search of a fresh session (every slide parsed on the way) reported beside it.

const SHAPING = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")

describe.skipIf(!existsSync(SHAPING))("presentationFindPerf", () => {
	it("finds across 81 slides, notes and tables in at most 80 ms CPU", { timeout: budget(120_000) }, async ({ task }) => {
		const bytes = new Uint8Array(readFileSync(SHAPING))
		const h = await editHarness(bytes)
		const coldStart = cpuMs()
		const first = await findInDeck(h.context, "qualification")
		const cold = cpuMs() - coldStart
		let best = Number.POSITIVE_INFINITY
		let count = 0

		for (let run = 0; run < 3; run++) {
			const start = cpuMs()
			const found = await findInDeck(h.context, run === 2 ? "the" : "qualification", { wholeWord: run === 1 })

			best = Math.min(best, cpuMs() - start)
			count = Math.max(count, found.length / PRESENTATION_FIND_INTS)
		}

		h.close()
		Object.assign(task.meta, {
			perf: { presentationFindCpuMs: { value: best, budget: 80 }, presentationFindColdCpuMs: { value: cold } }
		})
		expect(first.length).toBeGreaterThan(0)
		expect(count).toBeGreaterThan(0)
		expect(best).toBeLessThanOrEqual(budget(80))
	})
})
