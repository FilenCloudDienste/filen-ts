import { describe, expect, it } from "vitest"
import { shouldCheckForUpdate, UPDATE_CHECK_INTERVAL_MS, UPDATE_FIRST_CHECK_DELAY_MS } from "../main/updater.ts"

describe("shouldCheckForUpdate", () => {
	it("checks when idle with nothing downloaded", () => {
		expect(shouldCheckForUpdate({ checking: false, ready: null })).toBe(true)
	})

	it("never overlaps a running check or download", () => {
		expect(shouldCheckForUpdate({ checking: true, ready: null })).toBe(false)
	})

	it("stops once an update waits for a restart", () => {
		expect(shouldCheckForUpdate({ checking: false, ready: "4.0.1" })).toBe(false)
	})
})

describe("schedule", () => {
	it("checks soon after start, then hourly", () => {
		expect(UPDATE_FIRST_CHECK_DELAY_MS).toBeLessThan(60 * 1000)
		expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000)
	})
})
