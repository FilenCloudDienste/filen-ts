import { test, expect } from "./fixtures"
import { bootTo, enterScratchDirectory, trashScratchDirectory, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"
import { focusEditorSurface } from "./helpers/editor"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// "New text file" (Upload menu's third entry, uploadMenu.tsx): create -> row appears instantly ->
// editor opens automatically -> type + save round trip (the editable-preview save flow this reuses is
// already proven end to end by preview-lifecycle.spec.ts). Net-zero via the same scratch-directory
// convention every other data-mutating drive spec uses (enterScratchDirectory/trashScratchDirectory)
// rather than at /drive's root — this suite runs fullyParallel (playwright.config.ts), and a
// root-level create/trash races other specs' own root-listing assertions (see drive-actions.spec.ts's
// comment for the exact failure this once produced live).

test.describe.configure({ mode: "default" })

test("New text file: name without an extension defaults to .txt, the row appears instantly, and its editor opens for typing", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-create-text-${runId}`
	// Submitted with no extension — proves normalizeTextFileName's default-.txt behavior live, not
	// just at the unit level (createTextFile.test.ts).
	const baseName = `e2e-create-text-${runId}`
	const nameTxt = `${baseName}.txt`

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		// .first(): the fresh scratch directory starts empty, so its empty-state "+ Add" affordance
		// renders a second identical Upload trigger; the toolbar's is always first in DOM order.
		await page.getByRole("button", { name: "Upload", exact: true }).first().click()
		const menu = page.getByRole("menu")
		await expect(menu).toBeVisible()
		await menu.getByRole("menuitem", { name: "New text file", exact: true }).click()

		const nameDialogHeading = page.getByRole("heading", { name: "New text file", exact: true })
		await expect(nameDialogHeading).toBeVisible()
		await page.getByLabel("Name", { exact: true }).fill(baseName)
		await page.getByRole("button", { name: "Create", exact: true }).click()

		// The editor opening IS the outcome, and it is asserted FIRST: runCreateTextFile awaits the real
		// uploadFileBytes round trip before patching the listing, and the name dialog only closes after
		// that — asserting the close on the suite's UI-responsiveness budget would make a slow-but-
		// successful create look like a failure (the same ordering menus.spec.ts already carries). It
		// closes on that live create+upload, so it gets the write budget rather than a UI one.
		// The editor also has to come before the listing row below: the full-bleed preview overlay is a
		// modal dialog (previewOverlay.tsx) that inerts the rest of the page while open, so the listbox's
		// own option isn't accessible-queryable until it closes.
		const editor = page.locator(".cm-content")
		await expect(editor).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		// The name dialog is gone, replaced by that overlay — ALSO a role="dialog" (previewOverlay.tsx),
		// so this checks the name dialog's own heading rather than asserting zero dialogs on screen.
		await expect(nameDialogHeading).toHaveCount(0)
		await expect(page.getByRole("dialog").getByText(nameTxt)).toBeVisible()

		await focusEditorSurface(editor)
		await page.keyboard.type("created from the New text file dialog")

		const saveButton = page.getByRole("button", { name: "Save" })
		await expect(saveButton).toBeVisible()
		await saveButton.click()
		// The save clears the dirty bit once it resolves — the Save button (shown only while
		// editable+dirty) disappearing is the save's own success signal, and that is a real upload on the
		// account-wide lease, so it gets the write budget rather than a UI-responsiveness one.
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		await page.keyboard.press("Escape")
		await expect(editor).toHaveCount(0)

		// The row landed in the listing without a refetch (confirm-then-patch, mirrors newDirectory's
		// own convention) — checked last, now that the overlay closing has un-inerted the listbox again.
		const row = listbox.getByRole("option", { name: nameTxt })
		await expect(row).toBeVisible({ timeout: 15_000 })
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})
