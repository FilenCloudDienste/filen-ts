import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ByteSink } from "../core/opc/index"
import { readImage, renderSlideFor } from "../dom/presentation/engine/view"
import { slideImage, slideImageName, writeImageZip } from "../dom/presentation/raster"
import { installPresentationRealm, type RealmCanvas } from "../dom/presentation/services"
import { CORPUS_DIR } from "./corpusDir"
import { liveHeap, liveHeapNow } from "./liveHeap"
import { encodePng } from "./oracles/presentation/pixel"
import { installTestRealm, openDeck } from "./presentationExportFixtures"
import { budget, cpuMs } from "./timing"

// The 81-slide govuk Shaping deck as PNGs 1920 px wide in a stored zip: each slide rendered, painted through the canvas
// painters, encoded and written into the zip before the next, as the jobs worker does. Node has no 2D canvas, so the
// painters' calls land on nothing, but each canvas holds its real pixels (cleared white, as the export does) and
// encodes them to a real PNG (in JS here, natively in a browser: its CPU is counted apart); the harness measures the
// browsers' painting. Budgets: about 3x measured (CPU, the least of three runs; live heap above the open deck at any
// slide).

const DECK = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")
const CPU_BUDGET_MS = 650
const ENCODE_BUDGET_MS = 16_000
const PEAK_BUDGET_MB = 32
// CPU spent encoding, so far.
let encodeMs = 0

const inert: unknown = new Proxy(function inertCall() {}, {
	get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : inert),
	apply: () => inert,
	set: () => true
})

const canvas: RealmCanvas = {
	canvas: (width, height) => {
		const data = new Uint8Array(width * height * 4)
		const context = new Proxy(
			{
				fillRect: () => {
					data.fill(255)
				}
			},
			{ get: (target, key) => (key === "fillRect" ? target.fillRect : inert), set: () => true }
		)

		return {
			width,
			height,
			close: () => undefined,
			getContext: () => context,
			transferToImageBitmap: () => ({ width, height, close: () => undefined }),
			convertToBlob: () => {
				const start = cpuMs()
				const png = encodePng({ width, height, data })

				encodeMs += cpuMs() - start

				return Promise.resolve({
					arrayBuffer: () => Promise.resolve(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength))
				})
			}
		} as never
	},
	decode: () => Promise.resolve(undefined),
	copy: () => Promise.resolve(undefined),
	fontsReady: () => Promise.resolve()
}

beforeAll(() => {
	installTestRealm()
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe.skipIf(!existsSync(DECK))("presentationRasterPerf", () => {
	it(
		"zips govuk Shaping's 81 slides at 1920 px, encoded, within its CPU and memory budgets",
		{ timeout: budget(300_000) },
		async ({ task }) => {
			const context = await openDeck(new Uint8Array(readFileSync(DECK)))
			const deck = context.session.deck
			let written = 0
			const sink: ByteSink = {
				write: chunk => {
					written += chunk.length

					return Promise.resolve()
				},
				close: () => Promise.resolve()
			}
			let peak = 0
			const before = await liveHeap()
			const run = async (sample: boolean): Promise<number> => {
				async function* images() {
					for (let index = 0; index < deck.slides.length; index++) {
						const render = await renderSlideFor(context, deck.slides[index] as (typeof deck.slides)[number])
						const bytes = await slideImage(render, {
							canvas,
							size: deck.size,
							widthPx: 1920,
							format: "png",
							read: async part => (await readImage(context.session, part))?.bytes ?? null
						})

						if (bytes === undefined) throw new Error("no image")

						yield { name: slideImageName(index, "png"), bytes }

						if (sample && index % 10 === 9) peak = Math.max(peak, liveHeapNow() - before)
					}
				}

				const start = cpuMs()

				encodeMs = 0
				await writeImageZip(images(), sink)

				return cpuMs() - start
			}

			// Warm: slides parsed, faces loaded.
			await run(false)

			let best = Number.POSITIVE_INFINITY
			let encode = Number.POSITIVE_INFINITY

			for (let k = 0; k < 3; k++) {
				const total = await run(false)

				best = Math.min(best, total - encodeMs)
				encode = Math.min(encode, encodeMs)
			}

			await run(true)

			const peakMb = peak / (1024 * 1024)

			Object.assign(task.meta, {
				perf: {
					rasterCpuMs: { value: best, budget: CPU_BUDGET_MS },
					encodeCpuMs: { value: encode, budget: ENCODE_BUDGET_MS },
					peakMb: { value: peakMb, budget: PEAK_BUDGET_MB }
				}
			})
			// Every slide's PNG went in (a 1920 x 1080 PNG is more than its 33-byte header and IEND).
			expect(written).toBeGreaterThan(81 * 1024)
			expect(best).toBeLessThanOrEqual(CPU_BUDGET_MS)
			expect(encode).toBeLessThanOrEqual(ENCODE_BUDGET_MS)
			expect(peakMb).toBeLessThanOrEqual(PEAK_BUDGET_MB)
		}
	)
})
