import { describe, expect, it } from "vitest"
import type { DesktopSyncActivity, DesktopSyncOverview, DesktopSyncPair, DesktopSyncPlanSummary } from "@filen/shared/desktop"
import { sync } from "@/locales/en/sync"
import { hostBanner } from "@/features/desktop/lib/hostBanner.logic"
import { ACTIVITY_KIND_KEY, ACTIVITY_KIND_TONE, ACTIVITY_LIMIT, mergeActivity } from "@/features/sync/lib/activity.logic"
import { ROOT_PROBLEM_KEY, ROOT_WARNING_KEY, SYNC_ERROR_KEY, UNSYNCABLE_REASON_KEY } from "@/features/sync/lib/syncErrors.logic"
import {
	ACTION_KIND_KEY,
	aggregateSyncState,
	conflictDetailKey,
	FINDING_KEY,
	HELD_REASON_KEY,
	isLargePlan,
	MODE_DESCRIPTION_KEY,
	MODE_DIRECTION,
	MODE_KEY,
	MODE_SHORT_KEY,
	modeChangeNeedsBacklog,
	MODES,
	NOTICE_KEY,
	pathBasename,
	pathParent,
	PHASE_KEY,
	PLAN_LIST_KEY,
	planListsWithEntries,
	REFUSAL_KEY
} from "@/features/sync/lib/syncStatus.logic"

const CATALOG: Record<string, string> = sync

function expectAllKeysExist(map: Record<string, string>, members: readonly string[]): void {
	expect(Object.keys(map).sort()).toEqual([...members].sort())

	for (const [member, key] of Object.entries(map)) {
		expect(CATALOG[key], `${member} → ${key}`).toBeTypeOf("string")
	}
}

const PAIR: DesktopSyncPair = {
	id: "1",
	name: "Documents",
	localRoot: "/Users/a/Documents",
	remoteRoot: "uuid-1",
	mode: "twoWay",
	paused: false,
	phase: "idle",
	progress: null,
	transfers: [],
	lastSyncedAt: null,
	lastError: null,
	issues: { conflicts: 0, heldDeletions: 0, unsyncable: 0, failed: 0 },
	degraded: { local: false, remote: false },
	review: null,
	notices: []
}

const SUMMARY: DesktopSyncPlanSummary = {
	actions: 3,
	uploadBytes: 10,
	downloadBytes: 0,
	heldDeletions: 0,
	heldReason: null,
	conflicts: 1,
	unsyncable: 0,
	ignored: 2,
	refused: null
}

function overview(pairs: DesktopSyncPair[], host: DesktopSyncOverview["host"] = { state: "running" }): DesktopSyncOverview {
	return { host, pairs }
}

describe("sync copy", () => {
	it("maps every activity kind to a key", () => {
		expectAllKeysExist(ACTIVITY_KIND_KEY, [
			"uploaded",
			"downloaded",
			"createdRemoteDirectory",
			"createdLocalDirectory",
			"trashedRemote",
			"deletedLocal",
			"movedRemote",
			"movedLocal",
			"binned",
			"failed",
			"conflict",
			"deletionsHeld",
			"passFailed",
			"passCompleted"
		])
		expect(Object.keys(ACTIVITY_KIND_TONE).sort()).toEqual(Object.keys(ACTIVITY_KIND_KEY).sort())
	})

	it("maps every error code to a key", () => {
		expectAllKeysExist(SYNC_ERROR_KEY, [
			"hostUnavailable",
			"timeout",
			"unauthenticated",
			"pairNotFound",
			"planExpired",
			"rootExpired",
			"rootRefused",
			"localRootMissing",
			"remoteRootMissing",
			"localRootInUse",
			"localRootNested",
			"localRootContains",
			"remoteRootInUse",
			"remoteRootNested",
			"remoteRootContains",
			"modeConflict",
			"invalidIgnore",
			"unknown"
		])
	})

	it("maps every root problem and warning to a key", () => {
		expectAllKeysExist(ROOT_PROBLEM_KEY, [
			"notDirectory",
			"notWritable",
			"filesystemRoot",
			"homeDirectory",
			"appData",
			"temporary",
			"insidePair",
			"containsPair",
			"insideMount",
			"containsMount"
		])
		expectAllKeysExist(ROOT_WARNING_KEY, ["iCloud", "cloudStorage", "oneDrive"])
	})

	it("maps every phase, mode, notice, finding, held reason, refusal, list, action and unsyncable reason", () => {
		expectAllKeysExist(PHASE_KEY, ["idle", "syncing", "paused", "preparing", "review", "waitingForRoot", "unsupported", "error"])
		expectAllKeysExist(MODE_KEY, [...MODES])
		expectAllKeysExist(MODE_DESCRIPTION_KEY, [...MODES])
		expectAllKeysExist(MODE_SHORT_KEY, [...MODES])
		expectAllKeysExist(NOTICE_KEY, ["refusedLocalRoot", "refusedRemoteMissing", "refusedLocalOverlap", "refusedRemoteOverlap"])
		expectAllKeysExist(FINDING_KEY, ["uploads", "downloads", "conflicts", "heldDeletions", "refused", "unconverged", "overwrites"])
		expectAllKeysExist(HELD_REASON_KEY, [
			"scanIncomplete",
			"firstSyncWithDeletions",
			"remoteUnconverged",
			"remoteEmptied",
			"exceededThreshold"
		])
		expectAllKeysExist(REFUSAL_KEY, ["remoteCollision", "localCollision"])
		expectAllKeysExist(PLAN_LIST_KEY, ["actions", "held", "conflicts", "unsyncable", "ignored"])
		expectAllKeysExist(ACTION_KIND_KEY, [
			"upload",
			"download",
			"createRemoteDirectory",
			"createLocalDirectory",
			"moveRemote",
			"moveLocal",
			"trashRemote",
			"deleteLocal",
			"adoptBaseline"
		])
		expectAllKeysExist(UNSYNCABLE_REASON_KEY, [
			"invalidName",
			"repeatedFailure",
			"remoteUndecodable",
			"remoteInvalidName",
			"remoteBrokenParent",
			"localAlias",
			"localNameCollision",
			"remoteNameCollision"
		])
	})

	it("ships both plural forms of every counted string", () => {
		for (const base of [
			"detailIssues",
			"issuesFailed",
			"heldApproveBody",
			"reviewActions",
			"reviewHeld",
			"reviewConflicts",
			"reviewUnsyncable",
			"reviewIgnored"
		]) {
			expect(CATALOG[`${base}_one`], base).toBeTypeOf("string")
			expect(CATALOG[`${base}_other`], base).toBeTypeOf("string")
		}
	})

	it("says directory, never folder", () => {
		for (const [key, value] of Object.entries(CATALOG)) {
			expect(/folder/i.test(value), key).toBe(false)
		}
	})

	it("every host state that needs a banner has a key", () => {
		expect(hostBanner({ state: "off" })).toBeNull()
		expect(hostBanner({ state: "running" })).toBeNull()

		for (const reason of ["crashLoop", "addonMissing", "baselineInUse", "keychainLocked"] as const) {
			const banner = hostBanner({ state: "failed", reason })

			expect(banner?.retry).toBe(true)
			expect(CATALOG[banner?.key ?? ""]).toBeTypeOf("string")
		}

		expect(hostBanner({ state: "restarting", retryAt: 1 })?.retry).toBe(false)
	})
})

describe("aggregateSyncState", () => {
	it("is null before the first overview", () => {
		expect(aggregateSyncState(null)).toBeNull()
	})

	it("attention wins over syncing", () => {
		const syncing = { ...PAIR, id: "1", phase: "syncing" as const }
		const conflicted = { ...PAIR, id: "2", issues: { ...PAIR.issues, conflicts: 1 } }

		expect(aggregateSyncState(overview([syncing]))).toBe("syncing")
		expect(aggregateSyncState(overview([syncing, conflicted]))).toBe("attention")
		expect(aggregateSyncState(overview([{ ...PAIR, phase: "review" }]))).toBe("attention")
		expect(aggregateSyncState(overview([PAIR], { state: "failed", reason: "keychainLocked" }))).toBe("attention")
	})

	it("is idle for paused and up-to-date pairs", () => {
		expect(aggregateSyncState(overview([PAIR, { ...PAIR, id: "2", phase: "paused" }]))).toBe("idle")
	})
})

describe("sync status helpers", () => {
	it("asks for the backlog only when leaving a backup mode", () => {
		expect(modeChangeNeedsBacklog("localBackup", "twoWay")).toBe(true)
		expect(modeChangeNeedsBacklog("remoteBackup", "localBackup")).toBe(true)
		expect(modeChangeNeedsBacklog("twoWay", "localBackup")).toBe(false)
		expect(modeChangeNeedsBacklog("localBackup", "localBackup")).toBe(false)
	})

	it("names a local directory by its last segment on either platform", () => {
		expect(pathBasename("/Users/a/Documents")).toBe("Documents")
		expect(pathBasename("/Users/a/Documents/")).toBe("Documents")
		expect(pathBasename("C:\\Users\\a\\Work")).toBe("Work")
		expect(pathBasename("/")).toBe("/")
	})

	it("takes a path's parent, keeping a root's separator", () => {
		expect(pathParent("/Users/a/Documents")).toBe("/Users/a")
		expect(pathParent("/Users/a/Documents/")).toBe("/Users/a")
		expect(pathParent("/backup")).toBe("/")
		expect(pathParent("C:\\Users\\a\\Work")).toBe("C:\\Users\\a")
		expect(pathParent("C:\\Work")).toBe("C:\\")
		expect(pathParent("Pictures/2024/a.jpg")).toBe("Pictures/2024")
		expect(pathParent("a.jpg")).toBe("")
		expect(pathParent("/")).toBe("")
	})

	it("draws each mode's flow from the local directory to the cloud one", () => {
		expect(MODE_DIRECTION).toEqual({
			twoWay: "both",
			localToRemote: "toRemote",
			localBackup: "toRemote",
			remoteToLocal: "toLocal",
			remoteBackup: "toLocal"
		})
	})

	it("lists only plan lists that hold entries, and flags very large plans", () => {
		expect(planListsWithEntries(SUMMARY)).toEqual(["actions", "conflicts", "ignored"])
		expect(isLargePlan(SUMMARY)).toBe(false)
		expect(isLargePlan({ ...SUMMARY, actions: 100_001 })).toBe(true)
		expect(isLargePlan(null)).toBe(false)
	})

	it("describes a conflict by the side that deleted", () => {
		expect(conflictDetailKey({ relPath: "a", local: null, remote: "file" })).toBe("conflictLocalDeleted")
		expect(conflictDetailKey({ relPath: "a", local: "file", remote: null })).toBe("conflictRemoteDeleted")
		expect(conflictDetailKey({ relPath: "a", local: "file", remote: "file" })).toBe("conflictBoth")
	})
})

describe("mergeActivity", () => {
	function entry(seq: number, pairId = "1"): DesktopSyncActivity {
		return { seq, pairId, at: seq, kind: "uploaded", relPath: `f${String(seq)}` }
	}

	it("keeps one pair's entries, newest first, each once", () => {
		const merged = mergeActivity([entry(2)], [entry(3), entry(2), entry(4, "2"), entry(1)], "1")

		expect(merged.map(item => item.seq)).toEqual([3, 2, 1])
	})

	it("returns the same list when a batch adds nothing for the pair", () => {
		const current = [entry(1)]

		expect(mergeActivity(current, [entry(5, "2")], "1")).toBe(current)
	})

	it("caps the list", () => {
		const batch = Array.from({ length: ACTIVITY_LIMIT + 10 }, (_, index) => entry(index))

		expect(mergeActivity([], batch, "1")).toHaveLength(ACTIVITY_LIMIT)
	})
})
