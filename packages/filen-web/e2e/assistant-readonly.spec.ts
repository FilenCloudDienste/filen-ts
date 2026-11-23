import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { trackCspViolations } from "./helpers/csp"
import { DOCX_MIME, DOCX_FIXTURE_TEXT, docxFixtureBytes } from "./helpers/docxFixtures"
import {
	BOOT_SETTLE_TIMEOUT_MS,
	LAZY_VIEWER_TIMEOUT_MS,
	LIVE_WRITE_TIMEOUT_MS,
	bootTo,
	clickSidebarLink,
	dismissOverlays,
	enterScratchDirectory,
	gotoDirectory,
	openRailGroupChild,
	reloadToShell,
	selectAndTrashRow,
	trashScratchDirectory,
	uploadFiles,
	waitForListingSettled,
	withScratchDirectory
} from "./helpers/listing"
import { closeLinkDialog, createLink, openLinkDialog } from "./helpers/publicLinks"
import { MOD_KEY } from "./helpers/modkey"
import {
	assistantComposer,
	assistantPanel,
	assistantRequests,
	openAssistantPanel,
	scriptAssistant,
	sendAssistantMessage,
	waitForAssistantTurnEnd
} from "./helpers/assistant"
import { preview } from "@/locales/en/preview"

// Where a preview may write its file, and where the assistant sits beside it (readOnlyOrigin in
// features/drive/lib/previewSave.logic.ts, assistantSeesPreview in features/preview/lib/activeDocumentScope.ts):
// the user's own file opens editable from every listing of it, the Links section included, with the assistant's ✨
// beside it; the trash opens it view-only and keeps the assistant out. Then the playlists list's one order (most
// recently edited first, comparePlaylists), kept across refetches and after the assistant adds tracks.
// Write lane: every test uploads into its own scratch directory.
test.describe.configure({ mode: "default" })

const DOCX_SOURCE = "notes.docx"
const DOCX_TEXT = DOCX_FIXTURE_TEXT[DOCX_SOURCE]
const PREVIEW_TOGGLE = "#assistant-preview-toggle"

function docxPageText(scope: Page | Locator): Locator {
	return scope.locator(".fo-docx-page").getByText(DOCX_TEXT).first()
}

// Opens `name` from a non-drive section's listing (Links, Trash). Those accumulate every run's items and virtualize,
// so the listing's own local filter collapses it to the row; the open is retried, since the filtered listing still
// re-renders under the cursor (preview-lifecycle.spec.ts's trash test documents both).
async function openFromSection(page: Page, section: "Links" | "Trash", urlPattern: RegExp, name: string): Promise<Locator> {
	await clickSidebarLink(page, section, urlPattern)

	const { listbox } = await waitForListingSettled(page)
	const filterBox = page.getByRole("searchbox", { name: "Search", exact: true })
	const row = listbox.getByRole("option", { name })
	const dialog = page.getByRole("dialog")
	const text = docxPageText(dialog)

	await expect(async () => {
		if (!(await text.isVisible())) {
			await page.keyboard.press("Escape").catch(() => undefined)
			await expect(dialog).toHaveCount(0, { timeout: 10_000 })
			await filterBox.fill(name)
			await expect(row).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
			await row.dblclick()
		}

		await expect(text).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	}).toPass({ timeout: 3 * LAZY_VIEWER_TIMEOUT_MS })

	return dialog
}

// Closes whatever the preview stacked (its assistant pane, then the preview itself) with Escape.
async function closePreview(page: Page): Promise<void> {
	await expect(async () => {
		await page.keyboard.press("Escape")
		await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 2_000 })
	}).toPass({ timeout: 20_000 })
}

test.describe("read-only matrix", () => {
	test("the user's own file opens editable from Links, with the assistant beside it", async ({ page }) => {
		test.skip(!process.env["E2E_PREMIUM"], "public links need a premium account (E2E_PREMIUM)")

		const cspViolations = trackCspViolations(page)

		await withScratchDirectory(page, "assistant-links", async ({ listbox, scratchName, runId }) => {
			const name = `e2e-assistant-links-${runId}.docx`

			await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: docxFixtureBytes(DOCX_SOURCE) }], listbox)

			const linkDialog = await openLinkDialog(page, listbox, name)

			await createLink(linkDialog)
			await closeLinkDialog(page, linkDialog)

			try {
				await scriptAssistant(page)

				const dialog = await openFromSection(page, "Links", /\/links$/, name)

				// Editable: the editor's ribbon, and no view-only badge.
				await expect(dialog.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toBeVisible({
					timeout: LAZY_VIEWER_TIMEOUT_MS
				})
				await expect(dialog.getByRole("button", { name: preview.previewDocxViewOnly, exact: true })).toHaveCount(0)

				// The user's own link is a preview the assistant sees: its ✨ opens the pane inside the preview.
				const toggle = page.locator(PREVIEW_TOGGLE)

				await expect(toggle).toBeVisible()
				await toggle.click()
				await expect(assistantPanel(page)).toBeVisible()
				await expect(assistantComposer(page)).toBeVisible()

				await closePreview(page)
			} finally {
				// Trashing the file disables its link (driveCommandTrashHint), so nothing is left shared.
				await dismissOverlays(page)

				const scratch = await gotoDirectory(page, [scratchName])

				await selectAndTrashRow(page, scratch, name)
			}
		})

		expect(cspViolations).toEqual([])
	})

	test("a file in the trash opens view-only, with no assistant beside it", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await withScratchDirectory(page, "assistant-trash", async ({ listbox, runId }) => {
			const name = `e2e-assistant-trash-${runId}.docx`

			await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: docxFixtureBytes(DOCX_SOURCE) }], listbox)
			await selectAndTrashRow(page, listbox, name)

			const dialog = await openFromSection(page, "Trash", /\/trash$/, name)
			const viewOnly = dialog.getByRole("button", { name: preview.previewDocxViewOnly, exact: true })

			await expect(viewOnly).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await viewOnly.click()

			const reason = page.getByText(preview.previewDocxViewOnlyTrash, { exact: true })

			await expect(reason).toBeVisible()
			await page.keyboard.press("Escape")
			await expect(reason).toHaveCount(0)

			// No editor, no assistant: the trash stays hands-off.
			await expect(dialog.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toHaveCount(0)
			await expect(page.locator(PREVIEW_TOGGLE)).toHaveCount(0)
			await expect(assistantPanel(page)).toHaveCount(0)

			await closePreview(page)
		})

		expect(cspViolations).toEqual([])
	})
})

// A valid PCM WAV of silence (8 kHz, 16-bit, mono), as audio.spec.ts builds its tracks.
function silentWav(seconds: number): Buffer {
	const sampleRate = 8_000
	const dataSize = sampleRate * seconds * 2
	const buffer = Buffer.alloc(44 + dataSize)

	buffer.write("RIFF", 0, "ascii")
	buffer.writeUInt32LE(36 + dataSize, 4)
	buffer.write("WAVE", 8, "ascii")
	buffer.write("fmt ", 12, "ascii")
	buffer.writeUInt32LE(16, 16)
	buffer.writeUInt16LE(1, 20)
	buffer.writeUInt16LE(1, 22)
	buffer.writeUInt32LE(sampleRate, 24)
	buffer.writeUInt32LE(sampleRate * 2, 28)
	buffer.writeUInt16LE(2, 32)
	buffer.writeUInt16LE(16, 34)
	buffer.write("data", 36, "ascii")
	buffer.writeUInt32LE(dataSize, 40)

	return buffer
}

async function openPlaylists(page: Page): Promise<void> {
	await openRailGroupChild(page, "Media", "Playlists", /\/playlists(\/|$)/)
	await expect(page.getByRole("heading", { name: "Playlists", exact: true })).toBeVisible()
}

function playlistRow(page: Page, name: string): Locator {
	return page.getByRole("listitem").filter({ hasText: name })
}

async function createPlaylist(page: Page, name: string): Promise<void> {
	await page.getByRole("button", { name: "New playlist" }).click()

	const dialog = page.getByRole("dialog", { name: "New playlist" })

	await expect(dialog).toBeVisible()
	await dialog.getByLabel("Name", { exact: true }).fill(name)
	await dialog.getByRole("button", { name: "Create", exact: true }).click()
	await expect(dialog).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
	await expect(playlistRow(page, name)).toHaveCount(1)
}

// Idempotent: the body's own removal and the finally's net (nothing but the next run's cleanup sweeps playlists).
async function deletePlaylist(page: Page, name: string): Promise<void> {
	await openPlaylists(page)

	const row = playlistRow(page, name).first()
	const present = await row
		.waitFor({ state: "visible", timeout: 15_000 })
		.then(() => true)
		.catch(() => false)

	if (!present) {
		return
	}

	await row.getByRole("button", { name: "Playlist options" }).click()
	await page.getByRole("menuitem", { name: "Delete" }).click()
	await page.getByRole("alertdialog", { name: "Delete playlist" }).getByRole("button", { name: "Delete", exact: true }).click()
	await expect(playlistRow(page, name)).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
}

test("the playlists list keeps one order across refetches and after the assistant adds tracks", async ({ page }) => {
	const cspViolations = trackCspViolations(page)
	const runId = crypto.randomUUID()
	const scratchName = `e2e-assistant-playlist-${runId}`
	const trackA = `e2e-apl-a-${runId}.wav`
	const trackB = `e2e-apl-b-${runId}.wav`
	// Distinct from the scratch directory's name, so a name-scoped locator never matches both.
	const older = `e2e-apl-x-${runId}`
	const newer = `e2e-apl-y-${runId}`
	const ours = new RegExp(`e2e-apl-[xy]-${runId}`)

	// The two playlists' rows in the sidebar's DOM order: the account may hold others, which only interleave.
	async function order(): Promise<string[]> {
		const texts = await page.getByRole("listitem").filter({ hasText: ours }).allInnerTexts()

		return texts.map(text => (text.includes(older) ? older : newer))
	}

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		await uploadFiles(
			page,
			[
				{ name: trackA, mimeType: "audio/wav", buffer: silentWav(2) },
				{ name: trackB, mimeType: "audio/wav", buffer: silentWav(2) }
			],
			listbox
		)

		await openPlaylists(page)
		await createPlaylist(page, older)
		await createPlaylist(page, newer)

		// Most recently edited first, and the same after a refetch of every playlist file (a reload).
		await expect.poll(order).toEqual([newer, older])
		await reloadToShell(page)
		await expect(page.getByRole("heading", { name: "Playlists", exact: true })).toBeVisible()
		await expect.poll(order, { timeout: BOOT_SETTLE_TIMEOUT_MS }).toEqual([newer, older])

		// The assistant adds both tracks, selected in the drive, to the older playlist (stub installed after the reload:
		// it lives in the page).
		const scratch = await gotoDirectory(page, [scratchName])

		await scriptAssistant(page, {
			route: "audio change",
			steps: [
				[{ name: "list_playlists", args: {} }],
				[
					{
						name: "add_tracks_to_playlist",
						args: { playlist: `{{handle:${older}}}`, handles: [`{{handle:${trackA}}}`, `{{handle:${trackB}}}`] }
					}
				]
			],
			reply: "Added the two tracks."
		})
		await openAssistantPanel(page)

		const rowA = scratch.getByRole("option", { name: trackA })
		const rowB = scratch.getByRole("option", { name: trackB })

		await rowA.click()
		await rowB.click({ modifiers: [MOD_KEY] })
		await expect(rowB).toHaveAttribute("aria-selected", "true")
		await expect(rowA).toHaveAttribute("aria-selected", "true")

		await sendAssistantMessage(page, `Add the selected tracks to the playlist ${older}`)

		const card = assistantPanel(page).getByRole("group", { name: "Add 2 tracks to a playlist" })

		await expect(card).toBeVisible({ timeout: 30_000 })
		// The card lists the tracks in the order the call named them.
		await expect(card.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveText([trackA, trackB])
		await card.getByRole("button", { name: "Confirm", exact: true }).click()
		await expect(card.getByText("Done", { exact: true })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		await waitForAssistantTurnEnd(page, LIVE_WRITE_TIMEOUT_MS)

		// The turn read the selection from the screen context, never a guess.
		const steps = (await assistantRequests(page)).filter(request => request.kind === "step")

		expect(steps[0]?.last).toContain(trackA)
		expect(steps[0]?.last).toContain(trackB)

		// The edited playlist moves first, holds the tracks in the call's order, and keeps both orders after a reload.
		await openPlaylists(page)
		await expect.poll(order, { timeout: LIVE_WRITE_TIMEOUT_MS }).toEqual([older, newer])
		await playlistRow(page, older).first().getByRole("link", { name: older }).click()

		const pane = page.getByRole("region", { name: older })
		const firstTrack = pane.locator('tbody tr[aria-rowindex="2"]')
		const secondTrack = pane.locator('tbody tr[aria-rowindex="3"]')

		await expect(firstTrack.getByText(trackA)).toBeVisible({ timeout: 30_000 })
		await expect(secondTrack.getByText(trackB)).toBeVisible()

		await reloadToShell(page)
		await expect(page.getByRole("heading", { name: "Playlists", exact: true })).toBeVisible()
		await expect.poll(order, { timeout: BOOT_SETTLE_TIMEOUT_MS }).toEqual([older, newer])
		await expect(page.getByRole("region", { name: older }).locator('tbody tr[aria-rowindex="2"]').getByText(trackA)).toBeVisible({
			timeout: 30_000
		})

		expect(cspViolations).toEqual([])
	} finally {
		await dismissOverlays(page)

		for (const name of [older, newer]) {
			await deletePlaylist(page, name).catch((error: unknown) => {
				console.error(`assistant-readonly: playlist "${name}" not removed, left for the next run's sweep`, error)
			})
		}

		await trashScratchDirectory(page, scratchName)
	}
})
