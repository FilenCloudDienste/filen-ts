import { afterEach, describe, expect, it, vi } from "vitest"

// A phone is an iPhone, or Android whose browser says "Mobile", or a phone asking for desktop sites (a Mac or Linux user
// agent on a touch screen with a phone's short side). An iPad (either user agent), an Android tablet or a touch laptop
// is not.

const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
const ANDROID_PHONE =
	"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
const IPAD =
	"Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
// What Safari on an iPhone or iPad sends for a desktop site, and Chrome on Android.
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const CASES: readonly (readonly [string, string, number, readonly [number, number], boolean])[] = [
	["an iPhone", IPHONE, 5, [390, 844], true],
	["an Android phone", ANDROID_PHONE, 5, [412, 915], true],
	["an iPhone asking for desktop sites", MAC, 5, [390, 844], true],
	["an Android phone asking for desktop sites", LINUX, 5, [412, 915], true],
	["an iPad", IPAD, 5, [820, 1180], false],
	["an iPad asking for desktop sites", MAC, 5, [744, 1133], false],
	["an Android tablet", ANDROID_TABLET, 5, [800, 1280], false],
	["a touch laptop", WINDOWS, 10, [1280, 800], false],
	["a Mac", MAC, 0, [1512, 982], false]
]

afterEach(() => {
	vi.unstubAllGlobals()
	vi.resetModules()
})

describe("deviceProfile().phone", () => {
	it.each(CASES)("reads %s", async (_name, userAgent, maxTouchPoints, [width, height], phone) => {
		vi.stubGlobal("navigator", { userAgent, maxTouchPoints })
		vi.stubGlobal("screen", { width, height })

		const { deviceProfile } = await import("@/lib/deviceProfile")

		expect(deviceProfile().phone).toBe(phone)
	})
})
