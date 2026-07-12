import { describe, expect, it, vi } from "vitest"
import { isHeicUploadCandidate, maybeConvertHeicUpload, renameToJpg, type HeicUploadConvertDeps } from "@/features/drive/lib/heicUpload"

function mockFile(name: string, bytes = new Uint8Array([1, 2, 3])): File {
	return new File([bytes], name)
}

describe("isHeicUploadCandidate", () => {
	it("is true for a .heic file, case-insensitive", () => {
		expect(isHeicUploadCandidate(mockFile("photo.heic"))).toBe(true)
		expect(isHeicUploadCandidate(mockFile("PHOTO.HEIC"))).toBe(true)
	})

	it("is true for a .heif file", () => {
		expect(isHeicUploadCandidate(mockFile("photo.heif"))).toBe(true)
	})

	it("is false for a non-HEIC file, including other image formats", () => {
		expect(isHeicUploadCandidate(mockFile("photo.jpg"))).toBe(false)
		expect(isHeicUploadCandidate(mockFile("report.pdf"))).toBe(false)
		expect(isHeicUploadCandidate(mockFile("noextension"))).toBe(false)
	})
})

describe("renameToJpg", () => {
	it("swaps the extension for .jpg", () => {
		expect(renameToJpg("photo.heic")).toBe("photo.jpg")
		expect(renameToJpg("photo.HEIC")).toBe("photo.jpg")
	})

	it("preserves dots within the base name, only swapping the trailing extension", () => {
		expect(renameToJpg("vacation.2024.heic")).toBe("vacation.2024.jpg")
	})

	it("appends .jpg to a name with no extension at all", () => {
		expect(renameToJpg("noextension")).toBe("noextension.jpg")
	})
})

describe("maybeConvertHeicUpload", () => {
	function harness(): { deps: HeicUploadConvertDeps; transform: ReturnType<typeof vi.fn> } {
		const transform = vi.fn<HeicUploadConvertDeps["transform"]>()
		return { deps: { transform }, transform }
	}

	it("returns the original File untouched when the preference is off, without reading any bytes", async () => {
		const h = harness()
		const file = mockFile("photo.heic")

		const result = await maybeConvertHeicUpload(h.deps, file, false)

		expect(result).toBe(file)
		expect(h.transform).not.toHaveBeenCalled()
	})

	it("returns the original File untouched for a non-HEIC name, even with the preference on", async () => {
		const h = harness()
		const file = mockFile("photo.jpg")

		const result = await maybeConvertHeicUpload(h.deps, file, true)

		expect(result).toBe(file)
		expect(h.transform).not.toHaveBeenCalled()
	})

	it("converts a HEIC file to a renamed, image/jpeg-typed File when enabled", async () => {
		const h = harness()
		const jpegBytes = new Blob([new Uint8Array([9, 9, 9])], { type: "image/jpeg" })
		h.transform.mockResolvedValue(jpegBytes)
		const file = mockFile("photo.heic")

		const result = await maybeConvertHeicUpload(h.deps, file, true)

		expect(result).not.toBe(file)
		expect(result.name).toBe("photo.jpg")
		expect(result.type).toBe("image/jpeg")
		expect(h.transform).toHaveBeenCalledTimes(1)
	})

	it("preserves the original lastModified timestamp on the converted File", async () => {
		const h = harness()
		h.transform.mockResolvedValue(new Blob([new Uint8Array([1])]))
		const file = new File([new Uint8Array([1, 2, 3])], "photo.heic", { lastModified: 1_700_000_000_000 })

		const result = await maybeConvertHeicUpload(h.deps, file, true)

		expect(result.lastModified).toBe(1_700_000_000_000)
	})

	it("falls back to the original File when the transform rejects — an upload must never be blocked by a failed opportunistic re-encode", async () => {
		const h = harness()
		h.transform.mockRejectedValue(new Error("decode failed"))
		const file = mockFile("photo.heic")

		const result = await maybeConvertHeicUpload(h.deps, file, true)

		expect(result).toBe(file)
	})
})
