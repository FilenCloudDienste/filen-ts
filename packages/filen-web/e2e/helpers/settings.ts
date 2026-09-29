import type { Page } from "@playwright/test"
import { expect } from "../fixtures"
import { BOOT_SETTLE_TIMEOUT_MS, bootTo } from "./listing"

// A hard goto to an authed route now lands and stays, so /settings is reached directly instead of
// through a click-through of the account menu. /settings/account is the index route's redirect target
// and the section every caller starts on. Its own h1 is the barrier rather than the sidebar's, which
// the shell renders before the section route resolves.
export async function gotoSettings(page: Page): Promise<void> {
	await bootTo(page, "/settings/account")

	await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
}

// Every section's slug is its sidebar label lowercased.
export async function openSettingsSection(page: Page, label: string): Promise<void> {
	await page.getByRole("link", { name: label, exact: true }).click()
	await page.waitForURL(new RegExp(`/settings/${label.toLowerCase()}$`))
}

// The Account and Security pages mount their rows only once the live getUserInfo read has settled, and
// the h1 gotoSettings waits for renders before it. Callers that need a row wait here, on the Account
// page, for either terminal state: losing to the error state throws at once instead of timing out on
// a row that will never mount. Separate from gotoSettings so tests that never touch a row do not pay
// for the round trip.
export async function waitForAccountLoaded(page: Page): Promise<void> {
	const loaded = page.getByRole("button", { name: "Change email", exact: true })
	const failed = page.getByText("Couldn't load your account", { exact: true })

	await expect(loaded.or(failed)).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

	if (await failed.isVisible()) {
		throw new Error("The account settled to its error state (getUserInfo failed)")
	}
}
