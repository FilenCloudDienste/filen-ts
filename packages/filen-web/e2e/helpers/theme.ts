import { expect, type Page } from "@playwright/test"

// Imports nothing but Playwright: keymap.spec.ts is SDK-free and pulls this in.

// The rendered theme, read off the html element the theme provider toggles.
export function isDark(page: Page): Promise<boolean> {
	return page.evaluate(() => document.documentElement.classList.contains("dark"))
}

// A hotkey is only observable once its binding is installed, and nothing in the DOM says when that
// is — a keystroke that lands a frame early is swallowed with no trace, and a bare poll after it then
// watches a theme that will never change. Each press is re-issued until the theme follows, guarded by
// a read so a press that DID land is never undone by the retry.
export async function pressUntilTheme(page: Page, key: string, dark: boolean): Promise<void> {
	await expect(async () => {
		if ((await isDark(page)) !== dark) {
			await page.keyboard.press(key)
		}

		await expect.poll(() => isDark(page), { timeout: 5_000 }).toBe(dark)
	}).toPass({ timeout: 30_000 })
}
