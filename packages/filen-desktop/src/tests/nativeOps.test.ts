import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CacheStatusMessage, PlannedAction } from "@filen/sdk-rs"
import { createConvergence } from "../native/convergence.ts"
import { classify } from "../native/errors.ts"
import { createHostEngine } from "../native/ops.ts"
import { createPlanRegistry } from "../native/plans.ts"
import { createRuntimeFeed } from "../native/reducer.ts"
import type { FromNative } from "../shared/nativeProtocol.ts"
import { action, fakeEngine, fakePlan, fakeSdk, pairInfo, passEvent, REMOTE_ROOT, report, sdkError } from "./nativeFakes.ts"

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

function setup(pairs = [pairInfo()]) {
	const fake = fakeEngine(pairs)
	const log = { info: vi.fn(), warn: vi.fn() }
	const convergence = createConvergence()
	const plans = createPlanRegistry()
	const posted: FromNative[] = []
	const feed = createRuntimeFeed(fakeSdk, {
		post: message => {
			posted.push(message)
		},
		onAuthFailed: () => undefined,
		onPassEnded: () => undefined,
		onReachable: () => undefined
	})
	const host = createHostEngine({
		sdk: fakeSdk,
		engine: fake.handle,
		feed,
		plans,
		convergence,
		signal: new AbortController().signal,
		convergenceTimeoutMs: 5000,
		log
	})

	return { ...fake, convergence, plans, host, log, feed, posted }
}

function sized(planned: PlannedAction, size: bigint): PlannedAction {
	return { ...planned, size }
}

const resync = (roots: string[], converged: boolean): CacheStatusMessage[] => [
	{ tag: "ResyncProgress", inner: { progress: { tag: "Started", inner: { roots } } } },
	{ tag: "ResyncProgress", inner: { progress: { tag: "Finished", inner: { converged } } } }
]

async function failure(promise: Promise<unknown>) {
	try {
		await promise
	} catch (error) {
		return classify(fakeSdk, error)
	}

	throw new Error("resolved")
}

describe("native ops", () => {
	it("resume watches a pair paused at open", async () => {
		const { engine, host } = setup([pairInfo({ id: 1n, paused: true }), pairInfo({ id: 2n, localRoot: "/b" })])

		await host.watchAll([], () => undefined)
		expect(engine.watchPair).toHaveBeenCalledOnce()
		expect(engine.watchPair).toHaveBeenCalledWith(2n, undefined)

		await host.ops.resume({ pairId: "1" })
		expect(engine.resumePair).toHaveBeenCalledWith(1n)
		expect(engine.watchPair).toHaveBeenLastCalledWith(1n, undefined)

		// Its watch survives a pause, so the next resume starts none.
		await host.ops.pause({ pairId: "1" })
		await host.ops.resume({ pairId: "1" })
		expect(engine.watchPair).toHaveBeenCalledTimes(2)
	})

	it("evaluatePlan waits for convergence", async () => {
		const { engine, convergence, host } = setup()
		const { handle } = fakePlan([action("UploadFile", "a.txt")], { uploadBytes: 5n })

		engine.planPair.mockResolvedValue(handle)
		await host.refreshPairs()

		const evaluated = host.ops.evaluatePlan({ pairId: "1" })

		await vi.advanceTimersByTimeAsync(100)
		expect(engine.planPair).not.toHaveBeenCalled()

		convergence.onMessages(resync(["other"], true))
		convergence.onMessages(resync([REMOTE_ROOT], false))
		await vi.advanceTimersByTimeAsync(100)
		expect(engine.planPair).not.toHaveBeenCalled()

		convergence.onMessages(resync([REMOTE_ROOT], true))
		await expect(evaluated).resolves.toMatchObject({
			status: "ok",
			planId: "1",
			summary: { actions: 1, uploadBytes: 5, heldReason: null, refused: null, passToken: null },
			check: null
		})
	})

	it("evaluatePlan reports an unconverged remote after the timeout", async () => {
		const { engine, host } = setup()

		await host.refreshPairs()

		const evaluated = host.ops.evaluatePlan({ pairId: "1" })

		await vi.advanceTimersByTimeAsync(5000)
		await expect(evaluated).resolves.toEqual({ status: "unconverged" })
		expect(engine.planPair).not.toHaveBeenCalled()
	})

	it("awaitConverged answers whether the cache read the pair's cloud directory", async () => {
		const { convergence, host } = setup()

		await host.refreshPairs()

		const unread = host.ops.awaitConverged({ pairId: "1" })

		await vi.advanceTimersByTimeAsync(5000)
		await expect(unread).resolves.toBe(false)

		const read = host.ops.awaitConverged({ pairId: "1" })

		convergence.onMessages(resync([REMOTE_ROOT], true))
		await expect(read).resolves.toBe(true)
	})

	it("evaluatePlan counts the transfers, and those that replace a file, when asked", async () => {
		const replaced = (planned: PlannedAction): PlannedAction => ({ ...planned, transfer: fakeSdk.PlannedTransfer.Replace })
		const actions = [
			sized(replaced(action("UploadFile", "up.txt")), 7n),
			sized(replaced(action("DownloadFile", "d/kept.txt")), 5n),
			sized({ ...action("DownloadFile", "new.txt"), transfer: fakeSdk.PlannedTransfer.Create }, 11n),
			action("AdoptBaseline", "c.txt"),
			...Array.from({ length: 2500 }, (_, i) => action("AdoptBaseline", `bulk/${String(i)}`))
		]
		const { plan, handle } = fakePlan(actions)
		const { engine, convergence, host } = setup()

		engine.planPair.mockResolvedValue(handle)
		await host.refreshPairs()
		convergence.onMessages(resync([REMOTE_ROOT], true))

		await expect(host.ops.evaluatePlan({ pairId: "1", check: true })).resolves.toMatchObject({
			check: { uploads: 1, downloads: 2, overwrites: { files: 2, bytes: 12 } }
		})
		// Paged at the engine's limit.
		expect(plan.actions).toHaveBeenCalledTimes(3)
	})

	it("evaluatePlan reads a listing that started over as not ready", async () => {
		const { engine, convergence, host } = setup()

		engine.planPair.mockRejectedValue(sdkError(fakeSdk.ErrorKind.StaleState))
		await host.refreshPairs()
		convergence.onMessages(resync([REMOTE_ROOT], true))

		await expect(host.ops.evaluatePlan({ pairId: "1" })).resolves.toEqual({ status: "unconverged" })
	})

	it("a root listed again, or its pair removed, is not converged until listed anew", async () => {
		const { convergence, host } = setup()

		await host.refreshPairs()
		convergence.onMessages(resync([REMOTE_ROOT], true))
		convergence.onMessages([{ tag: "ResyncProgress", inner: { progress: { tag: "Started", inner: { roots: [REMOTE_ROOT] } } } }])
		expect(convergence.isConverged(REMOTE_ROOT)).toBe(false)

		convergence.onMessages([{ tag: "ResyncProgress", inner: { progress: { tag: "Finished", inner: { converged: true } } } }])
		expect(convergence.isConverged(REMOTE_ROOT)).toBe(true)

		await host.ops.removePair({ pairId: "1" })
		expect(convergence.isConverged(REMOTE_ROOT)).toBe(false)
	})

	it("pauses the pairs main holds back before any watch starts", async () => {
		const held = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
		const { engine, host } = setup([pairInfo({ id: 1n }), pairInfo({ id: 2n, localRoot: "/b", remoteRoot: held })])

		await host.watchAll([held.toUpperCase()], () => undefined)

		expect(engine.pausePair).toHaveBeenCalledExactlyOnceWith(2n, undefined)
		expect(engine.watchPair).toHaveBeenCalledExactlyOnceWith(1n, undefined)
	})

	it("asks for no pass of a paused pair, and retries every failed path of a running one with a pass", async () => {
		const { engine, host } = setup([pairInfo({ id: 1n }), pairInfo({ id: 2n, localRoot: "/b", paused: true })])

		await host.watchAll([], () => undefined)
		await expect(host.ops.requestPass({ pairId: "2" })).resolves.toBeNull()
		expect(engine.requestPass).not.toHaveBeenCalled()

		await host.ops.retryAll({ pairId: "1" })
		await host.ops.retryAll({ pairId: "2" })
		expect(engine.retryAll.mock.calls).toEqual([[1n], [2n]])
		expect(engine.requestPass.mock.calls).toEqual([[1n]])
	})

	it("asks for a pass after a path's retry of a running pair only", async () => {
		const { engine, host } = setup([pairInfo({ id: 1n }), pairInfo({ id: 2n, localRoot: "/b", paused: true })])

		await host.watchAll([], () => undefined)
		await expect(host.ops.retryPath({ pairId: "1", relPath: "a.bin" })).resolves.toBeNull()
		await expect(host.ops.retryPath({ pairId: "2", relPath: "b.bin" })).resolves.toBeNull()
		expect(engine.retryPath.mock.calls).toEqual([
			[1n, "a.bin"],
			[2n, "b.bin"]
		])
		expect(engine.requestPass.mock.calls).toEqual([[1n]])
	})

	it("asks for a pass after an approval of a running pair only, starting its watch when it has none", async () => {
		const { engine, host } = setup([pairInfo({ id: 1n }), pairInfo({ id: 2n, localRoot: "/b", paused: true })])

		await host.refreshPairs()
		await expect(host.ops.approveDeletions({ pairId: "2", passToken: "t2" })).resolves.toBeNull()
		await expect(host.ops.approveDeletions({ pairId: "1", passToken: "t1" })).resolves.toBeNull()
		expect(engine.approveDeletions.mock.calls).toEqual([
			[2n, "t2"],
			[1n, "t1"]
		])
		expect(engine.watchPair).toHaveBeenCalledExactlyOnceWith(1n, undefined)

		await host.ops.approveDeletions({ pairId: "1", passToken: "t3" })
		expect(engine.requestPass.mock.calls).toEqual([[1n]])
	})

	it("asks for a pass after a restore of a running pair only, starting its watch when it has none", async () => {
		const { engine, host } = setup([pairInfo({ id: 1n }), pairInfo({ id: 2n, localRoot: "/b", paused: true })])

		await host.refreshPairs()
		await expect(host.ops.restoreDeletions({ pairId: "2", passToken: "t2" })).resolves.toBeNull()
		await expect(host.ops.restoreDeletions({ pairId: "1", passToken: "t1" })).resolves.toBeNull()
		expect(engine.restoreDeletions.mock.calls).toEqual([
			[2n, "t2"],
			[1n, "t1"]
		])
		expect(engine.approveDeletions).not.toHaveBeenCalled()
		expect(engine.watchPair).toHaveBeenCalledExactlyOnceWith(1n, undefined)

		await host.ops.restoreDeletions({ pairId: "1", passToken: "t3" })
		expect(engine.requestPass.mock.calls).toEqual([[1n]])
	})

	it("returns where a resolution put the copy that lost", async () => {
		const { engine, host } = setup()

		await host.refreshPairs()
		engine.resolveConflict
			.mockResolvedValueOnce({ keptAs: "docs/report.old.docx" })
			.mockResolvedValueOnce({ quarantined: ".filen/bin/2026-11-03/report.docx" })
			.mockResolvedValueOnce({})

		await expect(host.ops.resolveConflict({ pairId: "1", relPath: "docs/report.docx", resolution: "keepBoth" })).resolves.toEqual({
			quarantined: null,
			keptAs: "docs/report.old.docx"
		})
		await expect(host.ops.resolveConflict({ pairId: "1", relPath: "docs/report.docx", resolution: "keepRemote" })).resolves.toEqual({
			quarantined: ".filen/bin/2026-11-03/report.docx",
			keptAs: null
		})
		await expect(host.ops.resolveConflict({ pairId: "1", relPath: "docs/report.docx", resolution: "keepLocal" })).resolves.toEqual({
			quarantined: null,
			keptAs: null
		})
	})

	it("resolves a batch of conflicts one after another, counting them once", async () => {
		const { engine, host } = setup()

		await host.refreshPairs()
		engine.listConflicts.mockClear()
		engine.listConflicts.mockResolvedValueOnce({ conflicts: [], total: 1n })
		engine.resolveConflict.mockResolvedValueOnce({}).mockRejectedValueOnce(sdkError(fakeSdk.ErrorKind.Io, "busy"))

		await expect(
			host.ops.resolveConflicts({ pairId: "1", resolution: "keepRemote", relPaths: ["a.txt", "b.txt", "c.txt"] })
		).resolves.toEqual({ resolved: 2, failed: 1 })
		expect(engine.listConflicts.mock.calls).toEqual([[1n, 0n, 0n]])
		expect(engine.resolveConflict.mock.calls).toEqual([
			[1n, "a.txt", fakeSdk.ConflictResolution.KeepRemote],
			[1n, "b.txt", fakeSdk.ConflictResolution.KeepRemote],
			[1n, "c.txt", fakeSdk.ConflictResolution.KeepRemote]
		])
	})

	it("stops a batch of conflicts at a lost session, still counting what it resolved", async () => {
		const { engine, host } = setup()

		await host.refreshPairs()
		engine.listConflicts.mockClear()
		engine.listConflicts.mockResolvedValueOnce({ conflicts: [], total: 2n })
		engine.resolveConflict.mockRejectedValueOnce(sdkError(fakeSdk.ErrorKind.Unauthenticated))

		await expect(host.ops.resolveConflicts({ pairId: "1", resolution: "keepLocal", relPaths: ["a.txt", "b.txt"] })).rejects.toThrow()
		expect(engine.resolveConflict).toHaveBeenCalledOnce()
		expect(engine.listConflicts).toHaveBeenCalledOnce()
	})

	it("lists unsyncable paths and scan gaps from the last report", async () => {
		const { engine, host } = setup()

		await host.refreshPairs()
		await expect(host.ops.unsyncablePaths({ pairId: "1", offset: 0, limit: 10 })).resolves.toBeNull()

		engine.lastReport.mockResolvedValue(
			report({
				unsyncable: [
					{ relPath: "a", reason: { tag: "LocalNameCollision" } },
					{ relPath: "b", reason: { tag: "RemoteNameCollision" } },
					{
						relPath: "CON.txt",
						reason: { tag: "RemoteNameNotStorable", inner: { name: "CON.txt", detail: "a reserved device name" } }
					}
				],
				unsyncableTotal: 3n,
				guard: { tag: "RestoreUnfinished", inner: { deletions: 2n } },
				scanGaps: [
					{ relPath: "locked", cause: { tag: "Unreadable", inner: { kind: "PermissionDenied" } } },
					{ relPath: "busy", cause: { tag: "ChangedDuringScan" } }
				],
				scanGapsTotal: 140n
			})
		)

		await expect(host.ops.unsyncablePaths({ pairId: "1", offset: 1, limit: 10 })).resolves.toEqual({
			total: 3,
			entries: [
				{ relPath: "b", reason: "remoteNameCollision", detail: null },
				{ relPath: "CON.txt", reason: "remoteNameNotStorable", detail: "a reserved device name" }
			]
		})
		await expect(host.ops.heldDeletions({ pairId: "1" })).resolves.toMatchObject({
			reason: "restoreUnfinished",
			gaps: [
				{ relPath: "locked", cause: "unreadable", kind: "PermissionDenied" },
				{ relPath: "busy", cause: "changedDuringScan", kind: null }
			],
			gapsTotal: 140
		})
	})

	it("counts a pair's held conflicts once, before any pass of it", async () => {
		const { engine, host, feed, posted } = setup()

		engine.listConflicts.mockResolvedValue({ conflicts: [], total: 3n })
		await host.refreshPairs()
		await host.refreshPairs()
		expect(engine.listConflicts).toHaveBeenCalledExactlyOnceWith(1n, 0n, 0n)

		feed.subscribe(true)
		await vi.advanceTimersByTimeAsync(300)
		expect(posted).toContainEqual(expect.objectContaining({ t: "aggregate", state: "attention" }))
		expect(posted.findLast(message => message.t === "overview")).toMatchObject({ pairs: [{ issues: { conflicts: 3 } }] })
	})

	it("counts the conflicts a previous process held, whatever pass reports first", async () => {
		const { engine, host, feed, posted } = setup()
		let listed: (page: { conflicts: []; total: bigint }) => void = () => undefined

		engine.listConflicts.mockReturnValueOnce(
			new Promise(resolve => {
				listed = resolve
			})
		)

		const refreshed = host.refreshPairs()

		feed.subscribe(true)
		await vi.advanceTimersByTimeAsync(0)
		// The pair is held paused at launch: its pass read nothing, and its report carries no conflict.
		feed.events([passEvent({ tag: "PassCompleted", inner: { report: report({ paused: true }) } })])
		await host.passEnded(1n, report({ paused: true }))
		listed({ conflicts: [], total: 1n })
		await refreshed
		await vi.advanceTimersByTimeAsync(300)
		expect(engine.listConflicts).toHaveBeenCalledExactlyOnceWith(1n, 0n, 0n)
		expect(posted.findLast(message => message.t === "overview")).toMatchObject({ pairs: [{ issues: { conflicts: 1 } }] })
	})

	it("recounts conflicts after a pass that reported one and after a resolution", async () => {
		const { engine, host, feed, posted } = setup()
		const conflicts = () => posted.findLast(message => message.t === "overview")

		engine.listConflicts.mockResolvedValue({ conflicts: [], total: 1n })
		await host.refreshPairs()
		feed.subscribe(true)

		// A pass reports the held conflict again plus a new one; the engine holds two, not three.
		engine.listConflicts.mockResolvedValue({ conflicts: [], total: 2n })
		feed.events([
			passEvent({ tag: "Conflict", inner: { relPath: "docs/notes.txt" } }),
			passEvent({ tag: "Conflict", inner: { relPath: "b.txt" } }),
			passEvent({ tag: "PassCompleted", inner: { report: report({ conflictsTotal: 2n }) } })
		])
		await host.passEnded(1n, report({ conflictsTotal: 2n }))
		await vi.advanceTimersByTimeAsync(300)
		expect(conflicts()).toMatchObject({ pairs: [{ issues: { conflicts: 2 } }] })

		// A pass that reported none recorded none: no read.
		await host.passEnded(1n, report())
		expect(engine.listConflicts).toHaveBeenCalledTimes(2)

		engine.listConflicts.mockResolvedValue({ conflicts: [], total: 0n })
		await host.ops.resolveConflict({ pairId: "1", relPath: "docs/notes.txt", resolution: "keepLocal" })
		expect(engine.listConflicts).toHaveBeenCalledTimes(3)
		await vi.advanceTimersByTimeAsync(300)
		expect(conflicts()).toMatchObject({ pairs: [{ issues: { conflicts: 0 } }] })
		expect(posted.findLast(message => message.t === "aggregate")).toEqual({ t: "aggregate", state: "idle" })
	})

	it("keeps the latest conflict count when an earlier read resolves after it", async () => {
		const { engine, host, feed, posted } = setup()
		let listed: (page: { conflicts: []; total: bigint }) => void = () => undefined

		engine.listConflicts.mockReturnValueOnce(
			new Promise(resolve => {
				listed = resolve
			})
		)
		engine.listConflicts.mockResolvedValueOnce({ conflicts: [], total: 2n })

		const refreshed = host.refreshPairs()

		feed.subscribe(true)
		await vi.advanceTimersByTimeAsync(0)
		await host.passEnded(1n, report({ conflictsTotal: 2n }))
		listed({ conflicts: [], total: 1n })
		await refreshed
		await vi.advanceTimersByTimeAsync(300)
		expect(posted.findLast(message => message.t === "overview")).toMatchObject({ pairs: [{ issues: { conflicts: 2 } }] })
	})

	it("holds every deletion of a migrated pair until a clean pass held none", async () => {
		const { engine, host, state } = setup([pairInfo({ firstPassCompleted: false })])

		await host.refreshPairs()
		await host.ops.setMigratedGuard({ pairId: "1" })
		expect(engine.setDeleteGuard).toHaveBeenCalledExactlyOnceWith(1n, 0n, 0)

		// The first clean pass held deletions: the next one must hold them too.
		state.pairs = state.pairs.map(pair => ({ ...pair, firstPassCompleted: true }))
		await host.passEnded(1n, report({ heldDeletions: 3n }))
		await host.passEnded(1n, null)
		await host.passEnded(1n, report({ passError: "x" }))
		expect(engine.setDeleteGuard).toHaveBeenCalledOnce()

		await host.passEnded(1n, report())
		expect(engine.setDeleteGuard).toHaveBeenLastCalledWith(1n, 10n, 0.5)

		// Lifted once.
		await host.passEnded(1n, report())
		expect(engine.setDeleteGuard).toHaveBeenCalledTimes(2)
	})

	it("keeps the guard of a migrated pair whose passes never completed cleanly", async () => {
		const { engine, host } = setup([pairInfo({ firstPassCompleted: false })])

		await host.refreshPairs()
		await host.ops.setMigratedGuard({ pairId: "1" })
		await host.passEnded(1n, report())
		expect(engine.setDeleteGuard).toHaveBeenCalledOnce()
	})

	it("plans expire and release", async () => {
		const plans = createPlanRegistry(1000)
		const first = fakePlan([])
		const second = fakePlan([])
		const firstId = plans.put(first.handle)
		const secondId = plans.put(second.handle)

		await vi.advanceTimersByTimeAsync(900)
		// Reading a plan keeps it another TTL.
		expect(plans.get(firstId)).toBe(first.handle)
		await vi.advanceTimersByTimeAsync(900)
		expect(second.plan.release).toHaveBeenCalledOnce()
		expect(plans.get(secondId)).toBeNull()
		expect(plans.get(firstId)).toBe(first.handle)

		plans.release(firstId)
		plans.release(firstId)
		expect(first.plan.release).toHaveBeenCalledOnce()

		const { host } = setup()

		await expect(failure(host.ops.planPage({ planId: firstId, list: "actions", offset: 0, limit: 10 }))).resolves.toEqual({
			code: "planExpired"
		})
	})

	it("refuses pairs the engine does not list", async () => {
		const { engine, host } = setup()

		await host.refreshPairs()
		await expect(failure(host.ops.pause({ pairId: "9" }))).resolves.toEqual({ code: "pairNotFound", pairId: "9" })
		expect(engine.pausePair).not.toHaveBeenCalled()
	})

	it("names the line of a refused user ignore text", async () => {
		const { engine, host } = setup()

		engine.setUserIgnore.mockRejectedValue(
			sdkError(fakeSdk.ErrorKind.InvalidState, "refusing the user ignore patterns: user ignore patterns:3: unclosed character class")
		)
		await expect(failure(host.ops.setUserIgnore({ text: "a\nb\n[" }))).resolves.toMatchObject({ code: "invalidIgnore", line: 3 })
	})
})

describe("classify", () => {
	it("reads unauthenticated off the error kind only", () => {
		expect(classify(fakeSdk, sdkError(fakeSdk.ErrorKind.Unauthenticated))).toBe("unauthenticated")
		expect(classify(fakeSdk, sdkError(fakeSdk.ErrorKind.Server, "HTTP 401"))).toEqual({ code: "unknown", message: "HTTP 401" })
	})

	it("maps the engine's refusals", () => {
		const nested = sdkError(fakeSdk.ErrorKind.InvalidState, "nested", { tag: "LocalRootNested", inner: { pair: 1n, existing: "/a" } })

		expect(classify(fakeSdk, nested)).toEqual({ code: "localRootNested" })
		expect(classify(fakeSdk, sdkError(fakeSdk.ErrorKind.InvalidState, "unknown sync pair"))).toEqual({ code: "pairNotFound" })
		expect(classify(fakeSdk, sdkError(fakeSdk.ErrorKind.FolderNotFound))).toEqual({ code: "remoteRootMissing" })
		expect(classify(fakeSdk, new Error("x".repeat(5000)))).toEqual({ code: "unknown", message: "x".repeat(4096) })
	})
})
