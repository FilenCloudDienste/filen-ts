import { vi, describe, it, expect, beforeEach } from "vitest"

// @ts-expect-error __DEV__ is a React Native global
globalThis.__DEV__ = true

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-image-manipulator", () => ({
	ImageManipulator: {
		manipulate: vi.fn()
	},
	SaveFormat: {
		JPEG: "jpeg"
	}
}))

vi.mock("@/lib/tmp", () => ({
	newTmpFile: vi.fn()
}))

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: vi.fn()
	}
}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForExpo: (path: string) => path
}))

vi.mock("expo-crypto", () => ({
	randomUUID: () => "test-uuid"
}))

vi.mock("@/lib/logger", () => ({
	default: {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn()
	}
}))

import { isHeicFile, convertHeicToJpg } from "@/lib/imageConversion"
import * as ImageManipulator from "expo-image-manipulator"
import { newTmpFile } from "@/lib/tmp"
import { fs, File } from "@/tests/mocks/expoFileSystem"
import { transplantMetadata } from "@/modules/filen-exif"
import logger from "@/lib/logger"

describe("isHeicFile", () => {
	it("detects .heic and .heif (case-insensitive)", () => {
		expect(isHeicFile("photo.heic")).toBe(true)
		expect(isHeicFile("photo.HEIC")).toBe(true)
		expect(isHeicFile("photo.heif")).toBe(true)
		expect(isHeicFile("IMG_1234.HEIF")).toBe(true)
	})

	it("detects the multi-image .heics / .heifs variants", () => {
		expect(isHeicFile("burst.heics")).toBe(true)
		expect(isHeicFile("burst.heifs")).toBe(true)
	})

	it("detects HEIC by full file URI too", () => {
		expect(isHeicFile("file:///var/mobile/Media/IMG_0001.heic")).toBe(true)
	})

	it("returns false for non-HEIC images and other files", () => {
		expect(isHeicFile("photo.jpg")).toBe(false)
		expect(isHeicFile("photo.jpeg")).toBe(false)
		expect(isHeicFile("photo.png")).toBe(false)
		expect(isHeicFile("clip.mp4")).toBe(false)
		expect(isHeicFile("noextension")).toBe(false)
	})

	it("does NOT match when .heic is not the final extension", () => {
		expect(isHeicFile("photo.heic.jpg")).toBe(false)
	})

	it("handles file URIs with a query/fragment or a literal % without throwing (drive picker robustness)", () => {
		expect(isHeicFile("file:///var/mobile/Media/IMG_0001.heic?download=1")).toBe(true)
		expect(isHeicFile("file:///var/mobile/Media/100%.heic")).toBe(true)
		expect(isHeicFile("file:///var/mobile/Media/report.pdf?x=1")).toBe(false)
	})
})

describe("convertHeicToJpg native transplant wiring", () => {
	const SOURCE_URI = "file:///cache/filen-tmp/staged.heic"
	const CONVERTED_URI = "file:///cache/manipulator/output.jpg"
	const TARGET_URI = "file:///cache/filen-tmp/test-uuid.jpg"

	function setup(): { source: InstanceType<typeof File>; target: InstanceType<typeof File> } {
		const source = new File(SOURCE_URI)

		fs.set(SOURCE_URI, new Uint8Array([1, 2, 3]))

		const target = new File(TARGET_URI)

		vi.mocked(newTmpFile).mockReturnValue(target as never)

		const rendered = {
			saveAsync: vi.fn(async () => {
				fs.set(CONVERTED_URI, new Uint8Array([9, 9, 9, 9]))

				return { uri: CONVERTED_URI }
			}),
			release: vi.fn()
		}

		vi.mocked(ImageManipulator.ImageManipulator.manipulate).mockReturnValue({
			renderAsync: vi.fn(async () => rendered),
			release: vi.fn()
		} as never)

		return { source, target }
	}

	beforeEach(() => {
		fs.clear()
		vi.mocked(transplantMetadata).mockReset()
		vi.mocked(transplantMetadata).mockResolvedValue(true)
		vi.mocked(logger.warn).mockClear()
	})

	it("transplants the source HEIC's metadata into the converted JPEG target", async () => {
		const { source } = setup()

		const result = await convertHeicToJpg(source as never)

		expect(result.uri).toBe(TARGET_URI)
		// The transplant reads the HEIC SOURCE and writes into the converted TARGET, in that order.
		expect(vi.mocked(transplantMetadata)).toHaveBeenCalledExactlyOnceWith(SOURCE_URI, TARGET_URI)
	})

	it("still returns the converted file when the transplant fails (fail-open, warns once)", async () => {
		const { source } = setup()

		vi.mocked(transplantMetadata).mockRejectedValue(new Error("native boom"))

		const result = await convertHeicToJpg(source as never)

		expect(result.uri).toBe(TARGET_URI)
		expect(fs.has(TARGET_URI)).toBe(true)
		expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce()
	})

	it("does not call the transplant for non-HEIC input", async () => {
		const jpg = new File("file:///cache/filen-tmp/photo.jpg")

		fs.set(jpg.uri, new Uint8Array([1, 2, 3]))

		await convertHeicToJpg(jpg as never)

		expect(vi.mocked(transplantMetadata)).not.toHaveBeenCalled()
	})
})
