import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/index"
import type { Paragraph, TextBody } from "../core/presentation/model"
import { fontRequests, layoutBody, type TextEnvironment } from "../core/presentation/text/body"
import { resolveBody, type BodyContext } from "../core/presentation/text/resolve"
import { FontManager } from "../core/fonts/index"
import { MeasureCache } from "../core/text/index"
import { CORPUS_DIR } from "./corpusDir"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { layoutSlide, openDeck } from "./presentationTextHarness"
import { budget, cpuMs } from "./timing"

// Text layout CPU: every text body of govuk Shaping (81 slides) resolved and laid out from a cold measuring cache,
// and one keystroke's re-layout of a 30-paragraph body with a warm cache (the editor's layoutText). The least CPU
// of three runs; widths from the bundled faces' hmtx tables (a table lookup per character, cheaper than the
// browser's measureText, which the worker's cache absorbs after the first layout).

const SHAPING = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")

describe("presentationTextPerf", () => {
	it.skipIf(!existsSync(SHAPING))(
		"lays out every body of govuk Shaping in at most 300 ms CPU",
		{ timeout: budget(120_000) },
		async ({ task }) => {
			const opened = await openDeck(SHAPING)
			let best = Number.POSITIVE_INFINITY
			let bodies = 0

			// Fonts prepared once (as the worker does at open); layout itself is synchronous.
			for (let index = 0; index < opened.deck.slides.length; index++) {
				const ref = opened.deck.slides[index]

				if (ref !== undefined) await layoutSlide(opened, ref, index + 1)
			}

			for (let run = 0; run < 3; run++) {
				const cold = { ...opened, environment: { fonts: opened.fonts, cache: new MeasureCache(new HmtxMeasurer()) } }
				const start = cpuMs()

				bodies = 0

				for (let index = 0; index < cold.deck.slides.length; index++) {
					const ref = cold.deck.slides[index]

					if (ref !== undefined) bodies += (await layoutSlide(cold, ref, index + 1)).length
				}

				best = Math.min(best, cpuMs() - start)
			}

			Object.assign(task.meta, {
				perf: { presentationTextDeckCpuMs: { value: best, budget: 300 }, presentationTextBodies: { value: bodies } }
			})
			expect(bodies).toBeGreaterThan(100)
			expect(best).toBeLessThanOrEqual(300)
		}
	)

	it("re-lays out a 30-paragraph body after a keystroke in at most 4 ms CPU", { timeout: budget(60_000) }, async ({ task }) => {
		const fonts = new FontManager(nodeFontHost, nodeFontAssets, undefined, "fotest")
		const environment: TextEnvironment = { fonts, cache: new MeasureCache(new HmtxMeasurer()) }
		const context: BodyContext = {
			listStyles: [],
			bodyPr: [],
			fonts: { color: () => rgba("000000"), typeface: typeface => (typeface.startsWith("+") ? "Calibri" : typeface) }
		}
		const sentence = "The quick brown fox jumps over the lazy dog while the slide keeps its layout steady"
		const paragraph = (k: number, extra: string): Paragraph => ({
			pPr: { marL: 342900, indent: -342900, bullet: { kind: "char", char: "•" } },
			runs: [
				{ kind: "r", text: `${sentence} ${k}${extra}`, rPr: { sz: 1800 } },
				{ kind: "r", text: " with a bold tail", rPr: { sz: 1800, b: true } }
			]
		})
		const body = (extra: string): TextBody => ({
			bodyPr: {},
			paragraphs: Array.from({ length: 30 }, (_, k) => paragraph(k, k === 15 ? extra : ""))
		})
		const box = { width: 900, height: 600 }

		await fonts.prepare(fontRequests(resolveBody(body(""), context)))
		layoutBody(resolveBody(body(""), context), box, environment)

		let best = Number.POSITIVE_INFINITY

		for (let run = 0; run < 20; run++) {
			const typed = body("x".repeat(run + 1))
			const start = cpuMs()

			layoutBody(resolveBody(typed, context), box, environment)
			best = Math.min(best, cpuMs() - start)
		}

		Object.assign(task.meta, { perf: { presentationTextKeystrokeCpuMs: { value: best, budget: 4 } } })
		expect(best).toBeLessThanOrEqual(4)
	})
})
