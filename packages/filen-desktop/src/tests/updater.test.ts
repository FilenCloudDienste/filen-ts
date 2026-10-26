import { describe, expect, it } from "vitest"
import { shouldCheckForUpdate, UPDATE_CHECK_INTERVAL_MS, UPDATE_FIRST_CHECK_DELAY_MS, testUpdateFeed } from "../main/updater.ts"

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

describe("testUpdateFeed", () => {
	it("takes an explicit-port http feed on 127.0.0.1 and normalises the trailing slash", () => {
		expect(testUpdateFeed("http://127.0.0.1:43210")).toBe("http://127.0.0.1:43210/")
		expect(testUpdateFeed("http://127.0.0.1:43210/feed/")).toBe("http://127.0.0.1:43210/feed/")
	})

	it.each([
		undefined,
		"",
		"not a url",
		"https://127.0.0.1:43210/",
		"http://localhost:43210/",
		"http://127.0.0.2:43210/",
		"http://0.0.0.0:43210/",
		"http://127.0.0.1/",
		"http://user:pass@127.0.0.1:43210/",
		"http://127.0.0.1:43210/?x=1",
		"http://127.0.0.1:43210/#x",
		"http://cdn.filen.io:80/"
	])("refuses %s", value => {
		expect(testUpdateFeed(value)).toBeNull()
	})
})
