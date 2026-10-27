import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { DesktopSyncPlanSummary, DesktopSyncReviewFinding } from "@filen/shared/desktop"
import { attachUnheld, type FirstRunPlan, firstRunVerdict, holdReviewed, runFirstRun } from "../main/sync/firstRun.ts"
import type { ShellPair } from "../main/sync/store.ts"
import { CLEAN_SUMMARY, fakeNative, memoryStore, Refusal } from "./syncFakes.ts"

const REMOTE = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
const LEGACY = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"
const MIB = 1_048_576

const { passToken: _passToken, ...SUMMARY } = CLEAN_SUMMARY

function plan(summary: Partial<DesktopSyncPlanSummary> = {}, rest: Partial<Omit<FirstRunPlan, "summary">> = {}): FirstRunPlan {
	return { summary: { ...SUMMARY, ...summary }, uploads: 0, downloads: 0, legacyHits: 0, ...rest }
}

let directory: string

beforeEach(async () => {
	directory = await realpath(await mkdtemp(path.join(tmpdir(), "filen-first-run-")))
})

afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

function shellPair(overrides: Partial<ShellPair> = {}): ShellPair {
	return {
		pairId: null,
		name: "Work",
		localRoot: directory,
		remoteRoot: REMOTE,
		mode: "twoWay",
		paused: false,
		state: "active",
		review: null,
		legacyUuid: null,
		legacyDotFiles: null,
		notices: [],
		createdAt: 1,
		...overrides
	}
}

describe("firstRunVerdict", () => {
	const rows: [string, FirstRunPlan | null, boolean, DesktopSyncReviewFinding[]][] = [
		["clean", plan(), false, []],
		["adoptions transfer nothing", plan({ actions: 50_000 }), false, []],
		[
			"1 MiB in 25 transfers",
			plan({ actions: 25, uploadBytes: MIB / 2, downloadBytes: MIB / 2 }, { uploads: 20, downloads: 5 }),
			false,
			[]
		],
		["over 1 MiB", plan({ uploadBytes: MIB, downloadBytes: 1 }, { uploads: 1, downloads: 1 }), false, ["uploads", "downloads"]],
		["over 25 transfers", plan({}, { downloads: 26 }), false, ["downloads"]],
		["conflicts", plan({ conflicts: 1 }), false, ["conflicts"]],
		["held deletions", plan({ heldDeletions: 1, heldReason: "firstSyncWithDeletions" }), false, ["heldDeletions"]],
		["refused", plan({ refused: "localCollision" }), false, ["refused"]],
		["old rules hid something", plan({}, { legacyHits: 2 }), false, ["newlySynced"]],
		["unconverged", null, false, ["unconverged"]],
		["dot files per pair", plan(), true, ["dotFilesPerPair"]],
		["unconverged with dot files per pair", null, true, ["unconverged", "dotFilesPerPair"]]
	]

	it.each(rows)("%s", (_name, input, dotFilesPerPair, findings) => {
		expect(firstRunVerdict(input, dotFilesPerPair)).toEqual(findings.length === 0 ? { start: true } : { start: false, findings })
	})
})

describe("runFirstRun", () => {
	const options = { reason: "baselineReset", paused: false, legacy: null, dotFilesPerPair: false } as const

	it("starts a clean pair", async () => {
		const store = memoryStore([shellPair({ pairId: "1", paused: true, state: "review" })])
		const { deps, ops } = fakeNative(store)

		await runFirstRun(deps, "1", options)

		expect(ops()).toEqual(["evaluatePlan", "releasePlan", "resume"])
		expect(store.get().pairs[0]).toMatchObject({ paused: false, state: "active", review: null })
	})

	it("keeps a pair the user paused paused, even when clean", async () => {
		const store = memoryStore([shellPair({ pairId: "1", paused: true, state: "review" })])
		const { deps, ops } = fakeNative(store)

		await runFirstRun(deps, "1", { ...options, paused: true })

		expect(ops()).not.toContain("resume")
		expect(store.get().pairs[0]).toMatchObject({ paused: true, state: "active", review: null })
	})

	it("holds a busy pair in review with what its run would do", async () => {
		const store = memoryStore([shellPair({ pairId: "1", paused: true })])
		const { deps, ops } = fakeNative(store, {
			evaluatePlan: () => ({
				status: "ok",
				planId: "p",
				summary: { ...CLEAN_SUMMARY, uploadBytes: 2 * MIB, heldDeletions: 3, passToken: "secret" },
				check: { uploads: 4, downloads: 0, legacyHits: null }
			})
		})

		await runFirstRun(deps, "1", options)

		expect(ops()).toEqual(["evaluatePlan", "releasePlan"])
		expect(store.get().pairs[0]).toMatchObject({
			paused: true,
			state: "review",
			review: {
				reason: "baselineReset",
				findings: ["uploads", "heldDeletions"],
				summary: { ...SUMMARY, uploadBytes: 2 * MIB, heldDeletions: 3 }
			}
		})
	})

	it("checks against the old rules only for a migrated pair", async () => {
		const store = memoryStore([shellPair({ pairId: "1" })])
		const { deps, ops, argsOf } = fakeNative(store, { evaluatePlan: () => ({ status: "unconverged" }) })

		await runFirstRun(deps, "1", { ...options, reason: "migrated", legacy: { excludeDotFiles: true } })

		expect(ops()).toEqual(["evaluatePlan"])
		expect(argsOf("evaluatePlan")).toEqual([{ pairId: "1", check: { legacy: { excludeDotFiles: true } } }])
		expect(store.get().pairs[0]?.review).toEqual({ reason: "migrated", findings: ["unconverged"], summary: null })
	})

	it("treats a plan the host did not scan as busy", async () => {
		const store = memoryStore([shellPair({ pairId: "1" })])
		const { deps } = fakeNative(store, {
			evaluatePlan: () => ({ status: "ok", planId: "p", summary: { ...CLEAN_SUMMARY, actions: 30 }, check: null })
		})

		await runFirstRun(deps, "1", options)

		expect(store.get().pairs[0]?.state).toBe("review")
	})
})

describe("attachUnheld", () => {
	it("a missing directory waits and is never created", async () => {
		const missing = path.join(directory, "unplugged")
		const store = memoryStore([shellPair({ localRoot: missing, legacyUuid: REMOTE, state: "waitingForRoot" })])
		const { deps, ops } = fakeNative(store)

		await attachUnheld(deps)

		expect(ops()).toEqual([])
		expect(store.get().pairs[0]?.state).toBe("waitingForRoot")
		expect(await readdir(directory)).toEqual([])
	})

	it("re-adds a pair a baseline reset lost, paused, through the guard", async () => {
		const store = memoryStore([shellPair({ name: "Kept", paused: true, state: "review" })])
		const { deps, ops, argsOf } = fakeNative(store)

		await attachUnheld(deps)

		expect(ops()).toEqual(["addPair", "pause", "evaluatePlan", "releasePlan"])
		expect(argsOf("addPair")).toEqual([{ localRoot: directory, remoteRoot: REMOTE, mode: "twoWay" }])
		expect(argsOf("evaluatePlan")).toEqual([{ pairId: "1", check: { legacy: null } }])
		expect(store.get().pairs).toEqual([shellPair({ pairId: "1", name: "Kept", paused: true, state: "active" })])
	})

	it("seeds a migrated pair from the old client's state before its first plan", async () => {
		const store = memoryStore([shellPair({ legacyUuid: LEGACY, state: "waitingForRoot" })])
		const { deps, ops, argsOf } = fakeNative(store)

		await attachUnheld(deps)

		expect(ops()).toEqual(["addPair", "pause", "seedLegacy", "evaluatePlan", "releasePlan", "resume"])
		expect(argsOf("seedLegacy")).toEqual([{ pairId: "1", stateDir: `/old/sync/state/v2/${LEGACY}` }])
		expect(store.get().pairs[0]?.state).toBe("active")
	})

	it("seeds a migrated pair a baseline reset lost again", async () => {
		const store = memoryStore([shellPair({ legacyUuid: LEGACY, state: "review" })])
		const { deps, ops, argsOf } = fakeNative(store)

		await attachUnheld(deps)

		expect(ops()).toContain("seedLegacy")
		expect(argsOf("evaluatePlan")).toEqual([{ pairId: "1", check: { legacy: null } }])
	})

	it.each([
		["refused", () => new Refusal("unknown")],
		["not imported", () => null]
	])("plans a pair whose seeding was %s anyway", async (_name, seedLegacy) => {
		const store = memoryStore([shellPair({ legacyUuid: LEGACY, state: "waitingForRoot" })])
		const { deps, ops } = fakeNative(store, { seedLegacy })

		await attachUnheld(deps)

		expect(ops()).toEqual(["addPair", "pause", "seedLegacy", "evaluatePlan", "releasePlan", "resume"])
		expect(store.get().pairs[0]?.state).toBe("active")
	})

	it("keeps a pair the engine refuses for good, unsynced with the reason, and one a passing failure hit for the next start", async () => {
		const store = memoryStore([shellPair({ notices: ["localTrashMoved"] })])
		const refused = fakeNative(store, { addPair: () => new Refusal("remoteRootNested") })

		await attachUnheld(refused.deps)
		expect(store.get().pairs).toEqual([shellPair({ state: "unsupported", notices: ["localTrashMoved", "refusedRemoteOverlap"] })])

		// Never offered to the engine again.
		await attachUnheld(refused.deps)
		expect(refused.ops()).toEqual(["addPair"])

		const kept = memoryStore([shellPair({ state: "review" })])
		const passing = fakeNative(kept, { addPair: () => new Refusal("timeout") })

		await attachUnheld(passing.deps)
		expect(kept.get().pairs).toEqual([shellPair({ state: "review" })])
	})

	it("takes the pair back out of the engine when it cannot be paused", async () => {
		const store = memoryStore([shellPair()])
		const { deps, ops } = fakeNative(store, { pause: () => new Refusal("hostUnavailable") })

		await attachUnheld(deps)

		expect(ops()).toEqual(["addPair", "pause", "removePair"])
		expect(store.get().pairs).toEqual([shellPair()])
	})
})

describe("holdReviewed", () => {
	it("pauses a pair in review the engine holds unpaused", async () => {
		const store = memoryStore([shellPair({ pairId: "4", state: "review" }), shellPair({ pairId: "5", localRoot: "/elsewhere" })])
		const { deps, argsOf } = fakeNative(store)

		await holdReviewed(deps)

		expect(argsOf("pause")).toEqual([{ pairId: "4" }])
		expect(store.get().pairs.map(pair => pair.paused)).toEqual([true, false])
	})
})
