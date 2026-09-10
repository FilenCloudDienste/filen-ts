import { test, expect } from "./fixtures"
import { waitForSwReady } from "./helpers/sw"

// Registration is PROD-only and gated on boot ready, so this runs against preview. webkit is excluded
// (not tagged @no-sdk) — its service-worker support under Playwright is unreliable.
//
// Its own file rather than a second test in sw.spec.ts: lane membership is decided per FILE
// (playwright.config.ts), and sw.spec.ts's live zip round trip pins that file to the serial write
// lane. This probe is unauthenticated and takes no drive lock, so it belongs in the read lane, where
// a transient service-worker registration blip can retry.
test.describe("service worker version endpoint", () => {
	test("registers and answers the version endpoint", async ({ page, browserName }) => {
		// Playwright-firefox's service-worker support under COI is unreliable (registration never
		// controls the page), so this is verified on chromium; webkit is excluded from the suite.
		test.skip(browserName === "firefox", "service workers are unreliable on Playwright-firefox under COI")

		await page.goto("/")

		// SW registration fires once the app reaches a ready shell.
		await expect(page.getByText("Sign in to Filen")).toBeVisible()

		await waitForSwReady(page)
	})
})
