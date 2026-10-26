import type { Locator, Page } from "@playwright/test"
import { test, expect, readFixtureManifest } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { DOCX_FIXTURE_TEXT, largePictureBytes, svgPictureBytes, webpPictureBytes } from "./helpers/docxFixtures"
import { ribbonButton, ribbonTab } from "./helpers/ribbon"
import { resolveModKey } from "./helpers/modkey"
import { preview } from "@/locales/en/preview"

// The DOCX editor's Insert and References tabs in a real browser: a picture from this device, the clipboard, a drop and the
// drive (the 25 MB one refused before it is read), a table of contents inserted and updated from its chip, a
// link and a footnote. Nothing is saved: the documents are only changed in the page.

type DocxEditFile = (typeof FIXTURE_FILES)["docx-edit"][number]

const INSERT = preview.previewOfficeRibbonTabInsert
const ILLUSTRATIONS = preview.previewOfficeRibbonIllustrations

async function openDocument(page: Page, name: DocxEditFile): Promise<Locator> {
	await bootTo(page)

	const { rows } = await openFixtureRows(page, "docx-edit")
	const row = rows[FIXTURE_FILES["docx-edit"].indexOf(name)]

	if (row === undefined) {
		throw new Error(`no row for ${name}`)
	}

	await row.dblclick()

	const toolbar = page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })

	await expect(toolbar).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.locator(".fo-docx-page").getByText(DOCX_FIXTURE_TEXT[name]).first()).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return toolbar
}

// A ribbon tab's button, then the item of its dropdown when it has one.
async function insertFrom(page: Page, tab: string, group: string, button: string, item?: string): Promise<void> {
	await ribbonTab(page, tab)
	await (await ribbonButton(page, page, group, button)).click()

	if (item !== undefined) {
		await page.getByRole("menuitem", { name: item, exact: true }).click()
	}
}

// Puts the caret at the end of the document's text (by the keymap the page's own UA picks).
async function caretAtEnd(page: Page): Promise<void> {
	const apple = (await resolveModKey(page)) === "Meta"

	await page
		.locator(".fo-docx-page")
		.first()
		.click({ position: { x: 200, y: 140 } })
	await page.keyboard.press(apple ? "Meta+ArrowDown" : "Control+End")
}

// Hands `bytes` to the page as one File in a DataTransfer and dispatches `events` with it on `selector`.
async function dispatchFile(
	page: Page,
	selector: string,
	events: readonly ("paste" | "dragover" | "drop")[],
	file: { name: string; type: string; bytes: Buffer }
): Promise<void> {
	await page.evaluate(
		({ selector, events, name, type, base64 }) => {
			const target = document.querySelector(selector)

			if (target === null) {
				throw new Error(`no ${selector}`)
			}

			const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
			const data = new DataTransfer()

			data.items.add(new File([bytes], name, { type }))

			const box = target.getBoundingClientRect()
			const at = { clientX: box.left + 200, clientY: box.top + 160, bubbles: true, cancelable: true }

			for (const event of events) {
				target.dispatchEvent(
					event === "paste"
						? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
						: new DragEvent(event, { ...at, dataTransfer: data })
				)
			}
		},
		{ selector, events, name: file.name, type: file.type, base64: file.bytes.toString("base64") }
	)
}

test("inserts pictures from this device, the clipboard, a drop and the drive; refuses one over 25 MB", async ({ page, browserName }) => {
	await openDocument(page, "w3-headers.docx")
	const pictures = page.locator(".fo-docx-page image")

	await caretAtEnd(page)

	const before = await pictures.count()

	// This device: the file chooser.
	const chooser = page.waitForEvent("filechooser")

	await insertFrom(page, INSERT, ILLUSTRATIONS, preview.previewDocxInsertPicture, preview.previewDocxPictureFromDevice)
	await (await chooser).setFiles({ name: "w3-picture.svg", mimeType: "image/svg+xml", buffer: svgPictureBytes() })
	await expect(pictures).toHaveCount(before + 1, { timeout: LAZY_VIEWER_TIMEOUT_MS })

	// Over 25 MB: refused from its size.
	const large = page.waitForEvent("filechooser")

	await insertFrom(page, INSERT, ILLUSTRATIONS, preview.previewDocxInsertPicture, preview.previewDocxPictureFromDevice)
	await (await large).setFiles({ name: "w3-picture-large.png", mimeType: "image/png", buffer: largePictureBytes() })
	await expect(page.getByText(preview.previewDocxPictureTooLarge)).toBeVisible()
	await expect(pictures).toHaveCount(before + 1)

	let inserted = 1

	// The clipboard: a WebP picture, converted to PNG. Firefox gives a page-made paste event no files (the unit
	// tests cover the paste path there).
	if (browserName !== "firefox") {
		await caretAtEnd(page)
		await dispatchFile(page, ".fo-docx-page", ["paste"], { name: "w3-picture.webp", type: "image/webp", bytes: webpPictureBytes() })
		inserted++
		await expect(pictures).toHaveCount(before + inserted, { timeout: LAZY_VIEWER_TIMEOUT_MS })
	}

	// A drop at a point on the page.
	await dispatchFile(page, ".fo-docx-page", ["dragover", "drop"], {
		name: "w3-picture.svg",
		type: "image/svg+xml",
		bytes: svgPictureBytes()
	})
	inserted++
	await expect(pictures).toHaveCount(before + inserted, { timeout: LAZY_VIEWER_TIMEOUT_MS })

	// The drive: its picker offers the pictures of the fixture tree.
	await insertFrom(page, INSERT, ILLUSTRATIONS, preview.previewDocxInsertPicture, preview.previewDocxPictureFromDrive)

	const picker = page.getByRole("dialog", { name: preview.previewDocxPictureDriveTitle })

	await picker.getByRole("button", { name: readFixtureManifest().fixtureRoot }).click()
	await picker.getByRole("button", { name: "docx-pictures" }).click()
	await picker.getByRole("button", { name: "w3-picture.webp" }).click()
	await expect(picker).toHaveCount(0, { timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(pictures).toHaveCount(before + inserted + 1, { timeout: LAZY_VIEWER_TIMEOUT_MS })
})

test("inserts a table of contents and updates the document's from its chip", async ({ page }) => {
	await openDocument(page, "w3-toc.docx")
	const pages = page.locator(".fo-docx-page")

	// The document's table, empty until updated.
	await pages.getByText("No table of contents entries found.").click()
	await page
		.getByRole("toolbar", { name: preview.previewDocxFieldChip })
		.getByRole("button", { name: preview.previewDocxUpdateToc })
		.click()
	await page.getByRole("menuitem", { name: preview.previewDocxTocUpdateAll }).click()
	await expect(pages.getByText("Chapter two")).toHaveCount(2, { timeout: LAZY_VIEWER_TIMEOUT_MS })

	// A new one at the end.
	await caretAtEnd(page)
	await insertFrom(page, preview.previewDocxRibbonTabReferences, preview.previewDocxRibbonToc, preview.previewDocxInsertToc)
	await page
		.getByRole("dialog", { name: preview.previewDocxTocTitle })
		.getByRole("button", { name: preview.previewDocxInsertAction })
		.click()
	await expect(pages.getByText("Chapter two")).toHaveCount(3, { timeout: LAZY_VIEWER_TIMEOUT_MS })
})

test("inserts a link and a footnote", async ({ page }) => {
	await openDocument(page, "w3-headers.docx")
	const pages = page.locator(".fo-docx-page")

	await caretAtEnd(page)
	await insertFrom(page, INSERT, preview.previewOfficeRibbonLinks, preview.previewDocxInsertLink)

	const link = page.getByRole("dialog", { name: preview.previewDocxLinkTitle })

	await link.getByLabel(preview.previewDocxLinkText).fill("E2E link text")
	// A new link goes to a web, email or phone address only.
	await link.getByLabel(preview.previewDocxLinkAddress).fill("ftp://files.example.com")
	await expect(link.getByRole("alert")).toHaveText(preview.previewDocxLinkSchemeRefused)
	await expect(link.getByRole("button", { name: preview.previewDocxInsertAction })).toBeDisabled()
	await link.getByLabel(preview.previewDocxLinkAddress).fill("example.com")
	await expect(link.getByRole("alert")).toHaveCount(0)
	await link.getByRole("button", { name: preview.previewDocxInsertAction }).click()
	await expect(pages.getByText("E2E link text")).toBeVisible()

	await insertFrom(page, preview.previewDocxRibbonTabReferences, preview.previewDocxInsertNotes, preview.previewDocxInsertFootnote)
	// Typed once the caret is in the new footnote's story.
	await expect(page.locator(".fo-docx-editor")).toHaveAttribute("data-fo-story", "footnote")
	await expect(page.locator(".fo-docx-sink [role='textbox']:focus")).toHaveCount(1)
	await page.keyboard.type("E2E footnote text")
	await expect(pages.getByText("E2E footnote text")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
})
