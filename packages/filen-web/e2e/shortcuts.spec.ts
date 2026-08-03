import { test, expect } from "./fixtures"
import { gotoSettings } from "./helpers/settings"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// The browser is the only real proof that the shortcuts catalog is complete WITHOUT having visited
// every feature's lazily-imported route chunk, and that a combo recording really does suppress the
// app's live hotkeys (both listen on `document`, so nothing short of a real page settles it).
//
// Read-only and net-zero by construction: the one rebind attempted is a CONFLICTING combo, which is
// refused and therefore persists nothing — there is no "reset to default" cleanup step to forget.
//
// Chromium-only: the authed shell mounts useAccountQuery, the worker cross-origin SDK path that hangs
// on Playwright-firefox (helpers/firefox.ts).
test.describe("keyboard shortcuts", () => {
	// Pin the color scheme so the "system" default resolves deterministically to light.
	test.use({ colorScheme: "light" })

	async function gotoKeyboardSettings(page: Parameters<typeof gotoSettings>[0]): Promise<void> {
		await gotoSettings(page)
		await page.getByRole("link", { name: "Keyboard", exact: true }).click()
		await page.waitForURL(/\/settings\/keyboard$/)
	}

	function settingsRow(page: Parameters<typeof gotoSettings>[0]) {
		return page.locator('li[data-action-id="app.openSettings"]')
	}

	test("the overlay opens on its combo and lists groups from route chunks that were never loaded", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoSettings(page)
		await page.keyboard.press("Shift+Slash")

		const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })

		await expect(dialog).toBeVisible()

		// Photos has never been visited in this session, so its actions only exist because the defs are
		// static data rather than side effects of the route chunk — the direct regression test.
		await expect(dialog.getByRole("heading", { name: /^photos$/i })).toBeVisible()
		await expect(dialog.getByRole("heading", { name: /^cloud drive$/i })).toBeVisible()
		// A description key from a non-"common" namespace ("drive:driveCommandSelectAll") resolves.
		await expect(dialog.locator('li[data-action-id="drive.selectAll"]')).toContainText("Select all")

		await page.keyboard.press("Escape")
		await expect(dialog).toBeHidden()

		// The account menu reaches the same dialog for anyone who never learns the combo.
		await page.getByRole("button", { name: "Account", exact: true }).click()
		await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click()
		await expect(dialog).toBeVisible()

		await page.keyboard.press("Escape")
		await expect(dialog).toBeHidden()
	})

	test("Settings -> Keyboard renders the same catalog", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoKeyboardSettings(page)

		await expect(page.getByRole("heading", { name: /^photos$/i })).toBeVisible()
		await expect(page.getByRole("heading", { name: /^cloud drive$/i })).toBeVisible()
		await expect(settingsRow(page)).toContainText("Not set")
	})

	test("recording suppresses every live hotkey and refuses a combo another action already holds", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoKeyboardSettings(page)

		const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"))

		await expect.poll(isDark).toBe(false)

		const row = settingsRow(page)

		await row.getByRole("button", { name: "Change shortcut" }).click()
		await expect(row).toContainText("Press the keys you want to use")

		// "d" is app.toggleTheme's live combo. While recording it must be captured as DATA — the theme
		// must not flip — and then refused, because both actions are global and would fire together.
		await page.keyboard.press("d")

		await expect(row).toContainText("Already used by")
		await expect.poll(isDark).toBe(false)
		await expect(row).toContainText("Not set")
		expect(await page.evaluate(() => window.__filenE2E.comboFor("app.openSettings"))).toBe("")
	})

	test("Escape cancels a recording without dismissing or navigating anything", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoKeyboardSettings(page)

		const row = settingsRow(page)

		await row.getByRole("button", { name: "Change shortcut" }).click()
		await expect(row).toContainText("Press the keys you want to use")

		await page.keyboard.press("Escape")

		await expect(row).toContainText("Not set")
		// The toggle is one persistent button, so focus never leaves the list and the capture handler
		// sees Escape before anything else can act on it.
		await expect(row.getByRole("button", { name: "Change shortcut" })).toBeVisible()
		expect(new URL(page.url()).pathname).toBe("/settings/keyboard")
	})

	test("a second shortcuts list never strands the recording session", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoKeyboardSettings(page)

		const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"))
		const row = settingsRow(page)

		await row.getByRole("button", { name: "Change shortcut" }).click()
		await expect(row).toContainText("Press the keys you want to use")

		// The dialog's own list claims the surface on mount, which ends the page's recording rather than
		// leaving a second recorder running invisibly behind it.
		await page.getByRole("button", { name: "Account", exact: true }).click()
		await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click()

		const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })

		await expect(dialog).toBeVisible()
		await page.keyboard.press("d")
		await page.keyboard.press("Escape")
		await expect(dialog).toBeHidden()

		await expect(row).toContainText("Not set")

		// No session survived either list, so the global binding works again.
		await page.keyboard.press("d")
		await expect.poll(isDark).toBe(true)

		// Net-zero: put the theme back.
		await page.keyboard.press("d")
		await expect.poll(isDark).toBe(false)
	})
})
