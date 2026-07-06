import { test, expect } from "@playwright/test"

// SDK-free: the theme-toggle action is registered globally (theme-provider, mounted above the auth
// gate), so it works on the pre-auth sign-in surface without a session.
test.describe("keymap", { tag: "@no-sdk" }, () => {
	// Pin the color scheme so the "system" default resolves deterministically to light.
	test.use({ colorScheme: "light" })

	test("the default binding toggles the theme and a user override rebinds it", async ({ page }) => {
		await page.goto("/")
		// Wait for a ready, interactive shell so the hotkey binding is active.
		await expect(page.getByText("Sign in to Filen")).toBeVisible()
		await page.waitForFunction(() => "__filenE2E" in window)

		const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"))

		await expect.poll(isDark).toBe(false)

		// Default combo "d" toggles the theme.
		await page.keyboard.press("d")
		await expect.poll(isDark).toBe(true)

		await page.keyboard.press("d")
		await expect.poll(isDark).toBe(false)

		// Rebind the action; the registry reflects the new combo and the new key drives the toggle.
		await page.evaluate(() => window.__filenE2E.setUserCombo("app.toggleTheme", "y"))
		const combo = await page.evaluate(() => window.__filenE2E.comboFor("app.toggleTheme"))
		expect(combo).toBe("y")

		await page.keyboard.press("y")
		await expect.poll(isDark).toBe(true)
	})
})
