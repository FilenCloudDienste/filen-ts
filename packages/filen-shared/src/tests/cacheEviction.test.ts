import { describe, it, expect } from "vitest"
import { planSizeCapEviction } from "@filen/shared"

const MB = 1024 * 1024

// planSizeCapEviction is a pure, soft, aggregate size-cap planner: evict OLDEST entries (by
// timestamp) first until the total is within the cap. protectNewest additionally guards the
// single newest entry from eviction (e.g. the just-cached / actively used resource).
describe("planSizeCapEviction", () => {
	it("evicts nothing when the total is within the cap", () => {
		const entries = [
			{ id: "a", timestamp: 1, size: 50 * MB },
			{ id: "b", timestamp: 2, size: 50 * MB }
		]

		expect(planSizeCapEviction(entries, 250 * MB)).toEqual([])
	})

	it("evicts the single oldest entry until within the cap", () => {
		const entries = [
			{ id: "old", timestamp: 1, size: 100 * MB },
			{ id: "mid", timestamp: 2, size: 100 * MB },
			{ id: "new", timestamp: 3, size: 100 * MB }
		]

		// 300MB > 250MB → drop the oldest (100MB) → 200MB
		expect(planSizeCapEviction(entries, 250 * MB)).toEqual(["old"])
	})

	it("evicts multiple oldest entries when one isn't enough", () => {
		const entries = [
			{ id: "o1", timestamp: 1, size: 100 * MB },
			{ id: "o2", timestamp: 2, size: 100 * MB },
			{ id: "o3", timestamp: 3, size: 100 * MB },
			{ id: "new", timestamp: 4, size: 100 * MB }
		]

		// 400MB > 250MB → drop o1, o2 → 200MB
		expect(planSizeCapEviction(entries, 250 * MB)).toEqual(["o1", "o2"])
	})

	it("never evicts the newest entry when protectNewest is set — a single oversized active file is kept", () => {
		const entries = [
			{ id: "old", timestamp: 1, size: 10 * MB },
			{ id: "huge-new", timestamp: 2, size: 300 * MB }
		]

		// newest alone exceeds the cap → evict only the old one; total stays above the cap
		expect(planSizeCapEviction(entries, 250 * MB, { protectNewest: true })).toEqual(["old"])
	})

	it("evicts nothing for a single entry when protectNewest is set, even if it exceeds the cap", () => {
		expect(planSizeCapEviction([{ id: "solo", timestamp: 1, size: 400 * MB }], 250 * MB, { protectNewest: true })).toEqual([])
	})

	it("sorts by timestamp regardless of input order", () => {
		const entries = [
			{ id: "new", timestamp: 3, size: 100 * MB },
			{ id: "old", timestamp: 1, size: 100 * MB },
			{ id: "mid", timestamp: 2, size: 100 * MB }
		]

		expect(planSizeCapEviction(entries, 250 * MB)).toEqual(["old"])
	})

	// protectNewest defaults to false: on the same fixture as the protectNewest:true case above,
	// the unguarded planner evicts the newest entry too once the older one alone isn't enough.
	it("evicts the newest entry too when protectNewest is not set", () => {
		const entries = [
			{ id: "old", timestamp: 1, size: 10 * MB },
			{ id: "huge-new", timestamp: 2, size: 300 * MB }
		]

		expect(planSizeCapEviction(entries, 250 * MB)).toEqual(["old", "huge-new"])
	})

	// Cases below have no mobile counterpart; folded in from web's pickEvictions suite.
	function entry(id: string, size: number, timestamp: number): { id: string; size: number; timestamp: number } {
		return { id, size, timestamp }
	}

	it("is a no-op when landing exactly on the cap", () => {
		const entries = [entry("a", 50, 1), entry("b", 50, 2)]

		expect(planSizeCapEviction(entries, 100)).toEqual([])
	})

	it("evicts everything when the cap is zero", () => {
		const entries = [entry("a", 10, 1), entry("b", 10, 2)]

		expect(planSizeCapEviction(entries, 0)).toEqual(["a", "b"])
	})

	it("is a no-op on an empty entry list", () => {
		expect(planSizeCapEviction([], 0)).toEqual([])
	})

	it("does not mutate the input array", () => {
		const entries = [entry("newest", 10, 2), entry("oldest", 10, 1)]

		planSizeCapEviction(entries, 5)

		expect(entries).toEqual([entry("newest", 10, 2), entry("oldest", 10, 1)])
	})

	it("breaks timestamp ties by input order (stable sort)", () => {
		const entries = [entry("a", 10, 5), entry("b", 10, 5), entry("c", 10, 5)]

		expect(planSizeCapEviction(entries, 15)).toEqual(["a", "b"])
	})
})
