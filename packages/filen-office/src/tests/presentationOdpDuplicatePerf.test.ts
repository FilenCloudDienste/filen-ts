import { describe, expect, it } from "vitest"
import type { SlideRef } from "../core/presentation/model"
import { odpBytes, page } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { budget, cpuMs } from "./timing"

// The first duplicate of a page on a 10,000-page ODP: the op proves the copy, which names every page once (a page
// named as others are takes a numbered name); the cost is the copied page's, plus one pass over the deck's names.

const PAGES = 10_000

async function firstDuplicateCpuMs(body: string): Promise<number> {
	const s = await driveSession(odpBytes({ body }), "odp")

	expect(s.session.deck.slides).toHaveLength(PAGES)

	const start = cpuMs()
	const result = await s.command({ family: "slide", kind: "duplicate", slide: s.session.deck.slides[0] as SlideRef })
	const spent = cpuMs() - start

	expect(result.ok).toBe(true)

	return spent
}

describe("presentationOdpDuplicatePerf", () => {
	it("duplicates a page of 10,000 pages sharing one name within 100 ms CPU", { timeout: budget(120_000) }, async ({ task }) => {
		const spent = await firstDuplicateCpuMs(page("").repeat(PAGES))

		Object.assign(task.meta, { perf: { presentationOdpDuplicateSameNamesCpuMs: { value: spent, budget: 100 } } })
		expect(spent).toBeLessThanOrEqual(budget(100))
	})

	it("duplicates a page of 10,000 named pages within 100 ms CPU", { timeout: budget(120_000) }, async ({ task }) => {
		const body = Array.from(
			{ length: PAGES },
			(_, k) => `<draw:page draw:name="page${String(k + 1)}" draw:master-page-name="M"></draw:page>`
		).join("")
		const spent = await firstDuplicateCpuMs(body)

		Object.assign(task.meta, { perf: { presentationOdpDuplicateCpuMs: { value: spent, budget: 100 } } })
		expect(spent).toBeLessThanOrEqual(budget(100))
	})

	it("duplicates a page of 10,000 pages with three comments each within 100 ms CPU", { timeout: budget(120_000) }, async ({ task }) => {
		const comment = (text: string) =>
			`<office:annotation><dc:creator>A</dc:creator><dc:date>2026-10-28T08:00:00</dc:date><text:p>${text}</text:p></office:annotation>`
		const body = Array.from(
			{ length: PAGES },
			(_, k) =>
				`<draw:page draw:name="p${String(k)}" draw:master-page-name="M"><draw:frame svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T${String(k)}</text:p></draw:text-box></draw:frame>${comment("c1")}${comment("c2")}${comment("c3")}</draw:page>`
		).join("")
		const spent = await firstDuplicateCpuMs(body)

		Object.assign(task.meta, { perf: { presentationOdpDuplicateCommentedCpuMs: { value: spent, budget: 100 } } })
		expect(spent).toBeLessThanOrEqual(budget(100))
	})
})
