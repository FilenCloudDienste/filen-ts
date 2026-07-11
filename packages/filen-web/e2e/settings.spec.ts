import { readFileSync } from "node:fs"
import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { dismissStartupReminders } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Every settings section here is either a plain, read-only render (Account/Appearance/Security's own
// existing assertions) or a client-side-only preference (theme) — nothing in this spec live-mutates
// session-invalidating or irreversible account state (changeEmail/setNickname/updatePersonalInfo/
// uploadAvatar/deleteAll* all stay unit/render-only per the settings study's e2e safety classes).
// getUserInfo/getGdprInfo are the only live network reads exercised, both read-only.
//
// Client-nav only (same constraint as contacts.spec.ts/notes.spec.ts): the injection hook re-seeds and
// navigates to "/" → /drive on every load, so a hard goto to any other authed route bounces back before
// it renders. The one path into /settings is goto("/drive") then a real in-app click through the
// account menu — the "Settings" entry now lands on /settings/account (D3's index redirect target).
//
// Chromium-only: the account query (useAccountQuery -> getUserInfo) fires a real authenticated read on
// every settings page mount — the same worker cross-origin SDK path that hangs on Playwright-firefox
// (helpers/firefox.ts).
async function gotoSettings(page: Page): Promise<void> {
	await page.goto("/drive")
	await dismissStartupReminders(page)
	await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

	await page.getByRole("button", { name: "Account", exact: true }).click()
	await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
	await page.waitForURL(/\/settings\/account$/)
}

test.describe("settings", () => {
	test("the settings sidebar renders every section and Account is the index-redirect landing section", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoSettings(page)

		for (const label of ["Account", "Security", "Appearance", "Events", "Billing"]) {
			await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible()
		}

		await expect(page.getByRole("link", { name: "Account", exact: true })).toHaveAttribute("aria-current", "page")
	})

	test("the Account section renders live getUserInfo data (email + storage breakdown)", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoSettings(page)

		await expect(page.getByText("Current email:")).toBeVisible()
		await expect(page.getByText(/[^\s@]+@[^\s@]+\.[^\s@]+/)).toBeVisible()

		await expect(page.getByText("Storage", { exact: true })).toBeVisible()
		await expect(page.getByText(/of .* used/)).toBeVisible()
	})

	test("security page is reachable from the sidebar and renders unchanged", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoSettings(page)

		await page.getByRole("link", { name: "Security", exact: true }).click()
		await page.waitForURL(/\/settings\/security$/)

		await expect(page.getByRole("heading", { name: "Security" })).toBeVisible()
		await expect(page.getByText("Change password", { exact: true })).toBeVisible()
		await expect(page.getByText("Two-factor authentication", { exact: true })).toBeVisible()
		// Two matches (the CardTitle + its own action button share this exact label) — .first() only
		// needs to prove the card itself rendered, not disambiguate a click target.
		await expect(page.getByText("Export master keys", { exact: true }).first()).toBeVisible()
		await expect(page.getByText("Delete account", { exact: true })).toBeVisible()
	})

	test("Events and Billing render present-but-minimal placeholders, not broken routes", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoSettings(page)

		await page.getByRole("link", { name: "Events", exact: true }).click()
		await page.waitForURL(/\/settings\/events$/)
		await expect(page.getByText("Coming soon", { exact: true })).toBeVisible()

		await page.getByRole("link", { name: "Billing", exact: true }).click()
		await page.waitForURL(/\/settings\/billing$/)
		await expect(page.getByText("Coming soon", { exact: true })).toBeVisible()
	})

	test("the theme three-way switch round-trips through light/dark/system", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoSettings(page)
		await page.getByRole("link", { name: "Appearance", exact: true }).click()
		await page.waitForURL(/\/settings\/appearance$/)

		const trigger = page.getByRole("combobox")

		async function pickTheme(label: string): Promise<void> {
			await trigger.click()
			await page.getByRole("listbox").getByRole("option", { name: label, exact: true }).click()
		}

		await pickTheme("Dark")
		await expect.poll(() => page.evaluate(() => localStorage.getItem("theme"))).toBe("dark")
		await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true)

		await pickTheme("Light")
		await expect.poll(() => page.evaluate(() => localStorage.getItem("theme"))).toBe("light")
		await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("light"))).toBe(true)

		await pickTheme("System")
		await expect.poll(() => page.evaluate(() => localStorage.getItem("theme"))).toBe("system")
	})

	test("GDPR export downloads a JSON file", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoSettings(page)

		const [download] = await Promise.all([
			page.waitForEvent("download", { timeout: 20_000 }),
			page.getByRole("button", { name: "Export data", exact: true }).click()
		])

		expect(download.suggestedFilename()).toMatch(/^filen-data-export\.\d+\.json$/)

		const path = await download.path()
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
		expect(parsed).toMatchObject({ user: expect.any(Object), events: expect.any(Object) })
	})
})
