import { afterEach, describe, expect, it, vi } from "vitest"

// heicTransform.ts's client-side contract: lazily spins up + memoizes a single shared worker (never
// at module load), wraps it with Comlink, and forwards transform() calls through it. The worker
// itself is heic.worker.ts, which heic.worker.test.ts already pins over a real MessageChannel — this
// file only needs to prove heicTransform.ts's OWN seam (lazy spin-up, memoization, retry-after-failure,
// transfer of a private copy, pass-through of the transform result/opts), so both the `?worker` constructor and
// Comlink.wrap are replaced with plain fakes rather than a second real worker boundary.

const { WorkerCtor, wrap, transformMock, transferSpy, terminateMock, releaseMock, recoverIfNewerBuild } = vi.hoisted(() => ({
	recoverIfNewerBuild: vi.fn(),
	WorkerCtor: vi.fn(),
	wrap: vi.fn(),
	transformMock: vi.fn(),
	transferSpy: vi.fn(),
	terminateMock: vi.fn(),
	releaseMock: vi.fn()
}))

vi.mock("@/features/preview/workers/heic.worker.ts?worker", () => ({ default: WorkerCtor }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild }))

// wrap() is faked (no real postMessage boundary here — that round trip, including genuine buffer
// detachment, is already proven by heic.worker.test.ts). transfer() stays real but spied on: it's
// heicTransform.ts's own responsibility to mark the bytes as transferable with the right transfer
// list, which is what this file actually needs to pin.
vi.mock("comlink", async importOriginal => {
	const actual = await importOriginal<typeof import("comlink")>()

	return {
		...actual,
		wrap,
		transfer: (obj: unknown, transfers: readonly Transferable[]) => {
			transferSpy(obj, transfers)
			return actual.transfer(obj as never, transfers as Transferable[])
		}
	}
})

// The real worker's EventTarget, so a test can fire the error a missing worker file raises.
class FakeWorkerTarget extends EventTarget {
	fake = "worker-instance"
	terminate = terminateMock
}

async function freshModule() {
	vi.resetModules()
	WorkerCtor.mockReset()
	wrap.mockReset()
	transformMock.mockReset()
	recoverIfNewerBuild.mockReset()
	WorkerCtor.mockImplementation(function FakeWorker() {
		return new FakeWorkerTarget()
	})
	const { releaseProxy } = await import("comlink")
	wrap.mockImplementation(() => ({ transform: transformMock, [releaseProxy]: releaseMock }))
	return import("@/features/preview/lib/heicTransform")
}

afterEach(() => {
	vi.clearAllMocks()
	vi.useRealTimers()
})

describe("transformHeicBytes", () => {
	it("spins up the worker lazily — not constructed until the first call", async () => {
		await freshModule()

		expect(WorkerCtor).not.toHaveBeenCalled()
	})

	it("constructs the worker, wraps it with Comlink, and returns the resolved Blob", async () => {
		const { transformHeicBytes } = await freshModule()
		const blob = new Blob(["jpeg"], { type: "image/jpeg" })
		transformMock.mockResolvedValue(blob)

		const result = await transformHeicBytes(new Uint8Array([1, 2, 3]))

		expect(WorkerCtor).toHaveBeenCalledTimes(1)
		expect(wrap).toHaveBeenCalledWith(expect.objectContaining({ fake: "worker-instance" }))
		expect(result).toBe(blob)
	})

	it("checks for a newer build when the worker fails to start", async () => {
		const { transformHeicBytes } = await freshModule()
		transformMock.mockResolvedValue(new Blob())

		await transformHeicBytes(new Uint8Array([1]))

		const worker = WorkerCtor.mock.results[0]?.value as EventTarget | undefined

		expect(recoverIfNewerBuild).not.toHaveBeenCalled()
		worker?.dispatchEvent(new Event("error"))
		expect(recoverIfNewerBuild).toHaveBeenCalledTimes(1)
	})

	it("memoizes the worker across multiple calls — one spin-up for the tab session", async () => {
		const { transformHeicBytes } = await freshModule()
		transformMock.mockResolvedValue(new Blob())

		await transformHeicBytes(new Uint8Array([1]))
		await transformHeicBytes(new Uint8Array([2]))

		expect(WorkerCtor).toHaveBeenCalledTimes(1)
		expect(wrap).toHaveBeenCalledTimes(1)
	})

	// The worker call takes bytes and nothing else: the encode-variant option existed only for the old
	// HEIC thumbnail generator, and thumbnails are the SDK's job now.
	it("passes nothing beyond the bytes", async () => {
		const { transformHeicBytes } = await freshModule()
		transformMock.mockResolvedValue(new Blob())

		await transformHeicBytes(new Uint8Array([1]))

		expect(transformMock.mock.calls[0]?.[1]).toBeUndefined()
	})

	it("transfers a private copy of the input, never the caller's own buffer", async () => {
		const { transformHeicBytes } = await freshModule()
		transformMock.mockResolvedValue(new Blob())
		const bytes = new Uint8Array([1, 2, 3])

		await transformHeicBytes(bytes)

		const sent = transformMock.mock.calls[0]?.[0] as Uint8Array
		expect(sent).not.toBe(bytes)
		expect(sent.buffer).not.toBe(bytes.buffer)
		expect(Array.from(sent)).toEqual([1, 2, 3])
		expect(transferSpy).toHaveBeenCalledWith(sent, [sent.buffer])
	})

	// The preview hands the SAME Uint8Array to every run of its transform effect (StrictMode's second
	// run in dev, the Retry button). The fake worker detaches whatever it is sent, the way a real
	// postMessage transfer does — a second call with the same input must still get through.
	it("leaves the caller's bytes intact, so the same input can be transformed again", async () => {
		const { transformHeicBytes } = await freshModule()
		transformMock.mockImplementation((sent: Uint8Array) => {
			structuredClone(sent, { transfer: [sent.buffer] })

			return Promise.resolve(new Blob(["jpeg"]))
		})
		const bytes = new Uint8Array([1, 2, 3])

		await expect(transformHeicBytes(bytes)).resolves.toBeInstanceOf(Blob)
		expect(bytes.byteLength).toBe(3)
		await expect(transformHeicBytes(bytes)).resolves.toBeInstanceOf(Blob)
		expect(Array.from(bytes)).toEqual([1, 2, 3])
	})

	it("does not cache a failed spin-up — the next call gets a fresh worker instead of staying broken", async () => {
		const { transformHeicBytes } = await freshModule()
		WorkerCtor.mockImplementationOnce(function FailingWorker() {
			throw new Error("worker spin-up failed")
		})
		transformMock.mockResolvedValue(new Blob())

		await expect(transformHeicBytes(new Uint8Array([1]))).rejects.toThrow("worker spin-up failed")
		await expect(transformHeicBytes(new Uint8Array([2]))).resolves.toBeInstanceOf(Blob)

		expect(WorkerCtor).toHaveBeenCalledTimes(2)
	})

	it("propagates a transform rejection from the worker without retrying", async () => {
		const { transformHeicBytes } = await freshModule()
		transformMock.mockRejectedValue(new Error("heic transform failed"))

		await expect(transformHeicBytes(new Uint8Array([1]))).rejects.toThrow("heic transform failed")
		// A failed transform (as opposed to a failed spin-up) leaves the worker memoized — the next
		// call reuses it rather than respawning.
		await expect(transformHeicBytes(new Uint8Array([2]))).rejects.toThrow("heic transform failed")
		expect(WorkerCtor).toHaveBeenCalledTimes(1)
	})

	// The upload path reads each file fresh and never touches the buffer again, so no copy is made.
	it("transfers an owned buffer as is, without copying it", async () => {
		const { transformHeicBytesOwned } = await freshModule()
		transformMock.mockResolvedValue(new Blob())
		const bytes = new Uint8Array([1, 2, 3])

		await transformHeicBytesOwned(bytes)

		expect(transformMock.mock.calls[0]?.[0]).toBe(bytes)
		expect(transferSpy).toHaveBeenCalledWith(bytes, [bytes.buffer])
	})
})

// libheif's wasm heap only ever grows, so an idle worker is torn down rather than kept for the session.
describe("heic worker lifetime", () => {
	it("terminates the worker once idle, and spins up a fresh one for the next transform", async () => {
		const { transformHeicBytes } = await freshModule()
		vi.useFakeTimers()
		transformMock.mockResolvedValue(new Blob())

		await transformHeicBytes(new Uint8Array([1]))
		await vi.advanceTimersByTimeAsync(29_999)

		expect(terminateMock).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)

		expect(releaseMock).toHaveBeenCalledTimes(1)
		expect(terminateMock).toHaveBeenCalledTimes(1)

		await transformHeicBytes(new Uint8Array([2]))

		expect(WorkerCtor).toHaveBeenCalledTimes(2)
	})

	it("never terminates while a transform is still running", async () => {
		const { transformHeicBytes, releaseHeicWorker } = await freshModule()
		vi.useFakeTimers()
		let finish: (blob: Blob) => void = () => undefined
		transformMock.mockImplementation(
			() =>
				new Promise<Blob>(resolve => {
					finish = resolve
				})
		)

		const running = transformHeicBytes(new Uint8Array([1]))

		await vi.advanceTimersByTimeAsync(60_000)
		releaseHeicWorker()

		expect(terminateMock).not.toHaveBeenCalled()

		finish(new Blob())
		await running
		releaseHeicWorker()

		expect(terminateMock).toHaveBeenCalledTimes(1)
	})

	// A preview stepped past while its transform waited for the worker posts nothing at all.
	it("never posts a transform whose caller went away while it waited", async () => {
		const { transformHeicBytes } = await freshModule()
		let finish: (blob: Blob) => void = () => undefined
		transformMock.mockImplementationOnce(
			() =>
				new Promise<Blob>(resolve => {
					finish = resolve
				})
		)

		const first = transformHeicBytes(new Uint8Array([1]))
		const gone = new AbortController()
		const second = transformHeicBytes(new Uint8Array([2]), gone.signal)

		await vi.waitFor(() => {
			expect(transformMock).toHaveBeenCalledTimes(1)
		})
		gone.abort()
		finish(new Blob())
		await first

		await expect(second).rejects.toThrow()
		expect(transformMock).toHaveBeenCalledTimes(1)
	})
})
