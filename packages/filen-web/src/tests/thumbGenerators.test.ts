import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { onlineManager } from "@tanstack/react-query"
import { log } from "@/lib/log"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type BaseFileItem, type DriveItem } from "@/features/drive/lib/item"
import { type ThumbGeneratorCategory, type ThumbGenerator, type ThumbSeedResult } from "@/features/drive/lib/thumbnails"
import {
	THUMB_MAX_DIM,
	THUMB_SDK_MAX_HEIGHT,
	THUMB_SDK_LOSSY_QUALITY,
	THUMB_PDF_READ_MAX,
	THUMB_SVG_SIZE_GATE,
	THUMB_WARM_SIZE_GATE
} from "@/features/drive/lib/thumbnails.logic"
import type { SdkThumbnailResult } from "@/workers/sdk.worker"
import type { ProbeTier } from "@filen/shared/videos"
import type { ProbeRecord } from "@/features/videos/lib/probeService.logic"
import type { FrameGeneratorDeps, FrameRequest, GeneratedFrame } from "@/features/videos/lib/frames"
import type { ProbeServiceDeps } from "@/features/videos/lib/probeService"
import { FRAME_DWELL_MS, FRAME_RECIPE_VERSION, type FrameHint } from "@/features/videos/lib/frames.logic"

const MIB = 1024 * 1024

// The range transport openPdf handed the `index`th getDocument call.
function transportOf(index: number): { requestDataRange(begin: number, end: number): void; answered: number[] } {
	return (getDocumentMock.mock.calls[index]?.[0] as { range: { requestDataRange(begin: number, end: number): void; answered: number[] } })
		.range
}

// The signal of a generation some cell still wants.
function live(): AbortSignal {
	return new AbortController().signal
}

// Mock boundaries: registerThumbGenerator/seedThumbnail are replaced so this file's module-scope
// registration (a side effect under test) never touches the real service's Map, and so the upload
// warm can be observed without driving a real generation. The sdk client, download narrowing and the
// preview-stream/media-type gates are replaced for the same reason thumbnails.test.ts replaces the sdk
// client and thumb-cache — the real ones either import a Vite `?worker` (unresolvable under node
// vitest) or reach a browser API (document, OffscreenCanvas) this suite's node environment lacks.
// generateVideoThumb/generatePdfThumb's OWN DOM-touching bodies are proven live (the e2e leg), not
// here — this file only exercises the branches reachable before any DOM element would be created.
const { registerThumbGeneratorMock, seedThumbnailMock, withGenerationSlotMock } = vi.hoisted(() => ({
	registerThumbGeneratorMock: vi.fn<(category: ThumbGeneratorCategory, generator: ThumbGenerator) => void>(),
	seedThumbnailMock: vi.fn<(item: DriveItem, produce: () => Promise<ThumbSeedResult>) => void>(),
	withGenerationSlotMock: vi.fn(<T>(_category: ThumbGeneratorCategory, produce: () => Promise<T>) => produce())
}))

vi.mock("@/features/drive/lib/thumbnails", () => ({
	registerThumbGenerator: registerThumbGeneratorMock,
	seedThumbnail: seedThumbnailMock,
	withGenerationSlot: withGenerationSlotMock
}))

const { downloadFileBytesMock, cancelPreviewDownloadIfEarlyMock, makeSdkThumbnailMock, makeSdkThumbnailFromFileMock } = vi.hoisted(() => ({
	downloadFileBytesMock: vi.fn<(file: unknown, token: string) => Promise<Uint8Array>>(),
	cancelPreviewDownloadIfEarlyMock: vi.fn<(token: string, maxFraction: number) => void>(),
	makeSdkThumbnailMock:
		vi.fn<(file: unknown, maxWidth: number, maxHeight: number, lossyQuality: number) => Promise<SdkThumbnailResult>>(),
	makeSdkThumbnailFromFileMock:
		vi.fn<(file: File, maxWidth: number, maxHeight: number, lossyQuality: number) => Promise<SdkThumbnailResult>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		downloadFileBytes: downloadFileBytesMock,
		cancelPreviewDownloadIfEarly: cancelPreviewDownloadIfEarlyMock,
		makeSdkThumbnail: makeSdkThumbnailMock,
		makeSdkThumbnailFromFile: makeSdkThumbnailFromFileMock
	}
}))

const { narrowToAnyFileMock } = vi.hoisted(() => ({ narrowToAnyFileMock: vi.fn((item: BaseFileItem) => item.data) }))

vi.mock("@/features/drive/lib/download", () => ({ narrowToAnyFile: narrowToAnyFileMock }))

const { waitForMediaStreamMock, previewStreamUrlMock, releasePreviewStreamMock, previewStreamStatusMock } = vi.hoisted(() => ({
	waitForMediaStreamMock: vi.fn<() => Promise<boolean>>(),
	previewStreamUrlMock:
		vi.fn<(file: unknown, name: string, contentType: string, id?: string, options?: { transient?: boolean }) => Promise<string>>(),
	releasePreviewStreamMock: vi.fn<(id: string) => void>(),
	previewStreamStatusMock: vi.fn<(id: string) => Promise<"present" | "lost" | "missing" | "unknown">>()
}))

vi.mock("@/features/preview/lib/previewStream", () => ({
	waitForMediaStream: waitForMediaStreamMock,
	previewStreamUrl: previewStreamUrlMock,
	releasePreviewStream: releasePreviewStreamMock,
	previewStreamStatus: previewStreamStatusMock,
	previewStreamIdOf: (url: string) => url.slice(url.lastIndexOf("/") + 1)
}))

const { allowedMediaContentTypeMock } = vi.hoisted(() => ({ allowedMediaContentTypeMock: vi.fn<(item: DriveItem) => string | null>() }))

vi.mock("@/features/preview/lib/mediaType", () => ({ allowedMediaContentType: allowedMediaContentTypeMock }))

const { getPreviewBytesMock } = vi.hoisted(() => ({
	getPreviewBytesMock: vi.fn<(scope: string | null, uuid: string) => Uint8Array | undefined>()
}))

vi.mock("@/features/preview/lib/previewCache", () => ({ getPreviewBytes: getPreviewBytesMock }))

// The keyframe read's services: drive's own probe scheduler and frame generator (each built once, from the
// Videos classes, over the shared record stores) and the frame hint store. Only the classes are exported, so
// any use of the Videos singletons would fail here. The frame worker's `?worker` is unresolvable under node.
const { probeRequestMock, probeResetMock, built, frameGenerateMock, frameResetMock, frameHintGetMock } = vi.hoisted(() => ({
	probeRequestMock:
		vi.fn<
			(
				target: { uuid: string; file: unknown },
				tier: ProbeTier,
				options: { signal?: AbortSignal; rank?: () => number }
			) => Promise<ProbeRecord | null>
		>(),
	probeResetMock: vi.fn(),
	// Plain arrays, which vi.clearAllMocks leaves alone: each instance is built once per module.
	built: { probes: [] as ProbeServiceDeps[], frames: [] as FrameGeneratorDeps[] },
	frameGenerateMock: vi.fn<(request: FrameRequest) => Promise<GeneratedFrame | null>>(),
	frameResetMock: vi.fn(),
	frameHintGetMock: vi.fn<(uuid: string) => Promise<FrameHint | null>>()
}))

vi.mock("@/features/videos/lib/probeService", () => ({
	ProbeService: class {
		public readonly request = probeRequestMock
		public readonly reset = probeResetMock
		public readonly onReconnect = vi.fn()

		public constructor(deps: ProbeServiceDeps) {
			built.probes.push(deps)
		}
	}
}))
vi.mock("@/features/videos/lib/frames", () => ({
	FrameGenerator: class {
		public readonly generate = frameGenerateMock
		public readonly reset = frameResetMock

		public constructor(deps: FrameGeneratorDeps) {
			built.frames.push(deps)
		}
	}
}))
vi.mock("@/features/videos/lib/records", () => ({
	frameHints: {
		get: (uuid: string) => frameHintGetMock(uuid)
	},
	probeRecords: {}
}))
vi.mock("@/features/videos/workers/frame.worker.ts?worker", () => ({ default: vi.fn() }))

// A stand-in pdf.js: what each generation hands getDocument (bytes or a range transport, the worker), each task's
// teardown, and the transport's requests are observable without a DOM. Nothing here ever renders a page.
const { pdfWorkerCtorMock, pdfWorkerDestroyMock, getDocumentMock, taskDestroyMock } = vi.hoisted(() => ({
	pdfWorkerCtorMock: vi.fn(),
	pdfWorkerDestroyMock: vi.fn(),
	getDocumentMock: vi.fn(),
	taskDestroyMock: vi.fn(() => Promise.resolve())
}))

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	PDFWorker: class {
		constructor() {
			pdfWorkerCtorMock()
		}

		destroy(): void {
			pdfWorkerDestroyMock()
		}
	},
	PDFDataRangeTransport: class {
		readonly answered: number[] = []

		requestDataRange(): void {
			throw new Error("not replaced")
		}

		onDataRange(begin: number): void {
			this.answered.push(begin)
		}

		abort(): void {
			// Nothing to abort.
		}
	},
	getDocument: getDocumentMock
}))

const { openOriginRangeSourceMock, rangeReadMock, rangeCloseMock } = vi.hoisted(() => ({
	openOriginRangeSourceMock: vi.fn(),
	rangeReadMock: vi.fn<(start: number, end: number, signal: AbortSignal) => Promise<Uint8Array>>(),
	rangeCloseMock: vi.fn()
}))

vi.mock("@/features/preview/lib/origin/rangeSource", () => ({ openOriginRangeSource: openOriginRangeSourceMock }))

const { recoverIfNewerBuildMock } = vi.hoisted(() => ({ recoverIfNewerBuildMock: vi.fn() }))

vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild: recoverIfNewerBuildMock }))

const { supportsNativeImageMock, thumbnailRasterMock } = vi.hoisted(() => ({
	supportsNativeImageMock: vi.fn<(format: string) => Promise<boolean>>(),
	thumbnailRasterMock:
		vi.fn<(bytes: Uint8Array, type: string, size: { width: number; height: number }, maxDim: number) => Promise<Uint8Array>>()
}))

vi.mock("@/lib/nativeImageSupport", () => ({ supportsNativeImage: supportsNativeImageMock }))
vi.mock("@/features/drive/lib/thumbRaster", () => ({ thumbnailRaster: thumbnailRasterMock }))

import {
	generateSdkThumb,
	generateVideoThumb,
	generatePdfThumb,
	generateSvgThumb,
	generateRasterThumb,
	rasterizeSvgThumb,
	resetDriveKeyframes,
	warmUploadThumbnail
} from "@/features/drive/lib/thumbGenerators"
import { frameHints, probeRecords } from "@/features/videos/lib/records"
import { rangeReads } from "@/lib/media/rangeReads"
import { testUuid } from "@/tests/support/uuid"

// Captured immediately after import: registerThumbGenerator only ever runs once, as a module-scope
// side effect at import time (see thumbGenerators.ts's own closing comment) — this must be read
// before the beforeEach below's vi.clearAllMocks() has any chance to wipe it.
const registrationCallsAtImport = registerThumbGeneratorMock.mock.calls.slice()

let uuidCounter = 0

function nextUuid(): UuidStr {
	uuidCounter += 1

	return testUuid(`u${uuidCounter.toString()}`)
}

function mockFile(overrides: Partial<SdkFile> = {}): SdkFile {
	return {
		uuid: nextUuid(),
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
			data: { name: "clip.mp4", mime: "video/mp4", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function namedFile(name: string, mime: string, overrides: Partial<SdkFile> = {}): SdkFile {
	return mockFile({
		meta: {
			type: "decoded",
			data: { name, mime, modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	})
}

function itemAsBaseFile(item: DriveItem): BaseFileItem {
	if (item.type !== "file") {
		throw new Error("expected a file item")
	}

	return item
}

function videoItem(): BaseFileItem {
	return itemAsBaseFile(narrowItem(mockFile()))
}

function imageItem(): BaseFileItem {
	return itemAsBaseFile(narrowItem(namedFile("photo.png", "image/png", { canMakeThumbnail: true })))
}

function rawItem(): BaseFileItem {
	return itemAsBaseFile(narrowItem(namedFile("shot.nef", "image/x-nikon-nef", { canMakeThumbnail: true })))
}

function pdfItem(): BaseFileItem {
	return itemAsBaseFile(narrowItem(namedFile("doc.pdf", "application/pdf")))
}

beforeEach(() => {
	vi.clearAllMocks()
	narrowToAnyFileMock.mockImplementation((item: BaseFileItem) => item.data)
	getPreviewBytesMock.mockReturnValue(undefined)
})

describe("registration", () => {
	// The old image and heic arms are gone, both folded into the single sdk arm.
	it("registers sdk/video/pdf/svg/raster generators exactly once, at import", () => {
		expect(registrationCallsAtImport).toEqual([
			["sdk", generateSdkThumb],
			["video", generateVideoThumb],
			["pdf", generatePdfThumb],
			["svg", generateSvgThumb],
			["raster", generateRasterThumb]
		])
	})
})

describe("generateSdkThumb", () => {
	it("asks the SDK for a 384x768 lossy thumbnail of the narrowed file, never downloading bytes itself", async () => {
		const item = imageItem()
		makeSdkThumbnailMock.mockResolvedValue({
			type: "thumbnail",
			bytes: new Uint8Array([1, 2]),
			width: 256,
			height: 170,
			fromEmbeddedPreview: true
		})

		await generateSdkThumb(item, live())

		expect(makeSdkThumbnailMock).toHaveBeenCalledWith(item.data, THUMB_MAX_DIM, THUMB_SDK_MAX_HEIGHT, THUMB_SDK_LOSSY_QUALITY)
		expect(downloadFileBytesMock).not.toHaveBeenCalled()
	})

	it("returns the SDK's bytes on a thumbnail result", async () => {
		makeSdkThumbnailMock.mockResolvedValue({
			type: "thumbnail",
			bytes: new Uint8Array([9, 9]),
			width: 256,
			height: 256,
			fromEmbeddedPreview: false
		})

		await expect(generateSdkThumb(imageItem(), live())).resolves.toEqual({ type: "bytes", bytes: new Uint8Array([9, 9]) })
	})

	it("routes a camera RAW through the same call — there is no separate RAW path", async () => {
		const item = rawItem()
		makeSdkThumbnailMock.mockResolvedValue({
			type: "thumbnail",
			bytes: new Uint8Array([7]),
			width: 256,
			height: 171,
			fromEmbeddedPreview: true
		})

		await expect(generateSdkThumb(item, live())).resolves.toEqual({ type: "bytes", bytes: new Uint8Array([7]) })
		expect(makeSdkThumbnailMock).toHaveBeenCalledWith(item.data, THUMB_MAX_DIM, THUMB_SDK_MAX_HEIGHT, THUMB_SDK_LOSSY_QUALITY)
	})

	// The three byte-less arms are answers about the file's content, not failures — the service keeps
	// them for the session and spends no blacklist strike, so the mapping has to preserve the reason.
	it.each(["unsupported", "overBudget"] as const)("maps a %s verdict to an 'unavailable' result", async type => {
		makeSdkThumbnailMock.mockResolvedValue({ type })

		await expect(generateSdkThumb(imageItem(), live())).resolves.toEqual({ type: "unavailable", reason: type })
	})

	it("maps a corrupt verdict to an 'unavailable' result, dropping the message", async () => {
		makeSdkThumbnailMock.mockResolvedValue({ type: "corrupt", message: "truncated JPEG scan" })

		await expect(generateSdkThumb(imageItem(), live())).resolves.toEqual({ type: "unavailable", reason: "corrupt" })
	})

	// A zero-length buffer claiming to be a thumbnail is a bug somewhere, not a verdict about the file
	// — the blacklist is the right place for it, so it must NOT settle.
	it("treats an empty thumbnail buffer as a transient failure, not a verdict", async () => {
		makeSdkThumbnailMock.mockResolvedValue({
			type: "thumbnail",
			bytes: new Uint8Array(),
			width: 0,
			height: 0,
			fromEmbeddedPreview: false
		})

		await expect(generateSdkThumb(imageItem(), live())).resolves.toEqual({ type: "failed" })
	})

	it("treats a rejected call (dead worker, no client, dropped read) as a transient failure", async () => {
		makeSdkThumbnailMock.mockRejectedValue(new Error("no authenticated client"))

		await expect(generateSdkThumb(imageItem(), live())).resolves.toEqual({ type: "failed" })
	})
})

describe("warmUploadThumbnail", () => {
	function browserFile(name = "photo.png"): File {
		return new File([new Uint8Array([1, 2, 3])], name)
	}

	// Shadows Blob.prototype's `size` getter on the instance — the size gate reads nothing else, and
	// allocating an actual 64 MiB source to prove a byte-count branch would be absurd.
	function sizedFile(name: string, size: number): File {
		const file = browserFile(name)

		Object.defineProperty(file, "size", { value: size })

		return file
	}

	// The item, not just its uuid: a production that throws falls through to the ordinary generation
	// inside the seat, which needs the item it would generate for.
	it("seeds the thumbnail service with the uploaded file's item", () => {
		const uploaded = namedFile("photo.png", "image/png", { canMakeThumbnail: true })

		warmUploadThumbnail(uploaded, browserFile())

		expect(seedThumbnailMock).toHaveBeenCalledTimes(1)
		expect(seedThumbnailMock.mock.calls[0]?.[0]).toEqual(narrowItem(uploaded))
	})

	// The gate is the point at which the SDK's from-stream decode can no longer afford the 384x768 it
	// is asked for, NOT the point at which it refuses: 64 MiB of budget less the whole buffered source
	// must still leave 768^2 * 40 = 22.5 MiB, so 41.5 MiB is the last source that comes back full-size
	// (the bigger request box moved this down from 54 MiB). A warm past it would persist a shrunken
	// thumbnail as the uuid's durable cache entry.
	it("gates the warm at the last source the local decode can still thumbnail at full size", () => {
		const gateBytes = 41.5 * 1024 * 1024

		expect(THUMB_WARM_SIZE_GATE).toBe(BigInt(gateBytes))
		expect(THUMB_WARM_SIZE_GATE).toBeLessThan(THUMB_PDF_READ_MAX)

		warmUploadThumbnail(namedFile("shot.nef", "image/x-nikon-nef", { canMakeThumbnail: true }), sizedFile("shot.nef", gateBytes))

		expect(seedThumbnailMock).toHaveBeenCalledTimes(1)

		warmUploadThumbnail(namedFile("shot2.nef", "image/x-nikon-nef", { canMakeThumbnail: true }), sizedFile("shot2.nef", gateBytes + 1))

		expect(seedThumbnailMock).toHaveBeenCalledTimes(1) // unchanged — the oversize source was skipped
	})

	// The old gate sat at the SDK's source ceiling (64 MiB), which is a refusal point and not a quality
	// one — everything between the two clamps silently.
	it("skips a source the SDK would still buffer but could only thumbnail undersized", () => {
		warmUploadThumbnail(namedFile("big.nef", "image/x-nikon-nef", { canMakeThumbnail: true }), sizedFile("big.nef", 63 * 1024 * 1024))

		expect(seedThumbnailMock).not.toHaveBeenCalled()
	})

	// Gated on thumbnailCategory of the UPLOADED file, which reads the SDK's own canMakeThumbnail —
	// never on a local extension guess.
	it("does nothing when the SDK says it cannot thumbnail the uploaded file", () => {
		warmUploadThumbnail(namedFile("archive.zip", "application/zip"), browserFile("archive.zip"))

		expect(seedThumbnailMock).not.toHaveBeenCalled()
	})

	function seededProduction(): () => Promise<ThumbSeedResult> {
		const produce = seedThumbnailMock.mock.calls[0]?.[1]

		if (produce === undefined) {
			throw new Error("expected a seeded production")
		}

		return produce
	}

	// A video is played from the local file by the drive-side arm's own frame grab. That grab needs a DOM
	// this suite lacks, which is what a decode failure looks like here: settled, since the drive-side
	// arm would grab the same frame from the same bytes, only after downloading them.
	it("leaves a local video the element cannot decode unanswered, for the drive-side keyframe read", async () => {
		allowedMediaContentTypeMock.mockReturnValue("video/x-matroska")
		stubVideoDom(() => 120, [], { errorCode: 4 })

		warmUploadThumbnail(namedFile("film.mkv", "video/x-matroska"), browserFile("film.mkv"))

		await expect(seededProduction()()).resolves.toEqual({ type: "unanswered" })
		expect(probeRequestMock).not.toHaveBeenCalled()
		expect(frameGenerateMock).not.toHaveBeenCalled()
	})

	it("seeds a video from the local file in a generation slot, never streaming it back", async () => {
		allowedMediaContentTypeMock.mockReturnValue("video/mp4")

		warmUploadThumbnail(namedFile("clip.mp4", "video/mp4"), browserFile("clip.mp4"))

		await expect(seededProduction()()).resolves.toEqual({ type: "none" })
		expect(withGenerationSlotMock).toHaveBeenCalledTimes(1)
		expect(withGenerationSlotMock.mock.calls[0]?.[0]).toBe("video")
		expect(previewStreamUrlMock).not.toHaveBeenCalled()
		expect(downloadFileBytesMock).not.toHaveBeenCalled()
	})

	it("leaves a video the drive-side arm would never stream unseeded", () => {
		allowedMediaContentTypeMock.mockReturnValue(null)

		warmUploadThumbnail(namedFile("clip.mp4", "video/mp4"), browserFile("clip.mp4"))

		expect(seedThumbnailMock).not.toHaveBeenCalled()
	})

	it("renders a pdf from the local file's bytes in a generation slot, never downloading it", async () => {
		const file = new File([new Uint8Array([7, 8, 9])], "doc.pdf")

		getDocumentMock.mockImplementation(() => ({ promise: Promise.reject(new Error("broken pdf")), destroy: taskDestroyMock }))

		warmUploadThumbnail(namedFile("doc.pdf", "application/pdf"), file)

		await expect(seededProduction()()).resolves.toEqual({ type: "none" })
		expect(withGenerationSlotMock).toHaveBeenCalledTimes(1)
		expect(withGenerationSlotMock.mock.calls[0]?.[0]).toBe("pdf")
		expect((getDocumentMock.mock.calls[0]?.[0] as { data: Uint8Array }).data).toEqual(new Uint8Array([7, 8, 9]))
		expect(downloadFileBytesMock).not.toHaveBeenCalled()
	})

	// An unreadable local file says nothing about the file, so a joined row still gets the drive-side arm.
	it("leaves a pdf whose local file cannot be read unanswered", async () => {
		const file = browserFile("doc.pdf")

		vi.spyOn(file, "arrayBuffer").mockRejectedValue(new DOMException("gone", "NotReadableError"))

		warmUploadThumbnail(namedFile("doc.pdf", "application/pdf"), file)

		await expect(seededProduction()()).resolves.toEqual({ type: "unanswered" })
		expect(getDocumentMock).not.toHaveBeenCalled()
	})

	it("reads a 100 MiB local pdf through File.slice ranges, within the read budget, never whole", async () => {
		const size = 100 * MIB
		const file = sizedFile("doc.pdf", size)
		const sliced: number[] = []
		const document = Promise.withResolvers<unknown>()

		vi.spyOn(file, "slice").mockImplementation((start = 0, end = size) => {
			sliced.push(end - start)

			return new Blob([new Uint8Array(end - start)])
		})
		const whole = vi.spyOn(file, "arrayBuffer")

		getDocumentMock.mockImplementation(() => ({ promise: document.promise, destroy: taskDestroyMock }))

		warmUploadThumbnail(namedFile("doc.pdf", "application/pdf", { size: BigInt(size) }), file)

		const produced = seededProduction()()

		await vi.waitFor(() => {
			expect(getDocumentMock).toHaveBeenCalledTimes(1)
		})
		const transport = transportOf(0)

		transport.requestDataRange(0, MIB)
		transport.requestDataRange(size - MIB, size)
		await vi.waitFor(() => {
			expect(transport.answered).toEqual([0, size - MIB])
		})
		// Past the budget: settled as a verdict about the file, the document destroyed.
		transport.requestDataRange(MIB, THUMB_PDF_READ_MAX)

		await expect(produced).resolves.toEqual({ type: "none" })
		expect(whole).not.toHaveBeenCalled()
		expect(sliced.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(THUMB_PDF_READ_MAX)
		expect(taskDestroyMock).toHaveBeenCalledTimes(1)
		expect(withGenerationSlotMock.mock.calls[0]?.[0]).toBe("pdf")
	})

	it("leaves a large local pdf unanswered when a range of it cannot be read", async () => {
		const size = 100 * MIB
		const file = sizedFile("doc.pdf", size)
		const unreadable = new Blob([])

		vi.spyOn(unreadable, "arrayBuffer").mockRejectedValue(new DOMException("gone", "NotReadableError"))
		vi.spyOn(file, "slice").mockReturnValue(unreadable)
		getDocumentMock.mockImplementation(() => ({ promise: new Promise(() => undefined), destroy: taskDestroyMock }))

		warmUploadThumbnail(namedFile("doc.pdf", "application/pdf", { size: BigInt(size) }), file)

		const produced = seededProduction()()

		await vi.waitFor(() => {
			expect(getDocumentMock).toHaveBeenCalledTimes(1)
		})
		transportOf(0).requestDataRange(0, MIB)

		await expect(produced).resolves.toEqual({ type: "unanswered" })
		expect(taskDestroyMock).toHaveBeenCalledTimes(1)
	})

	it("the seeded production hands the browser File straight to the SDK, in an image slot, and returns its bytes", async () => {
		const uploaded = namedFile("shot.nef", "image/x-nikon-nef", { canMakeThumbnail: true })
		const file = browserFile("shot.nef")
		makeSdkThumbnailFromFileMock.mockResolvedValue({
			type: "thumbnail",
			bytes: new Uint8Array([5, 5]),
			width: 256,
			height: 171,
			fromEmbeddedPreview: true
		})

		warmUploadThumbnail(uploaded, file)

		const produce = seedThumbnailMock.mock.calls[0]?.[1]

		if (produce === undefined) {
			throw new Error("expected a seeded production")
		}

		await expect(produce()).resolves.toEqual({ type: "bytes", bytes: new Uint8Array([5, 5]) })
		expect(withGenerationSlotMock).toHaveBeenCalledTimes(1)
		expect(withGenerationSlotMock.mock.calls[0]?.[0]).toBe("sdk")
		expect(makeSdkThumbnailFromFileMock).toHaveBeenCalledWith(file, THUMB_MAX_DIM, THUMB_SDK_MAX_HEIGHT, THUMB_SDK_LOSSY_QUALITY)
	})

	// unsupported/corrupt are answers about the bytes, which the drive-side arm sniffs identically — the
	// seat settles them. There is nothing for the ordinary path to add.
	it.each([{ type: "unsupported" } as const, { type: "corrupt", message: "truncated" } as const])(
		"the seeded production settles a $type verdict as 'none'",
		async verdict => {
			makeSdkThumbnailFromFileMock.mockResolvedValue(verdict)

			warmUploadThumbnail(namedFile("photo.png", "image/png", { canMakeThumbnail: true }), browserFile())

			const produce = seedThumbnailMock.mock.calls[0]?.[1]

			if (produce === undefined) {
				throw new Error("expected a seeded production")
			}

			await expect(produce()).resolves.toEqual({ type: "none" })
		}
	)

	// overBudget is NOT an answer about the file: this arm decodes under the budget left after its own
	// whole-source buffer, the drive arm under a near-full one, so a peak that does not fit here can
	// still fit there. Settling it would leave the freshly-uploaded row on a generic icon for its mount.
	it("leaves an overBudget verdict unanswered so the drive-side arm still gets its turn", async () => {
		makeSdkThumbnailFromFileMock.mockResolvedValue({ type: "overBudget" })

		warmUploadThumbnail(namedFile("photo.png", "image/png", { canMakeThumbnail: true }), browserFile())

		const produce = seedThumbnailMock.mock.calls[0]?.[1]

		if (produce === undefined) {
			throw new Error("expected a seeded production")
		}

		await expect(produce()).resolves.toEqual({ type: "unanswered" })
	})

	// An svg is rasterised from the local text, never handed to the SDK. A rejected document is a
	// verdict about its markup, which the drive-side arm would read the same.
	it("seeds an svg from the local file and settles a rejected document as 'none'", async () => {
		warmUploadThumbnail(namedFile("logo.svg", "image/svg+xml"), new File(["<html></html>"], "logo.svg"))

		const produce = seedThumbnailMock.mock.calls[0]?.[1]

		if (produce === undefined) {
			throw new Error("expected a seeded production")
		}

		await expect(produce()).resolves.toEqual({ type: "none" })
		expect(makeSdkThumbnailFromFileMock).not.toHaveBeenCalled()
	})
})

// The branches reachable before an <img> is created; the rasterising itself is proven live (the e2e leg).
describe("rasterizeSvgThumb — refusals (no DOM element ever created)", () => {
	it("refuses a document whose root is not <svg>", async () => {
		await expect(rasterizeSvgThumb("<html><body/></html>")).resolves.toEqual({ type: "unavailable", reason: "unsupported" })
	})

	it("refuses an entity-expansion bomb", async () => {
		const bomb = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;">]><svg>&b;</svg>'

		await expect(rasterizeSvgThumb(bomb)).resolves.toEqual({ type: "unavailable", reason: "unsupported" })
	})

	it("calls an unterminated root tag corrupt", async () => {
		await expect(rasterizeSvgThumb('<svg width="10')).resolves.toEqual({ type: "unavailable", reason: "corrupt" })
	})
})

describe("rasterizeSvgThumb — two renders at a time", () => {
	it("starts a third document's render only once one of the first two has settled", async () => {
		const decodes: { reject: (reason: unknown) => void }[] = []

		vi.stubGlobal(
			"Image",
			class {
				src = ""
				decode(): Promise<void> {
					return new Promise((_resolve, reject) => {
						decodes.push({ reject })
					})
				}
			}
		)
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:svg")
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

		try {
			const svg = '<svg viewBox="0 0 10 10"></svg>'
			const first = rasterizeSvgThumb(svg)
			const second = rasterizeSvgThumb(svg)
			const third = rasterizeSvgThumb(svg)

			await vi.waitFor(() => {
				expect(decodes).toHaveLength(2)
			})
			await Promise.resolve()
			expect(decodes).toHaveLength(2)

			decodes[0]?.reject(new Error("bad"))

			await expect(first).resolves.toEqual({ type: "unavailable", reason: "corrupt" })
			await vi.waitFor(() => {
				expect(decodes).toHaveLength(3)
			})

			decodes[1]?.reject(new Error("bad"))
			decodes[2]?.reject(new Error("bad"))

			await expect(second).resolves.toEqual({ type: "unavailable", reason: "corrupt" })
			await expect(third).resolves.toEqual({ type: "unavailable", reason: "corrupt" })
		} finally {
			vi.unstubAllGlobals()
			vi.restoreAllMocks()
		}
	})
})

describe("generateSvgThumb", () => {
	it("settles a gzipped SVG that is no gzip stream as corrupt, and one inflating past the gate as over budget", async () => {
		const { gzipSync } = await import("node:zlib")
		const item = itemAsBaseFile(narrowItem(namedFile("logo.svgz", "image/svg+xml")))

		downloadFileBytesMock.mockResolvedValue(new TextEncoder().encode("<svg/>"))

		await expect(generateSvgThumb(item, live())).resolves.toEqual({ type: "unavailable", reason: "corrupt" })

		downloadFileBytesMock.mockResolvedValue(new Uint8Array(gzipSync(new Uint8Array(Number(THUMB_SVG_SIZE_GATE) + 1).fill(0x20))))

		await expect(generateSvgThumb(item, live())).resolves.toEqual({ type: "unavailable", reason: "overBudget" })
	})

	it("fails, counting toward the blacklist, when the download fails", async () => {
		downloadFileBytesMock.mockRejectedValue(new Error("network"))

		await expect(generateSvgThumb(itemAsBaseFile(narrowItem(namedFile("logo.svg", "image/svg+xml"))), live())).resolves.toEqual({
			type: "failed"
		})
	})
})

describe("generateRasterThumb", () => {
	// A bare JPEG XL codestream of 1000 × 750 (13-bit height, 4:3).
	const JXL_1000 = Uint8Array.from([0xff, 0x0a, 0x6a, 0x17, 0x03, 0x00])

	function jxlItem(size = 6n): BaseFileItem {
		return itemAsBaseFile(narrowItem(namedFile("photo.jxl", "image/jxl", { size })))
	}

	it("has none, reading nothing, where the browser decodes no JPEG XL", async () => {
		supportsNativeImageMock.mockResolvedValue(false)

		await expect(generateRasterThumb(jxlItem(), live())).resolves.toEqual({ type: "unavailable", reason: "unsupported" })
		expect(downloadFileBytesMock).not.toHaveBeenCalled()
	})

	it("refuses a file above the whole-read limit before reading it", async () => {
		supportsNativeImageMock.mockResolvedValue(true)

		await expect(generateRasterThumb(jxlItem(65n * BigInt(MIB)), live())).resolves.toEqual({
			type: "unavailable",
			reason: "overBudget"
		})
		expect(downloadFileBytesMock).not.toHaveBeenCalled()
	})

	it("draws the header's size in the raster worker", async () => {
		supportsNativeImageMock.mockResolvedValue(true)
		downloadFileBytesMock.mockResolvedValue(JXL_1000.slice())
		thumbnailRasterMock.mockResolvedValue(new Uint8Array([9]))

		await expect(generateRasterThumb(jxlItem(), live())).resolves.toEqual({ type: "bytes", bytes: new Uint8Array([9]) })
		expect(thumbnailRasterMock).toHaveBeenCalledWith(expect.any(Uint8Array), "image/jxl", { width: 1000, height: 750 }, THUMB_MAX_DIM)
	})

	it("draws a JPEG XL turned by its orientation at its upright size", async () => {
		supportsNativeImageMock.mockResolvedValue(true)
		// 1000 × 750 as coded, orientation 6: 750 × 1000 as shown.
		downloadFileBytesMock.mockResolvedValue(Uint8Array.from([0xff, 0x0a, 0x6a, 0x17, 0xb3, 0x40, 0x00, 0x00]))
		thumbnailRasterMock.mockResolvedValue(new Uint8Array([9]))

		await generateRasterThumb(jxlItem(8n), live())

		expect(thumbnailRasterMock).toHaveBeenCalledWith(expect.any(Uint8Array), "image/jxl", { width: 750, height: 1000 }, THUMB_MAX_DIM)
	})

	it("settles bytes that are no JPEG XL, or that the browser cannot decode, as corrupt", async () => {
		supportsNativeImageMock.mockResolvedValue(true)
		downloadFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3]))

		await expect(generateRasterThumb(jxlItem(), live())).resolves.toEqual({ type: "unavailable", reason: "corrupt" })

		downloadFileBytesMock.mockResolvedValue(JXL_1000.slice())
		thumbnailRasterMock.mockRejectedValue(Object.assign(new Error("decode"), { name: "InvalidStateError" }))

		await expect(generateRasterThumb(jxlItem(), live())).resolves.toEqual({ type: "unavailable", reason: "corrupt" })
	})
})

// A browser that plays MP4 but answers Matroska with nothing, as Chrome and Safari do.
function canPlayMp4Only(query: string): string {
	return query === "video/mp4" ? "maybe" : ""
}

function stubCanPlay(): void {
	vi.stubGlobal("document", { createElement: () => ({ canPlayType: canPlayMp4Only }) })
}

function mkvItem(): BaseFileItem {
	return itemAsBaseFile(narrowItem(namedFile("film.mkv", "video/x-matroska")))
}

// Typed as the persisted record holds it.
type RecordedProbe = NonNullable<ProbeRecord["probe"]>

function videoProbe(overrides: Partial<RecordedProbe> = {}): RecordedProbe {
	return {
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
		partial: false,
		...overrides
	}
}

function probeRecord(probe: RecordedProbe | null): ProbeRecord {
	return { probe, tiers: { card: true, full: probe === null, cover: probe === null }, at: 1 }
}

const FRAME_BYTES = new Uint8Array([7, 7])

function keyframeReady(): void {
	probeRequestMock.mockResolvedValue(probeRecord(videoProbe()))
	frameGenerateMock.mockResolvedValue({ bytes: FRAME_BYTES, width: 384, height: 216, dominant: [1, 2, 3] })
	frameHintGetMock.mockResolvedValue(null)
}

describe("generateVideoThumb — routing before any read", () => {
	beforeEach(() => {
		stubCanPlay()
		keyframeReady()
		waitForMediaStreamMock.mockResolvedValue(true)
	})

	it("reads only the keyframe of an MKV the browser cannot play: no stream registration, one probe, one frame", async () => {
		allowedMediaContentTypeMock.mockReturnValue("video/x-matroska")

		const item = mkvItem()
		const signal = live()

		await expect(generateVideoThumb(item, signal)).resolves.toEqual({ type: "bytes", bytes: FRAME_BYTES })
		expect(waitForMediaStreamMock).not.toHaveBeenCalled()
		expect(previewStreamUrlMock).not.toHaveBeenCalled()
		expect(probeRequestMock).toHaveBeenCalledTimes(1)
		expect(probeRequestMock.mock.calls[0]?.[0]).toEqual({ uuid: item.data.uuid, file: item.data })
		expect(probeRequestMock.mock.calls[0]?.[1]).toBe("card")
		expect(probeRequestMock.mock.calls[0]?.[2].signal).toBe(signal)
		expect(frameGenerateMock).toHaveBeenCalledTimes(1)

		const request = frameGenerateMock.mock.calls[0]?.[0]

		expect(request?.target).toEqual({ uuid: item.data.uuid, file: item.data, size: 1_024 })
		expect(request?.box).toEqual({ width: THUMB_MAX_DIM, height: THUMB_MAX_DIM })
		expect(request?.signal).toBe(signal)
	})

	it("reads the keyframe when no worker will ever control the tab", async () => {
		allowedMediaContentTypeMock.mockReturnValue("video/mp4")
		waitForMediaStreamMock.mockResolvedValue(false)

		await expect(generateVideoThumb(videoItem(), live())).resolves.toEqual({ type: "bytes", bytes: FRAME_BYTES })
		expect(previewStreamUrlMock).not.toHaveBeenCalled()
		expect(probeRequestMock).toHaveBeenCalledTimes(1)
		expect(frameGenerateMock).toHaveBeenCalledTimes(1)
	})

	it("reads the keyframe when the item's content type isn't inline-allowlisted", async () => {
		allowedMediaContentTypeMock.mockReturnValue(null)

		await expect(generateVideoThumb(videoItem(), live())).resolves.toEqual({ type: "bytes", bytes: FRAME_BYTES })
		expect(waitForMediaStreamMock).not.toHaveBeenCalled()
		expect(previewStreamUrlMock).not.toHaveBeenCalled()
		expect(frameGenerateMock).toHaveBeenCalledTimes(1)
	})

	it("starts nothing for a generation already unwanted", async () => {
		allowedMediaContentTypeMock.mockReturnValue("video/x-matroska")

		const controller = new AbortController()

		controller.abort()

		await expect(generateVideoThumb(mkvItem(), controller.signal)).resolves.toEqual({ type: "failed" })
		expect(waitForMediaStreamMock).not.toHaveBeenCalled()
		expect(previewStreamUrlMock).not.toHaveBeenCalled()
		expect(probeRequestMock).not.toHaveBeenCalled()
		expect(frameGenerateMock).not.toHaveBeenCalled()
	})

	it("fails when previewStreamUrl itself rejects, without reading the keyframe", async () => {
		allowedMediaContentTypeMock.mockReturnValue("video/mp4")
		previewStreamUrlMock.mockRejectedValue(new Error("registration failed"))

		await expect(generateVideoThumb(videoItem(), live())).resolves.toEqual({ type: "failed" })
		expect(probeRequestMock).not.toHaveBeenCalled()
	})
})

describe("generateVideoThumb — keyframe result mapping", () => {
	beforeEach(() => {
		stubCanPlay()
		keyframeReady()
		allowedMediaContentTypeMock.mockReturnValue("video/x-matroska")
	})

	it("fails when no probe could be had (offline, budgets, a failed read)", async () => {
		probeRequestMock.mockResolvedValue(null)

		await expect(generateVideoThumb(mkvItem(), live())).resolves.toEqual({ type: "failed" })
		expect(frameGenerateMock).not.toHaveBeenCalled()
	})

	it("settles a file that is no container the probe reads", async () => {
		probeRequestMock.mockResolvedValue(probeRecord(null))

		await expect(generateVideoThumb(mkvItem(), live())).resolves.toEqual({ type: "unavailable", reason: "unsupported" })
		expect(frameGenerateMock).not.toHaveBeenCalled()
	})

	it("settles a file whose keyframes cannot be found without scanning, or that has no picture", async () => {
		probeRequestMock.mockResolvedValueOnce(probeRecord(videoProbe({ index: "none" })))
		probeRequestMock.mockResolvedValueOnce(probeRecord(videoProbe({ video: null })))

		await expect(generateVideoThumb(mkvItem(), live())).resolves.toEqual({ type: "unavailable", reason: "unsupported" })
		await expect(generateVideoThumb(mkvItem(), live())).resolves.toEqual({ type: "unavailable", reason: "unsupported" })
		expect(frameGenerateMock).not.toHaveBeenCalled()
	})

	it("settles a frame the generator left a settled miss for", async () => {
		frameGenerateMock.mockResolvedValue(null)
		frameHintGetMock.mockResolvedValue({ recipe: FRAME_RECIPE_VERSION, key: null, miss: "unsupported", at: 1 })

		await expect(generateVideoThumb(mkvItem(), live())).resolves.toEqual({ type: "unavailable", reason: "unsupported" })
	})

	it("fails a frame that came back without a verdict (budget spent, a failed read)", async () => {
		frameGenerateMock.mockResolvedValue(null)

		await expect(generateVideoThumb(mkvItem(), live())).resolves.toEqual({ type: "failed" })
	})

	it("fails a frame dropped because nobody wants it any more, without looking up its hint", async () => {
		const controller = new AbortController()

		frameGenerateMock.mockImplementation(() => {
			controller.abort()

			return Promise.resolve(null)
		})

		await expect(generateVideoThumb(mkvItem(), controller.signal)).resolves.toEqual({ type: "failed" })
		expect(frameHintGetMock).not.toHaveBeenCalled()
	})
})

describe("generateVideoThumb — drive's own keyframe services", () => {
	beforeEach(() => {
		stubCanPlay()
		keyframeReady()
		allowedMediaContentTypeMock.mockReturnValue("video/x-matroska")
	})

	it("builds one probe scheduler and one frame generator for drive, over the shared Videos record stores", async () => {
		await generateVideoThumb(mkvItem(), live())
		await generateVideoThumb(mkvItem(), live())

		expect(built.probes).toHaveLength(1)
		expect(built.frames).toHaveLength(1)
		expect(built.probes[0]?.records).toBe(probeRecords)
		expect(built.frames[0]?.hints).toBe(frameHints)
	})

	it("holds its generation slot through no dwell and no wait for playback to end", async () => {
		await generateVideoThumb(mkvItem(), live())

		const deps = built.frames[0]
		let slept = false
		let idle = false
		const releasePlayback = rangeReads.holdPlayback()

		try {
			void deps?.sleep(FRAME_DWELL_MS, live()).then(() => {
				slept = true
			})
			void deps?.reads.whenPlaybackIdle(live()).then(() => {
				idle = true
			})

			await Promise.resolve()

			expect(slept).toBe(true)
			expect(idle).toBe(true)
		} finally {
			releasePlayback()
		}
	})

	it("resets drive's probes and frames on logout, never the Videos singletons", async () => {
		await generateVideoThumb(mkvItem(), live())

		resetDriveKeyframes()

		await vi.waitFor(() => {
			expect(probeResetMock).toHaveBeenCalledTimes(1)
			expect(frameResetMock).toHaveBeenCalledTimes(1)
		})
	})
})

// A video element whose seeks land at once, and canvases that report the luma of the time drawn. With
// `errorCode` the element errors on load with that MediaError code instead.
function stubVideoDom(
	lumaAt: (time: number) => number,
	events: string[],
	options: { errorCode?: number; videoWidth?: number } = {}
): { seeks: number[] } {
	const seeks: number[] = []

	class FakeVideo {
		muted = false
		playsInline = false
		preload = ""
		duration = 100
		videoWidth = options.videoWidth ?? 1280
		videoHeight = 720
		readyState = 4
		error: { code: number } | null = null
		readonly HAVE_CURRENT_DATA = 2
		private time = 0
		private readonly listeners = new Map<string, () => void>()

		set src(_url: string) {
			setTimeout(() => {
				if (options.errorCode === undefined) {
					this.fire("loadedmetadata")

					return
				}

				this.error = { code: options.errorCode }
				this.fire("error")
			}, 0)
		}

		canPlayType(query: string): string {
			return canPlayMp4Only(query)
		}

		get currentTime(): number {
			return this.time
		}

		set currentTime(time: number) {
			this.time = time
			seeks.push(time)
			setTimeout(() => {
				this.fire("seeked")
			}, 0)
		}

		addEventListener(type: string, listener: () => void): void {
			this.listeners.set(type, listener)
		}

		removeEventListener(type: string): void {
			this.listeners.delete(type)
		}

		removeAttribute(): void {
			events.push("emptied")
		}

		load(): void {
			return undefined
		}

		private fire(type: string): void {
			this.listeners.get(type)?.()
		}
	}

	class FakeCanvas {
		private drawnAt = 0
		readonly width: number
		readonly height: number

		constructor(width: number, height: number) {
			this.width = width
			this.height = height
		}

		getContext() {
			return {
				drawImage: (video: FakeVideo) => {
					this.drawnAt = video.currentTime
				},
				getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4).fill(lumaAt(this.drawnAt)) })
			}
		}

		convertToBlob(): Promise<Blob> {
			return Promise.resolve(new Blob([new Uint8Array([1])], { type: "image/webp" }))
		}
	}

	vi.stubGlobal("document", { createElement: () => new FakeVideo() })
	vi.stubGlobal("OffscreenCanvas", FakeCanvas)

	return { seeks }
}

// The worker's registry answer a MEDIA_ERR_SRC_NOT_SUPPORTED is checked with; any range read fails the test.
function stubStreamStatus(events: string[], answer: "present" | "lost" | "missing" | "unknown" | "never"): void {
	vi.stubGlobal("fetch", () => {
		events.push("range read")

		return Promise.reject(new Error("no range read expected"))
	})
	previewStreamStatusMock.mockImplementation(id => {
		events.push(`status ${id}`)

		return answer === "never" ? new Promise(() => undefined) : Promise.resolve(answer)
	})
}

describe("generateVideoThumb — frame choice", () => {
	beforeEach(() => {
		waitForMediaStreamMock.mockResolvedValue(true)
		allowedMediaContentTypeMock.mockReturnValue("video/mp4")
		previewStreamUrlMock.mockImplementation((_file, _name, _type, id) => Promise.resolve(`/sw/download/${id ?? ""}`))
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("takes the frame one second in, and releases its stream registration once the element is emptied", async () => {
		const events: string[] = []
		const { seeks } = stubVideoDom(() => 120, events)

		releasePreviewStreamMock.mockImplementation(() => {
			events.push("released")
		})

		await expect(generateVideoThumb(videoItem(), live())).resolves.toEqual({ type: "bytes", bytes: new Uint8Array([1]) })
		expect(seeks).toEqual([1])
		expect(releasePreviewStreamMock).toHaveBeenCalledWith(previewStreamUrlMock.mock.calls[0]?.[3])
		// A one-frame registration goes in the worker's transient bucket, so it can never evict a player's.
		expect(previewStreamUrlMock.mock.calls[0]?.[4]).toEqual({ transient: true })
		expect(events).toEqual(["emptied", "released"])
	})

	it("looks once more, a few seconds in, only when the first frame is black, and never far into the file", async () => {
		const dark = stubVideoDom(time => (time === 5 ? 90 : 4), [])

		await generateVideoThumb(videoItem(), live())
		expect(dark.seeks).toEqual([1, 5])

		const allDark = stubVideoDom(() => 2, [])

		await generateVideoThumb(videoItem(), live())
		expect(allDark.seeks).toEqual([1, 5])
	})

	it("releases the registration when the stream fails too", async () => {
		previewStreamUrlMock.mockRejectedValue(new Error("registration failed"))

		await expect(generateVideoThumb(videoItem(), live())).resolves.toEqual({ type: "failed" })
		expect(releasePreviewStreamMock).toHaveBeenCalledTimes(1)
	})

	it("probes nothing when the element draws the frame", async () => {
		stubVideoDom(() => 120, [])

		await generateVideoThumb(videoItem(), live())
		expect(probeRequestMock).not.toHaveBeenCalled()
		expect(frameGenerateMock).not.toHaveBeenCalled()
	})
})

describe("generateVideoThumb — element failures", () => {
	beforeEach(() => {
		waitForMediaStreamMock.mockResolvedValue(true)
		allowedMediaContentTypeMock.mockReturnValue("video/mp4")
		previewStreamUrlMock.mockImplementation((_file, _name, _type, id) => Promise.resolve(`/sw/download/${id ?? ""}`))
		keyframeReady()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	// MEDIA_ERR_DECODE; MEDIA_ERR_SRC_NOT_SUPPORTED while the worker still holds the registration.
	it.each<[number, "present" | "unknown"]>([
		[3, "present"],
		[4, "present"],
		[4, "unknown"]
	])(
		"reads the keyframe once the element cannot decode the stream (MediaError %i, %s), its stream released first",
		async (code, answer) => {
			const events: string[] = []

			stubVideoDom(() => 120, events, { errorCode: code })
			stubStreamStatus(events, answer)
			releasePreviewStreamMock.mockImplementation(id => {
				events.push(`released ${id}`)
			})
			frameGenerateMock.mockImplementation(() => {
				events.push("frame")

				return Promise.resolve({ bytes: FRAME_BYTES, width: 384, height: 216, dominant: [1, 2, 3] })
			})

			await expect(generateVideoThumb(videoItem(), live())).resolves.toEqual({ type: "bytes", bytes: FRAME_BYTES })
			expect(previewStreamUrlMock).toHaveBeenCalledTimes(1)
			expect(probeRequestMock).toHaveBeenCalledTimes(1)
			expect(frameGenerateMock).toHaveBeenCalledTimes(1)

			const id = previewStreamUrlMock.mock.calls[0]?.[3] ?? ""

			// Only the ambiguous code costs the check: the worker's registry, asked while the registration is held,
			// and never a range read of the bytes the element has just fetched.
			expect(events).toEqual(
				code === 4 ? [`status ${id}`, "emptied", `released ${id}`, "frame"] : ["emptied", `released ${id}`, "frame"]
			)
		}
	)

	// MEDIA_ERR_SRC_NOT_SUPPORTED is also a fetch that failed before the metadata: offline, or a registration
	// the worker lost.
	it.each<"missing" | "lost" | "offline">(["missing", "lost", "offline"])(
		"fails without reading the keyframe, and tries the element again, when the stream could not be fetched (%s)",
		async answer => {
			const events: string[] = []

			stubVideoDom(() => 120, events, { errorCode: 4 })
			stubStreamStatus(events, answer === "offline" ? "present" : answer)
			onlineManager.setOnline(answer !== "offline")

			try {
				const item = videoItem()

				await expect(generateVideoThumb(item, live())).resolves.toEqual({ type: "failed" })
				expect(probeRequestMock).not.toHaveBeenCalled()
				expect(frameGenerateMock).not.toHaveBeenCalled()

				await expect(generateVideoThumb(item, live())).resolves.toEqual({ type: "failed" })
				expect(previewStreamUrlMock).toHaveBeenCalledTimes(2)
				expect(events.filter(event => event.startsWith("status"))).toHaveLength(answer === "offline" ? 0 : 2)
				expect(events).not.toContain("range read")
			} finally {
				onlineManager.setOnline(true)
			}
		}
	)

	it("does not hold the element's cleanups on a registry check the generation stopped waiting for", async () => {
		const events: string[] = []
		const controller = new AbortController()

		stubVideoDom(() => 120, events, { errorCode: 4 })
		stubStreamStatus(events, "never")
		previewStreamStatusMock.mockImplementation(() => {
			events.push("status")
			setTimeout(() => {
				controller.abort()
			}, 0)

			return new Promise(() => undefined)
		})
		releasePreviewStreamMock.mockImplementation(() => {
			events.push("released")
		})

		await expect(generateVideoThumb(videoItem(), controller.signal)).resolves.toEqual({ type: "failed" })
		expect(events).toEqual(["status", "emptied", "released"])
		expect(probeRequestMock).not.toHaveBeenCalled()
	})

	it("reads the keyframe when the metadata holds no picture", async () => {
		stubVideoDom(() => 120, [], { videoWidth: 0 })

		await expect(generateVideoThumb(videoItem(), live())).resolves.toEqual({ type: "bytes", bytes: FRAME_BYTES })
		expect(frameGenerateMock).toHaveBeenCalledTimes(1)
	})

	it("skips the element on a retry of a file it could not decode", async () => {
		stubVideoDom(() => 120, [], { errorCode: 3 })
		frameGenerateMock.mockResolvedValue(null)

		const item = videoItem()

		await expect(generateVideoThumb(item, live())).resolves.toEqual({ type: "failed" })
		await expect(generateVideoThumb(item, live())).resolves.toEqual({ type: "failed" })
		expect(previewStreamUrlMock).toHaveBeenCalledTimes(1)
		expect(frameGenerateMock).toHaveBeenCalledTimes(2)
	})

	// A held registration cannot rule out an SDK read that failed in passing (a server error, a rate limit), which
	// raises the same code before the metadata: the keyframe read runs, but the element is not settled out.
	it.each<"present" | "unknown">(["present", "unknown"])(
		"tries the element again on a retry after a MediaError 4 the registry could not pin on the format (%s)",
		async answer => {
			const events: string[] = []

			stubVideoDom(() => 120, events, { errorCode: 4 })
			stubStreamStatus(events, answer)
			frameGenerateMock.mockResolvedValue(null)

			const item = videoItem()

			await expect(generateVideoThumb(item, live())).resolves.toEqual({ type: "failed" })
			await expect(generateVideoThumb(item, live())).resolves.toEqual({ type: "failed" })
			expect(previewStreamUrlMock).toHaveBeenCalledTimes(2)
			expect(frameGenerateMock).toHaveBeenCalledTimes(2)
			expect(events).not.toContain("range read")
		}
	)

	// MEDIA_ERR_ABORTED and MEDIA_ERR_NETWORK: the reads failed, not the format.
	it.each([1, 2])("fails a stream that errored on its reads (MediaError %i) without reading the keyframe", async code => {
		stubVideoDom(() => 120, [], { errorCode: code })

		await expect(generateVideoThumb(videoItem(), live())).resolves.toEqual({ type: "failed" })
		expect(probeRequestMock).not.toHaveBeenCalled()
		expect(frameGenerateMock).not.toHaveBeenCalled()
	})

	it("reads no keyframe once the generation stopped during the element attempt", async () => {
		const controller = new AbortController()

		stubVideoDom(() => 120, [], { errorCode: 3 })
		releasePreviewStreamMock.mockImplementation(() => {
			controller.abort()
		})

		await expect(generateVideoThumb(videoItem(), controller.signal)).resolves.toEqual({ type: "failed" })
		expect(probeRequestMock).not.toHaveBeenCalled()
	})
})

describe("generatePdfThumb", () => {
	it("fails and never imports pdf.js when the download fails", async () => {
		downloadFileBytesMock.mockRejectedValue(new Error("network"))

		await expect(generatePdfThumb(pdfItem(), live())).resolves.toEqual({ type: "failed" })
	})
})

// A large pdf is read by range: every path settles, destroys the document and ends the range source.
describe("generatePdfThumb by range", () => {
	const SIZE = 100 * MIB
	let task: { promise: Promise<unknown>; resolve: (value: unknown) => void; onPassword: unknown }

	function largePdf(): BaseFileItem {
		return itemAsBaseFile(narrowItem(namedFile("doc.pdf", "application/pdf", { size: BigInt(SIZE) })))
	}

	// An opened document whose page 1 never comes (pdf.js waiting on a range it will never be answered).
	const getPageMock = vi.fn(() => new Promise(() => undefined))
	const OPENED = { numPages: 1, getPage: getPageMock }

	beforeEach(() => {
		const opened = Promise.withResolvers<unknown>()

		task = { promise: opened.promise, resolve: opened.resolve, onPassword: null }
		getDocumentMock.mockImplementation(() => Object.assign(task, { destroy: taskDestroyMock }))
		rangeReadMock.mockImplementation((start, end) => Promise.resolve(new Uint8Array(end - start)))
		openOriginRangeSourceMock.mockResolvedValue({
			size: SIZE,
			reader: { readRange: rangeReadMock },
			close: rangeCloseMock
		})
	})

	// Wrapped: an async function returning the generation itself would wait for it to settle.
	async function started(signal: AbortSignal = live()): Promise<{ generation: Promise<unknown> }> {
		const generation = generatePdfThumb(largePdf(), signal)

		await vi.waitFor(() => {
			expect(getDocumentMock).toHaveBeenCalledTimes(1)
		})

		return { generation }
	}

	it("opens the drive file by range on the background read budget, never downloading it", async () => {
		const { generation } = await started()

		expect(openOriginRangeSourceMock.mock.calls[0]?.[0]).toMatchObject({ kind: "file" })
		expect(openOriginRangeSourceMock.mock.calls[0]?.[2]).toEqual({ access: "authed", budget: rangeReads })
		expect(downloadFileBytesMock).not.toHaveBeenCalled()

		task.resolve(OPENED)
		transportOf(0).requestDataRange(SIZE - MIB, SIZE)
		transportOf(0).requestDataRange(0, THUMB_PDF_READ_MAX)

		await expect(generation).resolves.toEqual({ type: "unavailable", reason: "overBudget" })
		expect(rangeReadMock.mock.calls.every(([start, end]) => end - start <= 4 * MIB)).toBe(true)
		expect(taskDestroyMock).toHaveBeenCalledTimes(1)
		expect(rangeCloseMock).toHaveBeenCalledTimes(1)
	})

	it("settles a read over the budget before the document opened as overBudget", async () => {
		const { generation } = await started()

		transportOf(0).requestDataRange(0, THUMB_PDF_READ_MAX + MIB)

		await expect(generation).resolves.toEqual({ type: "unavailable", reason: "overBudget" })
		expect(taskDestroyMock).toHaveBeenCalledTimes(1)
		expect(rangeCloseMock).toHaveBeenCalledTimes(1)
	})

	it("settles a password-protected file as unsupported", async () => {
		const { generation } = await started()

		;(task.onPassword as (update: (password: string) => void, reason: number) => void)(vi.fn(), 1)

		await expect(generation).resolves.toEqual({ type: "unavailable", reason: "unsupported" })
		expect(taskDestroyMock).toHaveBeenCalledTimes(1)
		expect(rangeCloseMock).toHaveBeenCalledTimes(1)
	})

	it("fails on a read that fails after the document opened", async () => {
		const { generation } = await started()

		task.resolve(OPENED)
		await vi.waitFor(() => {
			expect(getPageMock).toHaveBeenCalled()
		})
		rangeReadMock.mockRejectedValue(new Error("network"))
		transportOf(0).requestDataRange(0, MIB)

		await expect(generation).resolves.toEqual({ type: "failed" })
		expect(taskDestroyMock).toHaveBeenCalledTimes(1)
		expect(rangeCloseMock).toHaveBeenCalledTimes(1)
	})

	it("fails once nobody wants the thumbnail any more", async () => {
		const controller = new AbortController()
		const { generation } = await started(controller.signal)

		controller.abort()

		await expect(generation).resolves.toEqual({ type: "failed" })
		expect(taskDestroyMock).toHaveBeenCalledTimes(1)
		expect(rangeCloseMock).toHaveBeenCalledTimes(1)
	})

	it("fails quietly when the document's teardown fails its pending page once nobody wants it", async () => {
		const page = Promise.withResolvers<never>()
		const controller = new AbortController()
		const warn = vi.spyOn(log, "warn")

		page.promise.catch(() => undefined)
		taskDestroyMock.mockImplementationOnce(() => {
			page.reject(new Error("Worker was destroyed"))

			return Promise.resolve()
		})

		const { generation } = await started(controller.signal)

		task.resolve({ numPages: 1, getPage: () => page.promise })
		await vi.waitFor(() => {
			expect(transportOf(0)).toBeDefined()
		})
		controller.abort()

		await expect(generation).resolves.toEqual({ type: "failed" })
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(warn).not.toHaveBeenCalledWith("thumb-generators", "renderPdfThumb: render failed", expect.anything(), expect.anything())
		expect(recoverIfNewerBuildMock).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it("reads a large pdf a preview holds by range from those bytes, never copying them whole", async () => {
		const held = new Uint8Array(5 * MIB).fill(9)

		getPreviewBytesMock.mockReturnValue(held)

		const { generation } = await started()
		const params = getDocumentMock.mock.calls[0]?.[0] as { data?: unknown; range?: unknown }

		expect(params.data).toBeUndefined()
		expect(params.range).toBeDefined()
		expect(openOriginRangeSourceMock).not.toHaveBeenCalled()
		expect(downloadFileBytesMock).not.toHaveBeenCalled()

		transportOf(0).requestDataRange(0, MIB)
		await vi.waitFor(() => {
			expect(transportOf(0).answered).toEqual([0])
		})
		task.resolve(OPENED)
		transportOf(0).requestDataRange(0, THUMB_PDF_READ_MAX)
		await expect(generation).resolves.toEqual({ type: "unavailable", reason: "overBudget" })
		expect(held.every(byte => byte === 9)).toBe(true)
	})

	it("fails without opening pdf.js when the range source cannot be opened", async () => {
		openOriginRangeSourceMock.mockRejectedValue(new Error("no session"))

		await expect(generatePdfThumb(largePdf(), live())).resolves.toEqual({ type: "failed" })
		expect(getDocumentMock).not.toHaveBeenCalled()
	})
})

describe("whole-file generators — stopping and reuse", () => {
	// Past half its bytes a download finishes anyway; the worker makes that call, against the token.
	it("asks the worker to stop an early download once nobody wants the thumbnail", async () => {
		const download = Promise.withResolvers<Uint8Array>()
		const controller = new AbortController()

		downloadFileBytesMock.mockReturnValue(download.promise)

		const attempt = generatePdfThumb(pdfItem(), controller.signal)

		controller.abort()

		const token = downloadFileBytesMock.mock.calls[0]?.[1]

		expect(cancelPreviewDownloadIfEarlyMock).toHaveBeenCalledWith(token, 0.5)
		download.reject(new Error("aborted"))
		await expect(attempt).resolves.toEqual({ type: "failed" })
	})

	it("never starts a download for a generation already unwanted", async () => {
		const controller = new AbortController()

		controller.abort()

		await expect(generatePdfThumb(pdfItem(), controller.signal)).resolves.toEqual({ type: "failed" })
		expect(downloadFileBytesMock).not.toHaveBeenCalled()
	})

	it("uses the bytes a preview already holds instead of downloading", async () => {
		const held = new Uint8Array([1, 2, 3])

		getPreviewBytesMock.mockReturnValue(held)
		getDocumentMock.mockImplementation(() => ({ promise: Promise.reject(new Error("broken pdf")), destroy: taskDestroyMock }))

		await generatePdfThumb(pdfItem(), live())

		const data = (getDocumentMock.mock.calls[0]?.[0] as { data: Uint8Array }).data

		expect(downloadFileBytesMock).not.toHaveBeenCalled()
		// pdf.js transfers what it is handed: the preview's buffer must stay intact.
		expect(data).toEqual(held)
		expect(data).not.toBe(held)
	})
})

describe("generatePdfThumb worker", () => {
	beforeEach(() => {
		downloadFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
		getDocumentMock.mockImplementation(() => ({ promise: Promise.reject(new Error("broken pdf")), destroy: taskDestroyMock }))
	})

	it("hands every generation the same pdf.js worker, and each task tears down only its own document", async () => {
		await expect(generatePdfThumb(pdfItem(), live())).resolves.toEqual({ type: "failed" })
		await expect(generatePdfThumb(pdfItem(), live())).resolves.toEqual({ type: "failed" })

		const workers = getDocumentMock.mock.calls.map(([params]) => (params as { worker: unknown }).worker)

		expect(workers).toHaveLength(2)
		expect(workers[0]).toBeDefined()
		expect(workers[1]).toBe(workers[0])
		expect(taskDestroyMock).toHaveBeenCalledTimes(2)
		expect(pdfWorkerDestroyMock).not.toHaveBeenCalled()
	})
})
