import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import {
	assistantConversation,
	assistantPanel,
	openAssistantPanel,
	scriptAssistant,
	sendAssistantMessage,
	waitForAssistantTurnEnd
} from "./helpers/assistant"
import { trackCspViolations } from "./helpers/csp"
import { menuItemName } from "./helpers/menu"
import {
	descendInto,
	LIVE_WRITE_TIMEOUT_MS,
	selectAndTrashRow,
	setTallListingViewport,
	textFile,
	uploadFiles,
	waitForListingSettled,
	withScratchDirectory
} from "./helpers/listing"
import { leadingNamePattern, namePattern, revealPickerRow } from "./helpers/rows"

// The assistant's drive writes, end to end over the scripted model (src/e2e-hooks/assistantStub.ts): the real loop,
// guard, batch planner, cards and drive actions run; only the model's choices are scripted. Every name a call
// carries is in the user's message too, as the guard requires of a change. Each test brackets its own scratch
// directory, and keeps its writes to the few the flow needs: each one waits on the account's drive-write lease.
//
// Write lane (playwright.config.ts): every test here uploads, so it takes the drive lock.

test.describe.configure({ mode: "default" })

function row(listbox: Locator, name: string): Locator {
	return listbox.getByRole("option", { name: namePattern(name) })
}

// A pending card in the panel, by its title.
function card(page: Page, title: string): Locator {
	return assistantPanel(page).getByRole("group", { name: title, exact: true })
}

// Confirms a card with a click the browser dispatches (cards ignore synthetic ones) and waits for its run to end.
async function confirmCard(page: Page, proposal: Locator, label: string): Promise<void> {
	await proposal.getByRole("button", { name: label, exact: true }).click()
	await expect(proposal.getByText("Done", { exact: true })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await waitForAssistantTurnEnd(page)
}

test.describe("assistant drive writes", () => {
	test.beforeEach(async ({ page }) => {
		await setTallListingViewport(page)
	})

	test("renames a directory's files by a pattern from the batch card", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await withScratchDirectory(page, "ai-batch", async ({ listbox, scratchName, runId }) => {
			const tag = runId.slice(0, 8)
			const names = [`alpha-${tag}.txt`, `beta-${tag}.txt`]
			const prefix = "draft-"

			await uploadFiles(
				page,
				names.map(name => textFile(name, `batch ${name}`)),
				listbox
			)

			// The scope is the directory on screen: the context line names it by path, with its handle.
			await scriptAssistant(page, {
				route: "batch change",
				steps: [
					[
						{
							name: "rename_by_pattern",
							args: { scope: `{{handle:/${scratchName}}}`, scheme: "add_prefix", text: prefix }
						}
					]
				],
				reply: "Renamed both files."
			})
			await openAssistantPanel(page)
			await sendAssistantMessage(page, `Add the prefix ${prefix} to every file in this directory`)

			const proposal = card(page, "Rename 2 files")

			await expect(proposal).toBeVisible({ timeout: 30_000 })

			const changes = proposal.getByRole("list", { name: "Changes", exact: true })

			for (const name of names) {
				await expect(changes.getByText(`${prefix}${name}`, { exact: true })).toBeVisible()
			}

			await expect(proposal.getByText("Text added before the name")).toBeVisible()
			await confirmCard(page, proposal, "Rename 2")

			for (const name of names) {
				await expect(row(listbox, `${prefix}${name}`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			}

			await expect(listbox.getByRole("option")).toHaveCount(2)
			await expect(assistantConversation(page).getByText("Renamed both files.")).toBeVisible()
		})

		expect(cspViolations).toEqual([])
	})

	// Sorted by the date uploaded, which for files uploaded here is now: the one plan that does not depend on what the
	// files' metadata say. The year comes from the browser, in the time zone the planner uses.
	test("sorts a directory's files into a year subdirectory from the organize card", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await withScratchDirectory(page, "ai-organize", async ({ listbox, scratchName, runId }) => {
			const tag = runId.slice(0, 8)
			const names = [`one-${tag}.txt`, `two-${tag}.txt`]

			await uploadFiles(
				page,
				names.map(name => textFile(name, `organize ${name}`)),
				listbox
			)

			const year = await page.evaluate(() => String(new Date().getFullYear()))

			await scriptAssistant(page, {
				route: "batch change",
				steps: [[{ name: "organize_by_date", args: { scope: `{{handle:/${scratchName}}}`, by: "year", date: "uploaded" } }]],
				reply: "Sorted them by year."
			})
			await openAssistantPanel(page)
			await sendAssistantMessage(page, "Sort the files in this directory into subdirectories by the year they were uploaded")

			const proposal = card(page, "Sort 2 files into subdirectories by date")

			await expect(proposal).toBeVisible({ timeout: 30_000 })
			await expect(proposal.getByText("By year (date uploaded)")).toBeVisible()

			const changes = proposal.getByRole("list", { name: "Changes", exact: true })

			await expect(changes.getByText(year, { exact: true })).toBeVisible()
			await expect(changes.getByText(/\(new\) · 2 files/)).toBeVisible()
			await confirmCard(page, proposal, "Move 2")

			const directory = listbox.getByRole("option", { name: leadingNamePattern(year) })

			await expect(directory).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			for (const name of names) {
				await expect(row(listbox, name)).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
			}

			await descendInto(page, listbox, year)

			const nested = await waitForListingSettled(page)

			for (const name of names) {
				await expect(row(nested.listbox, name)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			}
		})

		expect(cspViolations).toEqual([])
	})

	// The card names where the item goes back to: the scratch directory, whose row the drive root's cached listing
	// holds, so its path is known without a request (tools/entities.ts cachedRestorePath).
	test("restores a trashed file from the restore card, naming its destination directory", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await withScratchDirectory(page, "ai-restore", async ({ listbox, scratchName, runId }) => {
			const name = `restore-${runId.slice(0, 8)}.txt`

			await uploadFiles(page, [textFile(name, "restore probe")], listbox)
			await selectAndTrashRow(page, listbox, name)

			await scriptAssistant(page, {
				route: "restore change",
				steps: [
					[{ name: "list_section", args: { section: "trash", query: name } }],
					[{ name: "restore_items", args: { handles: [`{{handle:${name}}}`] } }]
				],
				reply: "Restored it."
			})
			await openAssistantPanel(page)
			await sendAssistantMessage(page, `Restore ${name} from the trash`)

			const proposal = card(page, "Restore 1 item from the trash")

			await expect(proposal).toBeVisible({ timeout: 30_000 })

			const item = proposal.getByRole("list", { name: "Items", exact: true }).getByRole("listitem")

			await expect(item).toHaveCount(1)
			await expect(item).toContainText(name)
			await expect(item).toContainText(`to /${scratchName}`)
			await confirmCard(page, proposal, "Restore 1")

			await expect(row(listbox, name)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		})

		expect(cspViolations).toEqual([])
	})

	// The move picker's own New directory: the picker enters the directory it created, and Move here moves into it.
	test("creates a directory inside the move picker and moves a file into it", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await withScratchDirectory(page, "ai-movepick", async ({ listbox, scratchName, runId }) => {
			const tag = runId.slice(0, 8)
			const name = `moved-${tag}.txt`
			const directoryName = `picked-${tag}`

			await uploadFiles(page, [textFile(name, "move probe")], listbox)

			const fileRow = row(listbox, name)

			await fileRow.click()
			await expect(fileRow).toHaveAttribute("aria-selected", "true")
			await page.getByRole("button", { name: "Move", exact: true }).click()
			await page.getByRole("menuitem", { name: menuItemName("Choose destination…") }).click()

			const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Select destination", exact: true }) })

			await expect(dialog).toBeVisible()

			// The bulk Move picker opens on the drive root: walked into the scratch directory first, so the new directory
			// lands inside it (and the scratch teardown takes it along) instead of in the shared root.
			const breadcrumb = dialog.getByRole("navigation", { name: "Breadcrumb" })

			await (await revealPickerRow(dialog, dialog.getByRole("button", { name: namePattern(scratchName) }))).dblclick()
			await expect(breadcrumb.getByText(scratchName, { exact: true })).toBeVisible()

			// Filtered by its icon: a directory row named "New directory" would match the name alone.
			await dialog
				.getByRole("button", { name: "New directory", exact: true })
				.filter({ has: page.locator("svg.lucide-folder-plus") })
				.click()

			const field = dialog.getByRole("textbox", { name: "Name of the new directory", exact: true })

			await field.fill(directoryName)
			await field.press("Enter")

			// Entered once created; the picker's breadcrumb names it.
			await expect(breadcrumb.getByText(directoryName, { exact: true })).toBeVisible({
				timeout: LIVE_WRITE_TIMEOUT_MS
			})

			const moveHere = dialog.getByRole("button", { name: "Move here", exact: true })

			await expect(moveHere).toBeEnabled()
			await moveHere.click()
			await expect(dialog).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

			await expect(fileRow).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(row(listbox, directoryName)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			await descendInto(page, listbox, directoryName)

			const nested = await waitForListingSettled(page)

			await expect(row(nested.listbox, name)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		})

		expect(cspViolations).toEqual([])
	})
})
