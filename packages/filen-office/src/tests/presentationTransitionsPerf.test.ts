import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Transition } from "../core/anim/model"
import { emitPptx } from "../core/pptx/write/emit"
import { CORPUS_DIR } from "./corpusDir"
import { odpApplier, openOdpDeck } from "./odpWriteFixtures"
import { editHarness } from "./presentationEditFixtures"
import { budget, cpuMs } from "./timing"

// A transition applied to every slide of an 81-slide deck, in worker CPU: the transition op over all of them
// through the edit session, its slides parsed as the editor's renders parse them (a transition op proves no shape:
// it writes none).

const PPTX = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")
const ODP = join(CORPUS_DIR, "odp", "govuk__Shaping_the_Qualifications_Landscape.odp")
const LIMIT_MS = 100
const RUNS = 5
const PUSH: Transition = { kind: "push", namespace: "p", options: { dir: "u" }, durationMs: 1200, advance: { onClick: true } }
const VORTEX: Transition = { kind: "vortex", namespace: "p14", options: {}, durationMs: 3000, advance: { onClick: true } }

describe.skipIf(!existsSync(PPTX) || !existsSync(ODP))("transition apply to all", () => {
	it(`sets one transition on all 81 slides of a pptx in ≤ ${String(LIMIT_MS)} ms CPU`, { timeout: budget(120_000) }, async () => {
		const h = await editHarness(new Uint8Array(readFileSync(PPTX)), { emit: emitPptx })
		const slides = h.session.deck.slides

		expect(slides).toHaveLength(81)

		try {
			for (let index = 0; index < slides.length; index++) await h.slide(index)

			let first = 0
			let best = Number.POSITIVE_INFINITY

			for (let run = 0; run < RUNS; run++) {
				const start = cpuMs()
				const result = await h.command({ family: "transition", kind: "set", slides, transition: run % 2 === 0 ? VORTEX : PUSH })
				const spent = cpuMs() - start

				expect(result.ok).toBe(true)

				if (run === 0) first = spent
				else best = Math.min(best, spent)
			}

			// The first command reads each slide's relationships once; the ones after it apply only.
			expect(first).toBeLessThanOrEqual(budget(LIMIT_MS))
			expect(best).toBeLessThanOrEqual(budget(LIMIT_MS / 10))
		} finally {
			h.close()
		}
	})

	it(`sets one transition on all 81 pages of an ODP in ≤ ${String(LIMIT_MS)} ms CPU`, { timeout: budget(120_000) }, async () => {
		const opened = await openOdpDeck(new Uint8Array(readFileSync(ODP)))
		const apply = odpApplier(opened)
		const slides = opened.deck.slides
		let worst = 0

		expect(slides).toHaveLength(81)

		for (let run = 0; run < RUNS; run++) {
			const start = cpuMs()
			const refusal = apply({ family: "transition", kind: "set", slides, transition: run % 2 === 0 ? PUSH : VORTEX })

			worst = Math.max(worst, cpuMs() - start)
			expect(refusal).toBeUndefined()
		}

		expect(worst).toBeLessThanOrEqual(budget(LIMIT_MS))
	})
})
