import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockMakeThumbnailInMemory, mockGetSdkClients } = vi.hoisted(() => {
	const mockMakeThumbnailInMemory = vi.fn()

	return {
		mockMakeThumbnailInMemory,
		mockGetSdkClients: vi.fn().mockResolvedValue({
			authedSdkClient: {
				makeThumbnailInMemory: mockMakeThumbnailInMemory
			}
		})
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

// Mirrors the generated bindings: string-valued tags (filen_sdk_rs.ts:12241-12246).
vi.mock("@filen/sdk-rs", () => ({
	MakeThumbnailInMemoryResult_Tags: {
		Thumbnail: "Thumbnail",
		Unsupported: "Unsupported",
		OverBudget: "OverBudget",
		Corrupt: "Corrupt"
	},
	AnyFile: {}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/lib/signals", () => ({
	toSignalOpts: (signal?: AbortSignal) => (signal ? { signal } : undefined)
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

import { generateImageViaSdk, THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT } from "@/lib/thumbnailsSdk"
import { fs, File } from "@/tests/mocks/expoFileSystem"

const OUTPUT_PATH = "file:///shared/group.io.filen.app/thumbnails/v3/uuid-1.webp"
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 0x57, 0x45, 0x42, 0x50]

function thumbnailVerdict(fromEmbeddedPreview = false) {
	return {
		tag: "Thumbnail",
		inner: {
			thumbnail: {
				webpData: new Uint8Array(WEBP_BYTES).buffer,
				width: 256,
				height: 170,
				fromEmbeddedPreview
			}
		}
	}
}

// The AnyFile the caller built with driveItemToAnyFile — opaque to this module.
const anyFile = { tag: "File", inner: [{ uuid: "uuid-1", size: 10n }] } as never

describe("generateImageViaSdk", () => {
	beforeEach(() => {
		fs.clear()
		vi.clearAllMocks()
		fs.set("file:///shared/group.io.filen.app/thumbnails/v3", "dir")
		mockMakeThumbnailInMemory.mockResolvedValue(thumbnailVerdict())
	})

	it("pins the request box the tiles are cut for", () => {
		expect(`${THUMBNAIL_MAX_WIDTH}x${THUMBNAIL_MAX_HEIGHT}`).toBe("256x512")
	})

	it("asks for a 256×512 contain thumbnail of the AnyFile with the JS AbortSignal as the uniffi cancellation handle", async () => {
		const controller = new AbortController()

		const outcome = await generateImageViaSdk({ file: anyFile, uuid: "uuid-1", outputPath: OUTPUT_PATH, signal: controller.signal })

		expect(outcome).toBe("written")
		expect(mockMakeThumbnailInMemory).toHaveBeenCalledWith(
			{ file: anyFile, maxWidth: 256, maxHeight: 512 },
			{ signal: controller.signal }
		)
	})

	it("passes undefined asyncOpts when there is no signal", async () => {
		await generateImageViaSdk({ file: anyFile, uuid: "uuid-1", outputPath: OUTPUT_PATH })

		expect(mockMakeThumbnailInMemory).toHaveBeenCalledWith(expect.objectContaining({ maxWidth: 256 }), undefined)
	})

	it("writes the WebP through <uuid>.webp.tmp and renames it into place", async () => {
		await generateImageViaSdk({ file: anyFile, uuid: "uuid-1", outputPath: OUTPUT_PATH })

		expect(Array.from(fs.get(OUTPUT_PATH) as Uint8Array)).toEqual(WEBP_BYTES)
		expect(fs.has(`${OUTPUT_PATH}.tmp`)).toBe(false)
	})

	it("removes the .tmp and leaves no .webp when the rename fails", async () => {
		vi.spyOn(File.prototype, "moveSync").mockImplementationOnce(() => {
			throw new Error("EACCES permission denied")
		})

		await expect(generateImageViaSdk({ file: anyFile, uuid: "uuid-1", outputPath: OUTPUT_PATH })).rejects.toThrow(
			"EACCES permission denied"
		)

		expect(fs.has(`${OUTPUT_PATH}.tmp`)).toBe(false)
		expect(fs.has(OUTPUT_PATH)).toBe(false)
	})

	it.each([
		["Unsupported", { tag: "Unsupported" }],
		["OverBudget", { tag: "OverBudget" }],
		["Corrupt", { tag: "Corrupt", inner: { message: "bad huffman table" } }]
	])("maps %s to 'settled' and writes nothing", async (_tag, verdict) => {
		mockMakeThumbnailInMemory.mockResolvedValueOnce(verdict)

		await expect(generateImageViaSdk({ file: anyFile, uuid: "uuid-1", outputPath: OUTPUT_PATH })).resolves.toBe("settled")
		expect(fs.has(OUTPUT_PATH)).toBe(false)
		expect(fs.has(`${OUTPUT_PATH}.tmp`)).toBe(false)
	})

	it("throws the abort reason when the signal aborted while the SDK was running", async () => {
		const controller = new AbortController()

		mockMakeThumbnailInMemory.mockImplementationOnce(async () => {
			controller.abort()

			return thumbnailVerdict()
		})

		await expect(
			generateImageViaSdk({ file: anyFile, uuid: "uuid-1", outputPath: OUTPUT_PATH, signal: controller.signal })
		).rejects.toThrow()
		expect(fs.has(OUTPUT_PATH)).toBe(false)
	})

	it("propagates a transport error untouched", async () => {
		mockMakeThumbnailInMemory.mockRejectedValueOnce(new Error("network error"))

		await expect(generateImageViaSdk({ file: anyFile, uuid: "uuid-1", outputPath: OUTPUT_PATH })).rejects.toThrow("network error")
	})
})
