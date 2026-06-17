import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

import logger from "@/lib/logger"
import { forwardDomConsoleLog } from "@/hooks/useDomEvents/forwardDomLog"

describe("forwardDomConsoleLog", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("forwards a console envelope to the logger under the 'webview' tag and returns true", () => {
		const handled = forwardDomConsoleLog({ __filenLog: { level: "error", message: "render crashed" } })

		expect(handled).toBe(true)
		expect(logger.error).toHaveBeenCalledWith("webview", "render crashed")
	})

	it("maps console.log → logger.debug", () => {
		forwardDomConsoleLog({ __filenLog: { level: "log", message: "trace" } })

		expect(logger.debug).toHaveBeenCalledWith("webview", "trace")
	})

	it("maps warn / info 1:1", () => {
		forwardDomConsoleLog({ __filenLog: { level: "warn", message: "w" } })
		forwardDomConsoleLog({ __filenLog: { level: "info", message: "i" } })

		expect(logger.warn).toHaveBeenCalledWith("webview", "w")
		expect(logger.info).toHaveBeenCalledWith("webview", "i")
	})

	it("returns false for non-envelope messages (so the app handler still runs)", () => {
		expect(forwardDomConsoleLog({ type: "valueChange", value: "x" })).toBe(false)
		expect(forwardDomConsoleLog(null)).toBe(false)
		expect(forwardDomConsoleLog("plain string")).toBe(false)
		expect(forwardDomConsoleLog(42)).toBe(false)

		expect(logger.error).not.toHaveBeenCalled()
	})

	it("returns false for a malformed envelope (missing message)", () => {
		expect(forwardDomConsoleLog({ __filenLog: { level: "error" } })).toBe(false)
	})
})
