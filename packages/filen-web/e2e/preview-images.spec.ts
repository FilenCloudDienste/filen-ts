import type { Locator, Page } from "@playwright/test"
import { test, expect, readFixtureManifest, settleLeases } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture, openFixtureRows } from "./helpers/fixtures"
import { itemRow, openArchive, openRowMenu } from "./helpers/archive"
import { menuItemName } from "./helpers/menu"
import { revealPickerRow } from "./helpers/rows"
import { trackCspViolations } from "./helpers/csp"
import { observeEgest, trackForeignRequests, type EgestObserver } from "./helpers/requests"
import { closeLinkDialog, createLink, openLinkDialog } from "./helpers/publicLinks"
import { PDF_BYTES } from "./helpers/fixtureBytes"
import {
	EPSI_WIDTH,
	HUGE_PNG_SIZE,
	IMAGE_ENTRIES,
	POSTSCRIPT_AI_TEXT,
	PSD_SIZE,
	QOI_SIZE,
	TIFF_PAGE,
	jxlSample,
	qoiSample,
	tiffSample
} from "./fixtures/images"
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
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })

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
	expect(cspBlocked).toEqual([])
})

test("a JPEG XL is shown by the browser where it decodes one, else decoded in the pool", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })

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
	expect(cspBlocked).toEqual([])
})

test("a gzipped SVG is inflated and shown as an SVG, and one inflating past the cap is refused", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })

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
	expect(cspBlocked).toEqual([])
})

test("a TIFF is read by the MuPDF engine: one page as a picture, several in the page column, BigTIFF refused", async ({
	page,
	context
}) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })

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

	// Several pages: the page column with its page commands (no find: an image has no text); the next-page key, pressed
	// straight after it opens, walks to the last. In a view of the usual height: in the listing's tall one every page
	// is in view at once, and there is nothing to step to.
	await page.setViewportSize({ width: 1280, height: 900 })
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
	expect(cspBlocked).toEqual([])
})

test("QOI, JPEG XL and TIFF entries of an archive open through the entry's bytes", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })
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
	expect(cspBlocked).toEqual([])
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
		await (await revealPickerRow(picker, picker.getByRole("button", { name: "images-svgz" }))).click()
		await expect(picker.getByRole("button", { name: /\.svgz$/u })).toHaveCount(0)
		await page.keyboard.press("Escape")
		await expect(picker).toHaveCount(0)

		// A TIFF's first page, drawn by an engine of its own.
		await place(0.3)
		await (await revealPickerRow(picker, picker.getByRole("button", { name: "images-tiff" }))).click()
		await picker.getByRole("button", { name: FIXTURE_FILES["images-tiff"][0], exact: true }).click()
		await expect(picker).toHaveCount(0, { timeout: ENGINE_TIMEOUT_MS })
		await expect(stamps).toHaveCount(1, { timeout: ENGINE_TIMEOUT_MS })

		// A QOI, decoded in the raster decode pool.
		await place(0.7)
		await (await revealPickerRow(picker, picker.getByRole("button", { name: "images-qoi" }))).click()
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

	test("a link's QOI, JPEG XL, TIFF and Illustrator files are read without a session: shown, or a PostScript-only one as its card", async ({
		page
	}) => {
		test.slow()

		const cspViolations = trackCspViolations(page)

		await withScratchDirectory(page, "images-links", async ({ listbox, runId }) => {
			const files = [
				{ name: `e2e-link-${runId}.qoi`, mimeType: "image/x-qoi", buffer: qoiSample(), ours: true },
				{ name: `e2e-link-${runId}.jxl`, mimeType: "image/jxl", buffer: jxlSample(), ours: false },
				{ name: `e2e-link-${runId}.tif`, mimeType: "image/tiff", buffer: tiffSample(), ours: true },
				// Read on the link's page too: a PDF inside, shown by the PDF viewer.
				{ name: `e2e-link-${runId}.ai`, mimeType: "application/illustrator", buffer: PDF_BYTES, ours: false },
				// PostScript only: its read finds no PDF, so the page shows the file's card.
				{
					name: `e2e-link-${runId}-ps.ai`,
					mimeType: "application/illustrator",
					buffer: Buffer.from(POSTSCRIPT_AI_TEXT, "latin1"),
					ours: false
				}
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

					if (name.endsWith("-ps.ai")) {
						await expect(page.getByRole("button", { name: "Download" })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
						await expect(page.getByRole("button", { name: "Preview" })).toHaveCount(0)
						await expect(page.getByRole("region", { name: /Page 1 of/u })).toHaveCount(0)

						continue
					}

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
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })
	const [FLAT, NO_COMPOSITE, LARGE] = FIXTURE_FILES["images-psd"]

	await bootTo(page)

	const { listbox, rows } = await openFixtureRows(page, "images-psd")

	// The embedded JPEG thumbnail, through the SDK: the flattened file's tile and the PSB's swap to it.
	await expect(rows[0].locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 30_000 })
	await expect(rows[2].locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 30_000 })

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
	expect(cspBlocked).toEqual([])
})

test("an Illustrator file saved PDF-compatible opens in the PDF viewer, view only; PostScript alone has no viewer", async ({
	page,
	context
}) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })
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
	expect(cspBlocked).toEqual([])
})

test("an EPS file is shown by its preview picture, never by running its PostScript", async ({ page, context }) => {
	const cspViolations = trackCspViolations(page)
	const { foreign, cspBlocked } = trackForeignRequests(context, { strictPreview: false })
	const [DOS, EPSI, PLAIN] = FIXTURE_FILES["images-eps"]

	await bootTo(page)

	const listbox = await gotoFixture(page, "images-eps")

	// A DOS EPS's TIFF section, in the read role; an EPSI preview, decoded in the pool: both drawn on a canvas.
	for (const [name, width] of [
		[DOS, TIFF_PAGE.width],
		[EPSI, EPSI_WIDTH]
	] as const) {
		await itemRow(listbox, name).dblclick()

		const shown = picture(page, name)

		await expect(shown, name).toBeVisible({ timeout: ENGINE_TIMEOUT_MS })
		expect(await tagOf(shown), name).toBe("CANVAS")
		await expect(shown, name).toHaveAttribute("width", String(width))
		await page.keyboard.press("Escape")
		await expect(shown).toHaveCount(0)
	}

	await itemRow(listbox, PLAIN).dblclick()
	await expect(page.getByText(preview.previewEpsNoPreview, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await page.keyboard.press("Escape")

	expect(cspViolations).toEqual([])
	expect(foreign).toEqual([])
	expect(cspBlocked).toEqual([])
})

// The rows' thumbnails done: no download request for two looks in a row.
async function egestQuiet(egest: EgestObserver): Promise<void> {
	let last = -1

	await expect
		.poll(
			() => {
				const now = egest.requests()
				const still = now === last

				last = now

				return still
			},
			{ intervals: [1500], timeout: 60_000 }
		)
		.toBe(true)
}

// The browser's own decode of a native image, as wide as the file says.
async function expectNativeImage(page: Page, name: string): Promise<void> {
	const shown = picture(page, name)

	await expect(shown).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	expect(await tagOf(shown)).toBe("IMG")
	await expect
		.poll(() => shown.evaluate(element => (element as HTMLImageElement).naturalWidth), { timeout: 60_000 })
		.toBe(HUGE_PNG_SIZE.width)
}

const [HUGE, HUGE_PADDED] = FIXTURE_FILES["images-huge"]

// Chromium reports the service worker's requests to the context; Firefox and WebKit do not, so there the <img>'s own
// stream is not seen and only a read from the page's SDK worker (a head read) would be.
function streamedChunks(browserName: string, chunks: number): number {
	return browserName === "chromium" ? chunks : 0
}

test("a 60 MP native image opens as the browser's own <img> on a desktop, with no request added", async ({
	page,
	context,
	browserName
}) => {
	const egest = observeEgest(context)

	await bootTo(page)

	const listbox = await gotoFixture(page, "images-huge")

	await egestQuiet(egest)

	// Each file's chunks (1 MiB each), streamed to the <img>: nothing read ahead of them.
	for (const [name, chunks] of [
		[HUGE, 1],
		[HUGE_PADDED, 2]
	] as const) {
		egest.reset()
		await itemRow(listbox, name).dblclick()
		await expectNativeImage(page, name)
		expect(egest.requests(), name).toBe(streamedChunks(browserName, chunks))
		await page.keyboard.press("Escape")
		await expect(picture(page, name)).toHaveCount(0)
		// The row the double-click selected is the details panel's once the preview is gone (it reads nothing while
		// covered): its photo header read belongs to neither open.
		await egestQuiet(egest)
	}
})

// An Android phone's user agent, for the page only: the device profile reads it.
const PHONE_USER_AGENT =
	"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"

test("on a phone, a native image past 50 MP is sized from its head and shown only when asked; a small file opens as before", async ({
	page,
	context,
	browserName
}) => {
	await context.addInitScript(userAgent => {
		Object.defineProperty(navigator, "userAgent", { get: () => userAgent })
	}, PHONE_USER_AGENT)

	const egest = observeEgest(context)

	await bootTo(page)

	const listbox = await gotoFixture(page, "images-huge")

	await egestQuiet(egest)

	// Over 1 MiB: its head is read first (one chunk, by the page's SDK worker), and the browser is not handed it.
	egest.reset()
	await itemRow(listbox, HUGE_PADDED).dblclick()
	await expect(page.getByText(preview.previewImageTooLarge, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(picture(page, HUGE_PADDED)).toHaveCount(0)
	expect(egest.requests()).toBe(1)
	await page.getByRole("button", { name: preview.previewImageOpenAnyway }).click()
	await expectNativeImage(page, HUGE_PADDED)
	await page.keyboard.press("Escape")
	// The details panel's read of the still-selected row, once the preview is gone (see the desktop test above).
	await egestQuiet(egest)

	// Under 1 MiB: nothing read ahead, as before.
	egest.reset()
	await itemRow(listbox, HUGE).dblclick()
	await expectNativeImage(page, HUGE)
	expect(egest.requests()).toBe(streamedChunks(browserName, 1))
	await page.keyboard.press("Escape")
})

test("a multi-page TIFF prints every page through the print root", async ({ page }) => {
	await page.addInitScript(() => {
		const record: { snapshots: { pages: number; shown: number }[] } = { snapshots: [] }

		Reflect.set(window, "__tiffPrint", record)
		window.print = () => {
			record.snapshots.push({
				pages: document.querySelectorAll(".fo-print-root > .fo-print-page").length,
				// Pictures decoded (Chromium, WebKit), or canvases Firefox draws while printing.
				shown:
					[...document.querySelectorAll<HTMLImageElement>(".fo-print-root img")].filter(
						image => image.complete && image.naturalWidth > 0
					).length + document.querySelectorAll(".fo-print-root canvas").length
			})
			window.dispatchEvent(new Event("afterprint"))
		}
	})

	await bootTo(page)

	const listbox = await gotoFixture(page, "images-tiff")

	await itemRow(listbox, TIFF_PAGES).dblclick()
	await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	await page.getByRole("button", { name: "File", exact: true }).click()
	await page.getByRole("menuitem", { name: menuItemName("Print…") }).click()

	const dialog = page.getByRole("dialog", { name: "Print" })

	await expect(dialog).toBeVisible()
	await expect(dialog.getByRole("radio", { name: "All" })).toBeChecked()
	await dialog.getByRole("button", { name: "Print…" }).click()
	await expect(dialog).toBeHidden({ timeout: 60_000 })

	expect(await page.evaluate(() => (Reflect.get(window, "__tiffPrint") as { snapshots: unknown[] }).snapshots)).toEqual([
		{ pages: 3, shown: 3 }
	])
	await expect(page.locator(".fo-print-root")).toHaveCount(0)
})
