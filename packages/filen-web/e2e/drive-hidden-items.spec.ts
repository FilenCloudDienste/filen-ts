import { test, expect } from "./fixtures"
import { enterScratchDirectory, trashScratchDirectory } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// The hide-hidden-items display filter, end to end: the Display menu's checkbox, the listing filter,
// the footer count, and the "won't be listed" toast a create fires while the filter is on. The rules
// themselves are unit-tested (hiddenItems.test.ts / directoryListing.test.ts / hiddenNameNotice.test.ts)
// — only the assembled wiring needs a browser.
//
// Its own spec file, not drive.spec.ts: that file's header states nothing in it ever creates, renames,
// moves or deletes anything. Net-zero via the same scratch-directory convention every other
// data-mutating drive spec uses.

test.describe.configure({ mode: "default" })

test("Display > Show hidden items filters dot-prefixed rows, counts them in the footer, and warns when a new name would be hidden", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-hidden-${runId}`
	const hiddenName = `.e2e-hidden-${runId}`
	const visibleName = `visible-${runId}`
	const secondHiddenName = `.e2e-hidden-second-${runId}`

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		async function createDirectory(name: string): Promise<void> {
			// .first(): an empty writable listing renders a second identical button inside its empty-state
			// "+ Add" affordance; the toolbar's copy is always first in DOM order.
			await page.getByRole("button", { name: "New directory", exact: true }).first().click()
			const dialog = page.getByRole("dialog")
			await expect(dialog).toBeVisible()
			await page.getByLabel("Name", { exact: true }).fill(name)
			await page.getByRole("button", { name: "Create", exact: true }).click()
			await expect(dialog).toHaveCount(0)
		}

		async function toggleShowHiddenItems(): Promise<void> {
			await page.getByRole("button", { name: "Display", exact: true }).click()
			const menu = page.getByRole("menu")
			await expect(menu).toBeVisible()
			const checkbox = menu.getByRole("menuitemcheckbox", { name: "Show hidden items", exact: true })
			const wasChecked = (await checkbox.getAttribute("aria-checked")) === "true"
			await checkbox.click()
			// Checkbox menu items keep the menu open by design so display options can be batch-toggled;
			// the flipped aria state is the completion signal, then the menu is closed explicitly.
			await expect(checkbox).toHaveAttribute("aria-checked", wasChecked ? "false" : "true")
			await page.keyboard.press("Escape")
			await expect(menu).toHaveCount(0)
		}

		await createDirectory(hiddenName)
		await createDirectory(visibleName)

		const hiddenRow = listbox.getByRole("option", { name: hiddenName })
		const visibleRow = listbox.getByRole("option", { name: visibleName })
		await expect(hiddenRow).toBeVisible()
		await expect(visibleRow).toBeVisible()

		// Default is ON (show everything), so the first toggle turns the filter on.
		await toggleShowHiddenItems()

		await expect(hiddenRow).toHaveCount(0)
		await expect(visibleRow).toBeVisible()
		await expect(page.getByText("1 hidden item is not shown", { exact: true })).toBeVisible()

		// Creating a name the filter will swallow has no other feedback — the row simply never appears —
		// so the toast is the only thing telling the user what happened.
		await createDirectory(secondHiddenName)
		await expect(page.getByText("Created — it won't be listed until you turn on Show hidden items under Display.")).toBeVisible()
		await expect(listbox.getByRole("option", { name: secondHiddenName })).toHaveCount(0)
		await expect(page.getByText("2 hidden items are not shown", { exact: true })).toBeVisible()

		// Restore the preference inside the test body — Playwright contexts are per-test isolated, but
		// the assertion that both rows come back is the real point.
		await toggleShowHiddenItems()

		await expect(hiddenRow).toBeVisible()
		await expect(visibleRow).toBeVisible()
		await expect(listbox.getByRole("option", { name: secondHiddenName })).toBeVisible()
		await expect(page.getByText("2 hidden items are not shown", { exact: true })).toHaveCount(0)
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})
