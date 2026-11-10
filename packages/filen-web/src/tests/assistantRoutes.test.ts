import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => undefined }))

const { screenOfPath } = await import("@/features/assistant/tools/routes")

describe("assistant routes", () => {
	// settings_storage opens Advanced, where the caches live, without taking the page's own name.
	it("reports Advanced as settings_advanced", () => {
		expect(screenOfPath("/settings/advanced")).toBe("settings_advanced")
		expect(screenOfPath("/settings/account")).toBe("settings_account")
	})
})
