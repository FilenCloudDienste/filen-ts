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
