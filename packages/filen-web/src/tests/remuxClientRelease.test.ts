import { afterEach, describe, expect, it, vi } from "vitest"

// Sign-out ends the remux worker through the preview worker registry, held or idle.
const { WorkerCtor, wrap, terminate } = vi.hoisted(() => ({ WorkerCtor: vi.fn(), wrap: vi.fn(), terminate: vi.fn() }))

vi.mock("@/workers/remux.worker.ts?worker", () => ({ default: WorkerCtor }))
vi.mock("comlink", async importOriginal => ({ ...(await importOriginal<typeof import("comlink")>()), wrap }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild: vi.fn() }))

const { releaseProxy } = await import("comlink")
const { holdRemuxWorker, probeEncodersInWorker } = await import("@/lib/media/remuxClient")
const { releaseAllPreviewWorkers } = await import("@/lib/workers/ownedWorker")

WorkerCtor.mockImplementation(function FakeWorker() {
	return Object.assign(new EventTarget(), { terminate })
})
wrap.mockImplementation(() => ({
	// Never answered: the life lock is not under test here.
	holdLifeLock: () => new Promise(() => undefined),
	encodeCapabilities: () => Promise.resolve({ video: [], audio: [] }),
	[releaseProxy]: vi.fn()
}))

afterEach(() => {
	releaseAllPreviewWorkers()
	vi.clearAllMocks()
})

describe("remux worker at sign-out", () => {
	it("terminates an idle worker", async () => {
		await probeEncodersInWorker()

		expect(terminate).not.toHaveBeenCalled()

		releaseAllPreviewWorkers()

		expect(terminate).toHaveBeenCalledTimes(1)
	})

	it("terminates a held worker at once; the hold's dead rejects as cancelled", async () => {
		const hold = await holdRemuxWorker()

		releaseAllPreviewWorkers()

		await expect(hold.dead).rejects.toMatchObject({ name: "AbortError" })
		expect(terminate).toHaveBeenCalledTimes(1)

		hold.release()
	})
})
