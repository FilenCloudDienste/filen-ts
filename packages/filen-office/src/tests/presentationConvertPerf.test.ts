import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive, type ByteSink } from "@filen/office/core/opc"
import { convertPresentation, type ConversionSource, type PresentationTarget } from "../core/convert/presentation/index"
import { openOdp } from "../core/odp/read/document"
import { openPptx } from "../core/pptx/package"
import type { Deck } from "../core/presentation/model"
import { CORPUS_DIR } from "./corpusDir"
import { liveHeapNow } from "./liveHeap"
import { budget, cpuMs } from "./timing"

// Converting govuk Shaping (81 slides, pictures, tables, charts) both ways as a conversion job does: the file opened,
// every slide parsed, the fresh package written to a sink that keeps nothing. The least CPU of three warm runs; the
// peak of the live heap (array buffers included) above what was live before the file was read.

const PPTX = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")
const ODP = join(CORPUS_DIR, "odp", "govuk__Shaping_the_Qualifications_Landscape.odp")
const CPU_BUDGET_MS = 4000
const HEAP_BUDGET = 250 * 1024 * 1024

async function opened(path: string): Promise<{ readonly deck: Deck; readonly input: ConversionSource }> {
	const bytes = new Uint8Array(readFileSync(path))

	if (path.endsWith(".odp")) {
		const open = await openOdp(bytesSource(bytes))

		if (open.kind !== "opened") throw new Error(open.reason)

		return { deck: open.deck, input: { format: "odp", parts: open.parts } }
	}

	const open = await openPptx(bytesSource(bytes))

	if (open.kind !== "opened") throw new Error(open.reason)

	return {
		deck: open.deck,
		input: {
			format: "pptx",
			parts: open.parts,
			source: { archive: await ZipArchive.open(bytesSource(bytes)), package: open.parts.opc }
		}
	}
}

async function measure(
	path: string,
	target: PresentationTarget
): Promise<{ readonly cpu: number; readonly heap: number; readonly size: number }> {
	let best = Number.POSITIVE_INFINITY
	let heap = 0
	let size = 0

	for (let run = 0; run < 4; run++) {
		const measured = run === 3
		const before = measured ? liveHeapNow() : 0
		let top = before
		let writes = 0
		let written = 0
		const sink: ByteSink = {
			write: chunk => {
				written += chunk.length

				if (measured && writes++ % 8 === 0) top = Math.max(top, liveHeapNow())

				return Promise.resolve()
			},
			close: () => Promise.resolve()
		}
		const start = cpuMs()
		const { deck, input } = await opened(path)
		const converted = await convertPresentation(deck, input, target, sink)
		const spent = cpuMs() - start

		if ("kind" in converted) throw new Error(`${converted.reason} ${converted.detail ?? ""}`)

		if (measured) heap = Math.max(top, liveHeapNow()) - before
		// The first run warms the code up.
		if (run > 0) best = Math.min(best, spent)

		size = written
	}

	return { cpu: best, heap, size }
}

describe.skipIf(!existsSync(PPTX) || !existsSync(ODP))("presentationConvertPerf", () => {
	it("converts govuk Shaping .pptx to .odp in at most 4 s CPU and 250 MB", { timeout: budget(240_000) }, async ({ task }) => {
		const { cpu, heap, size } = await measure(PPTX, "odp")

		Object.assign(task.meta, {
			perf: { pptxToOdpCpuMs: { value: cpu, budget: CPU_BUDGET_MS }, pptxToOdpHeapBytes: { value: heap, budget: HEAP_BUDGET } }
		})
		expect(size).toBeGreaterThan(100_000)
		expect(cpu).toBeLessThanOrEqual(budget(CPU_BUDGET_MS))
		expect(heap).toBeLessThanOrEqual(HEAP_BUDGET)
	})

	it("converts govuk Shaping .odp to .pptx in at most 4 s CPU and 250 MB", { timeout: budget(240_000) }, async ({ task }) => {
		const { cpu, heap, size } = await measure(ODP, "pptx")

		Object.assign(task.meta, {
			perf: { odpToPptxCpuMs: { value: cpu, budget: CPU_BUDGET_MS }, odpToPptxHeapBytes: { value: heap, budget: HEAP_BUDGET } }
		})
		expect(size).toBeGreaterThan(100_000)
		expect(cpu).toBeLessThanOrEqual(budget(CPU_BUDGET_MS))
		expect(heap).toBeLessThanOrEqual(HEAP_BUDGET)
	})
})
