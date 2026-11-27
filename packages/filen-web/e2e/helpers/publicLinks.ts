import type { Browser, Locator, Page } from "@playwright/test"
import { expect } from "../fixtures"
import { openRowMenu } from "./archive"
import { LIVE_WRITE_TIMEOUT_MS } from "./listing"
import { menuItemName } from "./menu"

// The "Public link" dialog a signed-in owner drives from a row. Creating a link is premium, so every spec using these
// skips without E2E_PREMIUM.

// The item's "Public link" dialog, opened from its row menu.
export async function openLinkDialog(page: Page, listbox: Locator, name: string): Promise<Locator> {
	await openRowMenu(page, listbox, name)
	await page.getByRole("menuitem", { name: menuItemName("Public link") }).click()

	const dialog = page.getByRole("dialog", { name: "Public link", exact: true })

	await expect(dialog).toBeVisible()

	return dialog
}

// Creates the item's link and returns its URL (built on the app's own origin).
export async function createLink(dialog: Locator): Promise<string> {
	await dialog.getByRole("button", { name: "Create public link", exact: true }).click()

	const url = dialog.getByLabel("Link", { exact: true })

	await expect(url).toHaveValue(/\/[fd]\/[0-9a-f-]+#/, { timeout: LIVE_WRITE_TIMEOUT_MS })

	return url.inputValue()
}

// Each change is a write the switch waits out (disabled while pending).
export async function setLinkDownloads(dialog: Locator, on: boolean): Promise<void> {
	const allow = dialog.getByRole("switch", { name: "Allow downloads", exact: true })

	if ((await allow.getAttribute("aria-checked")) !== String(on)) {
		await allow.click()
	}

	await expect(allow).toHaveAttribute("aria-checked", String(on), { timeout: LIVE_WRITE_TIMEOUT_MS })
	await expect(allow).toBeEnabled({ timeout: LIVE_WRITE_TIMEOUT_MS })
}

export async function closeLinkDialog(page: Page, dialog: Locator): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(dialog).toHaveCount(0)
}

// The link opened by a signed-out visitor, in a context of its own. WebKit keeps one OPFS per origin, so specs skip
// this there.
export async function openAsVisitor(
	browser: Browser,
	baseURL: string | undefined,
	url: string
): Promise<{ page: Page; close: () => Promise<void> }> {
	const context = await browser.newContext(baseURL === undefined ? {} : { baseURL })
	const page = await context.newPage()

	await page.goto(url)

	return { page, close: () => context.close() }
}
