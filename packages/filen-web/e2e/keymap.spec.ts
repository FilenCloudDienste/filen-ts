import { test, expect } from "./fixtures"
import { waitForE2eHooks } from "./helpers/e2eHooks"
import { bootToSignIn } from "./helpers/listing"
import { isDark, pressUntilTheme } from "./helpers/theme"

// SDK-free: the theme-toggle action is registered globally (theme-provider, mounted above the auth
// gate), so it works on the pre-auth sign-in surface without a session.
test.describe("keymap", { tag: "@no-sdk" }, () => {
	// Pin the color scheme so the "system" default resolves deterministically to light.
	test.use({ colorScheme: "light", injectSession: false })

	test("the default binding toggles the theme and a user override rebinds it", async ({ page }) => {
		// A ready, interactive shell, so the hotkey binding is active.
		await bootToSignIn(page)
		await waitForE2eHooks(page)

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
