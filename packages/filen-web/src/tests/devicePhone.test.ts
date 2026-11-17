import { afterEach, describe, expect, it, vi } from "vitest"

// A phone is an iPhone, or Android whose browser says "Mobile"; an iPad (either user agent) or an Android tablet is not.

const UAS: readonly (readonly [string, boolean])[] = [
	[
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
		true
	],
	["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", true],
	[
		"Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
		false
	],
	["Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", false],
	["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", false]
]

afterEach(() => {
	vi.unstubAllGlobals()
	vi.resetModules()
})

describe("deviceProfile().phone", () => {
	it.each(UAS)("reads %s", async (userAgent, phone) => {
		vi.stubGlobal("navigator", { userAgent, maxTouchPoints: 5 })

		const { deviceProfile } = await import("@/lib/deviceProfile")

		expect(deviceProfile().phone).toBe(phone)
	})
})
