import type { Locator } from "@playwright/test"
import { expect } from "../fixtures"

// The viewer's scrolling page column (focusable with tabindex -1): the closest such ancestor of the first page. The
// page surface's other children (the editor's live region, the tool panels) come before it, so it is found from a page.
export function pdfPageScroller(dialog: Locator): Locator {
	return dialog.getByRole("region", { name: /Page 1 of/u }).locator('xpath=ancestor::div[@tabindex="-1"][1]')
}

// The editor's one polite live region: a keyboard placement and the tools' steps are said there.
export function pdfLiveRegion(dialog: Locator): Locator {
	return dialog.locator("[data-pdf-live-region]")
}

// The editor's save ended with nothing left to save: Save is disabled and no longer busy (it is disabled while it runs).
export async function expectPdfSaved(save: Locator, timeout: number): Promise<void> {
	await expect(save).toHaveAttribute("aria-busy", "false", { timeout })
	await expect(save).toBeDisabled()
}
