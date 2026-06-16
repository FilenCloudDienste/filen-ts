import { describe, it, expect } from "vitest"
import { planSizeCapEviction } from "@/lib/cacheEviction"

const MB = 1024 * 1024

// planSizeCapEviction is a pure, soft, aggregate size-cap planner shared by
// fileCache + audioCache: evict OLDEST entries (by cachedAt) first until the total
// is within the cap, but NEVER the newest entry (the just-cached / active file).
describe("planSizeCapEviction", () => {
	it("evicts nothing when the total is within the cap", () => {
		const entries = [
			{ key: "a", cachedAt: 1, size: 50 * MB },
			{ key: "b", cachedAt: 2, size: 50 * MB }
		]

		expect(planSizeCapEviction(entries, 250 * MB)).toEqual([])
	})

	it("evicts the single oldest entry until within the cap", () => {
		const entries = [
			{ key: "old", cachedAt: 1, size: 100 * MB },
			{ key: "mid", cachedAt: 2, size: 100 * MB },
			{ key: "new", cachedAt: 3, size: 100 * MB }
		]

		// 300MB > 250MB → drop the oldest (100MB) → 200MB
		expect(planSizeCapEviction(entries, 250 * MB)).toEqual(["old"])
	})

	it("evicts multiple oldest entries when one isn't enough", () => {
		const entries = [
			{ key: "o1", cachedAt: 1, size: 100 * MB },
			{ key: "o2", cachedAt: 2, size: 100 * MB },
			{ key: "o3", cachedAt: 3, size: 100 * MB },
			{ key: "new", cachedAt: 4, size: 100 * MB }
		]

		// 400MB > 250MB → drop o1, o2 → 200MB
		expect(planSizeCapEviction(entries, 250 * MB)).toEqual(["o1", "o2"])
	})

	it("never evicts the newest entry — a single oversized active file is kept", () => {
		const entries = [
			{ key: "old", cachedAt: 1, size: 10 * MB },
			{ key: "huge-new", cachedAt: 2, size: 300 * MB }
		]

		// newest alone exceeds the cap → evict only the old one; cache stays above cap
		expect(planSizeCapEviction(entries, 250 * MB)).toEqual(["old"])
	})

	it("evicts nothing for a single entry even if it exceeds the cap", () => {
		expect(planSizeCapEviction([{ key: "solo", cachedAt: 1, size: 400 * MB }], 250 * MB)).toEqual([])
	})

	it("sorts by cachedAt regardless of input order", () => {
		const entries = [
			{ key: "new", cachedAt: 3, size: 100 * MB },
			{ key: "old", cachedAt: 1, size: 100 * MB },
			{ key: "mid", cachedAt: 2, size: 100 * MB }
		]

		expect(planSizeCapEviction(entries, 250 * MB)).toEqual(["old"])
	})
})
