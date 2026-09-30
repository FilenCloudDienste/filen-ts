import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const { mockAlert, mockInput, mockAlertsError } = vi.hoisted(() => ({
	mockAlert: vi.fn(),
	mockInput: vi.fn(),
	mockAlertsError: vi.fn()
}))

vi.mock("@/lib/prompts", () => ({ default: { alert: mockAlert, input: mockInput } }))
vi.mock("@/lib/alerts", () => ({ default: { error: mockAlertsError } }))

import logger from "@/lib/logger"
import { confirmPrompt, inputPrompt } from "@/lib/promptFlow"

const OPTIONS = { title: "title", message: "message" }
const LOG = { tag: "tag", message: "prompt failed", context: { uuid: "u1" } }

describe("promptFlow", () => {
	beforeEach(() => {
		mockAlert.mockReset()
		mockInput.mockReset()
		mockAlertsError.mockReset()
		vi.mocked(logger.warn).mockReset()
		vi.mocked(logger.error).mockReset()
	})

	describe("confirmPrompt", () => {
		it("passes the options through and returns true when confirmed", async () => {
			mockAlert.mockResolvedValue({ cancelled: false })

			await expect(confirmPrompt(OPTIONS, LOG)).resolves.toBe(true)
			expect(mockAlert).toHaveBeenCalledWith(OPTIONS)
			expect(mockAlertsError).not.toHaveBeenCalled()
		})

		it("returns false when cancelled", async () => {
			mockAlert.mockResolvedValue({ cancelled: true })

			await expect(confirmPrompt(OPTIONS, LOG)).resolves.toBe(false)
			expect(mockAlertsError).not.toHaveBeenCalled()
		})

		it("logs at warn by default with the context and error, surfaces it and returns false on a throw", async () => {
			const error = new Error("boom")

			mockAlert.mockRejectedValue(error)

			await expect(confirmPrompt(OPTIONS, LOG)).resolves.toBe(false)
			expect(logger.warn).toHaveBeenCalledWith("tag", "prompt failed", { uuid: "u1", error })
			expect(logger.error).not.toHaveBeenCalled()
			expect(mockAlertsError).toHaveBeenCalledWith(error)
		})

		it("logs at the site's level", async () => {
			const error = new Error("boom")

			mockAlert.mockRejectedValue(error)

			await expect(confirmPrompt(OPTIONS, { ...LOG, level: "error" })).resolves.toBe(false)
			expect(logger.error).toHaveBeenCalledWith("tag", "prompt failed", { uuid: "u1", error })
			expect(logger.warn).not.toHaveBeenCalled()
			expect(mockAlertsError).toHaveBeenCalledWith(error)
		})
	})

	describe("inputPrompt", () => {
		it("passes the options through and returns the value as entered", async () => {
			mockInput.mockResolvedValue({ cancelled: false, value: "  name  " })

			await expect(inputPrompt(OPTIONS, LOG)).resolves.toBe("  name  ")
			expect(mockInput).toHaveBeenCalledWith(OPTIONS)
		})

		it("trims when asked", async () => {
			mockInput.mockResolvedValue({ cancelled: false, value: "  name  " })

			await expect(inputPrompt(OPTIONS, LOG, { trim: true })).resolves.toBe("name")
		})

		it("returns null when cancelled", async () => {
			mockInput.mockResolvedValue({ cancelled: true })

			await expect(inputPrompt(OPTIONS, LOG, { allowEmpty: true })).resolves.toBeNull()
			expect(mockAlertsError).not.toHaveBeenCalled()
		})

		it("rejects an empty value, including one that is empty after trimming", async () => {
			mockInput.mockResolvedValue({ cancelled: false, value: "" })

			await expect(inputPrompt(OPTIONS, LOG)).resolves.toBeNull()

			mockInput.mockResolvedValue({ cancelled: false, value: "   " })

			await expect(inputPrompt(OPTIONS, LOG, { trim: true })).resolves.toBeNull()
		})

		it("returns an empty value when allowEmpty is set", async () => {
			mockInput.mockResolvedValue({ cancelled: false, value: "   " })

			await expect(inputPrompt(OPTIONS, LOG, { trim: true, allowEmpty: true })).resolves.toBe("")
		})

		it("logs at warn by default, surfaces the error and returns null on a throw", async () => {
			const error = new Error("boom")

			mockInput.mockRejectedValue(error)

			await expect(inputPrompt(OPTIONS, LOG)).resolves.toBeNull()
			expect(logger.warn).toHaveBeenCalledWith("tag", "prompt failed", { uuid: "u1", error })
			expect(logger.error).not.toHaveBeenCalled()
			expect(mockAlertsError).toHaveBeenCalledWith(error)
		})

		it("logs at the site's level on a throw", async () => {
			const error = new Error("boom")

			mockInput.mockRejectedValue(error)

			await expect(inputPrompt(OPTIONS, { ...LOG, level: "error" })).resolves.toBeNull()
			expect(logger.error).toHaveBeenCalledWith("tag", "prompt failed", { uuid: "u1", error })
			expect(logger.warn).not.toHaveBeenCalled()
			expect(mockAlertsError).toHaveBeenCalledWith(error)
		})
	})
})
