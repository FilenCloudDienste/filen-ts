import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { compressPreset, escapeRegExp, extractQuick, namePattern, openRowMenu, pickTreeTarget } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { html5DragCopy } from "./helpers/dnd"
import { FIXTURE_FILES, enterFixtureDirectory } from "./helpers/fixtures"
import { boxOf } from "./helpers/geometry"
import {
	cardButton,
	expectJobCard,
	hideJobCards,
	holdChunks,
	jobCard,
	openStopPrompt,
	pauseFirst,
	stopAllJobs,
	stopJob,
	type ChunkHold
} from "./helpers/jobs"
import {
	bootTo,
	breadcrumb,
	clickSidebarLink,
	createDirectoryViaDialog,
	descendInto,
	enterScratchDirectory,
	expectBreadcrumbAt,
	openTransfers,
	trashScratchDirectory,
	uploadFiles,
	waitForListingSettled,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"
import { resolveModKey } from "./helpers/modkey"

// Copies land through the SDK's copy job (download + re-upload), so each leg waits on the job's own
// card reaching its end state rather than on the listing alone. Shared-in copies can't be exercised
// here: the e2e account has no contacts, so nothing is ever shared into it (unit-tested instead).

async function uploadTextFile(page: Page, name: string): Promise<void> {
	await uploadFiles(page, [{ name, mimeType: "text/plain", buffer: Buffer.from(`copy probe ${name}`) }])
}

test.describe.configure({ mode: "serial" })

test.describe("drive copy", () => {
	test("copies a file into another directory through the item menu's tree, leaving the source in place", async ({ page }) => {
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
			// Taken at the target's own level (it has no subdirectories), never a bare .last().
			await pickTreeTarget(page, "Copy", [scratchName, targetDirName], "Copy here")

			// The job's card reaches its end on its own; the source stays where it was.
			await expect(page.getByText(`Copied 1 item → ${targetDirName}`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(listbox.getByRole("option", { name: fileName })).toBeVisible()

			await descendInto(page, listbox, targetDirName)
			const nested = await waitForListingSettled(page)

			await expect(nested.listbox.getByRole("option", { name: fileName })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			// One transfers row for the whole copy, which reopens its card. The hidden card leaves through
			// its exit animation first; a card reopened meanwhile is a second one beside it (copyToast.ts).
			await hideJobCards(page, ["copy"])
			await expect(page.getByText(`Copied 1 item → ${targetDirName}`)).toHaveCount(0)
			await openTransfers(page)
			await expect(page.getByRole("button", { name: "Show copy progress" })).toHaveCount(1)
			await page.getByRole("button", { name: "Show copy progress" }).click()
			await expect(page.getByText(`Copied 1 item → ${targetDirName}`)).toBeVisible()
			await hideJobCards(page, ["copy"])
		} finally {
			await hideJobCards(page, ["copy"])
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("copies a selection beside itself through the destination picker, keeping both names", async ({ page }) => {
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
			await hideJobCards(page, ["copy"])
		} finally {
			await hideJobCards(page, ["copy"])
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("copies with mod+c and cuts with mod+x, pasting by key and from the empty-space menu", async ({ page }) => {
		const runId = crypto.randomUUID()
		const scratchName = `e2e-copy-${runId}`
		const subName = `sub-${runId}`
		const keptName = `kept-${runId}.txt`
		const movedName = `moved-${runId}.txt`

		await bootTo(page)

		const mod = await resolveModKey(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			const openEmptySpaceMenu = async (): Promise<void> => {
				const box = await boxOf(listbox)

				await listbox.click({ button: "right", position: { x: 16, y: box.height - 16 } })
			}

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
			await hideJobCards(page, ["copy"])
			await expect(listbox.getByRole("option", { name: keptName })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			// A copy stays on the clipboard for further pastes until it is cleared.
			await openEmptySpaceMenu()
			await page.getByRole("menuitem", { name: "Clear clipboard" }).click()
			await openEmptySpaceMenu()
			await expect(page.getByRole("menuitem", { name: /^Paste/ })).toHaveAttribute("aria-disabled", "true")
			await expect(page.getByRole("menuitem", { name: "Clear clipboard" })).toHaveAttribute("aria-disabled", "true")
			await page.keyboard.press("Escape")

			// Cut in the parent, paste into the subdirectory through its empty-space menu: a move.
			const crumbs = breadcrumb(page)

			await crumbs.getByRole("link", { name: scratchName, exact: true }).click()
			await expect(listbox.getByRole("option", { name: movedName })).toBeVisible()
			await listbox.getByRole("option", { name: movedName }).click()
			await page.keyboard.press(`${mod}+x`)
			await expect(page.getByText("1 item cut — paste it to move it")).toBeVisible()

			await descendInto(page, listbox, subName)
			await expect(listbox.getByRole("option", { name: keptName })).toBeVisible()

			await openEmptySpaceMenu()
			await page.getByRole("menuitem", { name: /^Paste/ }).click()

			await expect(listbox.getByRole("option", { name: movedName })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			// Gated on the current crumb before asserting: keptName is in both directories, and the moved row's
			// absence would also hold for the moment between the two listings.
			await crumbs.getByRole("link", { name: scratchName, exact: true }).click()
			await expect(crumbs.locator('[aria-current="page"]')).toHaveText(scratchName)
			await waitForListingSettled(page)
			await expect(listbox.getByRole("option", { name: keptName })).toBeVisible()
			await expect(listbox.getByRole("option", { name: movedName })).toHaveCount(0)
		} finally {
			await hideJobCards(page, ["copy"])
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("copies by dragging with the copy modifier held, onto a row and onto a breadcrumb", async ({ page }) => {
		const runId = crypto.randomUUID()
		const scratchName = `e2e-copy-${runId}`
		const subName = `sub-${runId}`
		const fileName = `dragged-${runId}.txt`

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, subName)
			await uploadTextFile(page, fileName)
			await expect(listbox.getByRole("option")).toHaveCount(2, { timeout: LIVE_WRITE_TIMEOUT_MS })

			// Onto a directory row: a copy lands there and the source stays.
			await html5DragCopy(page, { selector: '[role="option"]', text: fileName }, { selector: '[role="option"]', text: subName })
			await expect(page.getByText(`Copied 1 item → ${subName}`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await hideJobCards(page, ["copy"])
			await expect(listbox.getByRole("option", { name: fileName })).toBeVisible()

			// From inside the subdirectory back onto its parent's breadcrumb: a second copy there.
			await descendInto(page, listbox, subName)
			await expect(listbox.getByRole("option", { name: fileName })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await html5DragCopy(
				page,
				{ selector: '[role="option"]', text: fileName },
				{ selector: 'nav[aria-label="Breadcrumb"] a', text: scratchName }
			)
			await expect(page.getByText(`Copied 1 item → ${scratchName}`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await hideJobCards(page, ["copy"])
			await expect(listbox.getByRole("option", { name: fileName })).toBeVisible()

			await breadcrumb(page).getByRole("link", { name: scratchName, exact: true }).click()
			await expect(listbox.getByRole("option", { name: `dragged-${runId}` })).toHaveCount(2, { timeout: LIVE_WRITE_TIMEOUT_MS })
		} finally {
			await hideJobCards(page, ["copy"])
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("pauses a copy, mirrors it in its transfers row, and stops it three ways: continue, keep, move to the trash", async ({
		page,
		browserName
	}) => {
		const cspViolations = trackCspViolations(page)
		const runId = crypto.randomUUID()
		const scratchName = `e2e-copy-${runId}`
		// One destination per leg, so what one stop leaves behind never meets the next leg's assertion.
		const keepDir = `keep-${runId}`
		const trashDir = `trash-${runId}`
		const runDir = `run-${runId}`
		// 24 MiB from the read-only fixture tree: long enough that Pause lands before the copy is done.
		const [source] = FIXTURE_FILES["download-cancel"]
		let hold: ChunkHold | null = null

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			for (const name of [keepDir, trashDir, runDir]) {
				await createDirectoryViaDialog(page, name, listbox)
			}

			await clickSidebarLink(page, "Cloud Drive", /\/drive$/)
			await waitForListingSettled(page)

			const fixture = await enterFixtureDirectory(page, "download-cancel")
			const copyInto = async (directory: string) => {
				await openRowMenu(page, fixture.listbox, source)
				await pickTreeTarget(page, "Copy", [scratchName, directory], "Copy here")

				// By the destination alone: the title reads "Copying … → X", then "Copy to X" once stopped.
				return expectJobCard(page, directory, LIVE_WRITE_TIMEOUT_MS)
			}

			// ---- paused: the card offers Resume, the transfers row mirrors it ----
			const keepCard = await copyInto(keepDir)

			await pauseFirst(keepCard)
			await expect(cardButton(keepCard, "Resume")).toBeVisible()

			await openTransfers(page)
			// One row for the whole copy, named after its one item (transferRow.tsx).
			await expect(
				page.getByRole("listitem", { name: source, exact: true }).getByRole("button", { name: "Resume", exact: true })
			).toBeVisible()

			// The three-way prompt; Continue leaves the job exactly as it was, paused.
			const stopPrompt = await openStopPrompt(page, keepCard, "copy")

			for (const choice of ["Continue copying", "Move copied items to trash", "Stop and keep copied items"]) {
				await expect(stopPrompt.getByRole("button", { name: choice, exact: true })).toBeVisible()
			}

			await stopPrompt.getByRole("button", { name: "Continue copying", exact: true }).click()
			await expect(stopPrompt).toHaveCount(0)
			await expect(keepCard.getByText("Paused", { exact: true })).toBeVisible()

			await stopJob(page, keepCard, "copy", "Stop and keep copied items")
			await keepCard.hover()
			await expect(keepCard.getByText("Stopped. What was copied so far was kept.", { exact: true })).toBeVisible({
				timeout: LIVE_WRITE_TIMEOUT_MS
			})
			await hideJobCards(page, ["copy"])

			// Back to the fixture listing through history: a reload would end every job this tab runs.
			await page.goBack()
			await expectBreadcrumbAt(page, "download-cancel")
			await waitForListingSettled(page)

			// ---- a second copy, stopped with its copied items moved to the trash ----
			const trashCard = await copyInto(trashDir)

			await pauseFirst(trashCard)
			await stopJob(page, trashCard, "copy", "Move copied items to trash")
			await trashCard.hover()
			await expect(trashCard.getByText(/^Stopped\./)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await hideJobCards(page, ["copy"])

			// ---- running rather than paused: held on its upload chunks, stopped and kept ----
			// Playwright's WebKit never routes the SDK worker's requests (helpers/jobs.ts), so this leg needs
			// Chromium or Firefox; the paused legs above already cover the stop prompt there.
			hold = await holdChunks(page, browserName, { hosts: "ingest" })

			if (hold !== null) {
				const held = hold
				const runCard = await copyInto(runDir)

				await expect.poll(() => held.held(), { timeout: LIVE_WRITE_TIMEOUT_MS }).toBeGreaterThan(0)
				await expect(cardButton(runCard, "Pause")).toBeVisible()
				await stopJob(page, runCard, "copy", "Stop and keep copied items")
				// Released only once the stop is asked for: the chunks in flight then finish, nothing after them starts.
				held.release()
				await runCard.hover()
				await expect(runCard.getByText("Stopped. What was copied so far was kept.", { exact: true })).toBeVisible({
					timeout: LIVE_WRITE_TIMEOUT_MS
				})
				await hideJobCards(page, ["copy"])
				await held.dispose()
				hold = null
			}

			// ---- the trashed leg left nothing in its destination ----
			await clickSidebarLink(page, "Cloud Drive", /\/drive$/)

			const root = await waitForListingSettled(page)

			await descendInto(page, root.listbox, scratchName)
			await descendInto(page, root.listbox, trashDir)
			await expect(root.listbox.getByRole("option", { name: namePattern(source) })).toHaveCount(0)

			expect(cspViolations).toEqual([])
		} finally {
			await stopAllJobs(page, [hold])
			await trashScratchDirectory(page, scratchName)
		}
	})

	test("a copy, a compress and an extract each get their own transfers row, which reopens that job's own card", async ({ page }) => {
		const cspViolations = trackCspViolations(page)
		const runId = crypto.randomUUID()
		const scratchName = `e2e-copy-${runId}`
		const destName = `dest-${runId}`
		const stem = `kinds-${runId}`
		const fileName = `${stem}.txt`
		const archiveName = `${stem}.zip`
		const kinds = [
			{ show: "Show copy progress", hide: "Hide copy progress", title: `Copied 1 item → ${destName}` },
			{ show: "Show compress progress", hide: "Hide compress progress", title: `Compressed 1 item into ${archiveName}` },
			{ show: "Show extract progress", hide: "Hide extract progress", title: new RegExp(`Extracted ${escapeRegExp(archiveName)} → `) }
		] as const
		// Every card, the leaving ones included: a card reopened while another still exits is a second one.
		const anyCard = jobCard(page, /./)

		await bootTo(page)

		try {
			const { listbox } = await enterScratchDirectory(page, scratchName)

			await createDirectoryViaDialog(page, destName, listbox)
			await uploadTextFile(page, fileName)
			await expect(listbox.getByRole("option")).toHaveCount(2, { timeout: LIVE_WRITE_TIMEOUT_MS })

			await openRowMenu(page, listbox, fileName)
			await pickTreeTarget(page, "Copy", [scratchName, destName], "Copy here")
			await expectJobCard(page, kinds[0].title, LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page)

			await compressPreset(page, listbox, [fileName], "ZIP (.zip)")
			await expectJobCard(page, kinds[1].title, LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page)
			await expect(listbox.getByRole("option", { name: namePattern(archiveName) })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			await extractQuick(page, listbox, archiveName, /^Extract here to “/)
			await expectJobCard(page, kinds[2].title, LIVE_WRITE_TIMEOUT_MS)
			await hideJobCards(page)
			await expect(listbox.getByRole("option", { name: namePattern(stem) })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
			await expect(anyCard).toHaveCount(0)

			await openTransfers(page)

			for (const { show } of kinds) {
				await expect(page.getByRole("button", { name: show, exact: true })).toHaveCount(1)
			}

			for (const { show, hide, title } of kinds) {
				await page.getByRole("button", { name: show, exact: true }).click()
				await expect(page.getByRole("button", { name: hide, exact: true })).toHaveCount(1)
				await expect(page.getByRole("button", { name: /^Hide (copy|compress|extract) progress$/ })).toHaveCount(1)
				await expect(jobCard(page, title)).toBeVisible()
				await hideJobCards(page)
				await expect(anyCard).toHaveCount(0)
			}

			expect(cspViolations).toEqual([])
		} finally {
			await stopAllJobs(page)
			await trashScratchDirectory(page, scratchName)
		}
	})
})
