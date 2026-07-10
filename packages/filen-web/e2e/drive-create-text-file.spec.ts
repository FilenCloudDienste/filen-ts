import { test, expect } from "./fixtures"
import { enterScratchDirectory, trashScratchDirectory } from "./helpers/listing"
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
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-create-text-${runId}`
	// Submitted with no extension — proves normalizeTextFileName's default-.txt behavior live, not
	// just at the unit level (createTextFile.test.ts).
	const baseName = `e2e-create-text-${runId}`
	const nameTxt = `${baseName}.txt`

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		await page.getByRole("button", { name: "Upload", exact: true }).click()
		const menu = page.getByRole("menu")
		await expect(menu).toBeVisible()
		await menu.getByRole("menuitem", { name: "New text file", exact: true }).click()

		const nameDialogHeading = page.getByRole("heading", { name: "New text file", exact: true })
		await expect(nameDialogHeading).toBeVisible()
		await page.getByLabel("Name", { exact: true }).fill(baseName)
		await page.getByRole("button", { name: "Create", exact: true }).click()
		// The name dialog closes, immediately replaced by the full-screen preview overlay — ALSO a
		// role="dialog" (see previewOverlay.tsx), so this checks the name dialog's own heading is gone
		// rather than asserting zero dialogs on screen.
		await expect(nameDialogHeading).toHaveCount(0)

		// The editor opens automatically (mobile parity) — no double-click needed, unlike every other
		// preview leg (preview-text.spec.ts, preview-lifecycle.spec.ts). Checked BEFORE the listing row
		// below: the full-bleed preview overlay is a modal dialog (previewOverlay.tsx) that inerts the
		// rest of the page while open, so the listbox's own option isn't accessible-queryable until it
		// closes.
		const editor = page.locator(".cm-content")
		await expect(editor).toBeVisible({ timeout: 30_000 })
		await expect(page.getByRole("dialog").getByText(nameTxt)).toBeVisible()

		await editor.click()
		await page.keyboard.type("created from the New text file dialog")

		const saveButton = page.getByRole("button", { name: "Save" })
		await expect(saveButton).toBeVisible()
		await saveButton.click()
		// The save clears the dirty bit once it resolves — the Save button (shown only while
		// editable+dirty) disappearing is the save's own success signal.
		await expect(saveButton).toHaveCount(0, { timeout: 15_000 })

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
