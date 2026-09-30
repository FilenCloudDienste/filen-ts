import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockOpenURL, mockAlertsError, mockLoggerError } = vi.hoisted(() => ({
	mockOpenURL: vi.fn(),
	mockAlertsError: vi.fn(),
	mockLoggerError: vi.fn()
}))

vi.mock("react-native", () => ({
	Linking: {
		openURL: mockOpenURL
	}
}))

vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))

vi.mock("@/lib/alerts", () => ({
	default: {
		error: mockAlertsError
	}
}))

vi.mock("@/lib/logger", () => ({
	default: {
		error: mockLoggerError
	}
}))

import { openTrustedUrl } from "@/lib/openTrustedUrl"

const URL = "https://filen.io/terms"

beforeEach(() => {
	vi.clearAllMocks()
})

describe("openTrustedUrl", () => {
	it("opens the url without alerting on success", async () => {
		mockOpenURL.mockResolvedValueOnce(undefined)

		await openTrustedUrl("settings", URL)

		expect(mockOpenURL).toHaveBeenCalledWith(URL)
		expect(mockAlertsError).not.toHaveBeenCalled()
		expect(mockLoggerError).not.toHaveBeenCalled()
	})

	it("logs under the tag and alerts when openURL rejects", async () => {
		const error = new Error("no handler")

		mockOpenURL.mockRejectedValueOnce(error)

		await openTrustedUrl("auth", URL)

		expect(mockLoggerError).toHaveBeenCalledWith("auth", "failed to open url", {
			url: URL,
			error
		})
		expect(mockAlertsError).toHaveBeenCalledWith(error)
	})
})
