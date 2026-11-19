import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile, File as SdkFile } from "@filen/sdk-rs"
import { narrowItem, type BaseFileItem } from "@/features/drive/lib/item"
import type { FrameCaptureParams, FrameCaptureResult } from "@/features/videos/workers/frame.worker"
import type { VideoProbe } from "@filen/shared/videos"
import { FRAME_SESSION_MAX_FRAMES } from "@/features/videos/lib/frames.logic"
import { testUuid } from "@/tests/support/uuid"

// Drive's keyframe read over the REAL Videos probe scheduler and frame generator classes, against the real
// Videos singletons: the two features share the record stores but never each other's session budgets. The
// SDK, kv, the frame worker and Comlink's wire are the boundaries; everything thumbGenerators.ts touches
// besides is replaced as in thumbGenerators.test.ts.

const { readVideoProbeMock, openRangePortMock, cancelPreviewDownloadMock, captureMock } = vi.hoisted(() => ({
	readVideoProbeMock: vi.fn<(file: AnyFile, uuid: string, tier: string, token: string) => Promise<VideoProbe | null>>(),
	openRangePortMock: vi.fn<(port: MessagePort, file: AnyFile, token: string) => Promise<void>>(() => Promise.resolve()),
	cancelPreviewDownloadMock: vi.fn<(token: string) => Promise<void>>(() => Promise.resolve()),
	captureMock: vi.fn<(params: FrameCaptureParams) => Promise<FrameCaptureResult>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		readVideoProbe: readVideoProbeMock,
		openRangePort: openRangePortMock,
		cancelPreviewDownload: cancelPreviewDownloadMock,
		cancelPreviewDownloadUnlessFinishing: cancelPreviewDownloadMock
	}
}))
vi.mock("@/lib/storage/adapter", async () => {
	const { memoryKv } = await import("@/tests/support/memoryKv")

	return memoryKv().kv
})
vi.mock("@/features/videos/workers/frame.worker.ts?worker", () => ({
	default: class {
		public addEventListener(): void {
			return undefined
		}

		public terminate(): void {
			return undefined
		}
	}
}))
vi.mock("comlink", async importOriginal => {
	const actual = await importOriginal<typeof import("comlink")>()

	return {
		...actual,
		wrap: () => ({
			capture: captureMock,
			[actual.releaseProxy]: () => undefined
		}),
		transfer: <T>(value: T) => value
	}
})
vi.mock("@/features/drive/lib/thumbnails", () => ({
	registerThumbGenerator: vi.fn(),
	seedThumbnail: vi.fn(),
	withGenerationSlot: vi.fn()
}))
vi.mock("@/features/drive/lib/download", () => ({ narrowToAnyFile: (item: BaseFileItem) => item.data }))
vi.mock("@/features/preview/lib/previewStream", () => ({
	waitForMediaStream: vi.fn(),
	previewStreamUrl: vi.fn(),
	releasePreviewStream: vi.fn()
}))
// No inline-allowed type: the element arm is skipped, so no DOM is needed.
vi.mock("@/features/preview/lib/mediaType", () => ({ allowedMediaContentType: () => null }))
vi.mock("@/features/preview/lib/previewCache", () => ({ getPreviewBytes: () => undefined }))
vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	PDFWorker: vi.fn(),
	PDFDataRangeTransport: vi.fn(),
	getDocument: vi.fn()
}))

import { generateVideoThumb, resetDriveKeyframes } from "@/features/drive/lib/thumbGenerators"
import { probeService } from "@/features/videos/lib/probeService"
import { frameGenerator } from "@/features/videos/lib/frames"

let uuidCounter = 0

function mkvItem(): BaseFileItem {
	uuidCounter += 1

	const file: SdkFile = {
		uuid: testUuid(`k${uuidCounter.toString()}`),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: "film.mkv", mime: "video/x-matroska", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	}
	const item = narrowItem(file)

	if (item.type !== "file") {
		throw new Error("expected a file item")
	}

	return item
}

const PROBE: VideoProbe = {
	v: 1,
	container: "mkv",
	durationSec: 60,
	index: "cues",
	video: {
		codec: "h264",
		fourcc: "avc1",
		codecString: "avc1.64001f",
		w: 1280,
		h: 720,
		par: 1,
		rotation: 0,
		bitDepth: 8,
		transfer: "sdr"
	},
	audio: [],
	subs: [],
	chapters: [],
	cover: null,
	coverLand: null,
	partial: false
}

const FRAME: FrameCaptureResult = {
	type: "frame",
	bytes: new Uint8Array([7, 7]),
	width: 384,
	height: 216,
	dominant: [1, 2, 3],
	key: {
		offset: 1000,
		size: 2000,
		timeSec: 10.8,
		decoder: { codec: "avc1.64001f", codedWidth: 1280, codedHeight: 720, description: null }
	},
	reads: 1
}

function live(): AbortSignal {
	return new AbortController().signal
}

beforeEach(() => {
	vi.clearAllMocks()
	// Node has no WebCodecs; the frame generators attempt nothing without it.
	vi.stubGlobal("VideoDecoder", {})
	readVideoProbeMock.mockResolvedValue(PROBE)
	captureMock.mockResolvedValue(FRAME)
})

describe("drive keyframe thumbnails — budgets of their own", () => {
	it("loads nothing for a logout before any keyframe read", async () => {
		resetDriveKeyframes()

		await Promise.resolve()

		expect(readVideoProbeMock).not.toHaveBeenCalled()
		expect(captureMock).not.toHaveBeenCalled()
	})

	it("spends drive's own frame budget and probe count, never the Videos ones", async () => {
		const items = Array.from({ length: FRAME_SESSION_MAX_FRAMES + 1 }, () => mkvItem())
		const results = await Promise.all(items.map(item => generateVideoThumb(item, live())))

		expect(results.filter(result => result.type === "bytes")).toHaveLength(FRAME_SESSION_MAX_FRAMES)
		expect(results.filter(result => result.type === "failed")).toHaveLength(1)
		expect(readVideoProbeMock).toHaveBeenCalledTimes(FRAME_SESSION_MAX_FRAMES + 1)
		expect(captureMock).toHaveBeenCalledTimes(FRAME_SESSION_MAX_FRAMES)
		expect(probeService.startedCount).toBe(0)

		// Videos' generator still has its whole session budget.
		const target = mkvItem()
		const made = await frameGenerator.generate({
			target: { uuid: target.data.uuid, file: target.data, size: 1_024 },
			probe: PROBE,
			box: { width: 384, height: 384 }
		})

		expect(made?.bytes).toEqual(FRAME.bytes)
	})

	it("spends no probe or capture where the browser cannot decode video frames, and keeps no verdict", async () => {
		vi.stubGlobal("VideoDecoder", undefined)

		const item = mkvItem()

		// Session-only (no blacklist strike, nothing persisted), so a browser update is picked up.
		expect(await generateVideoThumb(item, live())).toEqual({ type: "unavailable", reason: "unsupported" })
		expect(readVideoProbeMock).not.toHaveBeenCalled()
		expect(captureMock).not.toHaveBeenCalled()
		expect(openRangePortMock).not.toHaveBeenCalled()
		expect(await frameGenerator.settledMiss(item.data.uuid)).toBe(false)
	})

	it("starts drive's session over on logout, while a drive probe record stays shared with Videos", async () => {
		resetDriveKeyframes()

		// The reset lands one microtask on, once the loaded services resolve.
		await Promise.resolve()
		await expect(generateVideoThumb(mkvItem(), live())).resolves.toEqual({ type: "bytes", bytes: FRAME.bytes })

		const item = mkvItem()

		await generateVideoThumb(item, live())

		readVideoProbeMock.mockClear()

		await expect(probeService.request({ uuid: item.data.uuid, file: item.data }, "card")).resolves.toMatchObject({ probe: PROBE })
		expect(readVideoProbeMock).not.toHaveBeenCalled()
		expect(probeService.startedCount).toBe(0)
	})
})
