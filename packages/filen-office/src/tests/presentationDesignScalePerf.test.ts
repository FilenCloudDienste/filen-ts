import { describe, expect, it } from "vitest"
import { LAYOUT_TYPES } from "../core/templates/themes/pptx"
import { editHarness } from "./presentationEditFixtures"
import { designDeck } from "./presentationDesignFixtures"
import { cpuMs } from "./timing"

// Ensure fit on 81 slides: ≤ 60 ms worker CPU for the command (every slide parsed, every box, text and table
// scaled, the undo recorded), the least of three runs.

const SLIDES = 81
const BUDGET_MS = 60

describe("presentationDesignScalePerf", () => {
	it(
		`scales the content of ${String(SLIDES)} slides to a new size within ${String(BUDGET_MS)} ms of CPU`,
		{ timeout: 60_000 },
		async () => {
			const bytes = await designDeck(Array.from({ length: SLIDES }, (_, index) => LAYOUT_TYPES[index % LAYOUT_TYPES.length] ?? "obj"))
			let best = Number.POSITIVE_INFINITY

			for (let run = 0; run < 3; run++) {
				const h = await editHarness(bytes)
				const start = cpuMs()
				const result = await h.command({
					family: "design",
					kind: "setSize",
					cx: 9_144_000,
					cy: 6_858_000,
					type: "screen4x3",
					scale: "ensureFit"
				})

				best = Math.min(best, cpuMs() - start)
				expect(result.ok).toBe(true)
				h.close()
			}

			console.log(`ensure fit on ${String(SLIDES)} slides: ${best.toFixed(1)} ms CPU`)
			expect(best).toBeLessThanOrEqual(BUDGET_MS)
		}
	)
})
