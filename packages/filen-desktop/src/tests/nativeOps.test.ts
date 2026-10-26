import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CacheStatusMessage } from "@filen/sdk-rs"
import { createConvergence } from "../native/convergence.ts"
import { classify } from "../native/errors.ts"
import { createHostEngine } from "../native/ops.ts"
import { createPlanRegistry } from "../native/plans.ts"
import { createRuntimeFeed } from "../native/reducer.ts"
import { ACCOUNT_ROOT, action, fakeEngine, fakePlan, fakeSdk, pairInfo, REMOTE_ROOT, sdkError } from "./nativeFakes.ts"

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

function setup(pairs = [pairInfo()]) {
	const fake = fakeEngine(pairs)
	const convergence = createConvergence()
	const plans = createPlanRegistry()
	const feed = createRuntimeFeed(fakeSdk, { post: () => undefined, onAuthFailed: () => undefined })
	const host = createHostEngine({
		sdk: fakeSdk,
		engine: fake.handle,
		rootUuid: ACCOUNT_ROOT,
		feed,
		plans,
		convergence,
		signal: new AbortController().signal,
		convergenceTimeoutMs: 5000
	})

	return { ...fake, convergence, plans, host }
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

	it("evaluatePlan reports legacy hits", async () => {
		const { engine, convergence, host } = setup()
		const actions = [
			action("UploadFile", ".hidden"),
			action("UploadFile", "a.txt"),
			action("UploadFile", ".filenignore"),
			action("DownloadFile", "d/.git/config"),
			action("AdoptBaseline", "c.txt"),
			action("MoveRemote", "x.txt", ".x.txt"),
			action("CreateRemoteDir", ".filen.trash.local"),
			...Array.from({ length: 2500 }, (_, i) => action("AdoptBaseline", `bulk/${String(i)}`))
		]
		const { plan, handle } = fakePlan(actions)

		engine.planPair.mockResolvedValue(handle)
		await host.refreshPairs()
		convergence.onMessages(resync([REMOTE_ROOT], true))

		await expect(host.ops.evaluatePlan({ pairId: "1", check: { legacy: { excludeDotFiles: true } } })).resolves.toMatchObject({
			check: {
				uploads: 3,
				downloads: 1,
				legacyHits: { count: 4, sample: [".hidden", "d/.git/config", "x.txt", ".filen.trash.local"] }
			}
		})
		// Paged at the engine's limit.
		expect(plan.actions).toHaveBeenCalledTimes(3)

		await expect(host.ops.evaluatePlan({ pairId: "1", check: { legacy: { excludeDotFiles: false } } })).resolves.toMatchObject({
			check: { legacyHits: { count: 1, sample: [".filen.trash.local"] } }
		})
		await expect(host.ops.evaluatePlan({ pairId: "1", check: { legacy: null } })).resolves.toMatchObject({
			check: { uploads: 3, downloads: 1, legacyHits: null }
		})
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

	it("refuses the account root and pairs the engine does not list", async () => {
		const { engine, host } = setup()

		await host.refreshPairs()
		await expect(
			failure(host.ops.addPair({ localRoot: "/x", remoteRoot: ACCOUNT_ROOT.toUpperCase(), mode: "twoWay" }))
		).resolves.toEqual({
			code: "accountRoot"
		})
		expect(engine.addPair).not.toHaveBeenCalled()
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
