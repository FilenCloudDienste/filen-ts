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
