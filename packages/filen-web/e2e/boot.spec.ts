import { test, expect } from "./fixtures"
import { waitForE2eHooks } from "./helpers/e2eHooks"
import { BOOT_SETTLE_TIMEOUT_MS, bootTo } from "./helpers/listing"

test.describe("boot", () => {
	test("boots to a ready shell and forwards to sign-in when unauthenticated", async ({ page }) => {
		await page.goto("/")

		// The sign-in surface only renders once the boot store reaches "ready" (the root gate holds the
		// boot screen until then), so its presence is the user-visible proof of a ready boot phase. A
		// healthy boot never shows the boot-error screen. Boot budget, not the expect default: this is
		// a cold wasm init + OPFS open, which the 10s UI-responsiveness default was never sized for.
		await expect(page.getByText("Sign in to Filen")).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
		await expect(page.getByText("Filen could not start")).toHaveCount(0)

		// Legal footer on the sign-in screen — route wiring has no unit-test surface, and this test
		// already has the page loaded, so it costs no extra navigation.
		await expect(page.getByRole("link", { name: "Terms of Service", exact: true })).toHaveAttribute("href", "https://filen.io/terms")
		await expect(page.getByRole("link", { name: "Privacy Policy", exact: true })).toHaveAttribute("href", "https://filen.io/privacy")
	})

	test("an injected session boots authenticated and an authed read succeeds", async ({ page, injectedSession, browserName }) => {
		expect(injectedSession.length).toBeGreaterThan(0)

		// bootTo's own nav wait is the assertion this test wants: the authed shell rendering is itself
		// proof the session authenticated the router (`hasClient()` gated the redirect).
		await bootTo(page, "/")

		// The drive listing itself (not the old placeholder shell) is now the authed landing surface —
		// its toolbar is a stable, always-rendered proof the route mounted past the shell chrome. .first():
		// an empty writable root also renders a second identical button in its empty-state "+ Add"; the
		// toolbar's copy is always first in DOM order.
		await expect(page.getByRole("button", { name: "New directory", exact: true }).first()).toBeVisible({
			timeout: BOOT_SETTLE_TIMEOUT_MS
		})

		// The desktop system strip (Electron plumbing) is runtime-detected off window.desktop, which a
		// plain browser never defines - proves the strip has zero footprint here, not merely that it
		// wasn't asserted for.
		expect(await page.evaluate(() => window.desktop)).toBeUndefined()
		await expect(page.getByRole("button", { name: "Close window" })).toHaveCount(0)

		// Chats and Notes are both real, enabled rail Links now — the chats module promoted the last
		// remaining "coming soon" module out of the inert loop (same precedent as the notes promotion).
		await expect(page.getByRole("link", { name: "Chats", exact: true })).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
		await expect(page.getByRole("link", { name: "Notes", exact: true })).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

		// A real authenticated read against the API settles true — proves the injected session
		// authenticates, not merely that a Client object exists. The SDK worker's cross-origin fetch
		// under COI hangs on Playwright-firefox, so the network read is verified on the other engines;
		// firefox coverage stops at the authed-shell render above.
		if (browserName !== "firefox") {
			// The hooks arrive on a fire-and-forget dynamic import, independently of the shell's own
			// render — an authed shell is no proof they are installed.
			await waitForE2eHooks(page)

			const authed = await page.evaluate(() => window.__filenE2E.probeAuthedRead())
			expect(authed).toBe(true)
		}
	})
})
