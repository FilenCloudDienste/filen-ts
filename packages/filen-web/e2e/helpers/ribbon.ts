import type { Locator, Page } from "@playwright/test"
import { expect } from "../fixtures"
import { preview } from "@/locales/en/preview"

// The office editors' ribbon: a tab chosen, then a control of one of its groups wherever the row's width put it: in
// the group, in the group's dropdown once it collapsed, or in the overflow menu.

// The ribbon's command row within `scope` (the page, or the preview dialog).
export function ribbonCommands(scope: Page | Locator): Locator {
	return scope.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands, exact: true })
}

export async function ribbonTab(scope: Page | Locator, tab: string): Promise<void> {
	await scope.getByRole("tab", { name: tab, exact: true }).click()
}

// The control (`role`, named `name`) in `group` on the selected tab, opening the group's dropdown or the overflow
// menu first when the row has no room for it.
export async function ribbonControl(
	page: Page,
	scope: Page | Locator,
	group: string,
	name: string,
	role: "button" | "combobox"
): Promise<Locator> {
	const row = ribbonCommands(scope)
	const inRow = row.getByRole("group", { name: group, exact: true }).getByRole(role, { name, exact: true })

	if ((await inRow.count()) > 0) {
		return inRow
	}

	const collapsed = row.getByRole("button", { name: group, exact: true })

	await (
		(await collapsed.count()) > 0 ? collapsed : row.getByRole("button", { name: preview.previewOfficeRibbonMore, exact: true })
	).click()

	return page.getByRole("toolbar", { name: group, exact: true }).getByRole(role, { name, exact: true })
}

export function ribbonButton(page: Page, scope: Page | Locator, group: string, name: string): Promise<Locator> {
	return ribbonControl(page, scope, group, name, "button")
}

// The editors' chrome: the ribbon or command bar, and the panes (ribbonFocus.ts).
const OFFICE_CHROME = "[data-office-ribbon], [data-office-pane]"

function focusInChrome(page: Page): Promise<boolean> {
	return page.evaluate(selector => document.activeElement?.closest(selector) != null, OFFICE_CHROME)
}

// Closes the preview with Escape, as a person does: an Escape on the ribbon or a pane only gives the document the focus
// (onRibbonEscape; a field first cancels its entry), and the one from the document closes the preview, after which
// `closed` (the ribbon, or the dialog) is gone.
export async function closeOfficeDocument(page: Page, closed: Locator): Promise<void> {
	await expect(async () => {
		if (await focusInChrome(page)) {
			await page.keyboard.press("Escape")
		}

		expect(await focusInChrome(page)).toBe(false)
	}).toPass({ timeout: 10_000 })
	await page.keyboard.press("Escape")
	await expect(closed).toHaveCount(0)
}
