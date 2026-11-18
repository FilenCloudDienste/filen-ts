import { test, expect } from "./fixtures"
import { BOOT_SETTLE_TIMEOUT_MS } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"

// The real Turnstile widget against the page's CSP, which admits its frame only under the challenge path. Nothing is
// stubbed but the report endpoint (never reached: the dialog is not sent). public-links.spec.ts stubs the widget's
// script, so this is the one test that would see the live widget move its frame elsewhere.

const RANDOM_UUID = "deadbeef-0000-4000-8000-0123456789ab"
const HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const CHALLENGE_HOST = "https://challenges.cloudflare.com/"
const CHALLENGE_PATH = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/"
const REPORT_ENDPOINT = "https://filen.io/api/v1/abuse-report"
// The live widget loads its script, then its frame, from Cloudflare.
const WIDGET_TIMEOUT_MS = 30_000

declare global {
	interface Window {
		__frameViolations?: string[]
	}
}

test.describe("Turnstile challenge frame (real widget)", () => {
	test.use({ injectSession: false, serviceWorkers: "block" })

	test("loads under the challenge path with no frame-src violation", async ({ page, context }) => {
		const cspViolations = trackCspViolations(page)
		const challengeDocuments: string[] = []

		// Recorded by the page itself: a violation event names the directive, which a console message does not in every
		// engine.
		await page.addInitScript(() => {
			window.__frameViolations = []
			document.addEventListener("securitypolicyviolation", event => {
				if (event.effectiveDirective === "frame-src" || event.effectiveDirective === "child-src") {
					window.__frameViolations?.push(`${event.effectiveDirective} ${event.blockedURI}`)
				}
			})
		})
		context.on("request", request => {
			if (request.resourceType() === "document" && request.url().startsWith(CHALLENGE_HOST)) {
				challengeDocuments.push(request.url())
			}
		})
		await page.route(REPORT_ENDPOINT, route => route.abort())

		await page.goto(`/f/${RANDOM_UUID}#${HEX_KEY}`)
		await page.getByRole("button", { name: "Report abuse" }).click({ timeout: BOOT_SETTLE_TIMEOUT_MS })
		await expect(page.getByRole("dialog", { name: "Report abuse" })).toBeVisible()

		await expect
			.poll(() => page.frames().filter(frame => frame.url().startsWith(CHALLENGE_PATH)).length, { timeout: WIDGET_TIMEOUT_MS })
			.toBeGreaterThan(0)

		expect(challengeDocuments.length).toBeGreaterThan(0)
		expect(challengeDocuments.filter(url => !url.startsWith(CHALLENGE_PATH))).toEqual([])
		expect(await page.evaluate(() => window.__frameViolations ?? [])).toEqual([])
		expect(cspViolations.filter(message => /frame/i.test(message))).toEqual([])
	})
})
