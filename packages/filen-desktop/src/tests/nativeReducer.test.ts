import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type FromNative, SYNC_TRANSFERS_KEPT } from "../shared/nativeProtocol.ts"
import {
	createPairRuntime,
	createRuntimeFeed,
	FEED_INTERVAL_MS,
	reduceEvents,
	reduceWatchStatus,
	type PairRuntime
} from "../native/reducer.ts"
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
	const onPassEnded = vi.fn()
	const runtime = createRuntimeFeed(fakeSdk, { post: message => posted.push(message), onAuthFailed, onPassEnded })

	return {
		runtime,
		posted,
		onAuthFailed,
		onPassEnded,
		of: <T extends FromNative["t"]>(t: T) => posted.filter(message => message.t === t)
	}
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

	it("shows a wait for the cloud listing and the local read until the pass starts", () => {
		const state = new Map([["1", createPairRuntime()]])
		const progress = { entries: 10n, filesToHash: 4n, bytesToHash: 400n, filesHashed: 1n, bytesHashed: 100n }

		expect(reduceEvents(fakeSdk, state, [passEvent({ tag: "AwaitingRemote" })]).changed).toBe(true)
		expect(state.get("1")?.stage).toEqual({ kind: "waitingForCloud" })

		reduceEvents(fakeSdk, state, [passEvent({ tag: "Scanning", inner: { progress } })])
		expect(state.get("1")).toMatchObject({
			syncing: false,
			stage: { kind: "indexing", entries: 10, filesToHash: 4, bytesToHash: 400, filesHashed: 1, bytesHashed: 100 }
		})

		reduceEvents(fakeSdk, state, [passEvent({ tag: "PassStarted", inner: { mode: fakeSdk.SyncMode.TwoWay } })])
		expect(state.get("1")).toMatchObject({ syncing: true, stage: null })
	})

	it("reads a listing that took too long as not ready, not as an error", () => {
		const state = new Map([["1", createPairRuntime()]])

		reduceEvents(fakeSdk, state, [passEvent({ tag: "AwaitingRemote" })])

		const reduced = reduceEvents(fakeSdk, state, [
			passEvent({ tag: "PassFailed", inner: { error: "stale", kind: fakeSdk.ErrorKind.StaleState } })
		])

		expect(reduced.activity).toEqual([])
		expect(reduced.ended).toEqual([{ pairId: 1n, report: null }])
		expect(state.get("1")).toMatchObject({ lastError: null, syncing: false, stage: { kind: "waitingForCloud" } })

		// The watch's status after it, and the engine's next tries, keep it waiting.
		const runtime = state.get("1") ?? createPairRuntime()

		reduceWatchStatus(fakeSdk, runtime, {
			consecutiveFailures: 3,
			lastError: "stale",
			lastErrorKind: fakeSdk.ErrorKind.StaleState,
			state: 0
		})
		reduceEvents(fakeSdk, state, [
			passEvent({ tag: "AwaitingRemote" }),
			passEvent({ tag: "PassFailed", inner: { error: "stale", kind: fakeSdk.ErrorKind.StaleState } })
		])
		expect(state.get("1")).toMatchObject({ lastError: null, stage: { kind: "waitingForCloud" } })

		// Only a pass that ran, another end or a stopped watch ends the wait.
		reduceEvents(fakeSdk, state, [passEvent({ tag: "PassStarted", inner: { mode: fakeSdk.SyncMode.TwoWay } })])
		expect(state.get("1")?.stage).toBeNull()

		reduceEvents(fakeSdk, state, [passEvent({ tag: "PassFailed", inner: { error: "stale", kind: fakeSdk.ErrorKind.StaleState } })])
		reduceEvents(fakeSdk, state, [passEvent({ tag: "PassFailed", inner: { error: "denied", kind: fakeSdk.ErrorKind.Io } })])
		expect(state.get("1")).toMatchObject({ stage: null, lastError: "denied" })

		reduceEvents(fakeSdk, state, [passEvent({ tag: "PassFailed", inner: { error: "stale", kind: fakeSdk.ErrorKind.StaleState } })])
		reduceWatchStatus(fakeSdk, runtime, { consecutiveFailures: 0, state: fakeSdk.WatchState.Stopped })
		expect(runtime.stage).toBeNull()
	})

	it("waiting for the cloud listing is neither attention nor syncing", async () => {
		const { runtime, of } = feed()

		runtime.setPairs([pairInfo()])
		runtime.subscribe(true)
		runtime.events([
			passEvent({ tag: "AwaitingRemote" }),
			passEvent({ tag: "PassFailed", inner: { error: "stale", kind: fakeSdk.ErrorKind.StaleState } })
		])
		runtime.watchStatus(1n, { consecutiveFailures: 1, lastError: "stale", lastErrorKind: fakeSdk.ErrorKind.StaleState, state: 0 })
		await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)

		expect(of("overview").at(-1)).toMatchObject({ pairs: [{ stage: { kind: "waitingForCloud" }, lastError: null, syncing: false }] })
		expect(of("aggregate")).toEqual([])
	})

	it("shows why a pass held its work back, an unreachable server without asking for attention", async () => {
		const { runtime, of, onAuthFailed, onPassEnded } = feed()
		const completed = (halted: number | undefined) =>
			passEvent({
				tag: "PassCompleted",
				inner: { report: report({ halted, passError: halted === undefined ? undefined : "halted" }) }
			})

		runtime.setPairs([pairInfo()])
		runtime.subscribe(true)
		runtime.events([completed(fakeSdk.HaltReason.RemoteUnavailable)])
		await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)

		expect(of("overview").at(-1)).toMatchObject({ pairs: [{ halted: "offline" }] })
		expect(of("aggregate")).toEqual([])
		expect(of("passEnded")).toEqual([{ t: "passEnded", pairId: "1" }])
		expect(onPassEnded).toHaveBeenCalledWith(1n, expect.objectContaining({ halted: fakeSdk.HaltReason.RemoteUnavailable }))

		runtime.events([passEvent({ tag: "PassFailed", inner: { error: "connect", kind: fakeSdk.ErrorKind.Reqwest } })])
		await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)
		expect(of("overview").at(-1)).toMatchObject({ pairs: [{ halted: "offline", lastError: "connect" }] })
		expect(of("aggregate")).toEqual([])

		runtime.events([completed(fakeSdk.HaltReason.LocalStorageFull)])
		await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)
		expect(of("overview").at(-1)).toMatchObject({ pairs: [{ halted: "localStorageFull" }] })
		expect(of("aggregate")).toEqual([{ t: "aggregate", state: "attention" }])

		runtime.events([completed(fakeSdk.HaltReason.Unauthenticated)])
		expect(onAuthFailed).toHaveBeenCalledOnce()
	})

	it("asks for attention for a refusal and for paths that failed or cannot be synced", async () => {
		for (const fields of [{ refused: fakeSdk.RefuseReason.LocalCollision }, { unsyncableTotal: 1n }, { errorsTotal: 1n }]) {
			const { runtime, of } = feed()

			runtime.setPairs([pairInfo()])
			runtime.subscribe(true)
			runtime.events([passEvent({ tag: "PassCompleted", inner: { report: report(fields) } })])
			await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)

			expect(of("aggregate")).toEqual([{ t: "aggregate", state: "attention" }])
		}

		const { runtime, of } = feed()

		runtime.setPairs([pairInfo()])
		runtime.subscribe(true)
		runtime.events([passEvent({ tag: "PassCompleted", inner: { report: report({ refused: fakeSdk.RefuseReason.RemoteCollision }) } })])
		await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)
		expect(of("overview").at(-1)).toMatchObject({ pairs: [{ refused: "remoteCollision" }] })
	})

	it("an offline pass, halted or failing to lock, raises no attention for the failures it reports", async () => {
		for (const fields of [
			{ halted: fakeSdk.HaltReason.RemoteUnavailable, passError: "offline", errorsTotal: 2n },
			{ passError: "lock", passErrorKind: fakeSdk.ErrorKind.Reqwest, errorsTotal: 1n }
		]) {
			const { runtime, of } = feed()

			runtime.setPairs([pairInfo()])
			runtime.subscribe(true)
			runtime.events([passEvent({ tag: "PassCompleted", inner: { report: report(fields) } })])
			await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS)

			expect(of("overview").at(-1)).toMatchObject({ pairs: [{ halted: "offline", issues: { failed: Number(fields.errorsTotal) } }] })
			expect(of("aggregate")).toEqual([])
		}
	})

	it("the pass that tries the server again is no longer offline", () => {
		const state = new Map([["1", createPairRuntime()]])

		reduceEvents(fakeSdk, state, [passEvent({ tag: "PassFailed", inner: { error: "connect", kind: fakeSdk.ErrorKind.Reqwest } })])
		expect(state.get("1")).toMatchObject({ halted: "offline", lastError: "connect" })

		reduceEvents(fakeSdk, state, [passEvent({ tag: "PassStarted", inner: { mode: fakeSdk.SyncMode.TwoWay } })])
		expect(state.get("1")).toMatchObject({ syncing: true, halted: null, lastError: null })
	})

	it("a watch reporting an unfinished cloud listing is no error, an unreachable server is offline", () => {
		const runtime = createPairRuntime()
		const status = { consecutiveFailures: 1, lastError: "stale", lastErrorKind: fakeSdk.ErrorKind.StaleState, state: 0 }

		reduceWatchStatus(fakeSdk, runtime, status)
		expect(runtime).toMatchObject({ lastError: null, halted: null })

		reduceWatchStatus(fakeSdk, runtime, { ...status, lastError: "connect", lastErrorKind: fakeSdk.ErrorKind.Reqwest })
		expect(runtime).toMatchObject({ lastError: "connect", halted: "offline" })

		expect(
			createPairRuntime(pairInfo({ lastPassError: "stale", lastPassErrorKind: fakeSdk.ErrorKind.StaleState }), fakeSdk).lastError
		).toBeNull()
	})

	it("a pass halted by an expired session shows no halt, and signs out", () => {
		const state = new Map([["1", createPairRuntime()]])
		const reduced = reduceEvents(fakeSdk, state, [
			passEvent({ tag: "PassCompleted", inner: { report: report({ halted: fakeSdk.HaltReason.Unauthenticated }) } })
		])

		expect(reduced.authFailed).toBe(true)
		expect(state.get("1")?.halted).toBeNull()
	})

	it("a pair last failing offline at open shows as offline", () => {
		expect(createPairRuntime(pairInfo({ lastPassError: "x", lastPassErrorKind: fakeSdk.ErrorKind.Reqwest }), fakeSdk).halted).toBe(
			"offline"
		)
	})
})
