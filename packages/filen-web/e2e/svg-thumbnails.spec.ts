import { test, expect } from "./fixtures"
import { bootTo, enterScratchDirectory, trashScratchDirectory, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"

// An svg is rasterised in the page itself (no Rust decoder handles svg), so this is the live proof that
// doing so is safe: the markup below carries a script, an inline event handler and an external image,
// and the thumbnail still has to come out as the drawing and nothing else. Uploaded, so it takes the
// upload-time arm (the local file, nothing downloaded back); thumbnails.spec.ts proves the drive-side
// arm on a fixture. Both arms hand the markup to the same rasteriser.
const TRACKER_HOST = "svg-thumb-tracker.invalid"
const HOSTILE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 20 10" onload="window.top.__svgPwned = 'onload'">
	<script>window.top.__svgPwned = "script"</script>
	<image href="https://${TRACKER_HOST}/pixel.png" xlink:href="https://${TRACKER_HOST}/pixel.png" width="20" height="10"/>
	<rect width="20" height="10" fill="#e11d48"/>
</svg>`

test("an uploaded svg thumbnails as its drawing, at its own aspect, without running its script or fetching its resources", async ({
	page,
	injectedSession
}) => {
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-svg-thumb-${runId}`
	const svgName = `e2e-svg-thumb-${runId}.svg`
	const trackerRequests: string[] = []

	page.on("request", request => {
		if (new URL(request.url()).hostname === TRACKER_HOST) {
			trackerRequests.push(request.url())
		}
	})

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		await page
			.getByRole("main")
			.locator('input[type="file"]')
			.first()
			.setInputFiles([{ name: svgName, mimeType: "image/svg+xml", buffer: Buffer.from(HOSTILE_SVG, "utf8") }])

		const row = listbox.getByRole("option", { name: svgName })
		await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

		const thumb = row.locator("img")
		await expect(thumb).toHaveAttribute("src", /^blob:/, { timeout: 30_000 })

		// The drawing itself: 2:1 from its viewBox with the long side at the thumbnail size, and the
		// rect's red at its centre. Read back through a canvas, as the thumbnail is a same-origin blob.
		const rendered = await thumb.evaluate(async (img: HTMLImageElement) => {
			await img.decode()

			const canvas = document.createElement("canvas")

			canvas.width = img.naturalWidth
			canvas.height = img.naturalHeight

			const ctx = canvas.getContext("2d")

			if (ctx === null) {
				throw new Error("no 2d context")
			}

			ctx.drawImage(img, 0, 0)

			const [r = 0, g = 0, b = 0] = ctx.getImageData(Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight / 2), 1, 1).data

			return { width: img.naturalWidth, height: img.naturalHeight, r, g, b }
		})

		expect({ width: rendered.width, height: rendered.height }).toEqual({ width: 384, height: 192 })
		// #e11d48, within lossy-encode tolerance.
		expect(Math.abs(rendered.r - 0xe1)).toBeLessThanOrEqual(12)
		expect(Math.abs(rendered.g - 0x1d)).toBeLessThanOrEqual(12)
		expect(Math.abs(rendered.b - 0x48)).toBeLessThanOrEqual(12)

		expect(await page.evaluate(() => (window as unknown as { __svgPwned?: string }).__svgPwned)).toBeUndefined()
		expect(trackerRequests).toEqual([])
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})
