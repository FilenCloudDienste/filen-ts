import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive, type ByteSource } from "@filen/office/core/opc"
import { openPptx } from "../core/pptx/package"
import { savePptx } from "../core/pptx/write/save"
import { CORPUS_DIR } from "./corpusDir"
import { liveHeapNow } from "./liveHeap"
import { budget, cpuMs } from "./timing"
import { Changes } from "./pptxWriteFixtures"

// Saving govuk Shaping (16.7 MB, 81 slides) after one shape moved, as the worker does: slides parsed lazily (only the
// edited one), the snapshot, gate 2 and the zip in memory. The least CPU of three warm runs; the peak of the live heap
// (array buffers included) above the model while the save runs.

const SHAPING = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")

describe.skipIf(!existsSync(SHAPING))("pptxSavePerf", () => {
	it(
		"saves govuk Shaping with one shape edited in at most 600 ms CPU and 32 MiB above the model",
		{ timeout: budget(120_000) },
		async ({ task }) => {
			const bytes = new Uint8Array(readFileSync(SHAPING))
			let best = Number.POSITIVE_INFINITY
			let peak = 0

			// Four timed runs (the first warms up), then one measured for memory: every chunk handed on and every 16th read
			// of the source samples this process's live heap (liveHeap.ts), so the figure is what the save holds, whatever
			// else runs alongside.
			for (let run = 0; run < 5; run++) {
				const measured = run === 4
				const open = await openPptx(bytesSource(bytes))

				if (open.kind !== "opened") throw new Error(open.reason)

				const ref = open.deck.slides[3]

				if (ref === undefined) throw new Error("no slide")

				const node = await open.parts.slide(ref)
				const shape = node.shapes.find(
					candidate => candidate.kind === "sp" && candidate.xfrm !== undefined && candidate.lock === undefined
				)

				if (shape?.xfrm === undefined) throw new Error("no shape")

				shape.xfrm = { ...shape.xfrm, x: shape.xfrm.x + 12700 }

				let top = 0
				let reads = 0
				const sample = (): void => {
					if (measured) top = Math.max(top, liveHeapNow())
				}
				const file = bytesSource(bytes)
				const sampled: ByteSource = {
					size: file.size,
					// Every 16th read: each sample is two full collections.
					read: (offset, length) => {
						if (reads++ % 16 === 0) sample()

						return file.read(offset, length)
					}
				}
				const source = { archive: await ZipArchive.open(sampled), package: open.parts.opc, index: open.parts }
				const changes = new Changes().shape(node.part, shape.id, { kind: "xfrm" }).build()
				let written = 0
				// Drops what it gets, as the save port's writer does (it copies into its own chunks and transfers them).
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
				const outcome = await savePptx({ deck: open.deck, source, changes, revision: 1 }, sink, {})
				const spent = cpuMs() - start

				if (outcome.kind !== "written" || written !== outcome.report.size) throw new Error(JSON.stringify(outcome))

				if (measured) peak = top - before
				else if (run > 0) best = Math.min(best, spent)
			}

			Object.assign(task.meta, {
				perf: {
					pptxSaveCpuMs: { value: best, budget: 600 },
					pptxSavePeakAboveModelBytes: { value: peak, budget: 32 * 1024 * 1024 }
				}
			})
			expect(best).toBeLessThanOrEqual(budget(600))
			expect(peak).toBeGreaterThan(0)
			expect(peak).toBeLessThanOrEqual(32 * 1024 * 1024)
		}
	)
})
