import { test } from "./fixtures"
import { bootToSignIn } from "./helpers/listing"
import { waitForSwReady } from "./helpers/sw"
import { FIREFOX_SERVICE_WORKERS_BLOCKED } from "./helpers/firefox"

// Registration is PROD-only and gated on boot ready, so this runs against preview. webkit is excluded
// (not tagged @no-sdk) — its service-worker support under Playwright is unreliable.
//
// Its own file rather than a second test in sw.spec.ts: lane membership is decided per FILE
// (playwright.config.ts), and sw.spec.ts's live zip round trip pins that file to the serial write
// lane. This probe is unauthenticated and takes no drive lock, so it belongs in the read lane, where
// a transient service-worker registration blip can retry.
test.describe("service worker version endpoint", () => {
	test.use({ injectSession: false })

	test("registers and answers the version endpoint", async ({ page, browserName }) => {
		test.skip(browserName === "firefox", FIREFOX_SERVICE_WORKERS_BLOCKED)

		// SW registration fires once the app reaches a ready shell.
		await bootToSignIn(page)

		await waitForSwReady(page)
	})
})
