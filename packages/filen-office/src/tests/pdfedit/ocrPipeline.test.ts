import { describe, expect, it } from "vitest"
import { IDENTITY_MATRIX } from "../../core/pdfedit/matrix"
import { runOcrPages, type OcrPipeline, type OcrRenderedPage } from "../../dom/pdfedit/ocr/pipeline"
import type { OcrPageResult, OcrRecogniseArgs } from "../../dom/pdfedit/ocr/protocol"

// The pipeline's ordering and failure handling, with stand-ins for the engine and the recognisers (the real
// recogniser runs in filen-web's ocrPipeline test).

function rendered(page: number): OcrRenderedPage {
	return { pixels: new Uint8Array([page]), width: 1, height: 1, stride: 1, dpi: 72, pixelToPage: IDENTITY_MATRIX }
}

function result(args: OcrRecogniseArgs): OcrPageResult {
	return { pdf: new Uint8Array(args.pixels), turns: 0, confidence: 90, words: 3, doubtfulWords: 0, orientationPasses: 0 }
}

function harness(overrides: Partial<OcrPipeline> = {}) {
	const log: string[] = []
	const pipeline: OcrPipeline = {
		pages: [0, 1, 2, 3, 4, 5],
		render: page => {
			log.push(`render ${String(page)}`)

			return Promise.resolve(rendered(page))
		},
		flush: () => {
			log.push("flush")

			return Promise.resolve()
		},
		recognisers: [
			args => {
				log.push(`read ${String(args.pixels[0])}`)

				return Promise.resolve(result(args))
			}
		],
		apply: edit => {
			log.push(`apply ${String(edit.page)}`)

			return Promise.resolve()
		},
		...overrides
	}

	return { log, pipeline }
}

describe("OCR pipeline", () => {
	it("renders in batches of four, flushing after each, and applies every page", async () => {
		const { log, pipeline } = harness()
		const report = await runOcrPages(pipeline)

		expect(report.cancelled).toBe(false)
		expect(report.outcomes.map(outcome => outcome.status)).toEqual(["done", "done", "done", "done", "done", "done"])
		expect(log.filter(line => line === "flush")).toHaveLength(2)
		expect(log.indexOf("flush")).toBeGreaterThan(log.indexOf("render 3"))
		expect(log.indexOf("flush")).toBeLessThan(log.indexOf("render 4"))
	})

	it("recognises a batch only after rendering it when exclusive", async () => {
		const { log, pipeline } = harness({ exclusive: true })

		await runOcrPages(pipeline)

		expect(log.indexOf("read 0")).toBeGreaterThan(log.indexOf("flush"))
		// The next batch renders only once this one has been read.
		expect(log.indexOf("render 4")).toBeGreaterThan(log.indexOf("apply 3"))
	})

	it("renders the next batch while the recognisers read the last one, a page ahead per recogniser", async () => {
		const reads: (() => void)[] = []
		let renders = 0
		let taken = 0
		let mostAhead = 0
		const { log, pipeline } = harness({
			pages: [0, 1, 2, 3, 4, 5, 6, 7],
			render: page => {
				log.push(`render ${String(page)}`)
				renders++
				mostAhead = Math.max(mostAhead, renders - taken)

				return Promise.resolve(rendered(page))
			},
			recognisers: [
				args => {
					taken++
					log.push(`read ${String(args.pixels[0])}`)

					return new Promise<OcrPageResult>(resolve => {
						reads.push(() => {
							resolve(result(args))
						})
					})
				}
			]
		})
		const run = runOcrPages(pipeline)

		for (let page = 0; page < 8; page++) {
			await new Promise(resolve => setTimeout(resolve, 0))

			if (page === 3) {
				// Page 3, the batch's last, is being read: the next batch's first page is rendered meanwhile.
				expect(log.at(-1)).toBe("render 4")
				expect(log).toContain("read 3")
				expect(log).not.toContain("apply 3")
			}

			reads.shift()?.()
		}

		const report = await run

		expect(report.outcomes).toHaveLength(8)
		// At most one rendered page waits for the recogniser.
		expect(mostAhead).toBe(1)
	})

	it("reports a page that fails and goes on", async () => {
		const { pipeline } = harness({
			render: page => (page === 1 ? Promise.reject(new Error("render broke")) : Promise.resolve(rendered(page))),
			apply: edit => (edit.page === 2 ? Promise.reject(new Error("graft broke")) : Promise.resolve())
		})
		const report = await runOcrPages(pipeline)

		expect(report.outcomes.filter(outcome => outcome.status === "failed")).toEqual([
			{ page: 1, status: "failed", reason: "render broke" },
			{ page: 2, status: "failed", reason: "graft broke" }
		])
		expect(report.outcomes).toHaveLength(6)
	})

	it("stops at a cancel and applies nothing more", async () => {
		const signal = { aborted: false }
		const { log, pipeline } = harness({
			signal,
			recognisers: [
				args => {
					if (args.pixels[0] === 2) signal.aborted = true

					return Promise.resolve(result(args))
				}
			]
		})
		const report = await runOcrPages(pipeline)

		expect(report.cancelled).toBe(true)
		expect(log).not.toContain("apply 2")
		expect(log).not.toContain("render 4")
	})

	it("shares pages between two recognisers", async () => {
		const seen = new Set<number>()
		const slow = (index: number) => async (args: OcrRecogniseArgs) => {
			seen.add(index)
			await new Promise(resolve => setTimeout(resolve, 5))

			return result(args)
		}
		const { pipeline } = harness({ recognisers: [slow(0), slow(1)] })
		const report = await runOcrPages(pipeline)

		expect(report.outcomes).toHaveLength(6)
		expect(seen.size).toBe(2)
	})
})
