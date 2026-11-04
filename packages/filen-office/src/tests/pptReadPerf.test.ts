import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { pptToPptx } from "../core/ppt/toPptx"
import { openPptxPackage } from "../core/pptx/package"
import { CORPUS_DIR } from "./corpusDir"
import { budget, cpuMs } from "./timing"

// A 10.4 MB PowerPoint 97–2003 deck (19 slides, pictures in the Pictures stream) to its in-memory pptx: the persist
// directory, document, masters, slides and every part, its pictures read and decoded, then the pptx reader's open and
// the first slide. The least CPU of three warm runs.

const DECK = join(CORPUS_DIR, "ppt", "govuk__bis-13-594e-review-science-engineering-in-civil-service-e-careers-template.ppt")

describe.skipIf(!existsSync(DECK))("pptReadPerf", () => {
	it("converts the 10.4 MB deck to an in-memory pptx in at most 1.2 s CPU", { timeout: budget(120_000) }, async ({ task }) => {
		const bytes = new Uint8Array(readFileSync(DECK))
		let best = Number.POSITIVE_INFINITY
		let open = Number.POSITIVE_INFINITY

		expect(bytes.length).toBeGreaterThan(10_000_000)

		await pptToPptx(bytesSource(bytes))

		for (let run = 0; run < 3; run++) {
			const start = cpuMs()
			const converted = await pptToPptx(bytesSource(bytes))

			if (converted.kind === "refused") throw new Error(converted.reason)

			for (const entry of converted.pptx.entries()) await converted.pptx.read(entry.name)

			best = Math.min(best, cpuMs() - start)

			const opening = cpuMs()
			const opened = await openPptxPackage(converted.pptx)

			if (opened.kind === "refused") throw new Error(opened.reason)

			const [first] = opened.deck.slides

			if (first !== undefined) await opened.parts.slide(first)

			open = Math.min(open, cpuMs() - opening)
		}

		Object.assign(task.meta, { perf: { pptReadCpuMs: { value: best, budget: 1200 }, pptOpenConvertedCpuMs: { value: open } } })
		expect(best).toBeLessThanOrEqual(budget(1200))
	})
})
