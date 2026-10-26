import { describe, expect, it } from "vitest"
import { streamsSafely } from "@/features/drive/lib/downloadAsZip"

// A bulk Download as streams its archive through the service worker everywhere but Linux WebKit, which stops the
// page's requests while the download starts at a point the page cannot wait for.
describe("streamsSafely", () => {
	it.each([
		[
			"Safari on macOS",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
		],
		[
			"Safari on iOS",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"
		],
		["Chrome on Linux", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"],
		["Firefox on Linux", "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0"],
		[
			"Chrome on Android",
			"Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36"
		]
	])("streams on %s", (_name, userAgent) => {
		expect(streamsSafely(userAgent)).toBe(true)
	})

	it("gathers in memory on Linux WebKit", () => {
		expect(streamsSafely("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15")).toBe(
			false
		)
	})
})
