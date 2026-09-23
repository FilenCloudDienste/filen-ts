import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import {
	bootTo,
	createDirectoryViaDialog,
	descendInto,
	enterScratchDirectory,
	openTransfers,
	trashScratchDirectory,
	waitForListingSettled,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"
import { resolveModKey } from "./helpers/modkey"

// Copies land through the SDK's copy job (download + re-upload), so each leg waits on the job's own
// card reaching its end state rather than on the listing alone. Shared-in copies can't be exercised
// here: the e2e account has no contacts, so nothing is ever shared into it (unit-tested instead).

// Opens a submenu from its trigger; the tree levels are submenus of submenus.
async function openSubmenu(page: Page, name: string): Promise<void> {
	await page.getByRole("menuitem", { name, exact: true }).last().click()
}

async function openRowMenu(page: Page, listbox: ReturnType<Page["getByRole"]>, rowName: string): Promise<void> {
	await listbox.getByRole("option", { name: rowName }).getByRole("button", { name: "More actions", exact: true }).click()
	await expect(page.getByRole("menu").first()).toBeVisible()
}

async function uploadTextFile(page: Page, name: string): Promise<void> {
	await page
		.locator('input[type="file"]')
		.first()
		.setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(`copy probe ${name}`) })
}

test.describe.configure({ mode: "serial" })

test.describe("drive copy", () => {
	test("copies a file into another directory through the item menu's tree, leaving the source in place", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-copy-${runId}`
		const targetDirName = `target-${runId}`
		const fileName = `copied-${runId}.txt`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, targetDirName)
			await uploadTextFile(page, fileName)
			await expect(listbox.getByRole("option")).toHaveCount(2, { timeout: LIVE_WRITE_TIMEOUT_MS })

			await openRowMenu(page, listbox, fileName)
			await openSubmenu(page, "Copy")
			await openSubmenu(page, scratchName)
			await openSubmenu(page, targetDirName)
			// Scoped to the target's own level (it has no subdirectories): a bare .last() can resolve to the
			// parent level's entry before the target's submenu has mounted.
			await page
				.getByRole("menu")
				.filter({ has: page.getByRole("menuitem", { name: "No directories", exact: true }) })
				.getByRole("menuitem", { name: "Copy here", exact: true })
				.click()

			// The job's card reaches its end on its own; the source stays where it was.
			await expect(page.getByText(`Copied 1 item → ${targetDirName}`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(listbox.getByRole("option", { name: fileName })).toBeVisible()

			await descendInto(page, listbox, targetDirName)
			const nested = await waitForListingSettled(page)

			await expect(nested.listbox.getByRole("option", { name: fileName })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			// One transfers row for the whole copy, which reopens its card.
			await page.getByRole("button", { name: "Hide copy progress" }).click()
			await openTransfers(page)
			await expect(page.getByRole("button", { name: "Show copy progress" })).toHaveCount(1)
			await page.getByRole("button", { name: "Show copy progress" }).click()
			await expect(page.getByText(`Copied 1 item → ${targetDirName}`)).toBeVisible()
			// A finished card stays until dismissed, and the teardown's trash waits for toasts to clear.
			await page.getByRole("button", { name: "Hide copy progress" }).click()
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("copies a selection beside itself through the destination picker, keeping both names", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-copy-${runId}`
		const firstName = `first-${runId}.txt`
		const secondName = `second-${runId}.txt`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await uploadTextFile(page, firstName)
			await uploadTextFile(page, secondName)
			await expect(listbox.getByRole("option")).toHaveCount(2, { timeout: LIVE_WRITE_TIMEOUT_MS })

			// Both rows selected: the bulk bar's Copy opens the picker on the whole selection.
			await listbox.getByRole("option", { name: firstName }).click()
			await listbox.getByRole("option", { name: secondName }).click({ modifiers: ["Shift"] })
			await page.getByRole("toolbar", { name: "Selection actions" }).getByRole("button", { name: "Copy", exact: true }).click()

			const dialog = page.getByRole("dialog", { name: "Copy to" })

			await expect(dialog).toBeVisible()

			// The picker opens on the drive root; the selection's own directory is a valid destination.
			await dialog.getByRole("button", { name: scratchName }).dblclick()
			await expect(dialog.getByRole("navigation", { name: "Breadcrumb" }).getByText(scratchName)).toBeVisible()
			await dialog.getByRole("button", { name: "Copy here", exact: true }).click()
			await expect(dialog).toHaveCount(0)

			await expect(page.getByText(`Copied 2 items → ${scratchName}`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			// The copies sit beside their sources under new names ("name (1).txt"), so each stem is listed twice.
			await expect(listbox.getByRole("option")).toHaveCount(4, { timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(listbox.getByRole("option", { name: `first-${runId}` })).toHaveCount(2)
			await expect(listbox.getByRole("option", { name: `second-${runId}` })).toHaveCount(2)
			await page.getByRole("button", { name: "Hide copy progress" }).click()
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("copies with mod+c and cuts with mod+x, pasting by key and from the empty-space menu", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const runId = crypto.randomUUID()
		const scratchName = `e2e-copy-${runId}`
		const subName = `sub-${runId}`
		const keptName = `kept-${runId}.txt`
		const movedName = `moved-${runId}.txt`

		await bootTo(page)

		const mod = await resolveModKey(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, subName)
			await uploadTextFile(page, keptName)
			await uploadTextFile(page, movedName)
			await expect(listbox.getByRole("option")).toHaveCount(3, { timeout: LIVE_WRITE_TIMEOUT_MS })

			// mod+c in a text field stays the browser's text copy; over the listing it takes the selection.
			// Focus moves back without a click, which would toggle the selected row off again.
			const keptRow = listbox.getByRole("option", { name: keptName })

			await keptRow.click()
			await expect(keptRow).toHaveAttribute("aria-selected", "true")
			await page.getByRole("searchbox", { name: "Search" }).focus()
			await page.keyboard.press(`${mod}+c`)
			await keptRow.focus()
			await page.keyboard.press(`${mod}+c`)
			await expect(page.getByText("1 item ready to paste")).toHaveCount(1)

			await descendInto(page, listbox, subName)
			await waitForListingSettled(page)
			await page.keyboard.press(`${mod}+v`)

			await expect(page.getByText(`Copied 1 item → ${subName}`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await page.getByRole("button", { name: "Hide copy progress" }).click()
			await expect(listbox.getByRole("option", { name: keptName })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			// Cut in the parent, paste into the subdirectory through its empty-space menu: a move.
			const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" })

			await breadcrumb.getByRole("link", { name: scratchName, exact: true }).click()
			await expect(listbox.getByRole("option", { name: movedName })).toBeVisible()
			await listbox.getByRole("option", { name: movedName }).click()
			await page.keyboard.press(`${mod}+x`)
			await expect(page.getByText("1 item cut — paste it to move it")).toBeVisible()

			await descendInto(page, listbox, subName)
			await expect(listbox.getByRole("option", { name: keptName })).toBeVisible()

			const box = await listbox.boundingBox()

			if (box === null) {
				throw new Error("the listing has no box")
			}

			await listbox.click({ button: "right", position: { x: 16, y: box.height - 16 } })
			await page.getByRole("menuitem", { name: /^Paste/ }).click()

			await expect(listbox.getByRole("option", { name: movedName })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			await breadcrumb.getByRole("link", { name: scratchName, exact: true }).click()
			await expect(listbox.getByRole("option", { name: keptName })).toBeVisible()
			await expect(listbox.getByRole("option", { name: movedName })).toHaveCount(0)
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})
