import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The preview worker registry over fake workers: Comlink.wrap is replaced by a remote whose calls the test settles, so a
// terminated worker's call hangs exactly as a real one does.
const { wrap, releaseProxy, recoverIfNewerBuild } = vi.hoisted(() => ({
	wrap: vi.fn(),
	releaseProxy: vi.fn(),
	recoverIfNewerBuild: vi.fn()
}))

vi.mock("comlink", async importOriginal => ({ ...(await importOriginal<typeof import("comlink")>()), wrap }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild }))

const { releaseProxy: RELEASE } = await import("comlink")
const { createOwnedWorker, statelessWorker, releaseAllPreviewWorkers } = await import("@/lib/workers/ownedWorker")
const { WorkerGoneError, ownedWorkerState } = await import("@/lib/workers/ownedWorker.logic")
const { runPreviewDisposers } = await import("@/lib/workers/previewDisposers")

interface Api {
	work(): Promise<string>
}

class FakeWorker extends EventTarget {
	public readonly terminate = vi.fn()
}

let workers: FakeWorker[] = []

function create(): Worker {
	const worker = new FakeWorker()

	workers.push(worker)

	return worker as unknown as Worker
}

// Every call hangs until the test answers it, like a worker's.
function hangingRemote() {
	const pending: ((value: string) => void)[] = []
	const remote = {
		work: () =>
			new Promise<string>(resolve => {
				pending.push(resolve)
			}),
		[RELEASE]: releaseProxy
	}

	return { remote, pending }
}

let remotes: ReturnType<typeof hangingRemote>[] = []

beforeEach(() => {
	workers = []
	remotes = []
	wrap.mockImplementation(() => {
		const remote = hangingRemote()

		remotes.push(remote)

		return remote.remote
	})
})

afterEach(() => {
	runPreviewDisposers()
	vi.clearAllMocks()
	vi.useRealTimers()
})

describe("createOwnedWorker", () => {
	it("terminates exactly once and leaves sign-out nothing to do", () => {
		const owned = createOwnedWorker<Api>(create, "geo")

		owned.terminate()
		owned.terminate()
		releaseAllPreviewWorkers()

		expect(workers[0]?.terminate).toHaveBeenCalledTimes(1)
		expect(releaseProxy).toHaveBeenCalledTimes(1)
	})

	it("is terminated at sign-out while busy; its call in flight rejects as cancelled and it never reports a failure", async () => {
		const owned = createOwnedWorker<Api>(create, "geo")
		const failed = vi.fn()

		void owned.failed.then(failed)

		const call = owned.run(remote => remote.work())

		releaseAllPreviewWorkers()

		await expect(call).rejects.toMatchObject({ name: "AbortError" })
		await Promise.resolve()
		expect(workers[0]?.terminate).toHaveBeenCalledTimes(1)
		expect(failed).not.toHaveBeenCalled()
	})

	it("reports a crash as its failure, ends, and rejects calls in flight", async () => {
		const owned = createOwnedWorker<Api>(create, "geo")
		const call = owned.run(remote => remote.work())

		workers[0]?.dispatchEvent(new Event("error"))

		await expect(owned.failed).resolves.toMatchObject({ kind: "WorkerGoneError", message: "geo worker is gone (error)" })
		await expect(call).rejects.toBeInstanceOf(WorkerGoneError)
		expect(recoverIfNewerBuild).toHaveBeenCalledTimes(1)
		expect(workers[0]?.terminate).toHaveBeenCalledTimes(1)
	})

	it("answers a call while alive", async () => {
		const owned = createOwnedWorker<Api>(create, "geo")
		const call = owned.run(remote => remote.work())

		await Promise.resolve()
		remotes[0]?.pending[0]?.("done")

		await expect(call).resolves.toBe("done")
		owned.terminate()
	})

	// A reaction on the long-lived `gone` per call would hold every call's result until the worker ends.
	it("registers nothing on gone per call, so a settled call's result is not retained", async () => {
		const owned = createOwnedWorker<Api>(create, "geo")
		const subscribe = vi.spyOn(owned.gone, "then")
		const call = owned.run(remote => remote.work())

		await Promise.resolve()
		remotes[0]?.pending[0]?.("done")

		await expect(call).resolves.toBe("done")
		await expect(owned.run(() => Promise.resolve("again"))).resolves.toBe("again")
		expect(subscribe).not.toHaveBeenCalled()
		owned.terminate()
	})

	it("rejects a call made after it ended with the end reason, without starting it", async () => {
		const owned = createOwnedWorker<Api>(create, "geo")
		const work = vi.fn(() => Promise.resolve("never"))

		owned.terminate()

		await expect(owned.run(work)).rejects.toMatchObject({ name: "AbortError" })
		expect(work).not.toHaveBeenCalled()
	})
})

describe("statelessWorker", () => {
	it("keeps its idle timeout outside sign-out", async () => {
		vi.useFakeTimers()

		const pool = statelessWorker<Api>(create, 1000, "fontInspect")
		const call = pool.use(({ remote }) => remote.work())

		await vi.advanceTimersByTimeAsync(0)
		remotes[0]?.pending[0]?.("ok")
		await call
		await vi.advanceTimersByTimeAsync(999)

		expect(workers[0]?.terminate).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)

		expect(workers[0]?.terminate).toHaveBeenCalledTimes(1)
	})

	it("is terminated at sign-out while busy; the call rejects as cancelled and the next use starts a fresh worker", async () => {
		const pool = statelessWorker<Api>(create, 30_000, "fontInspect")
		const call = pool.use(({ remote }) => remote.work())

		await Promise.resolve()
		releaseAllPreviewWorkers()

		await expect(call).rejects.toMatchObject({ name: "AbortError" })
		expect(workers[0]?.terminate).toHaveBeenCalledTimes(1)

		const next = pool.use(({ remote }) => remote.work())

		await Promise.resolve()
		await Promise.resolve()
		remotes[1]?.pending[0]?.("fresh")

		await expect(next).resolves.toBe("fresh")
		expect(workers).toHaveLength(2)
	})

	it("an idle-disposed worker is no longer registered for sign-out", async () => {
		vi.useFakeTimers()

		const pool = statelessWorker<Api>(create, 10, "raster")
		const call = pool.use(({ remote }) => remote.work())

		await vi.advanceTimersByTimeAsync(0)
		remotes[0]?.pending[0]?.("ok")
		await call
		await vi.advanceTimersByTimeAsync(10)
		releaseAllPreviewWorkers()

		expect(workers[0]?.terminate).toHaveBeenCalledTimes(1)
	})

	it("invalidating a broken worker rejects its calls in flight", async () => {
		const pool = statelessWorker<Api>(create, 30_000, "raster")
		const call = pool.use(async handle => {
			pool.invalidate(handle)

			return await handle.remote.work()
		})

		await expect(call).rejects.toThrow("raster worker is gone (terminated)")
		expect(workers[0]?.terminate).toHaveBeenCalledTimes(1)
	})

	it("ends a worker that breaks, and the next use starts a fresh one", async () => {
		const pool = statelessWorker<Api>(create, 30_000, "raster")
		const call = pool.use(({ remote }) => remote.work())

		await Promise.resolve()
		workers[0]?.dispatchEvent(new Event("messageerror"))

		await expect(call).rejects.toThrow("raster worker is gone (messageerror)")

		const next = pool.use(() => Promise.resolve("second"))

		await expect(next).resolves.toBe("second")
		expect(workers).toHaveLength(2)
	})

	it("registers nothing on gone per call", async () => {
		const pool = statelessWorker<Api>(create, 30_000, "raster")
		const handle = await pool.use(current => Promise.resolve(current))
		const subscribe = vi.spyOn(handle.gone, "then")
		const call = pool.use(({ remote }) => remote.work())

		await Promise.resolve()
		await Promise.resolve()
		remotes[0]?.pending[0]?.("ok")

		await expect(call).resolves.toBe("ok")
		expect(subscribe).not.toHaveBeenCalled()
	})
})

describe("ownedWorkerState", () => {
	const restart = () => undefined
	const session = { key: "a", attempt: 0, generation: 1, owned: "worker", failure: null }

	it("is starting until the session for this key and attempt is published", () => {
		expect(ownedWorkerState(null, "a", 0, restart)).toEqual({ status: "starting" })
		expect(ownedWorkerState(session, "b", 0, restart)).toEqual({ status: "starting" })
		expect(ownedWorkerState(session, "a", 1, restart)).toEqual({ status: "starting" })
	})

	it("is ready, or failed with a restart", () => {
		expect(ownedWorkerState(session, "a", 0, restart)).toEqual({ status: "ready", owned: "worker", generation: 1 })
		expect(ownedWorkerState({ ...session, failure: { species: "plain", message: "x", label: "x" } }, "a", 0, restart)).toMatchObject({
			status: "failed",
			restart
		})
	})
})
