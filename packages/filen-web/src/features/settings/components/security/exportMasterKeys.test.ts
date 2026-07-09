import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildMasterKeysFilename, shouldShowExportReminder } from "@/features/settings/components/security/exportMasterKeys.logic"

describe("buildMasterKeysFilename", () => {
	it("joins email, the masterKeys marker, and the timestamp with dots, ending .txt", () => {
		expect(buildMasterKeysFilename("user@example.com", 1751000000000)).toBe("user@example.com.masterKeys.1751000000000.txt")
	})
})

describe("shouldShowExportReminder", () => {
	function params(overrides: Partial<Parameters<typeof shouldShowExportReminder>[0]> = {}) {
		return {
			accountStatus: "success" as const,
			didExportMasterKeys: false,
			alreadyFired: false,
			...overrides
		}
	}

	it("shows once: settled successfully, not yet exported, not yet fired", () => {
		expect(shouldShowExportReminder(params())).toBe(true)
	})

	it("never shows again once already fired this boot", () => {
		expect(shouldShowExportReminder(params({ alreadyFired: true }))).toBe(false)
	})

	it("never shows once the server reports the keys as exported", () => {
		expect(shouldShowExportReminder(params({ didExportMasterKeys: true }))).toBe(false)
	})

	it("never shows while the account query is pending", () => {
		expect(shouldShowExportReminder(params({ accountStatus: "pending" }))).toBe(false)
	})

	it("never shows on an account query error — an error must not read as 'keys exported'", () => {
		expect(shouldShowExportReminder(params({ accountStatus: "error" }))).toBe(false)
	})
})

describe("reminderFired / markReminderFired (module-level singleton, reset via fresh import)", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	it("starts unfired and flips permanently once marked", async () => {
		const { reminderFired, markReminderFired } = await import("@/features/settings/components/security/exportMasterKeys.logic")

		expect(reminderFired()).toBe(false)

		markReminderFired()

		expect(reminderFired()).toBe(true)
	})

	it("a fresh module instance (simulating a new boot) starts unfired again", async () => {
		const first = await import("@/features/settings/components/security/exportMasterKeys.logic")
		first.markReminderFired()
		expect(first.reminderFired()).toBe(true)

		vi.resetModules()

		const second = await import("@/features/settings/components/security/exportMasterKeys.logic")
		expect(second.reminderFired()).toBe(false)
	})
})
