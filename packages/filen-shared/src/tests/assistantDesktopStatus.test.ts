import { describe, expect, it } from "vitest"
import { NO_PAIR_MATCH_NOTE, NO_SYNC_PAIRS_NOTE, REMOTE_NOT_LOADED, syncStatus } from "@filen/shared"
import { MAX_ARRAY_ITEMS } from "@filen/shared/assistant"
import type { DesktopSyncOverview, DesktopSyncPair } from "@filen/shared/desktop"

function pair(id: string, name: string, overrides: Partial<DesktopSyncPair> = {}): DesktopSyncPair {
	return {
		id,
		name,
		localRoot: `/home/me/${name}`,
		remoteRoot: `remote-${id}`,
		mode: "twoWay",
		paused: false,
		phase: "idle",
		progress: null,
		transfers: [],
		lastSyncedAt: null,
		lastError: null,
		issues: { conflicts: 0, heldDeletions: 0, unsyncable: 0, skippedSymlinks: 0, failed: 0 },
		degraded: { local: false, remote: false },
		stage: null,
		halted: null,
		refused: null,
		review: null,
		notices: [],
		rootProblem: null,
		holds: [],
		info: [],
		...overrides
	}
}

function overview(pairs: DesktopSyncPair[]): DesktopSyncOverview {
	return { host: { state: "running" }, pairs, importNote: null }
}

function status(pairs: DesktopSyncPair[], query?: string) {
	return syncStatus({
		overview: overview(pairs),
		query,
		handle: row => `s-${row.id}`,
		remoteName: row => (row.id === "a" ? "Cloud A" : null),
		timeZone: "Europe/Berlin"
	})
}

describe("sync status rows", () => {
	it("shows only what is set: zero issue counts, no error and no progress are left out", () => {
		expect(status([pair("a", "Work", { lastSyncedAt: Date.UTC(2026, 10, 20, 13, 3), paused: true, phase: "paused" })])).toEqual({
			pairs: [
				{
					handle: "s-a",
					name: "Work",
					local: "/home/me/Work",
					remote: "Cloud A",
					mode: "twoWay",
					state: "paused",
					paused: true,
					// On the user's clock.
					lastSynced: "2026-11-20 14:03"
				}
			]
		})
	})

	it("names an unread remote directory as not loaded", () => {
		expect((status([pair("b", "Photos")])["pairs"] as { remote: string }[])[0]?.remote).toBe(REMOTE_NOT_LOADED)
	})

	it("filters by the query's words, and lists every pair with a note when none matches", () => {
		const pairs = [pair("a", "Work"), pair("b", "Photos")]

		expect((status(pairs, "photos")["pairs"] as { name: string }[]).map(row => row.name)).toEqual(["Photos"])
		expect(status(pairs, "music")).toMatchObject({ note: NO_PAIR_MATCH_NOTE })
		expect((status(pairs, "music")["pairs"] as unknown[]).length).toBe(2)
	})

	it("says when no pair is set up, and when the engine is not running", () => {
		expect(status([])).toEqual({ pairs: [], note: NO_SYNC_PAIRS_NOTE })
		expect(
			syncStatus({ overview: { ...overview([]), host: { state: "starting" } }, handle: () => "", remoteName: () => null })
		).toMatchObject({ engine: "starting" })
	})

	it("caps the rows and counts the rest", () => {
		const many = Array.from({ length: MAX_ARRAY_ITEMS + 3 }, (_, index) => pair(String(index), `Pair ${String(index)}`))

		expect(status(many)).toMatchObject({ total: MAX_ARRAY_ITEMS + 3, more: 3 })
	})
})
