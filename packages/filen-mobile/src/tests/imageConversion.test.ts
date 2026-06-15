import { vi, describe, it, expect } from "vitest"

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

import { isHeicFile } from "@/lib/imageConversion"

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
