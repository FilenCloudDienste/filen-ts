import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CacheStatusMessage, PlannedAction } from "@filen/sdk-rs"
import { createConvergence } from "../native/convergence.ts"
import { classify } from "../native/errors.ts"
import { createHostEngine } from "../native/ops.ts"
import { createPlanRegistry } from "../native/plans.ts"
import { createRuntimeFeed } from "../native/reducer.ts"
import { action, fakeEngine, fakePlan, fakeSdk, pairInfo, REMOTE_ROOT, sdkError } from "./nativeFakes.ts"

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
	const feed = createRuntimeFeed(fakeSdk, { post: () => undefined, onAuthFailed: () => undefined })
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

	return { ...fake, convergence, plans, host, log }
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

		await host.watchAll(() => undefined)
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

	it("evaluatePlan counts the transfers, and a one-way pair's overwrites when asked", async () => {
		const local = await realpath(await mkdtemp(path.join(tmpdir(), "filen-plan-check-")))

		try {
			await mkdir(path.join(local, "d"))
			await writeFile(path.join(local, "d", "kept.txt"), "old")

			const actions = [
				sized(action("UploadFile", "up.txt"), 7n),
				sized(action("DownloadFile", "d/kept.txt"), 5n),
				sized(action("DownloadFile", "new.txt"), 11n),
				action("AdoptBaseline", "c.txt"),
				...Array.from({ length: 2500 }, (_, i) => action("AdoptBaseline", `bulk/${String(i)}`))
			]
			const { plan, handle } = fakePlan(actions)
			const modes = [
				[fakeSdk.SyncMode.TwoWay, null],
				[fakeSdk.SyncMode.LocalToRemote, { files: 1, bytes: 7 }],
				[fakeSdk.SyncMode.LocalBackup, { files: 1, bytes: 7 }],
				[fakeSdk.SyncMode.RemoteToLocal, { files: 1, bytes: 5 }],
				[fakeSdk.SyncMode.RemoteBackup, { files: 1, bytes: 5 }]
			] as const

			for (const [mode, overwrites] of modes) {
				const { engine, convergence, host } = setup([pairInfo({ mode, localRoot: local })])

				engine.planPair.mockResolvedValue(handle)
				await host.refreshPairs()
				convergence.onMessages(resync([REMOTE_ROOT], true))

				await expect(host.ops.evaluatePlan({ pairId: "1", check: { overwrites: true } })).resolves.toMatchObject({
					check: { uploads: 1, downloads: 2, overwrites }
				})
				await expect(host.ops.evaluatePlan({ pairId: "1", check: { overwrites: false } })).resolves.toMatchObject({
					check: { uploads: 1, downloads: 2, overwrites: null }
				})
			}

			// Paged at the engine's limit.
			expect(plan.actions).toHaveBeenCalledTimes(30)
		} finally {
			await rm(local, { recursive: true, force: true })
		}
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
