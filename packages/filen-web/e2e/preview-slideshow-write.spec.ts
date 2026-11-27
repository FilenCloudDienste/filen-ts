import type { Browser, Locator, Page } from "@playwright/test"
import { test, expect, settleLeases } from "./fixtures"
import { itemRow } from "./helpers/archive"
import { JPEG_BYTES, PDF_BYTES, PNG_BYTES } from "./helpers/fixtureBytes"
import {
	backTo,
	BOOT_SETTLE_TIMEOUT_MS,
	createDirectoryViaDialog,
	descendInto,
	directoryListbox,
	LAZY_VIEWER_TIMEOUT_MS,
	uploadFiles,
	withScratchDirectory,
	type UploadFile
} from "./helpers/listing"
import { closeLinkDialog, createLink, openAsVisitor, openLinkDialog } from "./helpers/publicLinks"
import { revealSlideshowBar, slideshowBar } from "./helpers/slideshow"

// A slideshow over a tree of its own: two images beside a directory holding a third. In the preview, "Include
// subdirectories" adds the nested image; on a public directory link (premium) the visitor pages through the files
// with the arrows and runs a slideshow, sees thumbnails in the list and the grid, and finds the nested image by name.

const IMAGE_A: UploadFile = { name: "slide-a.png", mimeType: "image/png", buffer: PNG_BYTES }
const IMAGE_B: UploadFile = { name: "slide-b.png", mimeType: "image/png", buffer: PNG_BYTES }
const NESTED_IMAGE: UploadFile = { name: "deep.jpg", mimeType: "image/jpeg", buffer: JPEG_BYTES }
const DOCUMENT: UploadFile = { name: "pages.pdf", mimeType: "application/pdf", buffer: PDF_BYTES }
const NESTED = "nested"
const LINKED = "linked"

// A slide stays up 5 s by default once shown; a step is due well within this. The subdirectories' list is a tree
// walk on top.
const STEP_TIMEOUT_MS = 30_000

// The two images and `extra` here, the nested image in a directory below, back up on `parent` (the directory shown).
async function fillTree(page: Page, listbox: Locator, parent: string, extra: readonly UploadFile[]): Promise<void> {
	await uploadFiles(page, [IMAGE_A, IMAGE_B, ...extra], listbox)
	await createDirectoryViaDialog(page, NESTED, listbox)
	await descendInto(page, listbox, NESTED)
	await uploadFiles(page, [NESTED_IMAGE], listbox)
	await backTo(page, parent)
}

// The tree, with a document beside the images, in a linked directory, opened by a signed-out visitor.
async function withLinkedTree(
	page: Page,
	browser: Browser,
	baseURL: string | undefined,
	label: string,
	body: (visitor: Page, listbox: Locator) => Promise<void>
): Promise<void> {
	await withScratchDirectory(page, label, async ({ listbox, scratchName }) => {
		await createDirectoryViaDialog(page, LINKED, listbox)
		await descendInto(page, listbox, LINKED)
		await fillTree(page, listbox, LINKED, [DOCUMENT])
		await backTo(page, scratchName)

		const dialog = await openLinkDialog(page, listbox, LINKED)
		const url = await createLink(dialog)

		await closeLinkDialog(page, dialog)
		await settleLeases(page)

		const visitor = await openAsVisitor(browser, baseURL, url)

		try {
			const visitorListbox = directoryListbox(visitor.page)

			await expect(itemRow(visitorListbox, IMAGE_A.name)).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
			await body(visitor.page, visitorListbox)
		} finally {
			await visitor.close()
		}
	})
}

test.describe("preview slideshow (write)", () => {
	test("include subdirectories adds a nested image", async ({ page }) => {
		await withScratchDirectory(page, "slideshow-subdirs", async ({ listbox, scratchName }) => {
			await fillTree(page, listbox, scratchName, [])
			await itemRow(listbox, IMAGE_A.name).dblclick()

			const preview = page.getByRole("dialog", { name: IMAGE_A.name, exact: true })

			await expect(preview).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await preview.getByRole("button", { name: "Slideshow", exact: true }).click()

			const bar = slideshowBar(page)
			const subdirectories = bar.getByRole("button", { name: "Include subdirectories", exact: true })

			await expect(bar.getByText("1/2", { exact: true })).toBeVisible()
			await revealSlideshowBar(page)
			await subdirectories.click()
			await expect(subdirectories).toHaveAttribute("aria-pressed", "true")
			await expect(bar.getByText(/^\d\/3$/u)).toBeVisible({ timeout: STEP_TIMEOUT_MS })
			// The nested image's turn comes within two steps.
			await expect(page.getByRole("dialog", { name: NESTED_IMAGE.name, exact: true })).toBeVisible({
				timeout: STEP_TIMEOUT_MS * 2
			})

			// Remembered on the device: back off.
			await revealSlideshowBar(page)
			await subdirectories.click()
			await expect(subdirectories).toHaveAttribute("aria-pressed", "false")
			await revealSlideshowBar(page)
			await bar.getByRole("button", { name: "End slideshow", exact: true }).click()
			await expect(bar).toHaveCount(0)
		})
	})

	test.describe("on a public directory link", () => {
		test.skip(!process.env["E2E_PREMIUM"], "public links need a premium account")

		test.beforeEach(({ browserName }) => {
			test.skip(browserName === "webkit", "a signed-out visitor: WebKit shares one OPFS per origin")
		})

		test("a public directory link pages with the arrows and runs a slideshow", async ({ page, browser, baseURL }) => {
			await withLinkedTree(page, browser, baseURL, "slideshow-link", async (visitor, listbox) => {
				const shown = (name: string) => visitor.getByTitle(name, { exact: true })

				await itemRow(listbox, IMAGE_A.name).dblclick()
				await expect(shown(IMAGE_A.name)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
				await visitor.getByRole("button", { name: "Next file", exact: true }).click()
				await expect(shown(IMAGE_B.name)).toBeVisible()
				await visitor.getByRole("button", { name: "Previous file", exact: true }).click()
				await expect(shown(IMAGE_A.name)).toBeVisible()

				await visitor.getByRole("button", { name: "Slideshow", exact: true }).click()

				const bar = slideshowBar(visitor)

				// The PDF, first in the list, is no slide.
				await expect(bar.getByText("1/2", { exact: true })).toBeVisible()
				await expect(bar.getByText("2/2", { exact: true })).toBeVisible({ timeout: STEP_TIMEOUT_MS })
				await revealSlideshowBar(visitor)
				await bar.getByRole("button", { name: "End slideshow", exact: true }).click()
				await expect(bar).toHaveCount(0)
				await expect(visitor.getByRole("button", { name: "Next file", exact: true })).toBeVisible()
			})
		})

		test("a public directory link thumbnails a PNG and a PDF in the list and the grid", async ({ page, browser, baseURL }) => {
			await withLinkedTree(page, browser, baseURL, "slideshow-link-thumbs", async (visitor, listbox) => {
				// A tile's name leads with its menu trigger's, so the name is matched anywhere in it (both are unique here).
				const expectThumbnails = async () => {
					for (const { name } of [IMAGE_A, DOCUMENT]) {
						await expect(listbox.getByRole("option", { name }).locator("img")).toHaveAttribute("src", /^blob:/u, {
							timeout: LAZY_VIEWER_TIMEOUT_MS
						})
					}
				}

				await expectThumbnails()

				await visitor.getByRole("button", { name: "Display", exact: true }).click()

				const grid = visitor.getByRole("menuitemradio", { name: "Grid view", exact: true })

				await grid.click()
				await expect(grid).toHaveAttribute("aria-checked", "true")
				await visitor.keyboard.press("Escape")
				await expect(visitor.getByRole("menu")).toHaveCount(0)
				await expectThumbnails()
			})
		})

		test("a public directory link's search finds a nested file and opens it", async ({ page, browser, baseURL }) => {
			await withLinkedTree(page, browser, baseURL, "slideshow-link-search", async (visitor, listbox) => {
				await visitor.getByLabel("Search this directory", { exact: true }).fill("deep")

				const hit = itemRow(listbox, NESTED_IMAGE.name)

				await expect(hit).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
				// With its directory's path.
				await expect(hit).toHaveAccessibleName(new RegExp(`(^|\\s)${NESTED}(\\s|$)`, "u"))
				await expect(itemRow(listbox, IMAGE_A.name)).toHaveCount(0)

				await hit.dblclick()
				await expect(visitor.getByTitle(NESTED_IMAGE.name, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			})
		})
	})
})
