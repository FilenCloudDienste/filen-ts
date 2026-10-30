import { describe, expect, it } from "vitest"
import type { DesktopFileProviderErrorCode, DesktopFileProviderState } from "@filen/shared/desktop"
import { mounts } from "@/locales/en/mounts"
import {
	FILE_PROVIDER_CALLOUT_KEY,
	FILE_PROVIDER_CALLOUT_TONE,
	FILE_PROVIDER_ERROR_KEY,
	FILE_PROVIDER_STATUS_KEY,
	FILE_PROVIDER_STATUS_TONE,
	fileProviderCallouts,
	fileProviderStatus,
	fileProviderSwitchLocked
} from "@/features/mounts/lib/fileProviderStatus.logic"

const CATALOG: Record<string, string> = mounts

const OFF: DesktopFileProviderState = { supported: true, enabled: false, lockBlocked: false, userEnabled: null, translocated: false }
const ON: DesktopFileProviderState = { ...OFF, enabled: true, userEnabled: true }

const ERROR_CODES = [
	"unsupported",
	"appLocked",
	"noSession",
	"translocated",
	"extensionMissing",
	"notFound",
	"timeout",
	"unknown"
] as const satisfies readonly DesktopFileProviderErrorCode[]

describe("fileProviderStatus", () => {
	it("reads the shell's state", () => {
		expect(fileProviderStatus(null, null, null)).toBe("off")
		expect(fileProviderStatus(OFF, null, null)).toBe("off")
		expect(fileProviderStatus(ON, null, null)).toBe("on")
		expect(fileProviderStatus({ ...ON, userEnabled: false }, null, null)).toBe("needsEnabling")
		expect(fileProviderStatus({ ...ON, userEnabled: null }, null, null)).toBe("error")
	})

	it("shows a switch in flight, then a failure, over the state", () => {
		expect(fileProviderStatus(OFF, "enable", "unknown")).toBe("starting")
		expect(fileProviderStatus(ON, "disable", null)).toBe("stopping")
		expect(fileProviderStatus(ON, null, "timeout")).toBe("error")
	})

	it("has a label and a tone for every status", () => {
		for (const key of Object.values(FILE_PROVIDER_STATUS_KEY)) {
			expect(CATALOG[key], key).toBeTypeOf("string")
		}

		expect(FILE_PROVIDER_STATUS_TONE).toEqual({
			off: "off",
			starting: "busy",
			stopping: "busy",
			on: "on",
			needsEnabling: "warning",
			error: "error"
		})
	})
})

describe("fileProviderSwitchLocked", () => {
	it("waits for the first read and for a call in flight", () => {
		expect(fileProviderSwitchLocked(null, null)).toBe(true)
		expect(fileProviderSwitchLocked(OFF, "enable")).toBe(true)
		expect(fileProviderSwitchLocked(OFF, null)).toBe(false)
	})

	it("keeps it from going on under an app lock or translocated, but always lets it go off", () => {
		expect(fileProviderSwitchLocked({ ...OFF, lockBlocked: true }, null)).toBe(true)
		expect(fileProviderSwitchLocked({ ...OFF, translocated: true }, null)).toBe(true)
		expect(fileProviderSwitchLocked({ ...ON, lockBlocked: true, translocated: true }, null)).toBe(false)
		expect(fileProviderSwitchLocked({ ...OFF, supported: false }, null)).toBe(true)
	})
})

describe("fileProviderCallouts", () => {
	it("tells nothing before the first read, while on, or while off with nothing in the way", () => {
		expect(fileProviderCallouts(null, null, "unknown")).toEqual([])
		expect(fileProviderCallouts(ON, null, null)).toEqual([])
		expect(fileProviderCallouts(OFF, null, null)).toEqual([])
	})

	it("asks to switch it on in System Settings, and tells a failed registration", () => {
		expect(fileProviderCallouts({ ...ON, userEnabled: false }, null, null)).toEqual(["needsEnabling"])
		expect(fileProviderCallouts({ ...ON, userEnabled: null }, null, null)).toEqual(["notRegistered"])
	})

	it("tells the app lock and translocation first, without repeating their refusals", () => {
		expect(fileProviderCallouts({ ...OFF, lockBlocked: true }, null, "appLocked")).toEqual(["lockBlocked"])
		expect(fileProviderCallouts({ ...OFF, translocated: true }, null, "translocated")).toEqual(["translocated"])
		expect(fileProviderCallouts({ ...OFF, translocated: true, lockBlocked: true }, null, "timeout")).toEqual([
			"translocated",
			"lockBlocked",
			"error"
		])
	})

	it("tells a failure over the System Settings switch, and nothing but the blockers while a call runs", () => {
		expect(fileProviderCallouts({ ...ON, userEnabled: false }, null, "unknown")).toEqual(["error"])
		expect(fileProviderCallouts({ ...ON, userEnabled: false, lockBlocked: true }, "disable", "unknown")).toEqual(["lockBlocked"])
	})

	it("has a tone for every callout and a string for every one with its own text", () => {
		expect(Object.keys(FILE_PROVIDER_CALLOUT_TONE).sort()).toEqual([
			"error",
			"lockBlocked",
			"needsEnabling",
			"notRegistered",
			"translocated"
		])

		for (const key of Object.values(FILE_PROVIDER_CALLOUT_KEY)) {
			expect(CATALOG[key], key).toBeTypeOf("string")
		}
	})
})

describe("FILE_PROVIDER_ERROR_KEY", () => {
	it("labels every error code", () => {
		expect(Object.keys(FILE_PROVIDER_ERROR_KEY).sort()).toEqual([...ERROR_CODES].sort())

		for (const [code, key] of Object.entries(FILE_PROVIDER_ERROR_KEY)) {
			expect(CATALOG[key], `${code} → ${key}`).toBeTypeOf("string")
		}
	})
})

describe("Filen in Finder copy", () => {
	it("says directory, never folder", () => {
		for (const [key, value] of Object.entries(CATALOG)) {
			if (key.startsWith("finder") || key === "mountsFinder") {
				expect(value.toLowerCase(), key).not.toContain("folder")
			}
		}
	})
})
