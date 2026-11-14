import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { waitForE2eHooks } from "./helpers/e2eHooks"
import { gotoSettings, openSettingsSection } from "./helpers/settings"
import { isDark, pressUntilTheme } from "./helpers/theme"

// The browser is the only real proof that the shortcuts catalog is complete WITHOUT having visited
// every feature's lazily-imported route chunk, and that a combo recording really does suppress the
// app's live hotkeys (both listen on `document`, so nothing short of a real page settles it).
//
// Read-only and net-zero by construction: the one rebind attempted is a CONFLICTING combo, which is
// held back and then cancelled, so it persists nothing — there is no "reset to default" cleanup step to forget.
test.describe("keyboard shortcuts", () => {
	// Pin the color scheme so the "system" default resolves deterministically to light.
	test.use({ colorScheme: "light" })

	async function gotoKeyboardSettings(page: Page): Promise<void> {
		await gotoSettings(page)
		await openSettingsSection(page, "Keyboard")
	}

	// A global action with no default keys on any platform, listed near the top of the first group.
	const UNBOUND_ACTION = "app.openTransfers"

	function unboundRow(page: Page) {
		return page.locator(`li[data-action-id="${UNBOUND_ACTION}"]`)
	}

	test("the overlay opens on its combo and lists groups from route chunks that were never loaded", async ({ page }) => {
		await gotoSettings(page)

		const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })

		// Re-pressed until it opens: a press before the binding is installed is swallowed (helpers/theme.ts),
		// and one that did land is never pressed again, which could close it.
		await expect(async () => {
			if (!(await dialog.isVisible())) {
				await page.keyboard.press("Shift+Slash")
			}

			await expect(dialog).toBeVisible({ timeout: 2_000 })
		}).toPass({ timeout: 30_000 })

		// Photos has never been visited in this session, so its actions only exist because the defs are
		// static data rather than side effects of the route chunk — the direct regression test. The list is
		// virtualized, so a group further down is reached through the search, which matches group names too.
		const search = dialog.getByRole("searchbox", { name: "Search shortcuts by name" })

		await search.fill("photos")
		await expect(dialog.getByRole("heading", { name: /^photos$/i })).toBeVisible()
		await search.fill("cloud drive")
		await expect(dialog.getByRole("heading", { name: /^cloud drive$/i })).toBeVisible()
		// A description key from a non-"common" namespace ("drive:driveCommandSelectAll") resolves.
		await expect(dialog.locator('li[data-action-id="drive.selectAll"]')).toContainText("Select all")
		// Cleared, the list starts over at its first group.
		await search.fill("")
		await expect(dialog.getByRole("heading", { name: /^everywhere$/i })).toBeVisible()

		await page.keyboard.press("Escape")
		await expect(dialog).toBeHidden()

		// The account menu reaches the same dialog for anyone who never learns the combo.
		await page.getByRole("button", { name: "Account", exact: true }).click()
		await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click()
		await expect(dialog).toBeVisible()

		await page.keyboard.press("Escape")
		await expect(dialog).toBeHidden()
	})

	test("Settings -> Keyboard renders the same catalog", async ({ page }) => {
		await gotoKeyboardSettings(page)

		const search = page.getByRole("searchbox", { name: "Search shortcuts by name" })

		await expect(page.getByRole("heading", { name: /^everywhere$/i })).toBeVisible()
		await search.fill("cloud drive")
		await expect(page.getByRole("heading", { name: /^cloud drive$/i })).toBeVisible()
		await search.fill("photos")
		await expect(page.getByRole("heading", { name: /^photos$/i })).toBeVisible()
		await search.fill("")
		await expect(unboundRow(page)).toContainText("Not set")
	})

	test("recording suppresses every live hotkey and holds back a combo another action already holds", async ({ page }) => {
		await gotoKeyboardSettings(page)

		await expect.poll(() => isDark(page)).toBe(false)

		const row = unboundRow(page)

		await row.getByRole("button", { name: "Add shortcut" }).click()
		await expect(row).toContainText("Press the keys you want to use")

		// "d" is app.toggleTheme's live combo. While recording it must be captured as DATA — the theme
		// must not flip — and then held back, because both actions are global and would fire together.
		await page.keyboard.press("d")

		await expect(row).toContainText("is already used by")
		await row.getByRole("button", { name: "Cancel" }).click()
		await expect.poll(() => isDark(page)).toBe(false)
		await expect(row).toContainText("Not set")
		// The hooks arrive on a fire-and-forget dynamic import, independently of the shell's own
		// render — an interactive settings page is no proof they are installed.
		await waitForE2eHooks(page)
		expect(await page.evaluate(id => window.__filenE2E.comboFor(id), UNBOUND_ACTION)).toBe("")
	})

	test("Escape cancels a recording without dismissing or navigating anything", async ({ page }) => {
		await gotoKeyboardSettings(page)

		const row = unboundRow(page)

		await row.getByRole("button", { name: "Add shortcut" }).click()
		await expect(row).toContainText("Press the keys you want to use")

		await page.keyboard.press("Escape")

		await expect(row).toContainText("Not set")
		// Focus never leaves the list, so the capture handler sees Escape before anything else can act on it.
		await expect(row.getByRole("button", { name: "Add shortcut" })).toBeVisible()
		expect(new URL(page.url()).pathname).toBe("/settings/keyboard")
	})

	test("a second shortcuts list never strands the recording session", async ({ page }) => {
		await gotoKeyboardSettings(page)

		const row = unboundRow(page)

		await row.getByRole("button", { name: "Add shortcut" }).click()
		await expect(row).toContainText("Press the keys you want to use")

		// The dialog's own list claims the surface on mount, which ends the page's recording rather than
		// leaving a second recorder running invisibly behind it.
		await page.getByRole("button", { name: "Account", exact: true }).click()
		await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click()

		const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })

		await expect(dialog).toBeVisible()
		await page.keyboard.press("d")
		await page.keyboard.press("Escape")
		// Gone, not merely hidden: the dialog's own list holds the recording surface for as long as it is
		// mounted, so the presses below only read as global bindings once it has actually unmounted.
		await expect(dialog).toHaveCount(0)

		await expect(row).toContainText("Not set")

		// No session survived either list, so the global binding works again.
		await pressUntilTheme(page, "d", true)

		// Net-zero: put the theme back.
		await pressUntilTheme(page, "d", false)
	})
})
