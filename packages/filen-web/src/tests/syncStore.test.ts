import { describe, expect, it, vi } from "vitest"
import type { DesktopSyncOverview, DesktopSyncPair } from "@filen/shared/desktop"

const sync = vi.hoisted(() => ({ onOverview: vi.fn(), overview: vi.fn() }))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => ({ sync }) }))

const { loadSync, useSyncStore } = await import("@/features/sync/lib/syncStore")

const PAIR: DesktopSyncPair = {
	id: "1",
	name: "Documents",
	localRoot: "/a",
	remoteRoot: "r",
	mode: "twoWay",
	paused: false,
	phase: "syncing",
	progress: { done: 1, total: 4 },
	transfers: [],
	lastSyncedAt: null,
	lastError: null,
	issues: { conflicts: 0, heldDeletions: 0, unsyncable: 0, failed: 0 },
	degraded: { local: false, remote: false },
	review: null,
	notices: []
}

describe("sync store", () => {
	it("follows the overview once and keeps unchanged pairs' objects", async () => {
		let push: (overview: DesktopSyncOverview) => void = () => undefined

		sync.onOverview.mockImplementation((callback: (overview: DesktopSyncOverview) => void) => {
			push = callback

			return () => undefined
		})
		sync.overview.mockResolvedValue({ host: { state: "running" }, pairs: [] })

		loadSync()
		loadSync()
		expect(sync.onOverview).toHaveBeenCalledTimes(1)

		push({ host: { state: "running" }, pairs: [PAIR, { ...PAIR, id: "2", phase: "idle", progress: null }] })
		const first = useSyncStore.getState().overview

		push({
			host: { state: "running" },
			pairs: [
				{ ...PAIR, progress: { done: 2, total: 4 } },
				{ ...PAIR, id: "2", phase: "idle", progress: null }
			]
		})
		const second = useSyncStore.getState().overview

		expect(second?.pairs[0]).not.toBe(first?.pairs[0])
		expect(second?.pairs[1]).toBe(first?.pairs[1])
		expect(second?.host).toBe(first?.host)

		// The initial read does not overwrite a pushed overview.
		await Promise.resolve()
		expect(useSyncStore.getState().overview?.pairs).toHaveLength(2)
	})
})
