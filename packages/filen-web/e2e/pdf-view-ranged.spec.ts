import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { observeEgest } from "./helpers/jobs"
import { latinDocument } from "../scripts/pdf-fixtures/view/documents"

// The PDF viewer reads a drive file on demand: a large file shows page 1 after downloading only part of it (counted
// in the SDK's chunk requests, one per MiB), and the self-hosted pdf.js data files draw non-embedded CJK text,
// JPEG 2000, JBIG2 and CMYK pages, all under the CSP.
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"
const FIXTURES = new URL("./fixtures/pdf/view/", import.meta.url)
const CHUNK = 1024 * 1024

function fixture(name: string): Buffer {
	return readFileSync(new URL(name, FIXTURES))
}

async function openPdf(page: Page, listbox: Locator, name: string): Promise<Locator> {
	const row = listbox.getByRole("option", { name })

	await expect(row).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await row.dblclick()

	const dialog = page.getByRole("dialog").first()

	await expect(dialog.locator("canvas.block").first()).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return dialog
}

// Dark and coloured pixels of the first painted page canvas.
async function inkOf(dialog: Locator): Promise<{ dark: number; colour: number }> {
	return dialog
		.locator("canvas.block")
		.first()
		.evaluate((canvas: HTMLCanvasElement) => {
			const context = canvas.getContext("2d")

			if (context === null) return { dark: 0, colour: 0 }

			const data = context.getImageData(0, 0, canvas.width, canvas.height).data
			let dark = 0
			let colour = 0

			for (let at = 0; at < data.length; at += 4) {
				const r = data[at] ?? 255
				const g = data[at + 1] ?? 255
				const b = data[at + 2] ?? 255

				if (Math.max(r, g, b) < 128) dark++
				if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colour++
			}

			return { dark, colour }
		})
}

test("a large PDF shows its first page after reading part of the file", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	// 12 pages of 2048 x 2048 grey noise: about 48 MiB, an image's worth of chunks per page.
	const bytes = Buffer.from(latinDocument({ pages: 12, imageSide: 2048, linearized: false }))
	const chunks = Math.ceil(bytes.length / CHUNK)

	await withScratchDirectory(page, "pdf-ranged", async ({ listbox, runId }) => {
		const name = `e2e-pdf-ranged-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: bytes }], listbox)

		const egest = observeEgest(page)
		const dialog = await openPdf(page, listbox, name)

		// Page 1 and the pages rendered beside it, with the cross-reference table at the end: well under half.
		expect(egest.count()).toBeLessThan(chunks / 2)
		await expect(dialog.getByText("Page 1 of 12", { exact: false }).first()).toBeAttached()
	})

	expect(cspViolations).toEqual([])
})

test("the viewer's own data files draw CJK text, JPEG 2000, JBIG2 and CMYK pages", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const assets: string[] = []

	page.context().on("requestfinished", request => {
		const url = new URL(request.url())

		if (url.pathname.startsWith("/assets/pdfjs-")) assets.push(url.pathname)
	})

	await withScratchDirectory(page, "pdf-assets", async ({ listbox, runId }) => {
		const files = ["cjk-non-embedded.pdf", "jpx.pdf", "jbig2.pdf", "cmyk.pdf"].map(file => ({
			file,
			name: `e2e-pdf-${runId}-${file}`
		}))

		await uploadFiles(
			page,
			files.map(({ file, name }) => ({ name, mimeType: PDF_MIME, buffer: fixture(file) })),
			listbox
		)

		for (const { file, name } of files) {
			const dialog = await openPdf(page, listbox, name)
			const ink = await inkOf(dialog)

			if (file === "jpx.pdf" || file === "cmyk.pdf") expect(ink.colour, file).toBeGreaterThan(10_000)
			else expect(ink.dark, file).toBeGreaterThan(3_000)

			await page.keyboard.press("Escape")
			await expect(dialog).toHaveCount(0)
		}
	})

	expect(assets.some(path => path.endsWith(".bcmap"))).toBe(true)
	expect(assets.some(path => path.endsWith("/openjpeg.wasm"))).toBe(true)
	expect(assets.some(path => path.endsWith("/jbig2.wasm"))).toBe(true)
	expect(assets.some(path => path.includes("quickjs"))).toBe(false)
	expect(cspViolations).toEqual([])
})
