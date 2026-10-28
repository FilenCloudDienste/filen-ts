import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import { LAYOUT_TYPES } from "../core/templates/themes/pptx"
import { editHarness } from "./presentationEditFixtures"
import { designDeck } from "./presentationDesignFixtures"
import { cpuMs } from "./timing"

// Theme apply on 81 slides: ≤ 300 ms worker CPU for the command (every slide parsed, proved and moved onto the new
// theme's layouts), the least of three runs.

const SLIDES = 81
const BUDGET_MS = 300

describe("presentationDesignPerf", () => {
	it(`applies a gallery theme to ${String(SLIDES)} slides within ${String(BUDGET_MS)} ms of CPU`, { timeout: 60_000 }, async () => {
		const bytes = await designDeck(Array.from({ length: SLIDES }, (_, index) => LAYOUT_TYPES[index % LAYOUT_TYPES.length] ?? "obj"))
		let best = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const h = await editHarness(bytes)
			const op: DeckOp = {
				family: "design",
				kind: "setTheme",
				theme: { kind: "gallery", id: "harbor", variant: run },
				slides: [...h.session.deck.slides]
			}
			const start = cpuMs()
			const result = await h.command(op)

			best = Math.min(best, cpuMs() - start)
			expect(result.ok).toBe(true)
			h.close()
		}

		expect(best).toBeLessThanOrEqual(BUDGET_MS)
	})
})
