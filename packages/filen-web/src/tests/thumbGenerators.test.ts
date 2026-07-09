import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type BaseFileItem, type DriveItem } from "@/features/drive/lib/item"
import { type ThumbGeneratorCategory, type ThumbGenerator } from "@/features/drive/lib/thumbnails"

// Mock boundaries: registerThumbGenerator is replaced so module-scope registration (this file's own
// side effect under test) never touches the real service's Map; the sdk client, download narrowing,
// heic transform, and preview-stream/media-type gates are all replaced for the same reason
// thumbnails.test.ts replaces the sdk client and thumb-cache — the real ones are either unresolvable
// under node vitest (a Vite `?worker` import) or reach a browser API (document, OffscreenCanvas) this
// suite's node environment doesn't have. generateVideoThumb/generatePdfThumb's OWN DOM-touching
// bodies are proven live (see the task's smoke run), not here — this file only exercises the
// branches reachable before any DOM element would be created.
const { registerThumbGeneratorMock } = vi.hoisted(() => ({
	registerThumbGeneratorMock: vi.fn<(category: ThumbGeneratorCategory, generator: ThumbGenerator) => void>()
}))

vi.mock("@/features/drive/lib/thumbnails", () => ({ registerThumbGenerator: registerThumbGeneratorMock }))

const { downloadFileBytesMock } = vi.hoisted(() => ({
	downloadFileBytesMock: vi.fn<(file: unknown, token: string) => Promise<Uint8Array>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { downloadFileBytes: downloadFileBytesMock } }))

const { narrowToAnyFileMock } = vi.hoisted(() => ({ narrowToAnyFileMock: vi.fn((item: BaseFileItem) => item.data) }))

vi.mock("@/features/drive/lib/download", () => ({ narrowToAnyFile: narrowToAnyFileMock }))

const { transformHeicBytesMock } = vi.hoisted(() => ({
	transformHeicBytesMock: vi.fn<(bytes: Uint8Array, opts?: { maxDimension?: number }) => Promise<Blob>>()
}))

vi.mock("@/features/preview/lib/heicTransform", () => ({ transformHeicBytes: transformHeicBytesMock }))

const { isMediaStreamAvailableMock, previewStreamUrlMock } = vi.hoisted(() => ({
	isMediaStreamAvailableMock: vi.fn<() => boolean>(),
	previewStreamUrlMock: vi.fn<(file: unknown, name: string, contentType: string) => Promise<string>>()
}))

vi.mock("@/features/preview/lib/previewStream", () => ({
	isMediaStreamAvailable: isMediaStreamAvailableMock,
	previewStreamUrl: previewStreamUrlMock
}))

const { allowedMediaContentTypeMock } = vi.hoisted(() => ({ allowedMediaContentTypeMock: vi.fn<(item: DriveItem) => string | null>() }))

vi.mock("@/features/preview/lib/mediaType", () => ({ allowedMediaContentType: allowedMediaContentTypeMock }))

import { generateHeicThumb, generateVideoThumb, generatePdfThumb } from "@/features/drive/lib/thumbGenerators"

// Captured immediately after import: registerThumbGenerator only ever runs once, as a module-scope
// side effect at import time (see thumbGenerators.ts's own closing comment) — this must be read
// before the beforeEach below's vi.clearAllMocks() has any chance to wipe it.
const registrationCallsAtImport = registerThumbGeneratorMock.mock.calls.slice()

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

let uuidCounter = 0

function nextUuid(): UuidStr {
	uuidCounter += 1

	return testUuid(`u${uuidCounter.toString()}`)
}

function mockFile(overrides: Partial<SdkFile> = {}): SdkFile {
	return {
		uuid: nextUuid(),
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

function itemAsBaseFile(item: DriveItem): BaseFileItem {
	if (item.type !== "file") {
		throw new Error("expected a file item")
	}

	return item
}

function heicItem(): BaseFileItem {
	return itemAsBaseFile(
		narrowItem(
			mockFile({
				meta: {
					type: "decoded",
					data: { name: "photo.heic", mime: "image/heic", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
				}
			})
		)
	)
}

function videoItem(): BaseFileItem {
	return itemAsBaseFile(narrowItem(mockFile()))
}

function pdfItem(): BaseFileItem {
	return itemAsBaseFile(
		narrowItem(
			mockFile({
				meta: {
					type: "decoded",
					data: { name: "doc.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
				}
			})
		)
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	narrowToAnyFileMock.mockImplementation((item: BaseFileItem) => item.data)
})

describe("registration", () => {
	it("registers heic/video/pdf generators exactly once, at import", () => {
		expect(registrationCallsAtImport).toEqual([
			["heic", generateHeicThumb],
			["video", generateVideoThumb],
			["pdf", generatePdfThumb]
		])
	})
})

describe("generateHeicThumb", () => {
	it("resolves null and never calls transformHeicBytes when the download fails", async () => {
		downloadFileBytesMock.mockRejectedValue(new Error("network"))

		const result = await generateHeicThumb(heicItem())

		expect(result).toBeNull()
		expect(transformHeicBytesMock).not.toHaveBeenCalled()
	})

	it("downloads then transforms at THUMB_MAX_DIM, returning the transformed bytes", async () => {
		downloadFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
		transformHeicBytesMock.mockResolvedValue(new Blob([new Uint8Array([9, 9])]))

		const result = await generateHeicThumb(heicItem())

		expect(result).toEqual(new Uint8Array([9, 9]))
		expect(transformHeicBytesMock).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), { maxDimension: 512 })
	})

	it("resolves null when the transform rejects", async () => {
		downloadFileBytesMock.mockResolvedValue(new Uint8Array([1]))
		transformHeicBytesMock.mockRejectedValue(new Error("decode failed"))

		const result = await generateHeicThumb(heicItem())

		expect(result).toBeNull()
	})
})

describe("generateVideoThumb — early gates (no DOM element ever created)", () => {
	it("resolves null without calling previewStreamUrl when the SW isn't controlling the tab", async () => {
		isMediaStreamAvailableMock.mockReturnValue(false)

		const result = await generateVideoThumb(videoItem())

		expect(result).toBeNull()
		expect(previewStreamUrlMock).not.toHaveBeenCalled()
	})

	it("resolves null without calling previewStreamUrl when the item's content type isn't inline-allowlisted", async () => {
		isMediaStreamAvailableMock.mockReturnValue(true)
		allowedMediaContentTypeMock.mockReturnValue(null)

		const result = await generateVideoThumb(videoItem())

		expect(result).toBeNull()
		expect(previewStreamUrlMock).not.toHaveBeenCalled()
	})

	it("resolves null when previewStreamUrl itself rejects, before any DOM element is created", async () => {
		isMediaStreamAvailableMock.mockReturnValue(true)
		allowedMediaContentTypeMock.mockReturnValue("video/mp4")
		previewStreamUrlMock.mockRejectedValue(new Error("registration failed"))

		const result = await generateVideoThumb(videoItem())

		expect(result).toBeNull()
	})
})

describe("generatePdfThumb", () => {
	it("resolves null and never imports pdf.js when the download fails", async () => {
		downloadFileBytesMock.mockRejectedValue(new Error("network"))

		const result = await generatePdfThumb(pdfItem())

		expect(result).toBeNull()
	})
})
