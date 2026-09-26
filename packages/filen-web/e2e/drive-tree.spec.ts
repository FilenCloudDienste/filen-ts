import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import {
	bootTo,
	createDirectoryViaDialog,
	enterScratchDirectory,
	trashScratchDirectory,
	waitForListingSettled,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"
import { html5DragMove } from "./helpers/dnd"

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
	test("a tree node's context menu offers its listing row's entries under the destination entries, and opens it", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-tree-${runId}`
		const childName = `tree-child-${runId}`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, childName, listbox)

			// The listing row's own menu, as the reference the tree node's must end with.
			await listbox.getByRole("option", { name: childName }).click({ button: "right" })
			const rowMenu = page.getByRole("menu")
			await expect(rowMenu).toBeVisible()
			const rowEntries = await rowMenu.getByRole("menuitem").allTextContents()
			await page.keyboard.press("Escape")
			await expect(rowMenu).toHaveCount(0)

			await expandInTree(page, scratchName)
			const node = tree(page).getByRole("button", { name: childName, exact: true })
			await expect(node).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await node.click({ button: "right" })

			const menu = page.getByRole("menu")
			await expect(menu).toBeVisible()
			const entries = await menu.getByRole("menuitem").allTextContents()
			expect(entries.slice(0, 5)).toEqual(["Open", "New directory", "Upload files", "Upload directory", "New text file"])
			expect(entries.slice(-rowEntries.length)).toEqual(rowEntries)

			await menu.getByRole("menuitem", { name: "Open", exact: true }).click()
			await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText(childName, { exact: true })).toBeVisible()
			await waitForListingSettled(page)
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("drags a tree node onto another tree node to move it", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-tree-dnd-${runId}`
		const draggedName = `tree-dragged-${runId}`
		const targetName = `tree-target-${runId}`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, draggedName, listbox)
			await createDirectoryViaDialog(page, targetName, listbox)
			await expandInTree(page, scratchName)
			await expect(tree(page).getByRole("button", { name: draggedName, exact: true })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(tree(page).getByRole("button", { name: targetName, exact: true })).toBeVisible()

			const options = listbox.getByRole("option")
			await expect(options).toHaveCount(2)

			// Dispatched once, as in drive-dnd-move.spec.ts: an accepted drop always starts the move, and the
			// row leaves only once that write settles on the account-wide lease, where a re-dispatch would
			// only queue a second move behind the first.
			await html5DragMove(page, { selector: TREE_ROW_SELECTOR, text: draggedName }, { selector: TREE_ROW_SELECTOR, text: targetName })
			await expect(options).toHaveCount(1, { timeout: LIVE_WRITE_TIMEOUT_MS })

			await expect(listbox.getByRole("option", { name: targetName })).toBeVisible()
			await expect(listbox.getByRole("option", { name: draggedName })).toHaveCount(0)
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})
