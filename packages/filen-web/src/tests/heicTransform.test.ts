import { afterEach, describe, expect, it, vi } from "vitest"

// heicTransform.ts's client-side contract: lazily spins up + memoizes a single shared worker (never
// at module load), wraps it with Comlink, and forwards transform() calls through it. The worker
// itself is heic.worker.ts, which heic.worker.test.ts already pins over a real MessageChannel — this
// file only needs to prove heicTransform.ts's OWN seam (lazy spin-up, memoization, retry-after-failure,
// transfer-not-clone, pass-through of the transform result/opts), so both the `?worker` constructor and
// Comlink.wrap are replaced with plain fakes rather than a second real worker boundary.

const { WorkerCtor, wrap, transformMock, transferSpy } = vi.hoisted(() => ({
	WorkerCtor: vi.fn(),
	wrap: vi.fn(),
	transformMock: vi.fn(),
	transferSpy: vi.fn()
}))

vi.mock("@/features/preview/workers/heic.worker.ts?worker", () => ({ default: WorkerCtor }))

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

async function freshModule() {
	vi.resetModules()
	WorkerCtor.mockReset()
	wrap.mockReset()
	transformMock.mockReset()
	WorkerCtor.mockImplementation(function FakeWorker() {
		return { fake: "worker-instance" }
	})
	wrap.mockImplementation(() => ({ transform: transformMock }))
	return import("@/features/preview/lib/heicTransform")
}

afterEach(() => {
	vi.clearAllMocks()
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

	it("memoizes the worker across multiple calls — one spin-up for the tab session", async () => {
		const { transformHeicBytes } = await freshModule()
		transformMock.mockResolvedValue(new Blob())

		await transformHeicBytes(new Uint8Array([1]))
		await transformHeicBytes(new Uint8Array([2]))

		expect(WorkerCtor).toHaveBeenCalledTimes(1)
		expect(wrap).toHaveBeenCalledTimes(1)
	})

	it("forwards opts through untouched, and omits them when the caller passes none", async () => {
		const { transformHeicBytes } = await freshModule()
		transformMock.mockResolvedValue(new Blob())

		await transformHeicBytes(new Uint8Array([1]))
		await transformHeicBytes(new Uint8Array([1]), { maxDimension: 512 })

		expect(transformMock.mock.calls[0]?.[1]).toBeUndefined()
		expect(transformMock.mock.calls[1]?.[1]).toEqual({ maxDimension: 512 })
	})

	it("marks the input as transferred (its own buffer, not a clone) and forwards the same reference", async () => {
		const { transformHeicBytes } = await freshModule()
		transformMock.mockResolvedValue(new Blob())
		const bytes = new Uint8Array([1, 2, 3])

		await transformHeicBytes(bytes)

		expect(transferSpy).toHaveBeenCalledWith(bytes, [bytes.buffer])
		expect(transformMock.mock.calls[0]?.[0]).toBe(bytes)
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
})
