import { describe, it, expect } from "vitest"
import {
	deriveStatus,
	isOnlineComplete,
	shouldShowSearchTruncationNotice,
	type DriveSearchStatus
} from "@/features/drive/hooks/driveSearchStatus"

// Baseline: an open, live, online cache search with one empty snapshot delivered and every timer
// flag still down. Each test overrides only the inputs it exercises.
function base(over?: Partial<Parameters<typeof deriveStatus>[0]>): Parameters<typeof deriveStatus>[0] {
	return {
		isCacheSearch: true,
		live: true,
		openError: false,
		cacheUnavailable: false,
		rootDeleted: false,
		watchdogFired: false,
		hasSnapshot: true,
		isOnline: true,
		totalCount: 0,
		resyncing: false,
		graceElapsed: false,
		stallCeilingHit: false,
		...over
	}
}

describe("deriveStatus", () => {
	it("is idle when not a cache search", () => {
		expect(deriveStatus(base({ isCacheSearch: false }))).toBe("idle")
	})

	it("is warming before the first snapshot lands", () => {
		expect(deriveStatus(base({ hasSnapshot: false }))).toBe("warming")
	})

	it("is warming for an empty result still inside the grace window", () => {
		expect(deriveStatus(base({ totalCount: 0, graceElapsed: false, resyncing: false }))).toBe("warming")
	})

	it("settles to no-results for an empty result once grace elapsed and no resync is in flight", () => {
		expect(deriveStatus(base({ totalCount: 0, graceElapsed: true, resyncing: false }))).toBe("settled")
	})

	// Bug 2: an empty result past grace while a resync is still converging must NOT be a bare
	// spinner ("warming") forever — it surfaces an explicit "no results yet, still searching" state.
	it("is searching-empty for an empty result past grace while a resync is still converging", () => {
		expect(deriveStatus(base({ totalCount: 0, graceElapsed: true, resyncing: true }))).toBe("searching-empty")
	})

	it("stays warming (not searching-empty) for an empty resyncing result still inside grace", () => {
		expect(deriveStatus(base({ totalCount: 0, graceElapsed: false, resyncing: true }))).toBe("warming")
	})

	it("collapses searching-empty to settled (genuine no-results) once the stall ceiling trips", () => {
		expect(deriveStatus(base({ totalCount: 0, graceElapsed: true, resyncing: true, stallCeilingHit: true }))).toBe("settled")
	})

	it("is background while results exist and a resync is still converging", () => {
		expect(deriveStatus(base({ totalCount: 3, resyncing: true }))).toBe("background")
	})

	it("is settled once results exist and the resync is done", () => {
		expect(deriveStatus(base({ totalCount: 3, resyncing: false, graceElapsed: true }))).toBe("settled")
	})

	it("is offline-incomplete when offline with no matches", () => {
		expect(deriveStatus(base({ isOnline: false, totalCount: 0 }))).toBe("offline-incomplete")
	})

	it("is terminal when the snapshot reports the search is no longer live", () => {
		expect(deriveStatus(base({ live: false }))).toBe("terminal")
	})

	it("is terminal when the cache is unavailable", () => {
		expect(deriveStatus(base({ cacheUnavailable: true }))).toBe("terminal")
	})

	it("is terminal when the active root was deleted", () => {
		expect(deriveStatus(base({ rootDeleted: true }))).toBe("terminal")
	})

	it("is terminal on an open error even with a stale snapshot (self-heal moved to the hook)", () => {
		// The pure machine no longer self-heals via `hasSnapshot`: a failed FOREGROUND reopen keeps
		// a stale pre-background snapshot (hasSnapshot stays true, since sessionKey excludes the
		// foreground edge) and MUST still surface as terminal, not show the stale rows forever. The
		// hook owns the self-heal now — it clears openError on every accepted snapshot + accepted
		// setName — so by the time a real result is shown, openError is already false.
		expect(deriveStatus(base({ openError: true, hasSnapshot: true, totalCount: 1, graceElapsed: true }))).toBe("terminal")
	})
})

describe("isOnlineComplete", () => {
	it("is false without a snapshot", () => {
		expect(isOnlineComplete(false, 0)).toBe(false)
	})

	it("is false with a snapshot but zero matches", () => {
		expect(isOnlineComplete(true, 0)).toBe(false)
	})

	it("is true with a snapshot reporting matches", () => {
		expect(isOnlineComplete(true, 5)).toBe(true)
	})
})

describe("shouldShowSearchTruncationNotice", () => {
	const args = (over: { status?: DriveSearchStatus; totalCount?: number; loadedCount?: number }) => ({
		status: "settled" as DriveSearchStatus,
		totalCount: 10,
		loadedCount: 10,
		...over
	})

	it("shows once the match count exceeds what the window loaded", () => {
		expect(shouldShowSearchTruncationNotice(args({ totalCount: 5000, loadedCount: 1000 }))).toBe(true)
	})

	it("stays visible while a truncated result set is still converging in the background", () => {
		expect(shouldShowSearchTruncationNotice(args({ status: "background", totalCount: 5000, loadedCount: 1000 }))).toBe(true)
	})

	it("hides when the whole match set is loaded", () => {
		expect(shouldShowSearchTruncationNotice(args({ totalCount: 42, loadedCount: 42 }))).toBe(false)
	})

	// Guards the regression by CONSTRUCTION rather than by assertion: the notice used to key off the
	// rendered row count, so a local filter shrinking a fully-loaded result set claimed truncation
	// and told the user to refine a search that had already returned everything. This signature has
	// no access to a rendered count, so that mistake can no longer be expressed here — the case
	// below simply pins that a fully-loaded window stays quiet whatever is filtered downstream.
	it("stays quiet for a fully-loaded window regardless of what a local filter removes", () => {
		expect(shouldShowSearchTruncationNotice(args({ totalCount: 20, loadedCount: 20 }))).toBe(false)
	})

	it("stays hidden in every non-presenting status", () => {
		for (const status of ["idle", "warming", "terminal"] as const) {
			expect(shouldShowSearchTruncationNotice(args({ status, totalCount: 5000, loadedCount: 1000 }))).toBe(false)
		}
	})

	// deriveStatus only yields these two with totalCount === 0, so the truncation comparison can
	// never be true there anyway — assert the status gate with an input the machine can produce.
	it("stays hidden in the two zero-match statuses", () => {
		for (const status of ["searching-empty", "offline-incomplete"] as const) {
			expect(shouldShowSearchTruncationNotice(args({ status, totalCount: 0, loadedCount: 0 }))).toBe(false)
		}
	})
})
