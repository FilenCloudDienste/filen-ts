import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { DesktopSyncPlanSummary, DesktopSyncReviewFinding } from "@filen/shared/desktop"
import {
	attachUnheld,
	type FirstRunPlan,
	firstRunVerdict,
	holdReviewed,
	MAX_OVERWRITE_BYTES,
	MAX_OVERWRITE_FILES,
	overwriteVerdict,
	runFirstRun,
	startPreparing
} from "../main/sync/firstRun.ts"
import type { ShellPair } from "../main/sync/store.ts"
import { CLEAN_SUMMARY, fakeNative, memoryStore, Refusal } from "./syncFakes.ts"

const REMOTE = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
const LEGACY = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"
const MIB = 1_048_576

const { passToken: _passToken, ...SUMMARY } = CLEAN_SUMMARY

function plan(summary: Partial<DesktopSyncPlanSummary> = {}, rest: Partial<Omit<FirstRunPlan, "summary">> = {}): FirstRunPlan {
	return { summary: { ...SUMMARY, ...summary }, uploads: 0, downloads: 0, ...rest }
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
	const rows: [string, FirstRunPlan | null, DesktopSyncReviewFinding[]][] = [
		["clean", plan(), []],
		["adoptions transfer nothing", plan({ actions: 50_000 }), []],
		["1 MiB in 25 transfers", plan({ actions: 25, uploadBytes: MIB / 2, downloadBytes: MIB / 2 }, { uploads: 20, downloads: 5 }), []],
		["over 1 MiB", plan({ uploadBytes: MIB, downloadBytes: 1 }, { uploads: 1, downloads: 1 }), ["uploads", "downloads"]],
		["over 25 transfers", plan({}, { downloads: 26 }), ["downloads"]],
		["conflicts", plan({ conflicts: 1 }), ["conflicts"]],
		["held deletions", plan({ heldDeletions: 1, heldReason: "firstSyncWithDeletions" }), ["heldDeletions"]],
		["refused", plan({ refused: "localCollision" }), ["refused"]],
		["unconverged", null, ["unconverged"]]
	]

	it.each(rows)("%s", (_name, input, findings) => {
		expect(firstRunVerdict(input)).toEqual(findings.length === 0 ? { start: true } : { start: false, findings })
	})
})

describe("overwriteVerdict", () => {
	const held = { start: false, findings: ["overwrites"] }

	it.each([
		["nothing", { files: 0, bytes: 0 }, { start: true }],
		["at both limits", { files: MAX_OVERWRITE_FILES, bytes: MAX_OVERWRITE_BYTES }, { start: true }],
		["over the file limit", { files: MAX_OVERWRITE_FILES + 1, bytes: 0 }, held],
		["over the byte limit", { files: 1, bytes: MAX_OVERWRITE_BYTES + 1 }, held],
		["not known", null, held]
	])("%s", (_name, overwrites, verdict) => {
		expect(overwriteVerdict(overwrites)).toEqual(verdict)
	})
})

describe("runFirstRun", () => {
	const options = { paused: false }

	it("starts a clean pair", async () => {
		const store = memoryStore([shellPair({ pairId: "1", paused: true, state: "review" })])
		const { deps, ops, argsOf } = fakeNative(store)

		await runFirstRun(deps, "1", options)

		expect(ops()).toEqual(["evaluatePlan", "releasePlan", "resume"])
		expect(argsOf("evaluatePlan")).toEqual([{ pairId: "1", check: { overwrites: false } }])
		expect(store.get().pairs[0]).toMatchObject({ paused: false, state: "active", review: null })
	})

	it("keeps a pair the user paused paused, even when clean", async () => {
		const store = memoryStore([shellPair({ pairId: "1", paused: true, state: "review" })])
		const { deps, ops } = fakeNative(store)

		await runFirstRun(deps, "1", { paused: true })

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
				check: { uploads: 4, downloads: 0, overwrites: null }
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

	it("holds an unconverged pair in review", async () => {
		const store = memoryStore([shellPair({ pairId: "1" })])
		const { deps, ops } = fakeNative(store, { evaluatePlan: () => ({ status: "unconverged" }) })

		await runFirstRun(deps, "1", options)

		expect(ops()).toEqual(["evaluatePlan"])
		expect(store.get().pairs[0]?.review).toEqual({ reason: "baselineReset", findings: ["unconverged"], summary: null })
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
		expect(store.get().pairs).toEqual([shellPair({ pairId: "1", name: "Kept", paused: true, state: "active" })])
	})

	it("adds a migrated pair paused in the engine and preparing, keeping what the user had", async () => {
		const store = memoryStore([
			shellPair({ legacyUuid: LEGACY, state: "waitingForRoot" }),
			shellPair({ legacyUuid: REMOTE, remoteRoot: LEGACY, paused: true, state: "preparing" })
		])
		const { deps, ops } = fakeNative(store)

		await attachUnheld(deps)

		expect(ops()).toEqual(["addPair", "pause", "addPair", "pause"])
		expect(store.get().pairs.map(pair => [pair.pairId, pair.state, pair.paused, pair.review])).toEqual([
			["1", "preparing", false, null],
			["2", "preparing", true, null]
		])
	})

	it("treats a migrated pair a baseline reset lost like any other", async () => {
		const store = memoryStore([shellPair({ legacyUuid: LEGACY, state: "review" })])
		const { deps, ops } = fakeNative(store)

		await attachUnheld(deps)

		expect(ops()).toEqual(["addPair", "pause", "evaluatePlan", "releasePlan", "resume"])
		expect(store.get().pairs[0]?.state).toBe("active")
	})

	it("keeps a pair the engine refuses for good, unsynced with the reason, and one a passing failure hit for the next start", async () => {
		const store = memoryStore([shellPair()])
		const refused = fakeNative(store, { addPair: () => new Refusal("remoteRootNested") })

		await attachUnheld(refused.deps)
		expect(store.get().pairs).toEqual([shellPair({ state: "unsupported", notices: ["refusedRemoteOverlap"] })])

		// Never offered to the engine again.
		await attachUnheld(refused.deps)
		expect(refused.ops()).toEqual(["addPair"])

		const kept = memoryStore([
			shellPair({ state: "review" }),
			shellPair({ legacyUuid: LEGACY, remoteRoot: LEGACY, state: "waitingForRoot" })
		])
		const passing = fakeNative(kept, { addPair: () => new Refusal("timeout") })

		await attachUnheld(passing.deps)
		expect(kept.get().pairs).toEqual([
			shellPair({ state: "review" }),
			shellPair({ legacyUuid: LEGACY, remoteRoot: LEGACY, state: "waitingForRoot" })
		])
	})

	it("takes the pair back out of the engine when it cannot be paused", async () => {
		const store = memoryStore([shellPair()])
		const { deps, ops } = fakeNative(store, { pause: () => new Refusal("hostUnavailable") })

		await attachUnheld(deps)

		expect(ops()).toEqual(["addPair", "pause", "removePair"])
		expect(store.get().pairs).toEqual([shellPair()])
	})
})

describe("startPreparing", () => {
	const busy = {
		status: "ok",
		planId: "p",
		summary: { ...CLEAN_SUMMARY, actions: 9000, uploadBytes: 50 * MIB, conflicts: 12, heldDeletions: 4 },
		check: { uploads: 9000, downloads: 0, overwrites: null }
	}

	function preparing(overrides: Partial<ShellPair> = {}): ShellPair {
		return shellPair({ pairId: "1", legacyUuid: LEGACY, state: "preparing", ...overrides })
	}

	it("starts a two-way pair once its cloud directory is read, whatever its first run does", async () => {
		const store = memoryStore([preparing()])
		const { deps, ops } = fakeNative(store, { evaluatePlan: () => busy })

		await expect(startPreparing(deps)).resolves.toBe(false)

		expect(ops()).toEqual(["awaitConverged", "resume"])
		expect(store.get().pairs[0]).toMatchObject({ paused: false, state: "active", review: null })
	})

	it("keeps a pair the user had paused paused", async () => {
		const store = memoryStore([preparing({ paused: true })])
		const { deps, ops } = fakeNative(store)

		await expect(startPreparing(deps)).resolves.toBe(false)

		expect(ops()).toEqual(["awaitConverged"])
		expect(store.get().pairs[0]).toMatchObject({ paused: true, state: "active", review: null })
	})

	it("waits, unplanned and paused, while the cloud directory is not read", async () => {
		const store = memoryStore([preparing({ mode: "localToRemote" }), preparing({ pairId: "2" })])
		const { deps, ops } = fakeNative(store, { awaitConverged: () => false })

		await expect(startPreparing(deps)).resolves.toBe(true)

		expect(ops()).toEqual(["awaitConverged", "awaitConverged"])
		expect(store.get().pairs.map(pair => pair.state)).toEqual(["preparing", "preparing"])
	})

	it.each([
		["a failed convergence check", { awaitConverged: () => new Refusal("hostUnavailable") }],
		["a failed start", { resume: () => new Refusal("hostUnavailable") }]
	])("waits after %s", async (_name, answers) => {
		const store = memoryStore([preparing()])
		const { deps } = fakeNative(store, answers)

		await expect(startPreparing(deps)).resolves.toBe(true)
		expect(store.get().pairs[0]?.state).toBe("preparing")
	})

	it.each(["localToRemote", "localBackup", "remoteToLocal", "remoteBackup"] as const)(
		"starts a %s pair whose first run overwrites up to the limits",
		async mode => {
			const store = memoryStore([preparing({ mode })])
			const { deps, ops, argsOf } = fakeNative(store, {
				evaluatePlan: () => ({
					...busy,
					check: { uploads: 9000, downloads: 9000, overwrites: { files: MAX_OVERWRITE_FILES, bytes: MAX_OVERWRITE_BYTES } }
				})
			})

			await expect(startPreparing(deps)).resolves.toBe(false)

			expect(ops()).toEqual(["awaitConverged", "evaluatePlan", "releasePlan", "resume"])
			expect(argsOf("evaluatePlan")).toEqual([{ pairId: "1", check: { overwrites: true } }])
			expect(store.get().pairs[0]).toMatchObject({ paused: false, state: "active", review: null })
		}
	)

	it.each(["localToRemote", "localBackup", "remoteToLocal", "remoteBackup"] as const)(
		"holds a %s pair whose first run overwrites more in review",
		async mode => {
			const store = memoryStore([preparing({ mode })])
			const { deps, ops } = fakeNative(store, {
				evaluatePlan: () => ({
					...busy,
					check: { uploads: 0, downloads: 0, overwrites: { files: MAX_OVERWRITE_FILES + 1, bytes: 0 } }
				})
			})

			await expect(startPreparing(deps)).resolves.toBe(false)

			const { passToken: _token, ...summary } = busy.summary

			expect(ops()).toEqual(["awaitConverged", "evaluatePlan", "releasePlan"])
			expect(store.get().pairs[0]).toMatchObject({
				paused: true,
				state: "review",
				review: { reason: "migrated", findings: ["overwrites"], summary }
			})
		}
	)

	it("waits for a one-way pair whose plan found the cloud directory unread", async () => {
		const store = memoryStore([preparing({ mode: "remoteToLocal" })])
		const { deps, ops } = fakeNative(store, { evaluatePlan: () => ({ status: "unconverged" }) })

		await expect(startPreparing(deps)).resolves.toBe(true)

		expect(ops()).toEqual(["awaitConverged", "evaluatePlan"])
		expect(store.get().pairs[0]?.state).toBe("preparing")
	})

	it("leaves a pair settled or removed meanwhile alone", async () => {
		const store = memoryStore([preparing()])
		const { deps, ops } = fakeNative(store, {
			awaitConverged: () => {
				void store.update(state => ({ ...state, pairs: [] }))

				return true
			}
		})

		await expect(startPreparing(deps)).resolves.toBe(false)
		expect(ops()).toEqual(["awaitConverged"])
	})
})

describe("holdReviewed", () => {
	it("pauses a pair in review the engine holds unpaused, and every preparing one", async () => {
		const store = memoryStore([
			shellPair({ pairId: "4", state: "review" }),
			shellPair({ pairId: "5", localRoot: "/elsewhere" }),
			shellPair({ pairId: "6", legacyUuid: LEGACY, state: "preparing" })
		])
		const { deps, argsOf } = fakeNative(store)

		await holdReviewed(deps)

		expect(argsOf("pause")).toEqual([{ pairId: "4" }, { pairId: "6" }])
		// A preparing pair's flag is what the user had.
		expect(store.get().pairs.map(pair => pair.paused)).toEqual([true, false, false])
	})
})
