import { describe, expect, it } from "vitest"
import { deriveSearchStatus } from "@/lib/drive/search-status.logic"

// Baseline: an engaged, live search with one snapshot delivered (zero hits, grace not yet elapsed)
// and every timer flag down. Each test overrides only the inputs it exercises — mirrors the
// baseline-plus-overrides shape of every other truth-table test in this codebase.
function base(over?: Partial<Parameters<typeof deriveSearchStatus>[0]>): Parameters<typeof deriveSearchStatus>[0] {
	return {
		query: "doc",
		hasSnapshot: true,
		resultCount: 0,
		resyncing: false,
		live: true,
		rootDeleted: false,
		graceElapsed: false,
		watchdogTripped: false,
		...over
	}
}

describe("deriveSearchStatus", () => {
	it("is idle for an empty query", () => {
		expect(deriveSearchStatus(base({ query: "" }))).toBe("idle")
	})

	it("is idle for a whitespace-only query", () => {
		expect(deriveSearchStatus(base({ query: "   " }))).toBe("idle")
	})

	it("idle wins over every other signal, even a dead search", () => {
		expect(deriveSearchStatus(base({ query: "", live: false, rootDeleted: true, watchdogTripped: true }))).toBe("idle")
	})

	it("is warming with zero results before grace elapses", () => {
		expect(deriveSearchStatus(base({ resultCount: 0, graceElapsed: false }))).toBe("warming")
	})

	it("is warming with no snapshot yet, even once grace has already elapsed (the false-negative this guards against)", () => {
		expect(deriveSearchStatus(base({ hasSnapshot: false, graceElapsed: true }))).toBe("warming")
	})

	it("is warming with no snapshot yet, even while a resync is actively converging", () => {
		expect(deriveSearchStatus(base({ hasSnapshot: false, graceElapsed: true, resyncing: true }))).toBe("warming")
	})

	it("stops being forced into warming the instant a snapshot lands, even with zero results, once grace has elapsed", () => {
		expect(deriveSearchStatus(base({ hasSnapshot: true, resultCount: 0, graceElapsed: true, resyncing: false }))).toBe("settled")
	})

	it("stays warming with zero results while resyncing, still inside grace", () => {
		expect(deriveSearchStatus(base({ resultCount: 0, graceElapsed: false, resyncing: true }))).toBe("warming")
	})

	it("shows results immediately once any exist, even inside the grace window", () => {
		expect(deriveSearchStatus(base({ resultCount: 3, graceElapsed: false, resyncing: false }))).toBe("settled")
	})

	it("settles to no-results once grace elapses with nothing streaming", () => {
		expect(deriveSearchStatus(base({ resultCount: 0, graceElapsed: true, resyncing: false }))).toBe("settled")
	})

	it("is searching-empty for zero results past grace while a resync still converges", () => {
		expect(deriveSearchStatus(base({ resultCount: 0, graceElapsed: true, resyncing: true }))).toBe("searching-empty")
	})

	it("is background while results exist and a resync still converges", () => {
		expect(deriveSearchStatus(base({ resultCount: 5, resyncing: true }))).toBe("background")
	})

	it("is settled once results exist and the resync has finished", () => {
		expect(deriveSearchStatus(base({ resultCount: 5, resyncing: false }))).toBe("settled")
	})

	it("collapses searching-empty to settled once the ceiling trips", () => {
		expect(deriveSearchStatus(base({ resultCount: 0, graceElapsed: true, resyncing: true, watchdogTripped: true }))).toBe("settled")
	})

	it("collapses background to settled once the ceiling trips", () => {
		expect(deriveSearchStatus(base({ resultCount: 5, resyncing: true, watchdogTripped: true }))).toBe("settled")
	})

	it("is terminal when the last known snapshot reports the search is no longer live", () => {
		expect(deriveSearchStatus(base({ live: false }))).toBe("terminal")
	})

	it("is terminal when the active root was deleted", () => {
		expect(deriveSearchStatus(base({ rootDeleted: true }))).toBe("terminal")
	})

	it("is terminal on a watchdog trip with no data and no resync in flight (a genuine wedge)", () => {
		expect(deriveSearchStatus(base({ watchdogTripped: true, resultCount: 0, resyncing: false }))).toBe("terminal")
	})

	it("is terminal on a watchdog trip even if no snapshot ever arrived — the fatal wedge still wins over the warming guard", () => {
		expect(deriveSearchStatus(base({ hasSnapshot: false, watchdogTripped: true, resultCount: 0, resyncing: false }))).toBe("terminal")
	})

	it("is NOT terminal on a watchdog trip while a resync is still actively converging", () => {
		expect(deriveSearchStatus(base({ watchdogTripped: true, resultCount: 0, resyncing: true, graceElapsed: true }))).toBe("settled")
	})

	it("is NOT terminal on a watchdog trip once results already exist", () => {
		expect(deriveSearchStatus(base({ watchdogTripped: true, resultCount: 5, resyncing: false }))).toBe("settled")
	})
})
