import { vi, describe, it, expect, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
	setStringAsync: vi.fn<(text: string) => Promise<boolean>>()
}))

vi.mock("expo-clipboard", () => ({ setStringAsync: h.setStringAsync }))
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))
vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))

import { copyToClipboard } from "@/lib/clipboard"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"

beforeEach(() => {
	vi.clearAllMocks()
})

describe("copyToClipboard", () => {
	it("writes the text and toasts the success message", async () => {
		h.setStringAsync.mockResolvedValue(true)

		await copyToClipboard("secret", "copied", "settings", "copy failed")

		expect(h.setStringAsync).toHaveBeenCalledWith("secret")
		expect(alerts.normal).toHaveBeenCalledWith("copied")
		expect(alerts.error).not.toHaveBeenCalled()
		expect(logger.error).not.toHaveBeenCalled()
	})

	it("logs and alerts the error instead of toasting on failure", async () => {
		const error = new Error("denied")

		h.setStringAsync.mockRejectedValue(error)

		await copyToClipboard("secret", "copied", "chats", "copy failed")

		expect(logger.error).toHaveBeenCalledWith("chats", "copy failed", { error })
		expect(alerts.error).toHaveBeenCalledWith(error)
		expect(alerts.normal).not.toHaveBeenCalled()
	})
})
