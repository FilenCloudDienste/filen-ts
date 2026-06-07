import { vi, describe, it, expect, beforeEach } from "vitest"

// Native app-switcher/screen-capture APIs, mocked so we can assert which one applyPrivacyScreen
// dispatches to per platform + enabled state.
const { mockEnable, mockDisable, mockPrevent, mockAllow } = vi.hoisted(() => ({
	mockEnable: vi.fn().mockResolvedValue(undefined),
	mockDisable: vi.fn().mockResolvedValue(undefined),
	mockPrevent: vi.fn().mockResolvedValue(undefined),
	mockAllow: vi.fn().mockResolvedValue(undefined)
}))

vi.mock("expo-screen-capture", () => ({
	enableAppSwitcherProtectionAsync: mockEnable,
	disableAppSwitcherProtectionAsync: mockDisable,
	preventScreenCaptureAsync: mockPrevent,
	allowScreenCaptureAsync: mockAllow
}))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

// privacyScreen.ts also imports useSecureStore (for the hook) — not exercised here; stub it.
vi.mock("@/lib/secureStore", () => ({ useSecureStore: vi.fn() }))

import { applyPrivacyScreen, PRIVACY_SCREEN_BLUR_INTENSITY } from "@/features/settings/privacyScreen"
import { Platform } from "@/tests/mocks/reactNative"

beforeEach(() => {
	vi.clearAllMocks()
})

describe("applyPrivacyScreen", () => {
	describe("iOS — app-switcher blur only (screenshots stay allowed)", () => {
		beforeEach(() => {
			Platform.OS = "ios"
		})

		it("enabled → enableAppSwitcherProtectionAsync at the configured blur, never blocks screenshots", async () => {
			await applyPrivacyScreen(true)

			expect(mockEnable).toHaveBeenCalledTimes(1)
			expect(mockEnable).toHaveBeenCalledWith(PRIVACY_SCREEN_BLUR_INTENSITY)
			expect(mockDisable).not.toHaveBeenCalled()
			expect(mockPrevent).not.toHaveBeenCalled()
			expect(mockAllow).not.toHaveBeenCalled()
		})

		it("disabled → disableAppSwitcherProtectionAsync", async () => {
			await applyPrivacyScreen(false)

			expect(mockDisable).toHaveBeenCalledTimes(1)
			expect(mockEnable).not.toHaveBeenCalled()
			expect(mockPrevent).not.toHaveBeenCalled()
		})
	})

	describe("Android — FLAG_SECURE via prevent/allowScreenCaptureAsync", () => {
		beforeEach(() => {
			Platform.OS = "android"
		})

		it("enabled → preventScreenCaptureAsync (FLAG_SECURE)", async () => {
			await applyPrivacyScreen(true)

			expect(mockPrevent).toHaveBeenCalledTimes(1)
			expect(mockAllow).not.toHaveBeenCalled()
			expect(mockEnable).not.toHaveBeenCalled()
		})

		it("disabled → allowScreenCaptureAsync", async () => {
			await applyPrivacyScreen(false)

			expect(mockAllow).toHaveBeenCalledTimes(1)
			expect(mockPrevent).not.toHaveBeenCalled()
			expect(mockDisable).not.toHaveBeenCalled()
		})
	})
})
