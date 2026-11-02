import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Paragraph, SlideRef, TextBody } from "../core/presentation/model"
import { notesTarget } from "../core/presentation/notes"
import { review } from "../dom/presentation/engine/review"
import { textCapability } from "../dom/presentation/engine/text"
import { presentationTextServices } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { editHarness } from "./presentationEditFixtures"
import { budget, cpuMs } from "./timing"

// Speaker notes typed in the notes pane go through the same text editor as a slide's body: the worker lays the
// notes body out in its notes page's box on every keystroke. A keystroke's re-layout of a 30-paragraph notes body
// stays within the slide body's budget (≤ 4 ms worker CPU), the least of five runs with a warm measuring cache.

beforeAll(() => {
	installPresentationRealm({
		text: {
			fontHost: nodeFontHost,
			replayFonts: true,
			fontAssets: nodeFontAssets,
			measurer: new HmtxMeasurer(),
			yield: () => Promise.resolve()
		},
		canvas: {
			canvas: () => undefined,
			decode: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(undefined),
			fontsReady: () => Promise.resolve()
		}
	})
})

afterAll(() => {
	installPresentationRealm(undefined)
})

function thirtyParagraphs(extra: string): TextBody {
	const paragraphs: Paragraph[] = []

	for (let k = 0; k < 30; k++) {
		paragraphs.push({
			pPr: {},
			runs: [
				{
					kind: "r",
					text: `Notes paragraph ${String(k)}: what to say about this slide, with a pause before the next point${k === 29 ? extra : ""}.`,
					rPr: {}
				}
			]
		})
	}

	return { bodyPr: {}, paragraphs }
}

describe("presentationNotesPerf", () => {
	it(
		"opens the notes body in the text editor and lays out a keystroke in a 30-paragraph body in at most 4 ms CPU",
		{ timeout: budget(60_000) },
		async ({ task }) => {
			// A deck without notes: the notes slide and our notes master are made first, as the notes pane makes them.
			const deck = buildPptx({ slides: [{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("One"))) }] })
			const h = await editHarness(deck, undefined, { text: presentationTextServices })
			const slide = h.session.deck.slides[0] as SlideRef

			expect((await h.command({ family: "notes", kind: "setNotes", slide, body: { bodyPr: {}, paragraphs: [] } })).ok).toBe(true)
			await review(h.context, slide)

			const target = notesTarget(h.session.deck, slide)

			if (target === undefined) throw new Error("no notes body")

			const seed = await textCapability.textSeed(h.context, target)

			expect(seed.page.page.width).toBeGreaterThan(100)

			let typed = ""

			// The cache warms as the editor's first layouts do.
			await textCapability.layoutText(h.context, target, thirtyParagraphs(typed), undefined, undefined)

			let best = Number.POSITIVE_INFINITY

			for (let run = 0; run < 5; run++) {
				typed += "x"

				const start = cpuMs()

				await textCapability.layoutText(h.context, target, thirtyParagraphs(typed), undefined, undefined)

				best = Math.min(best, cpuMs() - start)
			}

			h.close()
			Object.assign(task.meta, { perf: { presentationNotesKeystrokeCpuMs: { value: best, budget: 4 } } })
			expect(best).toBeLessThanOrEqual(budget(4))
		}
	)
})
