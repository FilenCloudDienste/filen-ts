import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import {
	bootTo,
	descendInto,
	enterScratchDirectory,
	trashScratchDirectory,
	uploadFiles,
	waitForListingSettled,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"
import { focusEditorSurface } from "./helpers/editor"

// An open editor follows its file when a newer version is saved elsewhere. Two tabs of one session stand
// in for two devices: each save goes through the socket to the other exactly as it would across
// machines, and each tab's own save comes back to it as an echo, which is what must never prompt.
test.describe.configure({ mode: "default" })

const REMOTE_EVENT_TIMEOUT_MS = 30_000

async function openFile(page: Page, name: string) {
	const { listbox } = await waitForListingSettled(page)
	const row = listbox.getByRole("option", { name })

	await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await row.dblclick()

	const dialog = page.getByRole("dialog")

	await expect(dialog.locator(".cm-content")).toContainText("first line", { timeout: 30_000 })

	return dialog
}

async function typeInto(page: Page, text: string): Promise<void> {
	const dialog = page.getByRole("dialog")

	await focusEditorSurface(dialog.locator(".cm-content"))
	await page.keyboard.press("End")
	await page.keyboard.type(text)
	await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
}

async function save(page: Page): Promise<void> {
	const saveButton = page.getByRole("dialog").getByRole("button", { name: "Save", exact: true })

	await saveButton.click()
	// Save renders only while there is something to save: gone means the save landed.
	await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
}

test("an open editor follows saves made elsewhere, asks over unsaved edits, and never over its own save", async ({ page, context }) => {
	const runId = crypto.randomUUID()
	const scratchName = `e2e-remote-change-${runId}`
	const fileName = `e2e-remote-change-${runId}.txt`

	await bootTo(page)

	let other: Page | null = null

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		await uploadFiles(page, [{ name: fileName, mimeType: "text/plain", buffer: Buffer.from("first line", "utf8") }], listbox)

		const mine = await openFile(page, fileName)

		other = await context.newPage()
		await bootTo(other)
		await descendInto(other, (await waitForListingSettled(other)).listbox, scratchName)

		const theirs = await openFile(other, fileName)
		const prompt = page.getByRole("alertdialog", { name: "This file changed elsewhere" })

		// Clean: a save elsewhere simply shows up, with a word about it.
		await typeInto(other, " edited-elsewhere-1")
		await save(other)
		await expect(mine.locator(".cm-content")).toContainText("edited-elsewhere-1", { timeout: REMOTE_EVENT_TIMEOUT_MS })
		await expect(page.getByText("Updated with changes saved elsewhere.")).toBeVisible()
		await expect(prompt).toHaveCount(0)

		// The other tab's own save never asked it anything.
		await expect(other.getByRole("alertdialog")).toHaveCount(0)

		// Dirty: a save elsewhere asks, the comparison shows both sides, and Keep mine keeps the edits.
		await typeInto(page, " kept-here")
		await typeInto(other, " edited-elsewhere-2")
		await save(other)
		await expect(prompt).toBeVisible({ timeout: REMOTE_EVENT_TIMEOUT_MS })

		await prompt.getByRole("button", { name: "Compare", exact: true }).click()
		await expect(prompt.getByText("Their version", { exact: true })).toBeVisible()
		await expect(prompt.getByText("Your version", { exact: true })).toBeVisible()
		await expect(prompt.locator(".cm-mergeView")).toContainText("edited-elsewhere-2", { timeout: 30_000 })
		await expect(prompt.locator(".cm-mergeView")).toContainText("kept-here")
		await prompt.getByRole("button", { name: "Back", exact: true }).click()

		await prompt.getByRole("button", { name: "Keep mine", exact: true }).click()
		await expect(prompt).toHaveCount(0)
		await expect(mine.locator(".cm-content")).toContainText("kept-here")

		// Saving the kept edits makes them the newest version: the other tab follows, and this one, whose
		// save it was, asks nothing.
		await save(page)
		await expect(theirs.locator(".cm-content")).toContainText("kept-here", { timeout: REMOTE_EVENT_TIMEOUT_MS })
		await expect(prompt).toHaveCount(0)
		await expect(page.getByText("Your save replaced changes saved elsewhere moments before.", { exact: false })).toHaveCount(0)

		// Dirty again, answered with Save mine as copy: the edits land in a conflicted copy beside the file,
		// and the editor shows the newer version.
		await typeInto(page, " copied-out")
		await typeInto(other, " edited-elsewhere-3")
		await save(other)
		await expect(prompt).toBeVisible({ timeout: REMOTE_EVENT_TIMEOUT_MS })
		await prompt.getByRole("button", { name: "Save mine as copy", exact: true }).click()
		await expect(prompt).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(page.getByText(/^Saved your changes as .*\(conflicted copy .*\)\.txt\.$/)).toBeVisible()
		await expect(mine.locator(".cm-content")).toContainText("edited-elsewhere-3")
		await expect(mine.locator(".cm-content")).not.toContainText("copied-out")

		// Dirty while the file is trashed elsewhere: the edits are not dropped with it, and saving them as a
		// new file takes the name the trashed file freed.
		await typeInto(page, " survived-trash")
		await theirs.getByRole("button", { name: "More actions", exact: true }).click()
		await other.getByRole("menuitem", { name: "Trash", exact: true }).click()
		await other.getByRole("alertdialog", { name: "Move to trash?" }).getByRole("button", { name: "Trash", exact: true }).click()

		const deleted = page.getByRole("alertdialog", { name: "This file was deleted elsewhere" })

		await expect(deleted).toBeVisible({ timeout: REMOTE_EVENT_TIMEOUT_MS })
		await deleted.getByRole("button", { name: "Save as new file", exact: true }).click()
		await expect(deleted).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(page.getByText(`Saved your changes as ${fileName}.`, { exact: true })).toBeVisible()
		await expect(mine.locator(".cm-content")).toContainText("survived-trash")

		await page.keyboard.press("Escape")
		await expect(listbox.getByRole("option", { name: /\(conflicted copy .*\)\.txt / })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(listbox.getByRole("option", { name: new RegExp(`^${fileName.replaceAll(".", "\\.")} `) })).toBeVisible()
	} finally {
		await other?.close()
		await page.keyboard.press("Escape").catch(() => undefined)
		await trashScratchDirectory(page, scratchName)
	}
})
