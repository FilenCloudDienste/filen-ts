import { test, expect } from "./fixtures"

test.describe("boot", () => {
	test("boots to a ready shell and forwards to sign-in when unauthenticated", async ({ page }) => {
		await page.goto("/")

		// The sign-in surface only renders once the boot store reaches "ready" (the root gate holds the
		// boot screen until then), so its presence is the user-visible proof of a ready boot phase. A
		// healthy boot never shows the boot-error screen.
		await expect(page.getByText("Sign in to Filen")).toBeVisible()
		await expect(page.getByText("Filen could not start")).toHaveCount(0)
	})

	test("an injected session boots authenticated and an authed read succeeds", async ({ page, injectedSession, browserName }) => {
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/")

		// The hook injects the session then re-runs the guards, so the authed shell renders — which is
		// itself proof the session authenticated the router (`hasClient()` gated the redirect).
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()
		// The drive listing itself (not the old placeholder shell) is now the authed landing surface —
		// its toolbar is a stable, always-rendered proof the route mounted past the shell chrome.
		await expect(page.getByRole("button", { name: "New directory", exact: true })).toBeVisible()

		// The desktop system strip (Electron plumbing) is runtime-detected off window.desktop, which a
		// plain browser never defines - proves the strip has zero footprint here, not merely that it
		// wasn't asserted for.
		expect(await page.evaluate(() => window.desktop)).toBeUndefined()
		await expect(page.getByRole("button", { name: "Close window" })).toHaveCount(0)

		// A rail tooltip renders on hover.
		await page.getByRole("button", { name: "Notes" }).hover()
		await expect(page.getByText("Coming soon")).toBeVisible()

		// A real authenticated read against the API settles true — proves the injected session
		// authenticates, not merely that a Client object exists. The SDK worker's cross-origin fetch
		// under COI hangs on Playwright-firefox, so the network read is verified on the other engines;
		// firefox coverage stops at the authed-shell render above.
		if (browserName !== "firefox") {
			const authed = await page.evaluate(() => window.__filenE2E.probeAuthedRead())
			expect(authed).toBe(true)
		}
	})
})
