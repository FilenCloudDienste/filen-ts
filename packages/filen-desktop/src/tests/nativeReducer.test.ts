import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type FromNative, SYNC_TRANSFERS_KEPT } from "../shared/nativeProtocol.ts"
import { createPairRuntime, createRuntimeFeed, FEED_INTERVAL_MS, reduceEvents, type PairRuntime } from "../native/reducer.ts"
import { fakeSdk, pairInfo, passEvent, report } from "./nativeFakes.ts"

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

function feed() {
	const posted: FromNative[] = []
	const onAuthFailed = vi.fn()
	const runtime = createRuntimeFeed(fakeSdk, { post: message => posted.push(message), onAuthFailed })

	return { runtime, posted, onAuthFailed, of: <T extends FromNative["t"]>(t: T) => posted.filter(message => message.t === t) }
}

describe("reduceEvents", () => {
	it("coalesces progress", async () => {
		const { runtime, of } = feed()

		runtime.setPairs([pairInfo()])
		runtime.subscribe(true)
		await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)
		expect(of("overview")).toHaveLength(1)

		runtime.events([
			passEvent({ tag: "PassStarted", inner: { mode: fakeSdk.SyncMode.TwoWay } }),
			passEvent({ tag: "Planned", inner: { actions: 3n } }),
			passEvent({ tag: "Uploading", inner: { relPath: "big.bin" } })
		])

		for (let chunk = 0; chunk < 50; chunk++) {
			runtime.events(
				Array.from({ length: 10 }, (_, i) =>
					passEvent({
						tag: "Progress",
						inner: {
							relPath: "big.bin",
							direction: fakeSdk.TransferDirection.Upload,
							bytes: BigInt(chunk * 10 + i + 1),
							total: 1000n
						}
					})
				)
			)
			await vi.advanceTimersByTimeAsync(1)
		}

		await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)

		const overviews = of("overview")

		// One push for the whole burst, carrying where it ended.
		expect(overviews).toHaveLength(2)
		expect(overviews[1]).toMatchObject({
			pairs: [
				{ id: "1", syncing: true, progress: { done: 1, total: 3 }, transfers: [{ relPath: "big.bin", bytes: 500, total: 1000 }] }
			]
		})
		// The upload is reported once it is done, not per progress step.
		expect(of("activity")).toHaveLength(0)
		expect(of("aggregate")).toEqual([{ t: "aggregate", state: "syncing" }])
	})

	it("keeps every transfer in flight and only those", () => {
		const state = new Map<string, PairRuntime>()
		const progress = (relPath: string, bytes: bigint, total: bigint, direction = fakeSdk.TransferDirection.Upload) =>
			passEvent({ tag: "Progress", inner: { relPath, direction, bytes, total } })

		reduceEvents(fakeSdk, state, [
			passEvent({ tag: "PassStarted", inner: { mode: fakeSdk.SyncMode.TwoWay } }),
			...Array.from({ length: SYNC_TRANSFERS_KEPT }, (_, index) =>
				passEvent({ tag: "Uploading", inner: { relPath: `f${String(index)}` } })
			),
			passEvent({ tag: "Downloading", inner: { relPath: "late.bin" } })
		])

		const transfers = () => state.get("1")?.transfers.map(transfer => transfer.relPath)

		// Newest first, at most what a pass runs at once.
		expect(transfers()).toHaveLength(SYNC_TRANSFERS_KEPT)
		expect(transfers()?.[0]).toBe("late.bin")
		expect(transfers()).not.toContain("f0")

		reduceEvents(fakeSdk, state, [
			progress("f15", 10n, 20n),
			progress("f14", 20n, 20n),
			progress("late.bin", 5n, 5n, fakeSdk.TransferDirection.Download),
			passEvent({ tag: "ActionFailed", inner: { relPath: "f13", error: "denied" } }),
			// Begun again: one entry, in front.
			passEvent({ tag: "Uploading", inner: { relPath: "f12" } })
		])

		expect(transfers()?.slice(0, 2)).toEqual(["f12", "f15"])
		expect(transfers()).not.toContain("f14")
		expect(transfers()).not.toContain("f13")
		expect(transfers()).not.toContain("late.bin")
		expect(transfers()?.filter(relPath => relPath === "f12")).toHaveLength(1)
		expect(state.get("1")?.transfers[1]).toEqual({ relPath: "f15", direction: "upload", bytes: 10, total: 20 })

		// Progress past its start that was never seen begins one; its last step ends it.
		reduceEvents(fakeSdk, state, [progress("new.bin", 1n, 4n)])
		expect(transfers()?.[0]).toBe("new.bin")

		reduceEvents(fakeSdk, state, [passEvent({ tag: "Interrupted", inner: { actions: 3n } })])
		expect(transfers()).toEqual([])
	})

	it("pushes no overview while main is not subscribed, but always activity and the aggregate", async () => {
		const { runtime, of } = feed()

		runtime.setPairs([pairInfo()])
		runtime.events([
			passEvent({ tag: "PassStarted", inner: { mode: fakeSdk.SyncMode.TwoWay } }),
			passEvent({ tag: "Conflict", inner: { relPath: "a.txt" } })
		])
		await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)

		expect(of("overview")).toHaveLength(0)
		expect(of("activity")).toEqual([{ t: "activity", entries: [{ pairId: "1", at: 1000, kind: "conflict", relPath: "a.txt" }] }])
		expect(of("aggregate")).toEqual([{ t: "aggregate", state: "syncing" }])
	})

	it("PassFailed Unauthenticated sets authFailed", async () => {
		const state = new Map<string, PairRuntime>()
		const failed = reduceEvents(fakeSdk, state, [
			passEvent({ tag: "PassFailed", inner: { error: "401", kind: fakeSdk.ErrorKind.Unauthenticated } })
		])

		expect(failed.authFailed).toBe(true)
		expect(failed.activity).toEqual([{ pairId: "1", at: 1000, kind: "passFailed", detail: "401" }])
		expect(state.get("1")?.lastError).toBe("401")
		expect(
			reduceEvents(fakeSdk, state, [passEvent({ tag: "PassFailed", inner: { error: "offline", kind: fakeSdk.ErrorKind.Server } })])
				.authFailed
		).toBe(false)

		const { runtime, onAuthFailed } = feed()

		runtime.watchStatus(1n, { consecutiveFailures: 1, lastError: "401", lastErrorKind: fakeSdk.ErrorKind.Unauthenticated, state: 0 })
		expect(onAuthFailed).toHaveBeenCalledOnce()
	})

	it("PassCompleted sets issue counts", async () => {
		const { runtime, of } = feed()

		runtime.setPairs([pairInfo()])
		runtime.subscribe(true)
		runtime.events([
			passEvent({ tag: "PassStarted", inner: { mode: fakeSdk.SyncMode.TwoWay } }),
			passEvent({ tag: "Planned", inner: { actions: 2n } }),
			passEvent({ tag: "Uploading", inner: { relPath: "a.txt" } }),
			passEvent({ tag: "Downloading", inner: { relPath: "b.txt" } }),
			passEvent({ tag: "ActionFailed", inner: { relPath: "b.txt", error: "denied" } }),
			passEvent(
				{
					tag: "PassCompleted",
					inner: { report: report({ uploaded: 1n, conflictsTotal: 2n, heldDeletions: 3n, unsyncableTotal: 4n, errorsTotal: 1n }) }
				},
				1n,
				2000n
			)
		])
		await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)

		expect(of("overview").at(-1)).toMatchObject({
			pairs: [
				{
					syncing: false,
					progress: null,
					transfers: [],
					lastSyncedAt: 2000,
					lastError: null,
					issues: { conflicts: 2, heldDeletions: 3, unsyncable: 4, failed: 1 }
				}
			]
		})
		expect(of("activity")[0]).toEqual({
			t: "activity",
			entries: [
				{ pairId: "1", at: 1000, kind: "uploaded", relPath: "a.txt" },
				{ pairId: "1", at: 1000, kind: "failed", relPath: "b.txt", detail: "denied" },
				{ pairId: "1", at: 2000, kind: "passCompleted" }
			]
		})
		expect(of("aggregate")).toEqual([{ t: "aggregate", state: "attention" }])
	})

	it("a pass that changed nothing is no activity", () => {
		const state = new Map([["1", createPairRuntime()]])
		const quiet = reduceEvents(fakeSdk, state, [passEvent({ tag: "PassCompleted", inner: { report: report() } })])

		expect(quiet.activity).toEqual([])
		expect(state.get("1")?.lastSyncedAt).toBe(1000)
	})

	it("a local walk and a wait for the remote change nothing", () => {
		const state = new Map([["1", createPairRuntime()]])
		const progress = { entries: 10n, filesToHash: 4n, bytesToHash: 400n, filesHashed: 1n, bytesHashed: 100n }
		const reduced = reduceEvents(fakeSdk, state, [
			passEvent({ tag: "AwaitingRemote" }),
			passEvent({ tag: "Scanning", inner: { progress } })
		])

		expect(reduced).toEqual({ changed: false, activity: [], authFailed: false })
		expect(state.get("1")).toEqual(createPairRuntime())
	})
})
