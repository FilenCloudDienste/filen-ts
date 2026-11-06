import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { installPresentationRealm } from "../dom/presentation/services"
import { CORPUS_DIR } from "./corpusDir"
import { liveHeap, liveHeapNow } from "./liveHeap"
import { deckPdf, installTestRealm, openDeck } from "./presentationExportFixtures"
import { budget, cpuMs } from "./timing"

// The 81-slide govuk Shaping deck as a tagged PDF made by the PDF job over the session's port: every slide rendered,
// its text painted with subset fonts and its pictures embedded, page by page. Budgets: about 3x measured (CPU, the
// least of three runs; live heap above the open deck at any page, the PDF so far included).

const DECK = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")
const CPU_BUDGET_MS = 750
const PEAK_BUDGET_MB = 48

beforeAll(() => {
	installTestRealm()
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe.skipIf(!existsSync(DECK))("presentationPdfPerf", () => {
	it("writes govuk Shaping's 81 slides within its CPU and memory budgets", { timeout: budget(300_000) }, async ({ task }) => {
		const context = await openDeck(new Uint8Array(readFileSync(DECK)))

		// Warm: slides parsed, faces loaded.
		await deckPdf(context)

		let best = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const start = cpuMs()
			const { bytes } = await deckPdf(context)

			best = Math.min(best, cpuMs() - start)
			expect(bytes.length).toBeGreaterThan(0)
		}

		const before = await liveHeap()
		let peak = 0

		await deckPdf(context, {
			onPage: page => {
				if (page % 10 === 9) peak = Math.max(peak, liveHeapNow() - before)
			}
		})
		peak = Math.max(peak, (await liveHeap()) - before)

		const peakMb = peak / (1024 * 1024)

		Object.assign(task.meta, {
			perf: { pdfCpuMs: { value: best, budget: CPU_BUDGET_MS }, peakMb: { value: peakMb, budget: PEAK_BUDGET_MB } }
		})
		expect(best).toBeLessThanOrEqual(budget(CPU_BUDGET_MS))
		expect(peakMb).toBeLessThanOrEqual(PEAK_BUDGET_MB)
	})
})
