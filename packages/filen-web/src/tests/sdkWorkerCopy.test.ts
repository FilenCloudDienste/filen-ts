import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { CopyCounts, CopyReport, CopyUpdate, StringifiedClient } from "@filen/sdk-rs"
import type { CopyJobEvent, SdkWorkerApi } from "@/workers/sdk.worker"

// The worker's copy bridge against a stand-in client: only the wasm module and Comlink's expose are
// replaced, so the registries, the callback wrapping and the call lifecycle are the real ones.
interface FakePause {
	pause: () => void
	resume: () => void
	isPaused: () => boolean
	free: () => void
	freed: boolean
}

interface CopyParams {
	onUpdate: (update: CopyUpdate) => void
	onTopLevelCreated: (item: unknown) => void
	managedFuture: { abortSignal: AbortSignal; pauseSignal: FakePause }
}

const { exposed, fakeClient } = vi.hoisted(() => ({
	exposed: new Map<"api", unknown>(),
	fakeClient: {
		root: () => ({ uuid: "root" }),
		getDirOptional: vi.fn<(uuid: string) => Promise<unknown>>(),
		copyItems: vi.fn<(params: CopyParams) => Promise<CopyReport>>(),
		copyItemsTo: vi.fn<(params: CopyParams) => Promise<CopyReport>>(),
		free: vi.fn()
	}
}))

vi.mock("@filen/sdk-rs", () => {
	class PauseSignal {
		paused = false
		freed = false

		pause(): void {
			this.paused = true
		}

		resume(): void {
			this.paused = false
		}

		isPaused(): boolean {
			return this.paused
		}

		free(): void {
			this.freed = true
		}
	}

	return {
		default: vi.fn(),
		initThreadPool: vi.fn(),
		PauseSignal,
		UnauthClient: { from_config: () => ({ free: vi.fn(), fromStringified: () => fakeClient }) }
	}
})

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		exposed.set("api", api)
	},
	proxy: (value: unknown) => value,
	transfer: (value: unknown) => value
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

await import("@/workers/sdk.worker")

// What the page sees: every call answers with a promise.
const api = exposed.get("api") as Remote<SdkWorkerApi>

function counts(): CopyCounts {
	return {
		dirsCreated: 0n,
		dirsFailed: 0n,
		filesDone: 1n,
		filesFailed: 0n,
		bytesDone: 1n,
		bytesFailed: 0n,
		dirsNotAttempted: 0n,
		filesNotAttempted: 0n,
		bytesNotAttempted: 0n,
		entriesSkipped: 0n,
		bytesSkipped: 0n
	}
}

const REPORT: CopyReport = {
	topLevel: [],
	failures: [],
	skipped: [],
	renamed: [],
	totals: { dirs: 0n, files: 1n, bytes: 1n },
	counts: counts(),
	error: undefined
}

const UPDATE: CopyUpdate = {
	phase: "copyingFiles",
	runState: "running",
	scan: { sourcesDone: 1n, sourcesTotal: 1n, listingBytes: 0n, listingTotalBytes: undefined },
	totals: { dirs: 0n, files: 1n, bytes: 1n },
	counts: counts(),
	active: [],
	events: [],
	bytesPerSecond: undefined,
	etaMs: undefined,
	activeTimeMs: 0n
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

// Every call the stand-in client received, as the SDK got it.
function copyCalls(): CopyParams[] {
	return fakeClient.copyItems.mock.calls.map(call => call[0])
}

beforeEach(async () => {
	await api.injectClient("session" as unknown as StringifiedClient)
	fakeClient.copyItems.mockResolvedValue(REPORT)
})

describe("sdk worker copy", () => {
	// Events ride the callback's own port and the result the worker's; nothing orders the two, so the
	// result must wait for the caller to take the last event.
	it("returns a copy's report only once the caller has taken every event it sent", async () => {
		const replies: (() => void)[] = []
		const onEvent = vi.fn(
			(_event: CopyJobEvent) =>
				new Promise<void>(resolve => {
					replies.push(resolve)
				})
		)
		let returned = false

		fakeClient.copyItems.mockImplementation(params => {
			params.onUpdate(UPDATE)
			params.onTopLevelCreated({ request: 0n, sourceUuid: "s", item: { type: "file", uuid: "copied" } })

			return Promise.resolve(REPORT)
		})

		const call = api.copyItems("job", [], null, undefined, onEvent).then(report => {
			returned = true

			return report
		})

		await settle()

		expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(["update", "created"])
		expect(returned).toBe(false)

		replies[0]?.()
		await settle()

		expect(returned).toBe(false)

		replies[1]?.()

		await expect(call).resolves.toBe(REPORT)
		await api.releaseCopy("job")
	})

	it("still returns the report when the caller failed to take an event", async () => {
		fakeClient.copyItems.mockImplementation(params => {
			params.onUpdate(UPDATE)

			return Promise.resolve(REPORT)
		})

		await expect(api.copyItems("failing", [], null, undefined, () => Promise.reject(new Error("render failed")))).resolves.toBe(REPORT)
		await api.releaseCopy("failing")
	})

	// A retry after a storage refusal is the same job: a pause made between its calls must hold.
	it("keeps a job's pause across its calls until the job is released", async () => {
		await api.copyItems("paused", [], null, undefined, () => undefined)
		await api.pauseCopy("paused")
		await api.copyItems("paused", [], null, undefined, () => undefined)

		const [first, second] = copyCalls()

		expect(second?.managedFuture.pauseSignal).toBe(first?.managedFuture.pauseSignal)
		expect(second?.managedFuture.pauseSignal.isPaused()).toBe(true)
		expect(first?.managedFuture.pauseSignal.freed).toBe(false)

		await api.releaseCopy("paused")

		expect(first?.managedFuture.pauseSignal.freed).toBe(true)
	})

	it("keeps a stop sent between a job's calls, and one sent while its destination is looked up", async () => {
		await api.copyItems("stopped", [], null, undefined, () => undefined)
		await api.cancelCopy("stopped")
		await api.copyItems("stopped", [], null, undefined, () => undefined)

		expect(copyCalls()[1]?.managedFuture.abortSignal.aborted).toBe(true)

		await api.releaseCopy("stopped")

		const lookup = deferred<unknown>()

		fakeClient.getDirOptional.mockReturnValue(lookup.promise)

		const call = api.copyItems("looking-up", [], "dest", undefined, () => undefined)

		await api.cancelCopy("looking-up")
		lookup.resolve({ uuid: "dest" })
		await call

		expect(copyCalls()[2]?.managedFuture.abortSignal.aborted).toBe(true)

		await api.releaseCopy("looking-up")
	})

	it("forgets a released job: a later stop, pause or release does nothing", async () => {
		await api.copyItems("released", [], null, undefined, () => undefined)

		const pause = copyCalls()[0]?.managedFuture.pauseSignal

		await api.releaseCopy("released")
		await api.pauseCopy("released")
		await api.cancelCopy("released")
		await api.releaseCopy("released")

		expect(pause?.isPaused()).toBe(false)
		expect(copyCalls()[0]?.managedFuture.abortSignal.aborted).toBe(false)
	})
})
