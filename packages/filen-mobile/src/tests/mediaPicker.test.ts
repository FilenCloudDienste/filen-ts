import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockLaunchLibrary, mockLaunchCamera, mockHasPermissions } = vi.hoisted(() => ({
	mockLaunchLibrary: vi.fn(),
	mockLaunchCamera: vi.fn(),
	mockHasPermissions: vi.fn()
}))

vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))
vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

vi.mock("@/lib/i18n", async () => await import("@/tests/mocks/i18n"))

vi.mock("expo-image-picker", () => ({
	launchImageLibraryAsync: mockLaunchLibrary,
	launchCameraAsync: mockLaunchCamera,
	UIImagePickerPresentationStyle: { PAGE_SHEET: "pageSheet" }
}))

vi.mock("@/hooks/useMediaPermissions", () => ({
	hasAllNeededMediaPermissions: mockHasPermissions
}))

vi.mock("@/lib/systemPresentation", () => ({
	withSystemPresentation: vi.fn(async (fn: () => unknown) => await fn())
}))

import alerts from "@/lib/alerts"
import { pickMedia, pickedAssetName, requireMediaPermissions } from "@/lib/mediaPicker"
import type { ImagePickerAsset } from "expo-image-picker"

function asset(overrides: Partial<ImagePickerAsset>): ImagePickerAsset {
	return {
		uri: "file:///tmp/picked.heic",
		width: 1,
		height: 1,
		...overrides
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mockHasPermissions.mockResolvedValue(true)
})

describe("requireMediaPermissions", () => {
	it("alerts and returns false when permission is denied", async () => {
		mockHasPermissions.mockResolvedValue(false)

		expect(await requireMediaPermissions({ needCamera: false })).toBe(false)
		expect(alerts.error).toHaveBeenCalledWith("no_permissions_enable_manually")
	})

	it("alerts the error and returns false when the check throws", async () => {
		const error = new Error("boom")

		mockHasPermissions.mockRejectedValue(error)

		expect(await requireMediaPermissions({ needCamera: true })).toBe(false)
		expect(alerts.error).toHaveBeenCalledWith(error)
	})
})

describe("pickMedia", () => {
	it("opens the library without requesting the camera", async () => {
		const picked = [asset({})]

		mockLaunchLibrary.mockResolvedValue({ canceled: false, assets: picked })

		expect(await pickMedia({ source: "library" })).toBe(picked)
		expect(mockHasPermissions).toHaveBeenCalledWith(expect.objectContaining({ needCamera: false }))
		expect(mockLaunchCamera).not.toHaveBeenCalled()
	})

	it("opens the camera after requesting camera permission", async () => {
		mockLaunchCamera.mockResolvedValue({ canceled: false, assets: [asset({})] })

		await pickMedia({ source: "camera" })

		expect(mockHasPermissions).toHaveBeenCalledWith(expect.objectContaining({ needCamera: true }))
		expect(mockLaunchLibrary).not.toHaveBeenCalled()
	})

	it("returns null on cancel without alerting", async () => {
		mockLaunchLibrary.mockResolvedValue({ canceled: true, assets: null })

		expect(await pickMedia({ source: "library" })).toBeNull()
		expect(alerts.error).not.toHaveBeenCalled()
	})

	it("returns null without launching when permission is denied", async () => {
		mockHasPermissions.mockResolvedValue(false)

		expect(await pickMedia({ source: "camera" })).toBeNull()
		expect(mockLaunchCamera).not.toHaveBeenCalled()
	})

	it("alerts and returns null when the picker throws", async () => {
		const error = new Error("picker")

		mockLaunchLibrary.mockRejectedValue(error)

		expect(await pickMedia({ source: "library" })).toBeNull()
		expect(alerts.error).toHaveBeenCalledWith(error)
	})
})

describe("pickedAssetName", () => {
	it("prefers the asset file name", () => {
		expect(pickedAssetName(asset({ fileName: "IMG_1.HEIC" }))).toBe("IMG_1.HEIC")
	})

	it("falls back to a random name keeping the uri extension", () => {
		expect(pickedAssetName(asset({ fileName: null }))).toMatch(/^mock-uuid-\d+\.heic$/)
	})
})
