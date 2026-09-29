import { describe, expect, it } from "vitest"
import {
	buildMasterKeysFilename,
	shouldShowExportReminder,
	isStorageOverLimit,
	selectActiveReminder
} from "@/features/settings/components/security/exportMasterKeys.logic"

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

describe("isStorageOverLimit", () => {
	it("is true only when used strictly exceeds max (bigint)", () => {
		expect(isStorageOverLimit(11n, 10n)).toBe(true)
		expect(isStorageOverLimit(10n, 10n)).toBe(false)
		expect(isStorageOverLimit(9n, 10n)).toBe(false)
	})

	it("stays exact past Number's safe-integer range", () => {
		const max = 9_007_199_254_740_993n // Number.MAX_SAFE_INTEGER + 2
		expect(isStorageOverLimit(max + 1n, max)).toBe(true)
		expect(isStorageOverLimit(max, max)).toBe(false)
	})
})

describe("selectActiveReminder (one-at-a-time sequencing, keys before storage)", () => {
	function params(overrides: Partial<Parameters<typeof selectActiveReminder>[0]> = {}) {
		return {
			accountStatus: "success" as const,
			didExportMasterKeys: false,
			storageOverLimit: false,
			keysFired: false,
			storageFired: false,
			...overrides
		}
	}

	it("shows keys first when both reminders are eligible", () => {
		expect(selectActiveReminder(params({ storageOverLimit: true }))).toBe("exportKeys")
	})

	it("advances to storage once keys has fired and storage is over limit", () => {
		expect(selectActiveReminder(params({ storageOverLimit: true, keysFired: true }))).toBe("storage")
	})

	it("shows storage alone when keys is not eligible (already exported)", () => {
		expect(selectActiveReminder(params({ didExportMasterKeys: true, storageOverLimit: true }))).toBe("storage")
	})

	it("shows nothing once both have fired", () => {
		expect(selectActiveReminder(params({ storageOverLimit: true, keysFired: true, storageFired: true }))).toBe(null)
	})

	it("shows nothing when neither condition holds", () => {
		expect(selectActiveReminder(params({ didExportMasterKeys: true }))).toBe(null)
	})

	it("never surfaces a reminder until the account query has settled successfully", () => {
		expect(selectActiveReminder(params({ accountStatus: "pending", storageOverLimit: true }))).toBe(null)
		expect(selectActiveReminder(params({ accountStatus: "error", storageOverLimit: true }))).toBe(null)
	})
})
