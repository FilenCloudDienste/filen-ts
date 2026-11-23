import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { SW_DOWNLOAD_PREFIX } from "@/lib/sw/protocol"
import {
	bootTo,
	createDirectoryViaDialog,
	descendInto,
	LAZY_VIEWER_TIMEOUT_MS,
	LIVE_WRITE_TIMEOUT_MS,
	uploadFiles,
	waitForListingSettled
} from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture, openFixtureRows } from "./helpers/fixtures"
import { escapeRegExp, expectEntries, extractToTree, itemRow, openArchive, openRowMenu } from "./helpers/archive"
import { extractDone, withArchiveScratch } from "./helpers/jobs"
import { buildZip } from "./helpers/archiveFixtures"
import { menuItemName } from "./helpers/menu"
import { waitForSwReady } from "./helpers/sw"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import { ROUTING_EXTENSION_ENTRY, ROUTING_LATIN1_LINE, ROUTING_LOSSY_LINE, ROUTING_PACKAGE_ENTRY } from "./fixtures/routing"

// Which viewer a file opens in, by its name or by its stored type: extensions that open in an existing viewer
// (highlighted code, text, a streamed image, a package's listing), one that must not open as text, and the editor's
// lock for text that cannot be saved back as it is. Every leg but the extract reads the shared fixture tree; the
// extract writes into its own scratch directory.

const [YAML, MO] = FIXTURE_FILES["routing-code"]
const [SUBTITLES, LATIN1, MAIL, LOSSY] = FIXTURE_FILES["routing-text"]
const [JFIF, GENERIC_JPG] = FIXTURE_FILES["routing-images"]
const [CLIP_3GP] = FIXTURE_FILES["routing-video"]
const [PACKAGE] = FIXTURE_FILES["routing-package"]
const [EXTENSION] = FIXTURE_FILES["routing-extension"]

// The open text editor's content: contenteditable unless the file is shown read-only.
function editorContent(page: Page): Locator {
	return page.locator(".cm-content")
}

async function openText(page: Page, listbox: Locator, name: string, text: string): Promise<void> {
	await itemRow(listbox, name).dblclick()
	await expect(page.getByText(text)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

// A subtitle opens on its cue table and a message in the email viewer; their text is a toggle away.
async function toSource(page: Page): Promise<void> {
	await page.getByRole("dialog").getByRole("button", { name: "Source", exact: true }).click()
	await expect(editorContent(page)).toBeVisible()
}

async function closeText(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(editorContent(page)).toHaveCount(0)
}

test("code and text open in the editor, writable when a save writes them back as they were, and binary is never shown as text", async ({
	page,
	context
}) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })

	await bootTo(page)

	let listbox = await gotoFixture(page, "routing-code")

	// An extension only a grammar knows opens highlighted: its tokens sit in spans.
	await openText(page, listbox, YAML, "name: routing")
	await expect(page.locator(".cm-line span").first()).toBeVisible({ timeout: 15_000 })
	await expect(editorContent(page)).toHaveAttribute("contenteditable", "true")
	await closeText(page)

	// A compiled gettext catalog shares a grammar's extension but is binary: no preview, Open as text in Open's place,
	// which refuses it until asked and then shows it read-only.
	await openRowMenu(page, listbox, MO)
	await expect(page.getByRole("menuitem", { name: menuItemName("Open") })).toHaveCount(0)
	await page.getByRole("menuitem", { name: menuItemName("Open as text") }).click()
	await expect(page.getByText("This file isn't text.", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await page.getByRole("button", { name: "Show anyway (read-only)", exact: true }).click()
	await expect(editorContent(page)).toHaveAttribute("contenteditable", "false")
	await closeText(page)

	listbox = await gotoFixture(page, "routing-text")

	// A UTF-8 subtitle edits as text.
	await openText(page, listbox, SUBTITLES, "Hello from a subtitle")
	await toSource(page)
	await expect(editorContent(page)).toHaveAttribute("contenteditable", "true")
	await closeText(page)

	// Windows-1252 reads correctly and, a bijective codepage, saves back in it byte for byte: it edits too.
	await openText(page, listbox, LATIN1, ROUTING_LATIN1_LINE)
	await toSource(page)
	await expect(editorContent(page)).toHaveAttribute("contenteditable", "true")
	await closeText(page)

	// A message opens in the email viewer on its text body; its source, a toggle away, is kept as it arrived.
	await openText(page, listbox, MAIL, "Hello from a message")
	await toSource(page)
	await expect(page.getByText("Subject: Routing probe")).toBeVisible()
	await expect(editorContent(page)).toHaveAttribute("contenteditable", "false")
	await closeText(page)

	// UTF-8 with a byte that is not: read with a replacement character a save cannot write back, so read-only.
	await openText(page, listbox, LOSSY, ROUTING_LOSSY_LINE)
	await expect(editorContent(page)).toHaveAttribute("contenteditable", "false")
	await closeText(page)

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})

test("JPEG under an alias name, and JPEG stored with a generic type, stream over the service worker", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })
	const jpegResponses: string[] = []

	page.on("response", response => {
		if (response.url().includes(SW_DOWNLOAD_PREFIX) && response.headers()["content-type"] === "image/jpeg") {
			jpegResponses.push(response.url())
		}
	})

	await bootTo(page)

	const listbox = await gotoFixture(page, "routing-images")

	await waitForSwReady(page)

	for (const [index, name] of [JFIF, GENERIC_JPG].entries()) {
		await itemRow(listbox, name).dblclick()

		const img = page.getByRole("img", { name })

		await expect(img).toBeVisible({ timeout: 30_000 })
		// Served by the inline route as image/jpeg, not from a buffered blob: URL.
		expect(await img.getAttribute("src")).toMatch(new RegExp(`^${escapeRegExp(SW_DOWNLOAD_PREFIX)}`))
		await expect.poll(() => jpegResponses.length, { timeout: 15_000 }).toBeGreaterThan(index)

		await page.keyboard.press("Escape")
		await expect(img).toHaveCount(0)
	}

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})

test("a 3GPP video previews as a video and plays", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: true })

	await bootTo(page)

	const listbox = await gotoFixture(page, "routing-video")

	await waitForSwReady(page)
	await itemRow(listbox, CLIP_3GP).dblclick()

	const video = page.locator("video")

	await expect(video).toBeVisible({ timeout: 30_000 })
	// Muted, so no browser's autoplay policy holds it; re-asked per attempt, since the viewer may re-key its element
	// once its source resolves.
	await expect
		.poll(
			() =>
				video
					.evaluate(el => {
						const element = el as HTMLVideoElement

						element.muted = true

						if (element.paused) {
							void element.play().catch(() => undefined)
						}

						return element.currentTime
					})
					.catch(() => 0),
			{ timeout: 30_000 }
		)
		.toBeGreaterThan(0)

	await page.keyboard.press("Escape")
	await expect(video).toHaveCount(0)
	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})

test("a zip-based package lists at once at any size, and extracts into a directory", async ({ page, context }) => {
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })
	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	// Over 8 MiB, under a name the SDK's archive names do not list: still listed from its index, never gated.
	const fixture = await gotoFixture(page, "routing-package")
	const browser = await openArchive(page, fixture, PACKAGE)

	await expect(browser.row(ROUTING_PACKAGE_ENTRY)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(browser.gate.body).toHaveCount(0)
	await browser.close()

	await withArchiveScratch(
		page,
		"routing-package",
		async ({ listbox, scratchName, runId }) => {
			const archive = `e2e-routing-app-${runId}.apk`
			const destination = `dest-${runId}`

			await createDirectoryViaDialog(page, destination)

			await uploadFiles(page, [
				{
					name: archive,
					mimeType: "application/vnd.android.package-archive",
					buffer: buildZip([{ name: ROUTING_PACKAGE_ENTRY, data: "dex\n" }])
				}
			])
			await expect(itemRow(listbox, archive)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

			// Extract is offered for a package; into an empty directory, it makes one directory holding the entries.
			await extractToTree(page, listbox, archive, [scratchName, destination])
			await extractDone(page, archive)
			await descendInto(page, listbox, destination)

			const made = listbox.getByRole("option")

			await expect(made).toHaveCount(1)
			await made.dblclick()

			const inner = await waitForListingSettled(page)

			await expectEntries(inner.listbox, [ROUTING_PACKAGE_ENTRY])
		},
		cspViolations
	)

	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})

test("an icon and an animated PNG get thumbnails from the SDK", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })

	await bootTo(page)

	const { rows } = await openFixtureRows(page, "routing-thumbnails")

	// Each row's icon slot swaps to the generated thumbnail's blob: URL.
	for (const row of rows) {
		await expect(row.locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 30_000 })
	}

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})

test("a Chrome extension lists as the zip behind its signed header", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })

	await bootTo(page)

	const fixture = await gotoFixture(page, "routing-extension")
	const browser = await openArchive(page, fixture, EXTENSION)

	await expect(browser.row(ROUTING_EXTENSION_ENTRY)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await browser.close()

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})
