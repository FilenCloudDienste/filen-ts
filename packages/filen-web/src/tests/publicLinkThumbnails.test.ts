import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File as SdkFile } from "@filen/sdk-rs"
import { narrowItem, type BaseFileItem } from "@/features/drive/lib/item"
import type { ThumbGeneratorCategory } from "@/features/drive/lib/thumbnails"
import type { SdkThumbnailResult } from "@/workers/sdk.worker"
import type { ProbeServiceDeps } from "@/features/videos/lib/probeService"
import type { FrameGeneratorDeps } from "@/features/videos/lib/frames"
import { testUuid } from "@/tests/support/uuid"
import { encodePsd } from "@/tests/support/psdBytes"
import { dosEps } from "@/tests/support/epsBytes"
import { encodeTiff } from "@/tests/support/tiffBytes"

// A public directory link's thumbnail source: every category the drive makes, through the drive's own generators,
// with every read going to the public-link client's anonymous worker calls and none to the session's. The boundaries
// are those of thumbGenerators.test.ts.

const THUMB: SdkThumbnailResult = { type: "thumbnail", bytes: new Uint8Array([7]), width: 1, height: 1, fromEmbeddedPreview: false }

const { sdk } = vi.hoisted(() => ({
	sdk: {
		// The session client's reads, none of which a link's generation may reach.
		downloadFileBytes: vi.fn(),
		readFileBytesRange: vi.fn(),
		readVideoProbe: vi.fn(),
		openRangePort: vi.fn(),
		makeSdkThumbnail: vi.fn(),
		makeSdkThumbnailFromFile: vi.fn(),
		// The public-link client's.
		downloadLinkedFileBytesAnon: vi.fn<(file: unknown, token: string) => Promise<Uint8Array>>(),
		readLinkedFileBytesRangeAnon: vi.fn<(file: unknown, start: number, end: number, token: string) => Promise<Uint8Array>>(),
		readLinkedVideoProbeAnon: vi.fn(),
		openLinkedRangePortAnon: vi.fn(() => Promise.resolve()),
		makeLinkedSdkThumbnailAnon: vi.fn<(...args: unknown[]) => Promise<SdkThumbnailResult>>(),
		makeLinkedSdkThumbnailFromFileAnon: vi.fn<(file: File, ...rest: number[]) => Promise<SdkThumbnailResult>>(),
		cancelPreviewDownload: vi.fn(),
		cancelPreviewDownloadIfEarly: vi.fn(),
		cancelPreviewDownloadUnlessFinishing: vi.fn()
	}
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/features/drive/lib/thumbnails", () => ({
	registerThumbGenerator: vi.fn(),
	seedThumbnail: vi.fn(),
	withGenerationSlot: vi.fn(),
	defaultThumbnailDeps: {}
}))
vi.mock("@/features/publicLinks/lib/thumbCache", () => ({
	readLinkThumbnail: vi.fn(),
	storeLinkThumbnail: vi.fn(),
	deleteLinkThumbnail: vi.fn()
}))
vi.mock("@/features/drive/lib/download", () => ({ narrowToAnyFile: (item: BaseFileItem) => item.data }))

const { previewStreamUrlMock, waitForMediaStreamMock, allowedMediaContentTypeMock, getPreviewBytesMock } = vi.hoisted(() => ({
	previewStreamUrlMock: vi.fn<(...args: unknown[]) => Promise<string>>(),
	waitForMediaStreamMock: vi.fn<() => Promise<boolean>>(),
	allowedMediaContentTypeMock: vi.fn<() => string | null>(),
	getPreviewBytesMock: vi.fn<(scope: string | null, uuid: string) => Uint8Array | undefined>()
}))

vi.mock("@/features/preview/lib/previewStream", () => ({
	waitForMediaStream: waitForMediaStreamMock,
	previewStreamUrl: previewStreamUrlMock,
	releasePreviewStream: vi.fn(),
	previewStreamStatus: vi.fn(),
	previewStreamIdOf: (url: string) => url
}))
vi.mock("@/features/preview/lib/mediaType", () => ({ allowedMediaContentType: allowedMediaContentTypeMock }))
vi.mock("@/features/preview/lib/previewCache", () => ({ getPreviewBytes: getPreviewBytesMock }))

const { built, probeRequestMock, records } = vi.hoisted(() => ({
	built: { probes: [] as ProbeServiceDeps[], frames: [] as FrameGeneratorDeps[] },
	probeRequestMock: vi.fn(() => Promise.resolve(null)),
	records: { linkProbeRecords: { link: "probes" }, linkFrameHints: { link: "hints" } }
}))

vi.mock("@/features/videos/lib/probeService", () => ({
	ProbeService: class {
		public readonly request = probeRequestMock

		public constructor(deps: ProbeServiceDeps) {
			built.probes.push(deps)
		}
	}
}))
vi.mock("@/features/videos/lib/frames", () => ({
	FrameGenerator: class {
		public readonly generate = vi.fn()

		public constructor(deps: FrameGeneratorDeps) {
			built.frames.push(deps)
		}
	}
}))
vi.mock("@/features/videos/lib/records", () => ({ ...records, frameHints: {}, probeRecords: {} }))
vi.mock("@/features/videos/workers/frame.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	PDFWorker: vi.fn(),
	PDFDataRangeTransport: vi.fn(),
	getDocument: vi.fn()
}))

const { openOriginRangeSourceMock, runContentSniffMock, supportsNativeImageMock, thumbnailRasterMock } = vi.hoisted(() => ({
	openOriginRangeSourceMock: vi.fn<(...args: unknown[]) => Promise<never>>(),
	runContentSniffMock: vi.fn<(...args: unknown[]) => Promise<string>>(),
	supportsNativeImageMock: vi.fn<() => Promise<boolean>>(),
	thumbnailRasterMock: vi.fn<() => Promise<Uint8Array>>()
}))

vi.mock("@/features/preview/lib/origin/rangeSource", () => ({ openOriginRangeSource: openOriginRangeSourceMock }))
vi.mock("@/features/preview/lib/contentSniff", () => ({ runContentSniff: runContentSniffMock }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild: vi.fn() }))
vi.mock("@/lib/nativeImageSupport", () => ({ supportsNativeImage: supportsNativeImageMock }))
vi.mock("@/features/drive/lib/thumbRaster", () => ({ thumbnailRaster: thumbnailRasterMock }))

import { LINK_THUMBNAIL_SOURCE } from "@/features/publicLinks/lib/thumbnails"

const CATEGORIES: ThumbGeneratorCategory[] = ["sdk", "video", "pdf", "svg", "raster", "psd", "illustrator", "eps"]

let counter = 0

function fileItem(name: string, mime: string, size: number): BaseFileItem {
	counter += 1

	const file: SdkFile = {
		uuid: testUuid(`l${counter.toString()}`),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: BigInt(size),
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name, mime, modified: 1_700_000_000_000n, size: BigInt(size), key: "key", version: 2 } }
	}
	const item = narrowItem(file)

	if (item.type !== "file") {
		throw new Error("expected a file item")
	}

	return item
}

function generator(category: ThumbGeneratorCategory) {
	const generate = LINK_THUMBNAIL_SOURCE.deps?.getGenerator(category)

	if (generate === undefined) {
		throw new Error(`no ${category} generator`)
	}

	return generate
}

function live(): AbortSignal {
	return new AbortController().signal
}

function serveRanges(bytes: Uint8Array): void {
	sdk.readLinkedFileBytesRangeAnon.mockImplementation((_file, start, end) => Promise.resolve(bytes.slice(start, end)))
}

function expectNoSessionRead(): void {
	for (const call of [
		sdk.downloadFileBytes,
		sdk.readFileBytesRange,
		sdk.readVideoProbe,
		sdk.openRangePort,
		sdk.makeSdkThumbnail,
		sdk.makeSdkThumbnailFromFile
	]) {
		expect(call).not.toHaveBeenCalled()
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	getPreviewBytesMock.mockReturnValue(undefined)
	sdk.makeLinkedSdkThumbnailAnon.mockResolvedValue(THUMB)
	sdk.makeLinkedSdkThumbnailFromFileAnon.mockResolvedValue(THUMB)
})

describe("LINK_THUMBNAIL_SOURCE", () => {
	it("produces every category the drive does, each with a generator", () => {
		for (const category of CATEGORIES) {
			expect(LINK_THUMBNAIL_SOURCE.produces(category)).toBe(true)
			expect(LINK_THUMBNAIL_SOURCE.deps?.getGenerator(category)).toBeTypeOf("function")
		}
	})

	it("serves what it generated from the bytes in hand rather than reading its sealed copy back", () => {
		expect(LINK_THUMBNAIL_SOURCE.deps?.readBackStored).toBe(false)
	})

	it("decodes an image through the public-link client", async () => {
		await expect(generator("sdk")(fileItem("photo.png", "image/png", 1024), live())).resolves.toEqual({
			type: "bytes",
			bytes: THUMB.bytes
		})
		expect(sdk.makeLinkedSdkThumbnailAnon).toHaveBeenCalledOnce()
		expectNoSessionRead()
	})

	it("reads an svg whole through the public-link client, reusing no bytes of the drive's previews", async () => {
		sdk.downloadLinkedFileBytesAnon.mockRejectedValue(new Error("network"))

		await expect(generator("svg")(fileItem("logo.svg", "image/svg+xml", 1024), live())).resolves.toEqual({ type: "failed" })
		expect(sdk.downloadLinkedFileBytesAnon).toHaveBeenCalledOnce()
		expect(getPreviewBytesMock.mock.calls.every(([scope]) => scope === null)).toBe(true)
		expectNoSessionRead()
	})

	it("reads a JPEG XL through the public-link client", async () => {
		supportsNativeImageMock.mockResolvedValue(true)
		sdk.downloadLinkedFileBytesAnon.mockResolvedValue(Uint8Array.from([0xff, 0x0a, 0x6a, 0x17, 0x03, 0x00]))
		thumbnailRasterMock.mockResolvedValue(new Uint8Array([9]))

		await expect(generator("raster")(fileItem("photo.jxl", "image/jxl", 6), live())).resolves.toEqual({
			type: "bytes",
			bytes: new Uint8Array([9])
		})
		expectNoSessionRead()
	})

	it("reads a Photoshop file's embedded JPEG by range and decodes it, both through the public-link client", async () => {
		const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])
		const file = encodePsd(400, 300, { thumbnail: { id: 1036, jpeg } })

		serveRanges(file)

		await expect(generator("psd")(fileItem("art.psd", "image/vnd.adobe.photoshop", file.length), live())).resolves.toEqual({
			type: "bytes",
			bytes: THUMB.bytes
		})
		expect(sdk.readLinkedFileBytesRangeAnon).toHaveBeenCalledOnce()
		expect(sdk.makeLinkedSdkThumbnailFromFileAnon.mock.calls[0]?.[0].type).toBe("image/jpeg")
		expectNoSessionRead()
	})

	it("reads an EPS file's TIFF preview by range and decodes it through the public-link client", async () => {
		const file = dosEps(encodeTiff([{ width: 4, height: 2, rgb: [1, 2, 3] }]))

		serveRanges(file)

		await expect(generator("eps")(fileItem("figure.eps", "application/postscript", file.length), live())).resolves.toEqual({
			type: "bytes",
			bytes: THUMB.bytes
		})
		expect(sdk.makeLinkedSdkThumbnailFromFileAnon.mock.calls[0]?.[0].type).toBe("image/tiff")
		expectNoSessionRead()
	})

	it("sniffs an Illustrator file as a linked file, under the public-link client", async () => {
		runContentSniffMock.mockResolvedValue("notPdfCompatible")

		await expect(generator("illustrator")(fileItem("logo.ai", "application/illustrator", 1024), live())).resolves.toEqual({
			type: "unavailable",
			reason: "unsupported"
		})
		expect(runContentSniffMock.mock.calls[0]?.[1]).toMatchObject({ kind: "linkedFile" })
		expect(runContentSniffMock.mock.calls[0]?.[3]).toMatchObject({ access: "anon", scope: null })
		expectNoSessionRead()
	})

	it("reads a small pdf whole and a large one by range, both through the public-link client", async () => {
		sdk.downloadLinkedFileBytesAnon.mockRejectedValue(new Error("network"))
		openOriginRangeSourceMock.mockRejectedValue(new Error("network"))

		await expect(generator("pdf")(fileItem("doc.pdf", "application/pdf", 1024), live())).resolves.toEqual({ type: "failed" })
		expect(sdk.downloadLinkedFileBytesAnon).toHaveBeenCalledOnce()

		await expect(generator("pdf")(fileItem("big.pdf", "application/pdf", 100 * 1024 * 1024), live())).resolves.toEqual({
			type: "failed"
		})
		expect(openOriginRangeSourceMock.mock.calls[0]?.[0]).toMatchObject({ kind: "linkedFile" })
		expect(openOriginRangeSourceMock.mock.calls[0]?.[2]).toMatchObject({ access: "anon" })
		expectNoSessionRead()
	})

	it("streams a video through the public-link client's route", async () => {
		vi.stubGlobal("document", { createElement: () => ({ canPlayType: () => "maybe" }) })
		allowedMediaContentTypeMock.mockReturnValue("video/mp4")
		waitForMediaStreamMock.mockResolvedValue(true)
		previewStreamUrlMock.mockRejectedValue(new Error("no worker"))

		await expect(generator("video")(fileItem("clip.mp4", "video/mp4", 1024), live())).resolves.toEqual({ type: "failed" })
		expect(previewStreamUrlMock.mock.calls[0]?.[4]).toEqual({ transient: true, access: "anon" })
		vi.unstubAllGlobals()
	})

	it("reads a video's keyframe with its own services: the public-link client's probe and ranges, records kept in memory", async () => {
		vi.stubGlobal("VideoDecoder", {})
		allowedMediaContentTypeMock.mockReturnValue(null)

		const item = fileItem("film.mkv", "video/x-matroska", 1024)

		await expect(generator("video")(item, live())).resolves.toEqual({ type: "failed" })
		expect(probeRequestMock).toHaveBeenCalledOnce()

		const probes = built.probes.at(-1)
		const frames = built.frames.at(-1)

		expect(probes?.records).toBe(records.linkProbeRecords)
		expect(frames?.hints).toBe(records.linkFrameHints)

		await probes?.readProbe(item.data, item.data.uuid, "card", "t1")
		expect(sdk.readLinkedVideoProbeAnon).toHaveBeenCalledWith(item.data, "card", "t1")

		await frames?.openPort(item.data, "t2")
		expect(sdk.openLinkedRangePortAnon).toHaveBeenCalledOnce()
		expectNoSessionRead()
		vi.unstubAllGlobals()
	})
})
