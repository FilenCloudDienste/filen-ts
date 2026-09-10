import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	mockMakeThumbnailInMemory,
	mockMakeThumbnailFromPath,
	mockManagedFutureNew,
	mockWrapAbortSignalForSdk,
	mockDisposeSdkAbortSignal,
	mockGetSdkClients
} = vi.hoisted(() => {
	const mockMakeThumbnailInMemory = vi.fn()
	const mockMakeThumbnailFromPath = vi.fn()

	return {
		mockMakeThumbnailInMemory,
		mockMakeThumbnailFromPath,
		mockManagedFutureNew: vi.fn((args: unknown) => ({ managedFuture: args })),
		mockWrapAbortSignalForSdk: vi.fn((signal: AbortSignal) => ({ wrapped: signal })),
		mockDisposeSdkAbortSignal: vi.fn(),
		mockGetSdkClients: vi.fn().mockResolvedValue({
			authedSdkClient: {
				makeThumbnailInMemory: mockMakeThumbnailInMemory,
				makeThumbnailFromPath: mockMakeThumbnailFromPath
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
	AnyFile: {},
	// A plain record, not a uniffi handle — nothing to dispose.
	ManagedFuture: {
		new: mockManagedFutureNew
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/lib/signals", () => ({
	toSignalOpts: (signal?: AbortSignal) => (signal ? { signal } : undefined),
	wrapAbortSignalForSdk: mockWrapAbortSignalForSdk,
	disposeSdkAbortSignal: mockDisposeSdkAbortSignal
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

import { generateImageViaSdk, generateImageFromPathViaSdk, THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT } from "@/lib/thumbnailsSdk"
import { fs, File } from "@/tests/mocks/expoFileSystem"

const OUTPUT_PATH = "file:///shared/group.io.filen.app/thumbnails/v4/uuid-1.webp"
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
		fs.set("file:///shared/group.io.filen.app/thumbnails/v4", "dir")
		mockMakeThumbnailInMemory.mockResolvedValue(thumbnailVerdict())
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

// The from-path twin: a different SDK method and an extra cancellation channel, but the same
// tmp-write/rename and the same 4-arm verdict mapping — handleThumbnailResult is shared, so the
// cases below assert what is genuinely different rather than repeating the write tests above.
describe("generateImageFromPathViaSdk", () => {
	const LOCAL_PATH = "/document/photo.jpg"

	beforeEach(() => {
		fs.clear()
		vi.clearAllMocks()
		fs.set("file:///shared/group.io.filen.app/thumbnails/v4", "dir")
		mockMakeThumbnailFromPath.mockResolvedValue(thumbnailVerdict())
	})

	it("asks for a 256×512 contain thumbnail of the path, with the ManagedFuture carrying the wrapped abort signal", async () => {
		const controller = new AbortController()

		const outcome = await generateImageFromPathViaSdk({
			localPath: LOCAL_PATH,
			uuid: "uuid-1",
			outputPath: OUTPUT_PATH,
			signal: controller.signal
		})

		const wrapped = mockWrapAbortSignalForSdk.mock.results[0]?.value

		expect(outcome).toBe("written")
		expect(mockWrapAbortSignalForSdk).toHaveBeenCalledWith(controller.signal)
		// Both keys are required by the bindings; a thumbnail extraction is not a pausable transfer.
		expect(mockManagedFutureNew).toHaveBeenCalledWith({ pauseSignal: undefined, abortSignal: wrapped })
		expect(mockMakeThumbnailFromPath).toHaveBeenCalledWith(
			LOCAL_PATH,
			THUMBNAIL_MAX_WIDTH,
			THUMBNAIL_MAX_HEIGHT,
			mockManagedFutureNew.mock.results[0]?.value,
			{ signal: controller.signal }
		)
	})

	it("still builds a ManagedFuture when there is no signal, with both keys undefined", async () => {
		await generateImageFromPathViaSdk({ localPath: LOCAL_PATH, uuid: "uuid-1", outputPath: OUTPUT_PATH })

		expect(mockWrapAbortSignalForSdk).not.toHaveBeenCalled()
		expect(mockManagedFutureNew).toHaveBeenCalledWith({ pauseSignal: undefined, abortSignal: undefined })
		expect(mockMakeThumbnailFromPath).toHaveBeenCalledWith(
			LOCAL_PATH,
			THUMBNAIL_MAX_WIDTH,
			THUMBNAIL_MAX_HEIGHT,
			expect.anything(),
			undefined
		)
		// Nothing was allocated, so nothing is freed — disposeSdkAbortSignal tolerates undefined anyway.
		expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
		expect(mockDisposeSdkAbortSignal).toHaveBeenCalledWith(null)
	})

	it("hands the path to the SDK verbatim — decoding is the caller's job, and a second one would corrupt a literal %20", async () => {
		await generateImageFromPathViaSdk({
			localPath: "/document/IMG 1234 (1).jpg",
			uuid: "uuid-1",
			outputPath: OUTPUT_PATH
		})

		expect(mockMakeThumbnailFromPath).toHaveBeenCalledWith(
			"/document/IMG 1234 (1).jpg",
			THUMBNAIL_MAX_WIDTH,
			THUMBNAIL_MAX_HEIGHT,
			expect.anything(),
			undefined
		)
	})

	it("writes the WebP through <uuid>.webp.tmp and renames it into place (the shared result handler)", async () => {
		await generateImageFromPathViaSdk({ localPath: LOCAL_PATH, uuid: "uuid-1", outputPath: OUTPUT_PATH })

		expect(Array.from(fs.get(OUTPUT_PATH) as Uint8Array)).toEqual(WEBP_BYTES)
		expect(fs.has(`${OUTPUT_PATH}.tmp`)).toBe(false)
	})

	it.each([
		["Unsupported", { tag: "Unsupported" }],
		["OverBudget", { tag: "OverBudget" }],
		["Corrupt", { tag: "Corrupt", inner: { message: "bad huffman table" } }]
	])("maps %s to 'settled' and writes nothing", async (_tag, verdict) => {
		mockMakeThumbnailFromPath.mockResolvedValueOnce(verdict)

		await expect(generateImageFromPathViaSdk({ localPath: LOCAL_PATH, uuid: "uuid-1", outputPath: OUTPUT_PATH })).resolves.toBe(
			"settled"
		)
		expect(fs.has(OUTPUT_PATH)).toBe(false)
		expect(fs.has(`${OUTPUT_PATH}.tmp`)).toBe(false)
	})

	// wrapAbortSignalForSdk allocates two Arc-backed handles that nothing GCs, so every exit path has
	// to free them exactly once — a miss leaks two per file during a camera-upload backfill.
	it("disposes the wrapped signal exactly once on success", async () => {
		const controller = new AbortController()

		await generateImageFromPathViaSdk({ localPath: LOCAL_PATH, uuid: "uuid-1", outputPath: OUTPUT_PATH, signal: controller.signal })

		expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
		expect(mockDisposeSdkAbortSignal).toHaveBeenCalledWith(mockWrapAbortSignalForSdk.mock.results[0]?.value)
	})

	it("disposes the wrapped signal exactly once on a settled verdict", async () => {
		const controller = new AbortController()

		mockMakeThumbnailFromPath.mockResolvedValueOnce({ tag: "Unsupported" })

		await generateImageFromPathViaSdk({ localPath: LOCAL_PATH, uuid: "uuid-1", outputPath: OUTPUT_PATH, signal: controller.signal })

		expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
	})

	it("disposes the wrapped signal exactly once when the SDK throws", async () => {
		const controller = new AbortController()

		mockMakeThumbnailFromPath.mockRejectedValueOnce(new Error("io error"))

		await expect(
			generateImageFromPathViaSdk({ localPath: LOCAL_PATH, uuid: "uuid-1", outputPath: OUTPUT_PATH, signal: controller.signal })
		).rejects.toThrow("io error")

		expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
	})

	// Two cancellation channels race here, so the abort can arrive as the bindings' AbortError or as a
	// FilenSdkError Cancelled. Checking the JS signal first settles it before either can matter.
	it("throws the abort reason and disposes exactly once when the signal aborted mid-flight", async () => {
		const controller = new AbortController()

		mockMakeThumbnailFromPath.mockImplementationOnce(async () => {
			controller.abort()

			return thumbnailVerdict()
		})

		await expect(
			generateImageFromPathViaSdk({ localPath: LOCAL_PATH, uuid: "uuid-1", outputPath: OUTPUT_PATH, signal: controller.signal })
		).rejects.toThrow()

		expect(fs.has(OUTPUT_PATH)).toBe(false)
		expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
	})

	it("disposes exactly once when the SDK rejects with a Cancelled error rather than an AbortError", async () => {
		const controller = new AbortController()

		mockMakeThumbnailFromPath.mockImplementationOnce(async () => {
			controller.abort()

			throw new Error("Cancelled")
		})

		await expect(
			generateImageFromPathViaSdk({ localPath: LOCAL_PATH, uuid: "uuid-1", outputPath: OUTPUT_PATH, signal: controller.signal })
		).rejects.toThrow("Cancelled")

		expect(mockDisposeSdkAbortSignal).toHaveBeenCalledTimes(1)
	})
})
