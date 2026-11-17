import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, gotoFixture } from "./helpers/fixtures"
import { itemRow } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { trackForeignRequests } from "./helpers/requests"
import { QOI_SIZE } from "./fixtures/images"

// Images only the app's own decoders show: decoded in the raster decode pool and drawn from a bitmap on a canvas.
// Every leg reads the shared fixture tree; entering the editor writes nothing.

const [QOI] = FIXTURE_FILES["images-qoi"]
const [JXL] = FIXTURE_FILES["images-jxl"]
const [SVGZ, SVGZ_BOMB] = FIXTURE_FILES["images-svgz"]

test("a QOI image is decoded and drawn, and opens in the editor", async ({ page, context, browserName }) => {
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

	// The editor decodes its own copy (the viewer shows a canvas, not an <img> to take pixels from). It needs WebGL 2,
	// which only Chromium has on the Linux runners.
	if (browserName === "chromium") {
		await page.getByRole("button", { name: "Edit", exact: true }).click()
		// A QOI with alpha saves as a PNG copy beside it.
		await expect(page.getByRole("button", { name: "Save as PNG copy" })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await page.getByRole("button", { name: "Cancel", exact: true }).click()
	}

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
