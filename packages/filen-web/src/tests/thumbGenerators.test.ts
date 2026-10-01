import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type BaseFileItem, type DriveItem } from "@/features/drive/lib/item"
import { type ThumbGeneratorCategory, type ThumbGenerator, type ThumbSeedResult } from "@/features/drive/lib/thumbnails"
import {
	THUMB_MAX_DIM,
	THUMB_SDK_MAX_HEIGHT,
	THUMB_SDK_LOSSY_QUALITY,
	THUMB_SIZE_GATE,
	THUMB_WARM_SIZE_GATE
} from "@/features/drive/lib/thumbnails.logic"
import type { SdkThumbnailResult } from "@/workers/sdk.worker"

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
	withGenerationSlotMock: vi.fn(<T>(produce: () => Promise<T>) => produce())
}))

vi.mock("@/features/drive/lib/thumbnails", () => ({
	registerThumbGenerator: registerThumbGeneratorMock,
	seedThumbnail: seedThumbnailMock,
	withGenerationSlot: withGenerationSlotMock
}))

const { downloadFileBytesMock, makeSdkThumbnailMock, makeSdkThumbnailFromFileMock } = vi.hoisted(() => ({
	downloadFileBytesMock: vi.fn<(file: unknown, token: string) => Promise<Uint8Array>>(),
	makeSdkThumbnailMock:
		vi.fn<(file: unknown, maxWidth: number, maxHeight: number, lossyQuality: number) => Promise<SdkThumbnailResult>>(),
	makeSdkThumbnailFromFileMock:
		vi.fn<(file: File, maxWidth: number, maxHeight: number, lossyQuality: number) => Promise<SdkThumbnailResult>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		downloadFileBytes: downloadFileBytesMock,
		makeSdkThumbnail: makeSdkThumbnailMock,
		makeSdkThumbnailFromFile: makeSdkThumbnailFromFileMock
	}
}))

const { narrowToAnyFileMock } = vi.hoisted(() => ({ narrowToAnyFileMock: vi.fn((item: BaseFileItem) => item.data) }))

vi.mock("@/features/drive/lib/download", () => ({ narrowToAnyFile: narrowToAnyFileMock }))

const { waitForMediaStreamMock, previewStreamUrlMock } = vi.hoisted(() => ({
	waitForMediaStreamMock: vi.fn<() => Promise<boolean>>(),
	previewStreamUrlMock: vi.fn<(file: unknown, name: string, contentType: string) => Promise<string>>()
}))

vi.mock("@/features/preview/lib/previewStream", () => ({
	waitForMediaStream: waitForMediaStreamMock,
	previewStreamUrl: previewStreamUrlMock
}))

const { allowedMediaContentTypeMock } = vi.hoisted(() => ({ allowedMediaContentTypeMock: vi.fn<(item: DriveItem) => string | null>() }))

vi.mock("@/features/preview/lib/mediaType", () => ({ allowedMediaContentType: allowedMediaContentTypeMock }))

// A stand-in pdf.js whose documents fail to open, which is all the worker-sharing branch needs: the
// worker handed to getDocument and each task's teardown are observable without a DOM.
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
	getDocument: getDocumentMock
}))

import {
	generateSdkThumb,
	generateVideoThumb,
	generatePdfThumb,
	generateSvgThumb,
	rasterizeSvgThumb,
	warmUploadThumbnail
} from "@/features/drive/lib/thumbGenerators"
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
})

describe("registration", () => {
	// The old image and heic arms are gone, both folded into the single sdk arm.
	it("registers sdk/video/pdf/svg generators exactly once, at import", () => {
		expect(registrationCallsAtImport).toEqual([
			["sdk", generateSdkThumb],
			["video", generateVideoThumb],
			["pdf", generatePdfThumb],
			["svg", generateSvgThumb]
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

		await generateSdkThumb(item)

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

		await expect(generateSdkThumb(imageItem())).resolves.toEqual({ type: "bytes", bytes: new Uint8Array([9, 9]) })
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

		await expect(generateSdkThumb(item)).resolves.toEqual({ type: "bytes", bytes: new Uint8Array([7]) })
		expect(makeSdkThumbnailMock).toHaveBeenCalledWith(item.data, THUMB_MAX_DIM, THUMB_SDK_MAX_HEIGHT, THUMB_SDK_LOSSY_QUALITY)
	})

	// The three byte-less arms are answers about the file's content, not failures — the service keeps
	// them for the session and spends no blacklist strike, so the mapping has to preserve the reason.
	it.each(["unsupported", "overBudget"] as const)("maps a %s verdict to an 'unavailable' result", async type => {
		makeSdkThumbnailMock.mockResolvedValue({ type })

		await expect(generateSdkThumb(imageItem())).resolves.toEqual({ type: "unavailable", reason: type })
	})

	it("maps a corrupt verdict to an 'unavailable' result, dropping the message", async () => {
		makeSdkThumbnailMock.mockResolvedValue({ type: "corrupt", message: "truncated JPEG scan" })

		await expect(generateSdkThumb(imageItem())).resolves.toEqual({ type: "unavailable", reason: "corrupt" })
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

		await expect(generateSdkThumb(imageItem())).resolves.toEqual({ type: "failed" })
	})

	it("treats a rejected call (dead worker, no client, dropped read) as a transient failure", async () => {
		makeSdkThumbnailMock.mockRejectedValue(new Error("no authenticated client"))

		await expect(generateSdkThumb(imageItem())).resolves.toEqual({ type: "failed" })
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
		expect(THUMB_WARM_SIZE_GATE).toBeLessThan(THUMB_SIZE_GATE)

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
	it("seeds a video from the local file in a generation slot, never streaming it back", async () => {
		allowedMediaContentTypeMock.mockReturnValue("video/mp4")

		warmUploadThumbnail(namedFile("clip.mp4", "video/mp4"), browserFile("clip.mp4"))

		await expect(seededProduction()()).resolves.toEqual({ type: "none" })
		expect(withGenerationSlotMock).toHaveBeenCalledTimes(1)
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

	it("skips a pdf over the whole-buffer gate", () => {
		warmUploadThumbnail(namedFile("doc.pdf", "application/pdf", { size: THUMB_SIZE_GATE + 1n }), browserFile("doc.pdf"))

		expect(seedThumbnailMock).not.toHaveBeenCalled()
	})

	it("the seeded production hands the browser File straight to the SDK and returns its bytes", async () => {
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

describe("rasterizeSvgThumb — one render at a time", () => {
	it("starts a second document's render only once the first has settled", async () => {
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

			await vi.waitFor(() => {
				expect(decodes).toHaveLength(1)
			})
			await Promise.resolve()
			expect(decodes).toHaveLength(1)

			decodes[0]?.reject(new Error("bad"))

			await expect(first).resolves.toEqual({ type: "unavailable", reason: "corrupt" })
			await vi.waitFor(() => {
				expect(decodes).toHaveLength(2)
			})

			decodes[1]?.reject(new Error("bad"))

			await expect(second).resolves.toEqual({ type: "unavailable", reason: "corrupt" })
		} finally {
			vi.unstubAllGlobals()
			vi.restoreAllMocks()
		}
	})
})

describe("generateSvgThumb", () => {
	it("fails, counting toward the blacklist, when the download fails", async () => {
		downloadFileBytesMock.mockRejectedValue(new Error("network"))

		await expect(generateSvgThumb(itemAsBaseFile(narrowItem(namedFile("logo.svg", "image/svg+xml"))))).resolves.toEqual({
			type: "failed"
		})
	})
})

describe("generateVideoThumb — early gates (no DOM element ever created)", () => {
	it("fails without calling previewStreamUrl when no worker will ever control the tab", async () => {
		waitForMediaStreamMock.mockResolvedValue(false)

		await expect(generateVideoThumb(videoItem())).resolves.toEqual({ type: "failed" })
		expect(previewStreamUrlMock).not.toHaveBeenCalled()
	})

	it("fails without calling previewStreamUrl when the item's content type isn't inline-allowlisted", async () => {
		waitForMediaStreamMock.mockResolvedValue(true)
		allowedMediaContentTypeMock.mockReturnValue(null)

		await expect(generateVideoThumb(videoItem())).resolves.toEqual({ type: "failed" })
		expect(previewStreamUrlMock).not.toHaveBeenCalled()
	})

	it("fails when previewStreamUrl itself rejects, before any DOM element is created", async () => {
		waitForMediaStreamMock.mockResolvedValue(true)
		allowedMediaContentTypeMock.mockReturnValue("video/mp4")
		previewStreamUrlMock.mockRejectedValue(new Error("registration failed"))

		await expect(generateVideoThumb(videoItem())).resolves.toEqual({ type: "failed" })
	})
})

describe("generatePdfThumb", () => {
	it("fails and never imports pdf.js when the download fails", async () => {
		downloadFileBytesMock.mockRejectedValue(new Error("network"))

		await expect(generatePdfThumb(pdfItem())).resolves.toEqual({ type: "failed" })
	})
})

describe("generatePdfThumb worker", () => {
	beforeEach(() => {
		downloadFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
		getDocumentMock.mockImplementation(() => ({ promise: Promise.reject(new Error("broken pdf")), destroy: taskDestroyMock }))
	})

	it("hands every generation the same pdf.js worker, and each task tears down only its own document", async () => {
		await expect(generatePdfThumb(pdfItem())).resolves.toEqual({ type: "failed" })
		await expect(generatePdfThumb(pdfItem())).resolves.toEqual({ type: "failed" })

		const workers = getDocumentMock.mock.calls.map(([params]) => (params as { worker: unknown }).worker)

		expect(workers).toHaveLength(2)
		expect(workers[0]).toBeDefined()
		expect(workers[1]).toBe(workers[0])
		expect(taskDestroyMock).toHaveBeenCalledTimes(2)
		expect(pdfWorkerDestroyMock).not.toHaveBeenCalled()
	})
})
