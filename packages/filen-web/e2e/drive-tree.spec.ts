import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import {
	withScratchDirectory,
	createDirectoryViaDialog,
	waitForListingSettled,
	LIVE_WRITE_TIMEOUT_MS,
	expectBreadcrumbAt
} from "./helpers/listing"
import { pointerDragMove } from "./helpers/dnd"
import { menuItemLabels, menuItemName } from "./helpers/menu"

const TREE_ROW_SELECTOR = "[data-tree-path]"

// The sidebar's Cloud Drive tree: rows are plain buttons inside one labelled list.
function tree(page: Page) {
	return page.getByRole("list", { name: "Directory tree" })
}

// Opens the scratch directory's node so its children show below it. The tree reads the same listing the
// main pane just read, so its rows appear as that listing does.
async function expandInTree(page: Page, name: string): Promise<void> {
	const expand = tree(page).getByRole("button", { name: `Expand ${name}`, exact: true })

	await expect(expand).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await expand.click()
}

test.describe("sidebar directory tree", () => {
	test("a tree node's context menu offers exactly its listing row's entries, and opens it", async ({ page }) => {
		await withScratchDirectory(page, "tree", async ({ listbox, scratchName, runId }) => {
			const childName = `tree-child-${runId}`

			await createDirectoryViaDialog(page, childName, listbox)

			// The listing row's own menu, as the reference the tree node's must match.
			await listbox.getByRole("option", { name: childName }).click({ button: "right" })
			const rowMenu = page.getByRole("menu")
			await expect(rowMenu).toBeVisible()
			const rowEntries = await menuItemLabels(rowMenu.getByRole("menuitem"))
			await page.keyboard.press("Escape")
			await expect(rowMenu).toHaveCount(0)

			await expandInTree(page, scratchName)
			const node = tree(page).getByRole("button", { name: childName, exact: true })
			await expect(node).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await node.click({ button: "right" })

			const menu = page.getByRole("menu")
			await expect(menu).toBeVisible()
			// Compared without their key hints: the listing's keys act on its rows, the tree's own (its mod+v pastes into
			// the focused node) on its nodes, so the two menus' hints differ by design.
			const entries = await menuItemLabels(menu.getByRole("menuitem"))
			expect(entries.slice(0, 3)).toEqual(["Open", "New", "Paste"])
			expect(entries).toEqual(rowEntries)

			await menu.getByRole("menuitem", { name: menuItemName("Open") }).click()
			await expectBreadcrumbAt(page, childName)
			await waitForListingSettled(page)
		})
	})

	test("drags a tree node onto another tree node to move it", async ({ page }) => {
		await withScratchDirectory(page, "tree-dnd", async ({ listbox, scratchName, runId }) => {
			const draggedName = `tree-dragged-${runId}`
			const targetName = `tree-target-${runId}`

			await createDirectoryViaDialog(page, draggedName, listbox)
			await createDirectoryViaDialog(page, targetName, listbox)
			await expandInTree(page, scratchName)
			await expect(tree(page).getByRole("button", { name: draggedName, exact: true })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(tree(page).getByRole("button", { name: targetName, exact: true })).toBeVisible()

			const options = listbox.getByRole("option")
			await expect(options).toHaveCount(2)

			// Dragged once, as in drive-dnd-move.spec.ts: an accepted drop always starts the move, and the
			// row leaves only once that write settles on the account-wide lease, where a second drag would
			// only queue a second move behind the first.
			await pointerDragMove(
				page,
				{ selector: TREE_ROW_SELECTOR, text: draggedName },
				{ selector: TREE_ROW_SELECTOR, text: targetName }
			)
			await expect(options).toHaveCount(1, { timeout: LIVE_WRITE_TIMEOUT_MS })

			await expect(listbox.getByRole("option", { name: targetName })).toBeVisible()
			await expect(listbox.getByRole("option", { name: draggedName })).toHaveCount(0)
		})
	})
})
