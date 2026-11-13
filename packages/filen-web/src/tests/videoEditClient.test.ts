import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import type { VideoProbe } from "@filen/shared/videos"
import type { DriveItem } from "@/features/drive/lib/item"
import type { VideoEditRecipe, VideoSaveOutcome, VideoSourceInfo } from "@/features/preview/videoEdit/types"

// client.ts's own seam: when it spins the preview worker up, what it forwards, the port it opens and cancels, plans
// answered from the pure plan, exports run as saves (startVideoSave) that outlive the editor, the iOS decoder
// hand-over, and teardown on dispose and logout. The worker, Comlink.wrap and the save are fakes, tested on their own.

const h = vi.hoisted(() => ({
	PreviewCtor: vi.fn(),
	wrap: vi.fn(),
	openRangePort: vi.fn(),
	cancelPreviewDownload: vi.fn(),
	probeRequest: vi.fn(),
	planExport: vi.fn(),
	startVideoSave: vi.fn(),
	encodeCapabilities: vi.fn(),
	ios: { value: false },
	terminated: 0
}))

vi.mock("@/features/preview/videoEdit/worker/preview.worker.ts?worker", () => ({ default: h.PreviewCtor }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild: vi.fn() }))
vi.mock("@/lib/appleMobile", () => ({ isAppleMobile: () => h.ios.value }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { openRangePort: h.openRangePort, cancelPreviewDownload: h.cancelPreviewDownload } }))
vi.mock("@/features/videos/lib/probeService", () => ({ probeService: { request: h.probeRequest } }))
vi.mock("@/features/preview/videoEdit/lib/plan", () => ({ planExport: h.planExport }))
vi.mock("@/features/preview/videoEdit/save", () => ({ startVideoSave: h.startVideoSave }))
vi.mock("@/features/preview/videoEdit/saveDeps", () => ({
	videoSaveDeps: () => ({ encodeCapabilities: h.encodeCapabilities, versioning: () => true, ios: () => h.ios.value })
}))
vi.mock("comlink", async importOriginal => {
	const actual = await importOriginal<typeof import("comlink")>()

	return { ...actual, wrap: h.wrap, transfer: <T>(value: T) => value, proxy: <T>(value: T) => value }
})

const INFO = { duration: 10, width: 1920, height: 1080, keyframes: new Float64Array([0, 2]) } as unknown as VideoSourceInfo
const RECIPE = { keep: [{ start: 0, end: 10 }] } as unknown as VideoEditRecipe
const FILE = { uuid: "file-uuid", size: 123_456n, decryptedMeta: { name: "clip.mp4" } } as unknown as AnyFile
const ITEM = { type: "file", data: FILE } as unknown as DriveItem
const PROBE = { v: 1, container: "mp4" } as unknown as VideoProbe

class FakeWorker extends EventTarget {
	public terminate(): void {
		h.terminated++
	}
}

function previewRemote() {
	return {
		open: vi.fn(() => Promise.resolve(INFO)),
		frameAt: vi.fn(() => Promise.resolve("bitmap")),
		filmstrip: vi.fn(() => Promise.resolve([{ time: 1, bitmap: "still" }])),
		cancelFilmstrip: vi.fn(() => Promise.resolve()),
		watchWaveform: vi.fn(() => Promise.resolve()),
		unwatchWaveform: vi.fn(() => Promise.resolve()),
		suspendDecoding: vi.fn(() => Promise.resolve()),
		resumeDecoding: vi.fn(() => Promise.resolve()),
		close: vi.fn(() => Promise.resolve())
	}
}

interface FakeSave {
	finish: (outcome: VideoSaveOutcome) => void
	cancel: ReturnType<typeof vi.fn>
	detach: ReturnType<typeof vi.fn>
}

let preview: ReturnType<typeof previewRemote>
let saves: FakeSave[] = []

async function load() {
	vi.resetModules()

	const { releaseProxy } = await import("comlink")

	preview = previewRemote()
	h.PreviewCtor.mockImplementation(function Preview() {
		return new FakeWorker()
	})
	h.wrap.mockImplementation(() => ({ ...preview, [releaseProxy]: vi.fn() }))

	return import("@/features/preview/videoEdit/client")
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve()
	}
}

beforeEach(() => {
	for (const mock of [
		h.PreviewCtor,
		h.wrap,
		h.openRangePort,
		h.cancelPreviewDownload,
		h.probeRequest,
		h.planExport,
		h.startVideoSave,
		h.encodeCapabilities
	]) {
		mock.mockReset()
	}

	h.openRangePort.mockResolvedValue(undefined)
	h.probeRequest.mockResolvedValue({ probe: PROBE })
	h.encodeCapabilities.mockResolvedValue({ videoEncoder: true })
	h.planExport.mockReturnValue({ mode: "copy" })
	h.ios.value = false
	h.terminated = 0
	saves = []
	h.startVideoSave.mockImplementation(() => {
		const done = Promise.withResolvers<VideoSaveOutcome>()
		const save: FakeSave = {
			finish: done.resolve,
			cancel: vi.fn(() => {
				done.resolve({ status: "cancelled" })
			}),
			detach: vi.fn()
		}

		saves.push(save)

		return { id: "save", done: done.promise, cancel: save.cancel, detach: save.detach }
	})
})

afterEach(() => {
	vi.useRealTimers()
})

describe("createVideoEditClient", () => {
	it("starts nothing until asked, then opens the source once through one range port with the stored probe", async () => {
		const { createVideoEditClient } = await load()
		const client = createVideoEditClient({ item: ITEM })

		expect(h.PreviewCtor).not.toHaveBeenCalled()

		const [a, b] = await Promise.all([client.loadSource(), client.loadSource()])

		expect(a).toBe(INFO)
		expect(b).toBe(INFO)
		expect(h.PreviewCtor).toHaveBeenCalledTimes(1)
		expect(h.openRangePort).toHaveBeenCalledTimes(1)
		expect(h.probeRequest).toHaveBeenCalledTimes(1)
		expect(preview.open).toHaveBeenCalledTimes(1)
		expect(preview.open).toHaveBeenCalledWith(expect.objectContaining({ size: 123_456, probe: PROBE }))
		client.dispose()
	})

	it("takes a probe the caller holds, and refuses a directory", async () => {
		const { createVideoEditClient } = await load()
		const client = createVideoEditClient({ item: ITEM, probe: null })

		await client.loadSource()

		expect(h.probeRequest).not.toHaveBeenCalled()
		expect(preview.open).toHaveBeenCalledWith(expect.objectContaining({ probe: null }))
		expect(() => createVideoEditClient({ item: { type: "directory", data: {} } as unknown as DriveItem })).toThrow()
		client.dispose()
	})

	it("forwards frames, filmstrips and waveforms to the preview worker", async () => {
		const { createVideoEditClient } = await load()
		const client = createVideoEditClient({ item: ITEM })

		expect(await client.frameAt(2, RECIPE, 640)).toBe("bitmap")
		expect(preview.frameAt).toHaveBeenCalledWith(2, RECIPE, 640)
		expect(await client.filmstrip([1, 2], 48)).toEqual([{ time: 1, bitmap: "still" }])

		const onUpdate = vi.fn()
		const stop = client.waveform({ start: 0, end: 10 }, 200, onUpdate)

		await flush()

		expect(preview.watchWaveform).toHaveBeenCalledWith(expect.any(Number), { start: 0, end: 10 }, 200, onUpdate)

		stop()
		stop()
		await flush()

		expect(preview.unwatchWaveform).toHaveBeenCalledTimes(1)
		client.dispose()
	})

	it("supersedes a running filmstrip request with a newer one", async () => {
		const { createVideoEditClient } = await load()
		const client = createVideoEditClient({ item: ITEM })
		const first = Promise.withResolvers<unknown>()

		preview.filmstrip.mockImplementationOnce(() => first.promise as never)

		const pending = client.filmstrip([1], 48)

		await flush()
		await client.filmstrip([2], 48)

		expect(preview.cancelFilmstrip).toHaveBeenCalledTimes(1)
		first.resolve([])
		expect(await pending).toEqual([])
		client.dispose()
	})

	it("plans from the source, the encoders and the file's context, without a worker of its own", async () => {
		const { createVideoEditClient } = await load()
		const client = createVideoEditClient({ item: ITEM })

		expect(await client.plan(RECIPE)).toEqual({ mode: "copy" })
		expect(h.planExport).toHaveBeenCalledWith(RECIPE, INFO, { videoEncoder: true }, { name: "clip.mp4", versioning: true, ios: false })
		expect(h.PreviewCtor).toHaveBeenCalledTimes(1)
		client.dispose()
	})

	it("exports as a save of the opened source and passes its outcome through", async () => {
		const { createVideoEditClient } = await load()
		const client = createVideoEditClient({ item: ITEM })
		const onProgress = vi.fn()
		const running = client.exportVideo(RECIPE, "copy", onProgress)

		await flush()

		expect(h.startVideoSave).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ item: ITEM, recipe: RECIPE, info: INFO, target: "copy" }),
			onProgress
		)

		const request = h.startVideoSave.mock.calls[0]?.[1] as { copySuffix: (n: number) => string }

		expect(request.copySuffix(1)).not.toBe(request.copySuffix(2))

		saves[0]?.finish({ status: "remoteChanged", currentUuid: "other" })

		expect(await running.done).toEqual({ status: "remoteChanged", currentUuid: "other" })
		client.dispose()
	})

	it("cancels a save, and one cancelled before it started never starts", async () => {
		const { createVideoEditClient } = await load()
		const client = createVideoEditClient({ item: ITEM })
		const early = client.exportVideo(RECIPE, "copy", vi.fn())

		early.cancel()

		expect(await early.done).toEqual({ status: "cancelled" })
		expect(h.startVideoSave).not.toHaveBeenCalled()

		const later = client.exportVideo(RECIPE, "copy", vi.fn())

		await flush()
		later.cancel()

		expect(saves[0]?.cancel).toHaveBeenCalledTimes(1)
		expect(await later.done).toEqual({ status: "cancelled" })
		client.dispose()
	})

	it("detaches a save to its transfer row, and dispose never stops a running save", async () => {
		const { createVideoEditClient } = await load()
		const client = createVideoEditClient({ item: ITEM })
		const running = client.exportVideo(RECIPE, "inPlace", vi.fn())

		await flush()
		running.detachToTransfer()
		client.dispose()

		expect(saves[0]?.detach).toHaveBeenCalledTimes(1)
		expect(saves[0]?.cancel).not.toHaveBeenCalled()

		saves[0]?.finish({ status: "done", item: ITEM })
		expect(await running.done).toEqual({ status: "done", item: ITEM })

		// Detached before the save started: detached as soon as it does.
		const other = createVideoEditClient({ item: ITEM })
		const early = other.exportVideo(RECIPE, "copy", vi.fn())

		early.detachToTransfer()
		await flush()

		expect(saves[1]?.detach).toHaveBeenCalledTimes(1)
		other.dispose()
	})

	it("hands the preview's decoder to an export on iOS and takes it back after", async () => {
		h.ios.value = true

		const { createVideoEditClient } = await load()
		const client = createVideoEditClient({ item: ITEM })
		const running = client.exportVideo(RECIPE, "inPlace", vi.fn())

		await flush()

		expect(preview.suspendDecoding).toHaveBeenCalledTimes(1)
		expect(preview.resumeDecoding).not.toHaveBeenCalled()

		saves[0]?.finish({ status: "done", item: ITEM })
		await running.done
		await flush()

		expect(preview.resumeDecoding).toHaveBeenCalledTimes(1)
		client.dispose()
	})

	it("closes the source and its port on dispose, and the worker once idle", async () => {
		vi.useFakeTimers()

		const { createVideoEditClient } = await load()
		const client = createVideoEditClient({ item: ITEM })

		await client.loadSource()
		client.dispose()
		await vi.advanceTimersByTimeAsync(0)

		expect(preview.close).toHaveBeenCalledTimes(1)
		expect(h.cancelPreviewDownload).toHaveBeenCalledTimes(1)
		expect(h.terminated).toBe(0)

		await vi.advanceTimersByTimeAsync(30_000)

		expect(h.terminated).toBe(1)
		await expect(client.frameAt(0, RECIPE, 10)).rejects.toThrow(/disposed/)
	})

	it("ends every client and the worker at logout", async () => {
		const { createVideoEditClient, releaseVideoEditWorkers } = await load()
		const client = createVideoEditClient({ item: ITEM })

		await client.loadSource()
		releaseVideoEditWorkers()
		await flush()

		expect(preview.close).toHaveBeenCalledTimes(1)
		expect(h.terminated).toBe(1)
	})
})
