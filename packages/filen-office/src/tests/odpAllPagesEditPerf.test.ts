import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SlideNode } from "../core/presentation/model"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { odpBytes } from "./odpFixtures"
import { presetTransition, TRANSITION_PRESETS } from "../core/anim/presets/transitions/catalog"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { budget, cpuMs } from "./timing"

// An op on every page of a 1000-page ODP deck (Apply to All of a transition), its pages parsed. A page is proved when
// an op first rewrites its shapes (a transition writes none), and then against the names its streams take and the deck's page names, read once per reading and deck state,
// and reads its new styles back over the reading's style sheet, never the whole content stream again per page.

const DECK = join(CORPUS_DIR, "odp", "odftk__Presentation3.odp")

describe.skipIf(!existsSync(DECK))("odpAllPagesEditPerf", () => {
	it(
		"applies a transition to all 1000 parsed pages, each proved on its first edit, in at most 1 s CPU",
		{ timeout: budget(300_000) },
		async ({ task }) => {
			const d = await driveSession(new Uint8Array(readFileSync(DECK)), "odp")
			const slides = [...d.session.deck.slides]
			const vortex = TRANSITION_PRESETS.find(entry => entry.kind === "vortex")

			if (vortex === undefined) throw new Error("no vortex preset")

			expect(slides.length).toBe(1000)
			await odpParts(d.session.deck)?.parseAll()

			const start = cpuMs()
			const result = await d.command({ family: "transition", kind: "set", slides, transition: presetTransition(vortex) })
			const spent = cpuMs() - start

			expect(result).toMatchObject({ ok: true })
			Object.assign(task.meta, { perf: { odpAllPagesEditCpuMs: { value: spent, budget: 1000 } } })
			expect(spent).toBeLessThan(1000)
		}
	)
})

describe("an ODP page's proof", () => {
	const deck = odpBytes({
		body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:custom-shape draw:name="Box" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="2cm"><text:p>Box</text:p><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/></draw:custom-shape></draw:page>'
	})

	it("waits for an op that rewrites the page's shapes, and proves the page before that op applies", async () => {
		const d = await driveSession(deck, "odp")
		const slide = d.session.deck.slides[0]
		const vortex = TRANSITION_PRESETS.find(entry => entry.kind === "vortex")

		if (slide === undefined || vortex === undefined) throw new Error("no slide")

		expect(await d.command({ family: "transition", kind: "set", slides: [slide], transition: presetTransition(vortex) })).toMatchObject(
			{ ok: true }
		)
		expect(sessionEdits(d.session).proofs().has(slide)).toBe(false)

		const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes[0]

		if (shape === undefined) throw new Error("no shape")

		expect(
			await d.command({ family: "shape", kind: "setAlt", target: { slide, id: shape.id }, alt: { descr: "Moved" } })
		).toMatchObject({ ok: true })
		expect(sessionEdits(d.session).proofs().get(slide)).toMatchObject({ shapes: 1 })
	})
})
