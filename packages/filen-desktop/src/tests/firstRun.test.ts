import { chmod, lstat, mkdir, mkdtemp, stat, symlink, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopSyncMode, DesktopSyncPlanSummary, DesktopSyncReviewFinding } from "@filen/shared/desktop"
import {
	attachUnheld,
	BIN_DIR,
	ensureRules,
	type FirstRunPlan,
	firstRunVerdict,
	holdReviewed,
	MAX_MIGRATED_CONFLICTS,
	MAX_OVERWRITE_BYTES,
	MAX_OVERWRITE_FILES,
	migratedVerdict,
	runFirstRun,
	SLOW_LISTING_ROUNDS,
	startPreparing
} from "../main/sync/firstRun.ts"
import type { ShellPair } from "../main/sync/store.ts"
import { CLEAN_SUMMARY, fakeNative, memoryStore, Refusal, ROOT_CONTEXT, shellPair as baseShellPair } from "./syncFakes.ts"

const REMOTE = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
const LEGACY = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"
const MIB = 1_048_576
const RULES = [".*", "!/.filenignore"]

const { passToken: _passToken, ...SUMMARY } = CLEAN_SUMMARY

function plan(summary: Partial<DesktopSyncPlanSummary> = {}, rest: Partial<Omit<FirstRunPlan, "summary">> = {}): FirstRunPlan {
	return { summary: { ...SUMMARY, ...summary }, uploads: 0, downloads: 0, overwrites: { files: 0, bytes: 0 }, ...rest }
}

let directory: string

beforeEach(async () => {
	directory = await realpath(await mkdtemp(path.join(tmpdir(), "filen-first-run-")))
})

afterEach(async () => {
	await chmod(directory, 0o700)
	await rm(directory, { recursive: true, force: true })
})

function shellPair(overrides: Partial<ShellPair> = {}): ShellPair {
	return baseShellPair({ name: "Work", localRoot: directory, remoteRoot: REMOTE, createdAt: 1, ...overrides })
}

function evaluation(summary: Partial<DesktopSyncPlanSummary>, overwrites = { files: 0, bytes: 0 }) {
	return { status: "ok", planId: "p", summary: { ...CLEAN_SUMMARY, ...summary }, check: { uploads: 0, downloads: 0, overwrites } }
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

describe("migratedVerdict", () => {
	const rows: [string, FirstRunPlan, DesktopSyncMode, DesktopSyncReviewFinding[]][] = [
		["ordinary transfers", plan({ actions: 90_000, uploadBytes: 50 * MIB }, { uploads: 90_000 }), "twoWay", []],
		["conflicts up to the limit", plan({ conflicts: MAX_MIGRATED_CONFLICTS }), "twoWay", []],
		["conflicts over it", plan({ conflicts: MAX_MIGRATED_CONFLICTS + 1 }), "twoWay", ["conflicts"]],
		["held deletions", plan({ heldDeletions: 1 }), "localToRemote", ["heldDeletions"]],
		["refused", plan({ refused: "remoteCollision" }), "twoWay", ["refused"]],
		[
			"one-way overwrites at both limits",
			plan({}, { overwrites: { files: MAX_OVERWRITE_FILES, bytes: MAX_OVERWRITE_BYTES } }),
			"remoteToLocal",
			[]
		],
		[
			"one-way overwrites over the files",
			plan({}, { overwrites: { files: MAX_OVERWRITE_FILES + 1, bytes: 0 } }),
			"localBackup",
			["overwrites"]
		],
		[
			"one-way overwrites over the bytes",
			plan({}, { overwrites: { files: 1, bytes: MAX_OVERWRITE_BYTES + 1 } }),
			"remoteBackup",
			["overwrites"]
		],
		["two-way replaces as it syncs", plan({}, { overwrites: { files: MAX_OVERWRITE_FILES + 1, bytes: 0 } }), "twoWay", []]
	]

	it.each(rows)("%s", (_name, input, mode, findings) => {
		expect(migratedVerdict(input, mode)).toEqual(findings.length === 0 ? { start: true } : { start: false, findings })
	})
})

describe("ensureRules", () => {
	const file = () => path.join(directory, ".filenignore")

	it("writes the rules, keeping the user's lines and a BOM, and leaves no temporary file", async () => {
		await writeFile(file(), "\uFEFFbuild/")

		await expect(ensureRules(directory, RULES)).resolves.toBeNull()
		expect(await readFile(file(), "utf8")).toBe("\uFEFFbuild/\n.*\n!/.filenignore\n")
		expect(await readdir(path.join(directory, BIN_DIR))).toEqual([])

		// Nothing to add the second time.
		await expect(ensureRules(directory, RULES)).resolves.toBeNull()
	})

	it("never rewrites a file that is no UTF-8 text", async () => {
		const bytes = Buffer.from([0x62, 0xff, 0x0a])

		await writeFile(file(), bytes)

		await expect(ensureRules(directory, RULES)).resolves.toBe("ruleFileUndecodable")
		expect(await readFile(file())).toEqual(bytes)
	})

	it("keeps the file's mode", async () => {
		await writeFile(file(), "build/")
		await chmod(file(), 0o640)

		await expect(ensureRules(directory, RULES)).resolves.toBeNull()
		expect((await stat(file())).mode & 0o777).toBe(0o640)
	})

	it("never replaces a link or anything but a file", async () => {
		const target = path.join(directory, "elsewhere")

		await writeFile(target, "")
		await symlink(target, file())

		await expect(ensureRules(directory, RULES)).resolves.toBe("ruleFileUnwritable")
		expect(await readFile(target, "utf8")).toBe("")
		expect((await lstat(file())).isSymbolicLink()).toBe(true)

		await rm(file())
		await mkdir(file())
		await expect(ensureRules(directory, RULES)).resolves.toBe("ruleFileUnwritable")
	})

	it("says so when the directory cannot be written", async () => {
		await chmod(directory, 0o500)

		await expect(ensureRules(directory, RULES)).resolves.toBe("ruleFileUnwritable")
	})
})

describe("runFirstRun", () => {
	const options = { paused: false }

	it("starts a clean pair", async () => {
		const store = memoryStore([shellPair({ pairId: "1", paused: true, state: "review" })])
		const { deps, ops, argsOf } = fakeNative(store)

		await runFirstRun(deps, "1", options)

		expect(ops()).toEqual(["evaluatePlan", "releasePlan", "resume"])
		expect(argsOf("evaluatePlan")).toEqual([{ pairId: "1", check: true }])
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
				check: { uploads: 4, downloads: 0, overwrites: { files: 0, bytes: 0 } }
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
			shellPair({
				localRoot: path.join(directory, "missing"),
				legacyUuid: REMOTE,
				remoteRoot: LEGACY,
				paused: true,
				state: "preparing"
			})
		])
		const { deps, ops } = fakeNative(store)

		await attachUnheld(deps)

		expect(ops()).toEqual(["addPair", "pause"])
		expect(store.get().pairs.map(pair => [pair.pairId, pair.state, pair.paused, pair.review])).toEqual([
			["1", "preparing", false, null],
			[null, "waitingForRoot", true, null]
		])
	})

	it("writes a migrated pair's rules before the engine gets it", async () => {
		const store = memoryStore([shellPair({ legacyUuid: LEGACY, state: "waitingForRoot", legacyRules: ["build/", ...RULES] })])
		const { deps, call } = fakeNative(store)
		let written: string | null = null

		call.mockImplementationOnce(async () => {
			written = await readFile(path.join(directory, ".filenignore"), "utf8")

			return { ok: true, value: { pairId: "1" } }
		})

		await attachUnheld(deps)

		expect(written).toBe("build/\n.*\n!/.filenignore\n")
		expect(store.get().pairs[0]).toMatchObject({ pairId: "1", state: "preparing", holds: [] })
	})

	it("holds a migrated pair whose rules cannot be written, unknown to the engine, and adds it once they are", async () => {
		const store = memoryStore([shellPair({ legacyUuid: LEGACY, state: "waitingForRoot", legacyRules: RULES })])
		const { deps, ops } = fakeNative(store)

		// A directory where the rule file goes.
		await mkdir(path.join(directory, ".filenignore"))
		await attachUnheld(deps)

		expect(ops()).toEqual([])
		expect(store.get().pairs[0]).toMatchObject({ pairId: null, state: "preparing", holds: ["ruleFileUnwritable"] })

		await rm(path.join(directory, ".filenignore"), { recursive: true })
		await attachUnheld(deps)

		expect(ops()).toEqual(["addPair", "pause"])
		expect(store.get().pairs[0]).toMatchObject({ pairId: "1", state: "preparing", holds: [] })
	})

	it("refuses a migrated pair whose directory could not be a pair's root", async () => {
		const store = memoryStore([shellPair({ legacyUuid: LEGACY, state: "waitingForRoot" })])
		const { deps, ops } = fakeNative(store)

		deps.rootContext = () => Promise.resolve({ ...ROOT_CONTEXT, home: directory })
		await attachUnheld(deps)

		expect(ops()).toEqual([])
		expect(store.get().pairs[0]).toMatchObject({
			state: "unsupported",
			notices: ["refusedLocalRoot"],
			rootProblem: "homeDirectory"
		})
	})

	it("keeps a pair of the whole drive from the engine until the user starts it", async () => {
		const store = memoryStore([shellPair({ legacyUuid: LEGACY, state: "waitingForRoot" })])
		const { deps, ops } = fakeNative(store)

		deps.driveRoot = REMOTE.toUpperCase()
		await attachUnheld(deps)
		await attachUnheld(deps)

		expect(ops()).toEqual([])
		expect(store.get().pairs[0]).toMatchObject({ pairId: null, state: "preparing", holds: ["driveRoot"] })

		await store.update(state => ({ ...state, pairs: state.pairs.map(pair => ({ ...pair, holds: [], wholeDriveConfirmed: true })) }))
		await attachUnheld(deps)

		expect(ops()).toEqual(["addPair", "pause"])
	})

	it("keeps a pair the engine refuses for good, unsynced with the reason, and one a passing failure hit for later", async () => {
		const store = memoryStore([shellPair()])
		const refused = fakeNative(store, { addPair: () => new Refusal("remoteRootNested") })

		await attachUnheld(refused.deps)
		expect(store.get().pairs).toEqual([shellPair({ state: "unsupported", notices: ["refusedRemoteOverlap"] })])

		// Never offered to the engine again.
		await attachUnheld(refused.deps)
		expect(refused.ops()).toEqual(["addPair"])

		const conflicting = memoryStore([shellPair()])

		await attachUnheld(fakeNative(conflicting, { addPair: () => new Refusal("modeConflict") }).deps)
		expect(conflicting.get().pairs[0]?.notices).toEqual(["refusedModeConflict"])

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
	function preparing(overrides: Partial<ShellPair> = {}): ShellPair {
		return shellPair({ pairId: "1", legacyUuid: LEGACY, state: "preparing", ...overrides })
	}

	it("dry-runs and starts one pair, on the guard, and leaves the next for later", async () => {
		const store = memoryStore([preparing({ legacyRules: RULES, holds: ["ruleFileUnwritable"] }), preparing({ pairId: "2" })])
		const { deps, ops, argsOf } = fakeNative(store, {
			evaluatePlan: () => evaluation({ actions: 9000, uploadBytes: 50 * MIB, conflicts: MAX_MIGRATED_CONFLICTS })
		})

		await expect(startPreparing(deps)).resolves.toEqual({ started: "1", waiting: true })

		expect(ops()).toEqual(["awaitConverged", "evaluatePlan", "releasePlan", "setMigratedGuard", "resume"])
		expect(argsOf("evaluatePlan")).toEqual([{ pairId: "1", check: true }])
		expect(store.get().pairs.map(pair => [pair.state, pair.paused, pair.legacyRules, pair.holds])).toEqual([
			["active", false, null, []],
			["preparing", false, null, []]
		])
		expect(await readFile(path.join(directory, ".filenignore"), "utf8")).toBe(".*\n!/.filenignore\n")
	})

	it("says which pair starts before starting it, and takes that back when it did not start", async () => {
		const store = memoryStore([preparing()])
		const started = fakeNative(store)
		let before: string[] = []

		vi.mocked(started.deps.starting).mockImplementation(() => {
			before = started.ops()
		})
		await startPreparing(started.deps)
		expect(before).not.toContain("resume")
		expect(started.ops().at(-1)).toBe("resume")

		const failing = fakeNative(memoryStore([preparing()]), { resume: () => new Refusal("hostUnavailable") })

		await startPreparing(failing.deps)
		expect(vi.mocked(failing.deps.starting).mock.calls).toEqual([["1"], [null]])
	})

	it("settles a pair the user had paused without starting it, and moves on", async () => {
		const store = memoryStore([preparing({ paused: true }), preparing({ pairId: "2" })])
		const { deps, ops } = fakeNative(store)

		await expect(startPreparing(deps)).resolves.toEqual({ started: "2", waiting: true })

		expect(ops().filter(op => op === "resume")).toHaveLength(1)
		expect(store.get().pairs[0]).toMatchObject({ paused: true, state: "active", review: null })
	})

	it("says so once the cloud directory was not read in many rounds, and stops saying it once it is", async () => {
		const store = memoryStore([preparing()])
		let read = false
		const { deps } = fakeNative(store, { awaitConverged: () => read })

		for (let round = 1; round < SLOW_LISTING_ROUNDS; round++) {
			await expect(startPreparing(deps)).resolves.toEqual({ started: null, waiting: true })
		}

		expect(store.get().pairs[0]?.holds).toEqual([])

		await startPreparing(deps)
		expect(store.get().pairs[0]).toMatchObject({ state: "preparing", holds: ["cloudListingSlow"] })

		read = true
		await expect(startPreparing(deps)).resolves.toEqual({ started: "1", waiting: true })
		expect(store.get().pairs[0]).toMatchObject({ state: "active", holds: [] })
	})

	it.each([
		["a failed convergence check", { awaitConverged: () => new Refusal("hostUnavailable") }],
		["a plan of an unread cloud directory", { evaluatePlan: () => ({ status: "unconverged" }) }],
		["a guard not set", { setMigratedGuard: () => new Refusal("hostUnavailable") }],
		["a failed start", { resume: () => new Refusal("hostUnavailable") }]
	])("waits after %s", async (_name, answers) => {
		const store = memoryStore([preparing()])
		const { deps } = fakeNative(store, answers)

		await expect(startPreparing(deps)).resolves.toEqual({ started: null, waiting: true })
		expect(store.get().pairs[0]?.state).toBe("preparing")
	})

	it.each([
		["held deletions", "localToRemote", evaluation({ heldDeletions: 4 }), ["heldDeletions"]],
		["many conflicts", "twoWay", evaluation({ conflicts: MAX_MIGRATED_CONFLICTS + 1 }), ["conflicts"]],
		["overwrites", "remoteBackup", evaluation({}, { files: MAX_OVERWRITE_FILES + 1, bytes: 0 }), ["overwrites"]]
	] as const)("holds a pair whose first run has %s in review", async (_name, mode, evaluated, findings) => {
		const store = memoryStore([preparing({ mode })])
		const { deps, ops } = fakeNative(store, { evaluatePlan: () => evaluated })

		await expect(startPreparing(deps)).resolves.toEqual({ started: null, waiting: false })

		const { passToken: _token, ...summary } = evaluated.summary

		expect(ops()).toEqual(["awaitConverged", "evaluatePlan", "releasePlan"])
		expect(store.get().pairs[0]).toMatchObject({ paused: true, state: "review", review: { reason: "migrated", findings, summary } })
	})

	it("decides again when the user paused the pair during its dry run", async () => {
		const store = memoryStore([preparing()])
		const { deps, ops } = fakeNative(store, {
			evaluatePlan: () => {
				void store.update(state => ({ ...state, pairs: state.pairs.map(pair => ({ ...pair, paused: true })) }))

				return evaluation({})
			}
		})

		await expect(startPreparing(deps)).resolves.toEqual({ started: null, waiting: true })
		expect(ops()).not.toContain("resume")
		expect(store.get().pairs[0]).toMatchObject({ state: "preparing", paused: true })
	})

	it("leaves a pair removed meanwhile alone", async () => {
		const store = memoryStore([preparing()])
		const { deps, ops } = fakeNative(store, {
			awaitConverged: () => {
				void store.update(state => ({ ...state, pairs: [] }))

				return true
			}
		})

		await expect(startPreparing(deps)).resolves.toEqual({ started: null, waiting: false })
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
