import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, type ByteSink } from "../core/opc/index"
import { pptToPptx } from "../core/ppt/toPptx"
import { CORPUS_DIR } from "./corpusDir"
import { pptAsPptx } from "./pptConvertFixtures"
import { budget, cpuMs } from "./timing"

// Download as .pptx of the 10.4 MB PowerPoint 97–2003 deck (19 slides, pictures in the Pictures stream): the conversion
// and the zip of every part, written to a sink that keeps nothing. The least CPU of three warm runs.

const DECK = join(CORPUS_DIR, "ppt", "govuk__bis-13-594e-review-science-engineering-in-civil-service-e-careers-template.ppt")

function countingSink(): ByteSink & { readonly size: () => number } {
	let size = 0

	return {
		write(chunk) {
			size += chunk.length

			return Promise.resolve()
		},
		close: () => Promise.resolve(),
		size: () => size
	}
}

describe.skipIf(!existsSync(DECK))("pptToPptxPerf", () => {
	it("saves the 10.4 MB deck as .pptx in at most 2 s CPU", { timeout: budget(180_000) }, async ({ task }) => {
		const bytes = new Uint8Array(readFileSync(DECK))
		let best = Number.POSITIVE_INFINITY
		let size = 0

		for (let run = 0; run < 4; run++) {
			const start = cpuMs()
			const converted = await pptToPptx(bytesSource(bytes))

			if (converted.kind === "refused") throw new Error(converted.reason)

			const sink = countingSink()

			await pptAsPptx(converted, sink)

			// The first run warms the code up.
			if (run > 0) best = Math.min(best, cpuMs() - start)

			size = sink.size()
		}

		Object.assign(task.meta, { perf: { pptToPptxCpuMs: { value: best, budget: 2000 } } })
		expect(size).toBeGreaterThan(1_000_000)
		expect(best).toBeLessThanOrEqual(budget(2000))
	})
})
