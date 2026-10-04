import { describe, expect, it } from "vitest"
import { deviceLabel, parseUserAgent, USER_AGENT_MAX_LENGTH, type ParsedUserAgent } from "@filen/shared"

const CASES: readonly (readonly [string, string, ParsedUserAgent])[] = [
	[
		"Chrome on macOS",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
		{ browser: "Chrome", browserVersion: "129.0.0.0", os: "macOS", osVersion: "10.15.7", device: "desktop" }
	],
	[
		"Chrome on Windows 10/11",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.120 Safari/537.36",
		{ browser: "Chrome", browserVersion: "128.0.6613.120", os: "Windows", osVersion: "10", device: "desktop" }
	],
	[
		"headless Chrome on macOS",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36",
		{ browser: "Headless Chrome", browserVersion: "141.0.7390.37", os: "macOS", osVersion: "10.15.7", device: "desktop" }
	],
	[
		"Edge on Windows",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.52",
		{ browser: "Edge", browserVersion: "129.0.2792.52", os: "Windows", osVersion: "10", device: "desktop" }
	],
	[
		"Firefox on Linux",
		"Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
		{ browser: "Firefox", browserVersion: "131.0", os: "Linux", device: "desktop" }
	],
	[
		"Firefox on Ubuntu",
		"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
		{ browser: "Firefox", browserVersion: "130.0", os: "Linux", device: "desktop" }
	],
	[
		"Safari on macOS",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
		{ browser: "Safari", browserVersion: "18.0", os: "macOS", osVersion: "10.15.7", device: "desktop" }
	],
	[
		"Safari on iPhone",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
		{ browser: "Safari", browserVersion: "18.0", os: "iOS", osVersion: "18.0", device: "mobile" }
	],
	[
		"Safari on iPad",
		"Mozilla/5.0 (iPad; CPU OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
		{ browser: "Safari", browserVersion: "17.6", os: "iPadOS", osVersion: "17.6.1", device: "tablet" }
	],
	[
		"Chrome on iPhone",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1",
		{ browser: "Chrome", browserVersion: "129.0.6668.69", os: "iOS", osVersion: "17.7", device: "mobile" }
	],
	[
		"Firefox on iPhone",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15",
		{ browser: "Firefox", browserVersion: "131.0", os: "iOS", osVersion: "17.7", device: "mobile" }
	],
	[
		"Chrome on an Android phone",
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.81 Mobile Safari/537.36",
		{ browser: "Chrome", browserVersion: "129.0.6668.81", os: "Android", osVersion: "14", device: "mobile" }
	],
	[
		"Chrome on an Android tablet",
		"Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
		{ browser: "Chrome", browserVersion: "128.0.0.0", os: "Android", osVersion: "13", device: "tablet" }
	],
	[
		"Samsung Internet",
		"Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
		{ browser: "Samsung Internet", browserVersion: "26.0", os: "Android", osVersion: "14", device: "mobile" }
	],
	[
		"Opera on Windows",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0",
		{ browser: "Opera", browserVersion: "114.0.0.0", os: "Windows", osVersion: "10", device: "desktop" }
	],
	[
		"Vivaldi on Linux",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Vivaldi/6.9.3447.48",
		{ browser: "Vivaldi", browserVersion: "6.9.3447.48", os: "Linux", device: "desktop" }
	],
	[
		"Brave when it names itself",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Brave/129",
		{ browser: "Brave", browserVersion: "129", os: "macOS", osVersion: "10.15.7", device: "desktop" }
	],
	[
		"Chrome on ChromeOS",
		"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
		{ browser: "Chrome", browserVersion: "129.0.0.0", os: "ChromeOS", device: "desktop" }
	],
	[
		"Windows 7",
		"Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
		{ browser: "Chrome", browserVersion: "109.0.0.0", os: "Windows", osVersion: "7", device: "desktop" }
	],
	[
		"the Filen desktop app",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) filen-desktop/2.0.29 Chrome/126.0.6478.234 Electron/31.7.0 Safari/537.36",
		{ app: "Filen Desktop", os: "macOS", osVersion: "10.15.7", device: "desktop" }
	],
	[
		"the Filen desktop app under its package name",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) @filen/desktop/3.0.0 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36",
		{ app: "Filen Desktop", os: "Windows", osVersion: "10", device: "desktop" }
	],
	[
		"another Electron app",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SomeApp/1.2.3 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36",
		{ browser: "Electron", browserVersion: "31.0.0", os: "Linux", device: "desktop" }
	],
	["the legacy Filen iOS app", "Filen/1490 CFNetwork/1568.100.1 Darwin/24.0.0", { app: "Filen", os: "iOS", device: "mobile" }],
	["an OkHttp client", "okhttp/4.12.0", { app: "OkHttp", os: "Android", device: "mobile" }],
	["the Filen CLI", "filen-cli", { app: "Filen CLI", device: "unknown" }],
	["axios", "axios/1.7.7", { app: "axios", device: "unknown" }],
	["Node.js fetch", "node", { app: "Node.js", device: "unknown" }],
	["curl", "curl/8.7.1", { app: "curl", device: "unknown" }]
]

describe("parseUserAgent", () => {
	for (const [name, ua, expected] of CASES) {
		it(`reads ${name}`, () => {
			expect(parseUserAgent(ua)).toEqual(expected)
		})
	}

	it("reads nothing from an empty, missing or unrecognisable UA", () => {
		expect(parseUserAgent("")).toEqual({ device: "unknown" })
		expect(parseUserAgent("   ")).toEqual({ device: "unknown" })
		expect(parseUserAgent(undefined)).toEqual({ device: "unknown" })
		expect(parseUserAgent(null)).toEqual({ device: "unknown" })
		expect(parseUserAgent("something/1.0")).toEqual({ device: "unknown" })
	})

	it("never reads past USER_AGENT_MAX_LENGTH", () => {
		const padding = "x".repeat(USER_AGENT_MAX_LENGTH)

		expect(parseUserAgent(`${padding} Firefox/131.0`)).toEqual({ device: "unknown" })
		expect(parseUserAgent(`Firefox/131.0 ${padding}`)).toEqual({ browser: "Firefox", browserVersion: "131.0", device: "unknown" })
	})

	it("parses a hostile 50 KB UA in bounded time", () => {
		// Thousands of "Version/" tokens and no "Safari/": the old joined Safari rule backtracked over the
		// rest of the string from each one (3.9 s at this size).
		const hostile = `${"Version/1 ".repeat(5_000)}Safari/1`
		const started = performance.now()

		expect(parseUserAgent(hostile)).toEqual({ device: "unknown" })
		expect(parseUserAgent(`${"Version/1 ".repeat(50)}Safari/1`)).toEqual({
			browser: "Safari",
			browserVersion: "1",
			device: "unknown"
		})
		expect(performance.now() - started).toBeLessThan(250)
	})
})

describe("deviceLabel", () => {
	it("names the browser and the OS", () => {
		expect(deviceLabel({ browser: "Chrome", browserVersion: "129", os: "macOS", device: "desktop" })).toBe("Chrome on macOS")
	})

	it("prefers a Filen app over the browser", () => {
		expect(deviceLabel({ app: "Filen Desktop", browser: "Electron", os: "Windows", device: "desktop" })).toBe(
			"Filen Desktop on Windows"
		)
	})

	it("falls back to the half that is known, then to the unknown label", () => {
		expect(deviceLabel({ browser: "Firefox", device: "unknown" })).toBe("Firefox")
		expect(deviceLabel({ os: "Android", device: "mobile" })).toBe("Android")
		expect(deviceLabel({ device: "unknown" })).toBe("Unknown device")
	})

	it("takes the app's own strings", () => {
		const strings = { browserOnOs: (browser: string, os: string) => `${browser} auf ${os}`, unknown: "Unbekannt" }

		expect(deviceLabel({ browser: "Safari", os: "iOS", device: "mobile" }, strings)).toBe("Safari auf iOS")
		expect(deviceLabel({ device: "unknown" }, strings)).toBe("Unbekannt")
	})
})
