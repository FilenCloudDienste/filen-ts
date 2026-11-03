import { describe, expect, it } from "vitest"
import { decodeEot } from "../core/fonts/eot"
import { corpusFonts } from "./embeddedFontFixtures"
import { budget, cpuMs } from "./timing"

// eotPerf: the four Roboto faces one corpus deck embeds (MicroType Express compressed, about 270 KB of font data
// together) decode in at most 150 ms of CPU; every embedded font of the corpus is recorded beside them.

const RUNS = 3
const FONTS = corpusFonts()
const ROBOTO = FONTS.filter(font => font.name.includes("Civil_Society") && font.name.includes("Roboto"))

function decodeAll(fonts: readonly { readonly bytes: Uint8Array }[]): number {
	let best = Number.POSITIVE_INFINITY

	for (let run = 0; run < RUNS; run++) {
		const start = cpuMs()

		for (const font of fonts) decodeEot(font.bytes)

		best = Math.min(best, cpuMs() - start)
	}

	return best
}

describe.skipIf(ROBOTO.length !== 4)("embedded font decoding", () => {
	it("decodes four corpus fonts in at most 150 ms of CPU", { timeout: budget(60_000) }, ({ task }) => {
		const four = decodeAll(ROBOTO)
		const all = decodeAll(FONTS)

		Object.assign(task.meta, { perf: { fourFontsCpuMs: { value: four, budget: 150 }, allFontsCpuMs: { value: all } } })

		expect(four).toBeLessThanOrEqual(budget(150))
	})
})
