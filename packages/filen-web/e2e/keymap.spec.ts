import { test, expect } from "@playwright/test"
import { BOOT_SETTLE_TIMEOUT_MS } from "./helpers/listing"
import { isDark, pressUntilTheme } from "./helpers/theme"

// SDK-free: the theme-toggle action is registered globally (theme-provider, mounted above the auth
// gate), so it works on the pre-auth sign-in surface without a session.
test.describe("keymap", { tag: "@no-sdk" }, () => {
	// Pin the color scheme so the "system" default resolves deterministically to light.
	test.use({ colorScheme: "light" })

	test("the default binding toggles the theme and a user override rebinds it", async ({ page }) => {
		await page.goto("/")
		// Wait for a ready, interactive shell so the hotkey binding is active. Boot budget, not the
		// expect default: this is a cold wasm init + OPFS open.
		await expect(page.getByText("Sign in to Filen")).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
		await page.waitForFunction(() => "__filenE2E" in window)

		await expect.poll(() => isDark(page)).toBe(false)

		// Default combo "d" toggles the theme.
		await pressUntilTheme(page, "d", true)
		await pressUntilTheme(page, "d", false)

		// Rebind the action; the registry reflects the new combo and the new key drives the toggle.
		await page.evaluate(() => window.__filenE2E.setUserCombo("app.toggleTheme", "y"))
		const combo = await page.evaluate(() => window.__filenE2E.comboFor("app.toggleTheme"))
		expect(combo).toBe("y")

		await pressUntilTheme(page, "y", true)
	})
})
