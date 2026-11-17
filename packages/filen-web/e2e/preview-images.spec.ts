import type { Locator, Page } from "@playwright/test"
import { test, expect, readFixtureManifest, settleLeases } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture, openFixtureRows } from "./helpers/fixtures"
import { itemRow, openArchive, openRowMenu } from "./helpers/archive"
import { menuItemName } from "./helpers/menu"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import { closeLinkDialog, createLink, openLinkDialog } from "./helpers/publicLinks"
import { PDF_BYTES } from "./helpers/fixtureBytes"
import { IMAGE_ENTRIES, PSD_SIZE, QOI_SIZE, TIFF_PAGE, jxlSample, qoiSample, tiffSample } from "./fixtures/images"
import { preview } from "@/locales/en/preview"

// Images only the app's own decoders show (QOI, JPEG XL where the browser has no decoder, gzipped SVG, TIFF): decoded
// in the raster decode pool or the MuPDF engine and drawn from a bitmap on a canvas. The viewer legs read the shared
// fixture tree (on the drive, in an archive, behind a forced fallback); the editor, stamp and public-link legs work in
// scratch directories of their own.

// The engine worker compiles MuPDF (about 10 MB of wasm) on its first use.
const ENGINE_TIMEOUT_MS = 60_000

// The shown picture: an <img> (the browser's decode) or a canvas (ours), named for the file.
function picture(page: Page, name: string): Locator {
	return page.getByRole("img", { name, exact: true })
}

async function tagOf(locator: Locator): Promise<string> {
	return await locator.evaluate(element => element.tagName)
}

const [QOI] = FIXTURE_FILES["images-qoi"]
const [JXL] = FIXTURE_FILES["images-jxl"]
const [SVGZ, SVGZ_BOMB] = FIXTURE_FILES["images-svgz"]
const [TIFF_SINGLE, TIFF_PAGES, TIFF_BIG] = FIXTURE_FILES["images-tiff"]

test("a QOI image is decoded and drawn", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: false })

	await bootTo(page)

	const listbox = await gotoFixture(page, "images-qoi")

	await itemRow(listbox, QOI).dblclick()

	const picture = page.getByRole("img", { name: QOI })

	await expect(picture).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	expect(await picture.evaluate(element => element.tagName)).toBe("CANVAS")
	await expect(picture).toHaveAttribute("width", String(QOI_SIZE.width))
	// Smaller than the display long side: drawn whole, no reduced chip.
	await expect(page.getByRole("button", { name: "Full res ▸" })).toHaveCount(0)

	await page.keyboard.press("Escape")
	await expect(picture).toHaveCount(0)

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})

test("a JPEG XL is shown by the browser where it decodes one, else decoded in the pool", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: false })

	await bootTo(page)

	const listbox = await gotoFixture(page, "images-jxl")

	await itemRow(listbox, JXL).dblclick()

	const picture = page.getByRole("img", { name: JXL })

	await expect(picture).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	// The boot probe's answer picks the route: the browser's <img>, or the pool's bitmap on a canvas.
	const { jxl: native } = await page.evaluate(() => window.__filenE2E.nativeImageSupport())

	expect(await picture.evaluate(element => element.tagName)).toBe(native ? "IMG" : "CANVAS")

	await page.keyboard.press("Escape")
	await expect(picture).toHaveCount(0)

	// Forced onto the route of a browser without a decoder: libjxl in the pool, drawn on a canvas, in every engine.
	await page.evaluate(() => window.__filenE2E.forceDecodedImages())
	await itemRow(listbox, JXL).dblclick()
	await expect(picture).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	expect(await picture.evaluate(element => element.tagName)).toBe("CANVAS")
	await expect(picture).toHaveAttribute("width", "1")
	await page.keyboard.press("Escape")
	await expect(picture).toHaveCount(0)

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})

test("a gzipped SVG is inflated and shown as an SVG, and one inflating past the cap is refused", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: false })

	await bootTo(page)

	const listbox = await gotoFixture(page, "images-svgz")

	await itemRow(listbox, SVGZ).dblclick()

	const picture = page.getByRole("img", { name: SVGZ })

	await expect(picture).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	// Shown from a blob of the inflated markup, never served by the inline route.
	await expect(picture).toHaveAttribute("src", /^blob:/)
	await expect.poll(() => picture.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(80)

	await page.keyboard.press("Escape")
	await expect(picture).toHaveCount(0)

	await itemRow(listbox, SVGZ_BOMB).dblclick()
	await expect(page.getByText("This image is too large to show once uncompressed.", { exact: true })).toBeVisible({
		timeout: LAZY_VIEWER_TIMEOUT_MS
	})
	await page.keyboard.press("Escape")

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})

test("a TIFF is read by the MuPDF engine: one page as a picture, several in the page column, BigTIFF refused", async ({
	page,
	context
}) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: false })

	await bootTo(page)

	const listbox = await gotoFixture(page, "images-tiff")

	// One page: drawn whole as a bitmap on a canvas, at its own size (below the display long side).
	await itemRow(listbox, TIFF_SINGLE).dblclick()

	const single = page.getByRole("img", { name: TIFF_SINGLE })

	await expect(single).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	expect(await single.evaluate(element => element.tagName)).toBe("CANVAS")
	await expect(single).toHaveAttribute("width", String(TIFF_PAGE.width))
	await page.keyboard.press("Escape")
	await expect(single).toHaveCount(0)

	// Several pages: the page column with its page commands (no find: an image has no text); the next-page key walks
	// to the last.
	await itemRow(listbox, TIFF_PAGES).dblclick()
	await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("button", { name: "Find in document" })).toHaveCount(0)

	for (const shown of [2, 3]) {
		await page.keyboard.press("n")
		await expect(page.getByText(`Page ${String(shown)} of 3`, { exact: true })).toBeVisible({ timeout: 15_000 })
	}

	await page.keyboard.press("Escape")

	// BigTIFF: refused from its header.
	await itemRow(listbox, TIFF_BIG).dblclick()
	await expect(page.getByText("BigTIFF images can't be previewed.", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await page.keyboard.press("Escape")

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})

test("QOI, JPEG XL and TIFF entries of an archive open through the entry's bytes", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: false })
	const [ARCHIVE] = FIXTURE_FILES["images-archive"]

	await bootTo(page)

	const listbox = await gotoFixture(page, "images-archive")
	const browser = await openArchive(page, listbox, ARCHIVE)

	for (const [format, name] of Object.entries(IMAGE_ENTRIES)) {
		await expect(browser.row(name)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await browser.row(name).dblclick()

		const shown = picture(page, name)

		await expect(shown, format).toBeVisible({ timeout: format === "tiff" ? ENGINE_TIMEOUT_MS : LAZY_VIEWER_TIMEOUT_MS })

		// QOI and TIFF are always ours; JPEG XL is the browser's where it decodes it.
		if (format !== "jxl") {
			expect(await tagOf(shown), format).toBe("CANVAS")
		}

		await page.getByRole("button", { name: preview.previewArchiveEntryBack, exact: true }).click()
		await expect(shown).toHaveCount(0)
	}

	await browser.close()

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})

test("a PDF stamp takes a TIFF's and a QOI's picture from Filen, and is never offered a gzipped SVG", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const { fixtureRoot } = readFixtureManifest()

	await withScratchDirectory(page, "images-stamp", async ({ listbox, runId }) => {
		const name = `e2e-images-stamp-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: "application/pdf", buffer: PDF_BYTES }], listbox)
		await itemRow(listbox, name).dblclick()

		const dialog = page.getByRole("dialog").first()
		const pageRegion = dialog.getByRole("region", { name: /Page 1 of/u })

		await expect(pageRegion).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

		const stamps = dialog.locator('[data-annotation-type="Stamp"]')
		const picker = page.getByRole("dialog", { name: preview.previewPdfAnnotImageFromFilen, exact: true })

		// Stamp ▾ › Image from Filen, then a click on the page asks for the picture.
		const place = async (at: number): Promise<void> => {
			await dialog
				.getByRole("button", { name: preview.previewPdfToolVariants.replace("{{tool}}", preview.previewPdfAnnotToolStamp) })
				.click()
			await page.getByRole("menuitem", { name: preview.previewPdfAnnotImageFromFilen }).click()

			const box = await pageRegion.boundingBox()

			if (box === null) throw new Error("the page is not shown")

			await page.mouse.click(box.x + box.width * at, box.y + box.height * 0.5)

			const author = page.getByRole("textbox", { name: preview.previewOfficeAuthorNameLabel })

			if (await author.isVisible().catch(() => false)) {
				await author.fill("E2E Author")
				await page.getByRole("button", { name: preview.previewOfficeAuthorNameSave }).click()
			}

			await expect(picker).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
			await picker.getByRole("button", { name: fixtureRoot }).click()
		}

		// A gzipped SVG is not offered (markup, not pixels); its directory shows no file.
		await place(0.3)
		await picker.getByRole("button", { name: "images-svgz" }).click()
		await expect(picker.getByRole("button", { name: /\.svgz$/u })).toHaveCount(0)
		await page.keyboard.press("Escape")
		await expect(picker).toHaveCount(0)

		// A TIFF's first page, drawn by an engine of its own.
		await place(0.3)
		await picker.getByRole("button", { name: "images-tiff" }).click()
		await picker.getByRole("button", { name: FIXTURE_FILES["images-tiff"][0], exact: true }).click()
		await expect(picker).toHaveCount(0, { timeout: ENGINE_TIMEOUT_MS })
		await expect(stamps).toHaveCount(1, { timeout: ENGINE_TIMEOUT_MS })

		// A QOI, decoded in the raster decode pool.
		await place(0.7)
		await picker.getByRole("button", { name: "images-qoi" }).click()
		await picker.getByRole("button", { name: QOI, exact: true }).click()
		await expect(picker).toHaveCount(0, { timeout: ENGINE_TIMEOUT_MS })
		await expect(stamps).toHaveCount(2, { timeout: ENGINE_TIMEOUT_MS })

		// Left unsaved.
		await page.keyboard.press("Escape")
		await page
			.getByRole("alertdialog", { name: preview.previewUnsavedChangesTitle })
			.getByRole("button", { name: /Discard/u })
			.click()
		await expect(page.getByRole("dialog")).toHaveCount(0)
	})

	expect(cspViolations).toEqual([])
})

test("a QOI is edited from the pool's decode and saved as a PNG copy beside it", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "images-qoi-edit", async ({ listbox, runId }) => {
		const stem = `e2e-qoi-edit-${runId}`
		const name = `${stem}.qoi`

		await uploadFiles(page, [{ name, mimeType: "image/x-qoi", buffer: qoiSample() }], listbox)
		await itemRow(listbox, name).dblclick()
		await expect(picture(page, name)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await page.getByRole("button", { name: preview.previewImageSaveEditAction, exact: true }).click()

		// The editor runs where the browser gives a worker WebGL 2; elsewhere it says so, and the leg ends there.
		const save = page.getByRole("button", { name: preview.previewImageSaveAsPngCopyAction, exact: true })
		const refused = page.getByText(preview.previewImageSaveRefusedNoGraphics, { exact: true })

		await expect(save.or(refused)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

		if (await refused.isVisible()) {
			test.info().annotations.push({ type: "skip-leg", description: "no WebGL 2 in a worker: the editor does not run here" })
			await page.keyboard.press("Escape")

			return
		}

		// A quarter turn, then the copy (a QOI with alpha saves as PNG).
		await page.getByRole("tab", { name: preview.previewImageEditTabCrop }).click()
		await page.getByRole("button", { name: preview.previewImageEditRotateLeft, exact: true }).click()
		await expect(save).toBeEnabled()
		await save.click()

		const copy = `${stem} (edited).png`

		await expect(page.getByText(`Saved as ${copy}`)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		// Out of edit mode, then out of the preview.
		await expect(async () => {
			if ((await page.getByRole("dialog").count()) > 0) {
				await page.keyboard.press("Escape")
			}

			await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 2_000 })
		}).toPass({ timeout: 15_000 })
		await expect(itemRow(listbox, copy)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	})

	expect(cspViolations).toEqual([])
})

test.describe("public links", () => {
	test.skip(!process.env["E2E_PREMIUM"], "public links need a premium account (E2E_PREMIUM)")

	test("a link's QOI, JPEG XL, TIFF and PDF-compatible Illustrator file are read without a session and shown", async ({ page }) => {
		test.slow()

		const cspViolations = trackCspViolations(page)

		await withScratchDirectory(page, "images-links", async ({ listbox, runId }) => {
			const files = [
				{ name: `e2e-link-${runId}.qoi`, mimeType: "image/x-qoi", buffer: qoiSample(), ours: true },
				{ name: `e2e-link-${runId}.jxl`, mimeType: "image/jxl", buffer: jxlSample(), ours: false },
				{ name: `e2e-link-${runId}.tif`, mimeType: "image/tiff", buffer: tiffSample(), ours: true },
				// Read on the link's page too: a PDF inside, shown by the PDF viewer.
				{ name: `e2e-link-${runId}.ai`, mimeType: "application/illustrator", buffer: PDF_BYTES, ours: false }
			]

			await uploadFiles(
				page,
				files.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })),
				listbox
			)

			const links: string[] = []

			for (const { name } of files) {
				const dialog = await openLinkDialog(page, listbox, name)

				links.push(await createLink(dialog))
				await closeLinkDialog(page, dialog)
			}

			try {
				for (const [index, { name, ours }] of files.entries()) {
					await settleLeases(page)
					await page.goto(links[index] ?? "")

					if (name.endsWith(".ai")) {
						await expect(page.getByRole("region", { name: /Page 1 of/u })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })

						continue
					}

					const shown = picture(page, name)

					await expect(shown, name).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })

					if (ours) {
						expect(await tagOf(shown), name).toBe("CANVAS")
					}
				}
			} finally {
				// Back on the drive for the scratch directory's teardown (a link page has no sidebar).
				await bootTo(page)
			}
		})

		expect(cspViolations).toEqual([])
	})
})

test("a Photoshop file shows its composite and its embedded thumbnail; without a composite, or as PSB, it says so", async ({
	page,
	context
}) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: false })
	const [FLAT, NO_COMPOSITE, LARGE] = FIXTURE_FILES["images-psd"]

	await bootTo(page)

	const { listbox, rows } = await openFixtureRows(page, "images-psd")

	// The embedded JPEG thumbnail, through the SDK: the flattened file's tile swaps to it; the others have none.
	await expect(rows[0].locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 30_000 })

	await itemRow(listbox, FLAT).dblclick()

	const composite = picture(page, FLAT)

	await expect(composite).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
	expect(await tagOf(composite)).toBe("CANVAS")
	await expect(composite).toHaveAttribute("width", String(PSD_SIZE.width))
	await page.keyboard.press("Escape")
	await expect(composite).toHaveCount(0)

	await itemRow(listbox, NO_COMPOSITE).dblclick()
	await expect(page.getByText(preview.previewPsdNoComposite, { exact: true })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
	await page.keyboard.press("Escape")

	await itemRow(listbox, LARGE).dblclick()
	await expect(page.getByText(preview.previewPsbUnsupported, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await page.keyboard.press("Escape")

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})

test("an Illustrator file saved PDF-compatible opens in the PDF viewer, view only; PostScript alone has no viewer", async ({
	page,
	context
}) => {
	const cspViolations = trackCspViolations(page)
	const foreign = trackForeignRequests(context, { strictPreview: false })
	const [PDF_AI, POSTSCRIPT_AI] = FIXTURE_FILES["images-ai"]

	await bootTo(page)

	const listbox = await gotoFixture(page, "images-ai")

	// Its first kilobyte holds a PDF: the PDF viewer, without the editing tools (a save would drop Illustrator's data).
	await itemRow(listbox, PDF_AI).dblclick()

	const dialog = page.getByRole("dialog").first()

	await expect(dialog.getByRole("region", { name: /Page 1 of/u })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(dialog.getByRole("button", { name: preview.previewPdfAnnotToolRectangle })).toHaveCount(0)
	await page.keyboard.press("Escape")
	await expect(page.getByRole("dialog")).toHaveCount(0)

	// PostScript only: no Open once read, Open as text in its place.
	await itemRow(listbox, POSTSCRIPT_AI).dblclick()
	await expect(async () => {
		await page.keyboard.press("Escape")
		await openRowMenu(page, listbox, POSTSCRIPT_AI)
		await expect(page.getByRole("menuitem", { name: menuItemName("Open") })).toHaveCount(0, { timeout: 2_000 })
	}).toPass({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("menuitem", { name: menuItemName("Open as text") })).toBeVisible()
	await page.keyboard.press("Escape")

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
})
