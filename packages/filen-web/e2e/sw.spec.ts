import { test, expect } from "@playwright/test"

// Registration is PROD-only and gated on boot ready, so this runs against preview. webkit is excluded
// (not tagged @no-sdk) — its service-worker support under Playwright is unreliable.
test.describe("service worker", () => {
	test("registers and answers the version endpoint", async ({ page, browserName }) => {
		// Playwright-firefox's service-worker support under COI is unreliable (registration never
		// controls the page), so this is verified on chromium; webkit is excluded from the suite.
		test.skip(browserName === "firefox", "service workers are unreliable on Playwright-firefox under COI")

		await page.goto("/")

		// SW registration fires once the app reaches a ready shell.
		await expect(page.getByText("Sign in to Filen")).toBeVisible()

		// Poll the synthetic endpoint until the worker has activated and claimed the page.
		await expect
			.poll(
				() =>
					page.evaluate(async () => {
						try {
							const res = await fetch("/__sw/version")

							return res.ok ? ((await res.json()) as unknown) : null
						} catch {
							return null
						}
					}),
				{ timeout: 30_000 }
			)
			.toEqual({ v: 1 })
	})
})
