import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, type ByteSource } from "@filen/office/core/opc"
import { openOdp } from "../core/odp/read/document"
import { saveOdp } from "../core/odp/write/save"
import { CORPUS_DIR } from "./corpusDir"
import { liveHeapNow } from "./liveHeap"
import { budget, cpuMs } from "./timing"
import { changes } from "./odpWriteFixtures"

// Saving odftk Presentation3.odp (1,000 pages, 2.4 MB of content.xml) after one shape moved on one page, as the
// worker does: pages parsed lazily (only the edited one), the splice (untouched pages copied by their spans, the page
// compared with a pristine reading of the source), gate 2 (the package re-opened and the page read back) and the zip
// in memory. The least CPU of three warm runs; the peak of the live heap (array buffers included) above the model.

const DECK = join(CORPUS_DIR, "odp", "odftk__Presentation3.odp")

describe.skipIf(!existsSync(DECK))("odpSavePerf", () => {
	it(
		"saves the 1,000-page deck with one slide edited in at most 2 s CPU and 64 MiB above the model",
		{ timeout: budget(180_000) },
		async ({ task }) => {
			const bytes = new Uint8Array(readFileSync(DECK))
			let best = Number.POSITIVE_INFINITY
			let peak = 0

			for (let run = 0; run < 5; run++) {
				const measured = run === 4
				let top = 0
				let reads = 0
				const sample = (): void => {
					if (measured) top = Math.max(top, liveHeapNow())
				}
				const file = bytesSource(bytes)
				// Every 16th read of the source samples the live heap (each sample is two full collections).
				const sampled: ByteSource = {
					size: file.size,
					read: (offset, length) => {
						if (reads++ % 16 === 0) sample()

						return file.read(offset, length)
					}
				}
				const open = await openOdp(sampled)

				if (open.kind !== "opened") throw new Error(open.reason)

				const ref = open.deck.slides[500]

				if (ref === undefined) throw new Error("no slide")

				const node = await open.parts.slide(ref)
				const shape = node.shapes.find(
					candidate => candidate.xfrm !== undefined && candidate.synthetic !== true && candidate.lock === undefined
				)

				if (shape?.xfrm === undefined) throw new Error("no shape")

				shape.xfrm = { ...shape.xfrm, x: shape.xfrm.x + 12_700 }
				node.revision++

				let written = 0
				const sink = {
					write: (chunk: Uint8Array) => {
						written += chunk.length
						sample()

						return Promise.resolve()
					},
					close: () => Promise.resolve()
				}
				const before = measured ? liveHeapNow() : 0
				const start = cpuMs()
				const outcome = await saveOdp({ deck: open.deck, source: { parts: open.parts }, changes: changes(), revision: 1 }, sink)
				const spent = cpuMs() - start

				expect(outcome.kind).toBe("written")
				expect(written).toBeGreaterThan(0)

				if (measured) peak = Math.max(top, liveHeapNow()) - before
				else if (run > 0) best = Math.min(best, spent)
			}

			const peakMiB = peak / (1024 * 1024)

			Object.assign(task.meta, {
				perf: {
					odpSaveCpuMs: { value: best, budget: 2000 },
					odpSavePeakMiB: { value: peakMiB, budget: 64 }
				}
			})
			expect(best).toBeLessThanOrEqual(2000)
			expect(peakMiB).toBeLessThanOrEqual(64)
		}
	)
})
