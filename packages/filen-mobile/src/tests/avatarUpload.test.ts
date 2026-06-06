import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("expo-image-manipulator", () => ({
	ImageManipulator: { manipulate: vi.fn() },
	SaveFormat: { JPEG: "jpeg" }
}))
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }))
vi.mock("@/constants", () => ({ EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS: new Set([".heic", ".webp"]) }))

import { fs } from "@/tests/mocks/expoFileSystem"
import { prepareAvatarFileForUpload } from "@/features/settings/avatarUpload"

const noopDefer = () => {}

// Minimal ImagePickerAsset shape used by the function under test.
function makeAsset(over: Record<string, unknown> = {}) {
	return {
		uri: "file:///pick/img.jpg",
		mimeType: "image/jpeg",
		fileSize: 100,
		fileName: "img.jpg",
		...over
	} as unknown as Parameters<typeof prepareAvatarFileForUpload>[0]["asset"]
}

describe("prepareAvatarFileForUpload", () => {
	beforeEach(() => {
		fs.clear()
		vi.clearAllMocks()
	})

	it("returns the original file unchanged for a JPEG (no transcode)", async () => {
		fs.set("file:///pick/img.jpg", new Uint8Array([1]))

		const file = await prepareAvatarFileForUpload({ asset: makeAsset(), defer: noopDefer })

		expect(file.uri).toBe("file:///pick/img.jpg")

		const { ImageManipulator } = await import("expo-image-manipulator")

		expect(vi.mocked(ImageManipulator.manipulate)).not.toHaveBeenCalled()
	})

	it("returns the original file unchanged for a PNG", async () => {
		fs.set("file:///pick/img.png", new Uint8Array([1]))

		const file = await prepareAvatarFileForUpload({
			asset: makeAsset({ uri: "file:///pick/img.png", mimeType: "image/png", fileName: "img.png" }),
			defer: noopDefer
		})

		expect(file.uri).toBe("file:///pick/img.png")
	})

	it("throws avatar_upload_failed when the picked file does not exist", async () => {
		await expect(prepareAvatarFileForUpload({ asset: makeAsset(), defer: noopDefer })).rejects.toThrow("avatar_upload_failed")
	})

	it("throws avatar_not_an_image when mimeType is missing", async () => {
		fs.set("file:///pick/x", new Uint8Array([1]))

		await expect(
			prepareAvatarFileForUpload({ asset: makeAsset({ uri: "file:///pick/x", mimeType: undefined }), defer: noopDefer })
		).rejects.toThrow("avatar_not_an_image")
	})

	it("throws avatar_not_an_image for a non-image mimeType", async () => {
		fs.set("file:///pick/x", new Uint8Array([1]))

		await expect(
			prepareAvatarFileForUpload({ asset: makeAsset({ uri: "file:///pick/x", mimeType: "video/mp4" }), defer: noopDefer })
		).rejects.toThrow("avatar_not_an_image")
	})

	// Findings #72 + #94 — falsy-value guard on fileSize and fileName
	// Line 25: !asset.fileSize fires for 0 (falsy number); !asset.fileName fires for '' and undefined

	it("throws avatar_not_an_image when fileSize is 0 (zero-byte file — falsy guard)", async () => {
		fs.set("file:///pick/x", new Uint8Array([1]))

		await expect(
			prepareAvatarFileForUpload({ asset: makeAsset({ uri: "file:///pick/x", fileSize: 0 }), defer: noopDefer })
		).rejects.toThrow("avatar_not_an_image")
	})

	it("throws avatar_not_an_image when fileName is empty string (falsy guard)", async () => {
		fs.set("file:///pick/x", new Uint8Array([1]))

		await expect(
			prepareAvatarFileForUpload({ asset: makeAsset({ uri: "file:///pick/x", fileName: "" }), defer: noopDefer })
		).rejects.toThrow("avatar_not_an_image")
	})

	it("throws avatar_not_an_image when fileName is undefined", async () => {
		fs.set("file:///pick/x", new Uint8Array([1]))

		await expect(
			prepareAvatarFileForUpload({ asset: makeAsset({ uri: "file:///pick/x", fileName: undefined }), defer: noopDefer })
		).rejects.toThrow("avatar_not_an_image")
	})

	it("throws avatar_unsupported_format for a non-jpeg/png with an unsupported extension", async () => {
		fs.set("file:///pick/img.gif", new Uint8Array([1]))

		await expect(
			prepareAvatarFileForUpload({
				asset: makeAsset({ uri: "file:///pick/img.gif", mimeType: "image/gif", fileName: "img.gif" }),
				defer: noopDefer
			})
		).rejects.toThrow("avatar_unsupported_format")
	})

	it("transcodes a supported non-jpeg/png (heic) to JPEG and returns the converted file", async () => {
		const originalUri = "file:///pick/img.heic"
		const convertedUri = "file:///tmp/converted.jpg"

		fs.set(originalUri, new Uint8Array([1]))
		fs.set(convertedUri, new Uint8Array([2]))

		const { ImageManipulator } = await import("expo-image-manipulator")
		const saveAsync = vi.fn(async () => ({ uri: convertedUri }))

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce({
			renderAsync: vi.fn(async () => ({ saveAsync }))
		} as unknown as ReturnType<typeof ImageManipulator.manipulate>)

		const file = await prepareAvatarFileForUpload({
			asset: makeAsset({ uri: originalUri, mimeType: "image/heic", fileName: "img.heic" }),
			defer: noopDefer
		})

		expect(file.uri).toBe(convertedUri)
		expect(saveAsync).toHaveBeenCalledWith({ format: "jpeg", base64: false })
	})

	it("throws avatar_upload_failed when the transcoded file does not exist", async () => {
		const originalUri = "file:///pick/img.heic"

		fs.set(originalUri, new Uint8Array([1]))
		// convertedUri intentionally NOT set in fs -> convertedFile.exists === false

		const { ImageManipulator } = await import("expo-image-manipulator")

		vi.mocked(ImageManipulator.manipulate).mockReturnValueOnce({
			renderAsync: vi.fn(async () => ({ saveAsync: vi.fn(async () => ({ uri: "file:///tmp/missing.jpg" })) }))
		} as unknown as ReturnType<typeof ImageManipulator.manipulate>)

		await expect(
			prepareAvatarFileForUpload({
				asset: makeAsset({ uri: originalUri, mimeType: "image/heic", fileName: "img.heic" }),
				defer: noopDefer
			})
		).rejects.toThrow("avatar_upload_failed")
	})

	it("registers temp-file cleanup via defer", async () => {
		fs.set("file:///pick/img.jpg", new Uint8Array([1]))

		const deferred: Array<() => void> = []

		await prepareAvatarFileForUpload({ asset: makeAsset(), defer: fn => deferred.push(fn) })

		expect(deferred.length).toBeGreaterThanOrEqual(1)
	})
})
