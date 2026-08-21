import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const platformMock = vi.hoisted(() => ({ OS: "android" as "ios" | "android" }))

vi.mock("react-native", () => ({
	Platform: platformMock
}))

const mockNotifee = vi.hoisted(() => ({
	isBatteryOptimizationEnabled: vi.fn<() => Promise<boolean>>(),
	openBatteryOptimizationSettings: vi.fn<() => Promise<void>>()
}))

vi.mock("react-native-notify-kit", () => ({ default: mockNotifee }))

import batteryOptimization from "@/lib/batteryOptimization"

describe("batteryOptimization", () => {
	beforeEach(() => {
		platformMock.OS = "android"

		mockNotifee.isBatteryOptimizationEnabled.mockReset()
		mockNotifee.isBatteryOptimizationEnabled.mockResolvedValue(false)
		mockNotifee.openBatteryOptimizationSettings.mockReset()
		mockNotifee.openBatteryOptimizationSettings.mockResolvedValue(undefined)
	})

	describe("isRestricted", () => {
		it("reports the platform's answer on Android", async () => {
			mockNotifee.isBatteryOptimizationEnabled.mockResolvedValue(true)

			await expect(batteryOptimization.isRestricted()).resolves.toBe(true)
		})

		it("is false when the app is already allowlisted", async () => {
			mockNotifee.isBatteryOptimizationEnabled.mockResolvedValue(false)

			await expect(batteryOptimization.isRestricted()).resolves.toBe(false)
		})

		it("never touches the native module on iOS, which has no equivalent", async () => {
			platformMock.OS = "ios"

			await expect(batteryOptimization.isRestricted()).resolves.toBe(false)
			expect(mockNotifee.isBatteryOptimizationEnabled).not.toHaveBeenCalled()
		})

		it("reports false rather than throwing when the read fails", async () => {
			// This only drives an optional hint. A failed read must not invent a warning, and must not
			// take down whatever screen asked.
			mockNotifee.isBatteryOptimizationEnabled.mockRejectedValue(new Error("no such service"))

			await expect(batteryOptimization.isRestricted()).resolves.toBe(false)
		})
	})

	describe("openSettings", () => {
		it("opens the system battery-optimization screen on Android", async () => {
			await batteryOptimization.openSettings()

			expect(mockNotifee.openBatteryOptimizationSettings).toHaveBeenCalledTimes(1)
		})

		it("no-ops on iOS", async () => {
			platformMock.OS = "ios"

			await batteryOptimization.openSettings()

			expect(mockNotifee.openBatteryOptimizationSettings).not.toHaveBeenCalled()
		})

		it("does not throw when the intent cannot be resolved on this firmware", async () => {
			mockNotifee.openBatteryOptimizationSettings.mockRejectedValue(new Error("no activity found"))

			await expect(batteryOptimization.openSettings()).resolves.toBeUndefined()
		})
	})
})
