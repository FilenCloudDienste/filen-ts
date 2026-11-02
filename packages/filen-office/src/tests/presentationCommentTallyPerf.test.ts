import { describe, expect, it } from "vitest"
import { commentCharacterRoom, commentCharactersFit, setSlideComments, type CommentEntry } from "../core/presentation/comments"
import { odpBytes, page } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { budget, cpuMs } from "./timing"

// The deck's comment character tally over 10,000 slides: each slide's comments read, a slide's room and an op's fit
// asked once per slide, in constant time per step (a sum over the deck's slides per step is quadratic).

function entry(slide: number): CommentEntry {
	return {
		id: `odf:${String(slide)}`,
		format: "odf",
		author: "A",
		text: "A short comment",
		created: "",
		resolved: false,
		changed: false,
		plain: true
	}
}

describe("presentationCommentTallyPerf", () => {
	it("reads, rooms and fits the comments of 10,000 slides in at most 40 ms CPU", { timeout: budget(120_000) }, async ({ task }) => {
		const s = await driveSession(odpBytes({ body: page("").repeat(10_000) }), "odp")
		const deck = s.session.deck

		expect(deck.slides).toHaveLength(10_000)

		let fits = 0
		const start = cpuMs()

		for (const [index, slide] of deck.slides.entries()) {
			const entries = [entry(index)]

			if (commentCharactersFit(deck, slide, entries)) fits++
			setSlideComments(deck, slide, { entries, scope: new Map() })
			commentCharacterRoom(deck, slide)
		}

		const spent = cpuMs() - start

		expect(fits).toBe(10_000)

		Object.assign(task.meta, { perf: { presentationCommentTallyCpuMs: { value: spent, budget: 40 } } })
		expect(spent).toBeLessThanOrEqual(budget(40))
	})
})
