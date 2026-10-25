import type { Locator, Page } from "@playwright/test"
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
