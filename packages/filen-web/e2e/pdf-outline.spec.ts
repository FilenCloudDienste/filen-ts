import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { writePdf, type PdfObject } from "../scripts/pdf-fixtures/view/pdfWriter"
import { preview } from "@/locales/en/preview"

// The outline pane: the bar's Outline button opens it beside the pages (kept open for the next PDF), a row goes to its
// page, the current section follows the page shown, and the arrow keys and Enter work the tree. Under the CSP.
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"
const PAGES = 12
const CHAPTERS = [0, 4, 8] as const

// PAGES pages, each saying its number, and one bookmark per chapter start ("Chapter 1" on page 1, and so on).
function outlinedPdf(): Uint8Array {
	// 1 catalog, 2 pages, 3 font, 4 outlines, 5.. bookmarks, then a page and its content per page.
	const bookmarkBase = 5
	const pageBase = bookmarkBase + CHAPTERS.length
	const pageRef = (index: number): string => `${String(pageBase + index * 2)} 0 R`
	const objects: PdfObject[] = [
		{ dict: "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>" },
		{
			dict: `<< /Type /Pages /Kids [${Array.from({ length: PAGES }, (_, index) => pageRef(index)).join(" ")}] /Count ${String(PAGES)} >>`
		},
		{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
		{
			dict: `<< /Type /Outlines /First ${String(bookmarkBase)} 0 R /Last ${String(bookmarkBase + CHAPTERS.length - 1)} 0 R /Count ${String(CHAPTERS.length)} >>`
		}
	]

	CHAPTERS.forEach((page, index) => {
		const previous = index > 0 ? `/Prev ${String(bookmarkBase + index - 1)} 0 R` : ""
		const next = index < CHAPTERS.length - 1 ? `/Next ${String(bookmarkBase + index + 1)} 0 R` : ""

		objects.push({
			dict: `<< /Title (Chapter ${String(index + 1)}) /Parent 4 0 R ${previous} ${next} /Dest [${pageRef(page)} /XYZ null null null] >>`
		})
	})

	for (let index = 0; index < PAGES; index++) {
		objects.push({
			dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(pageBase + index * 2 + 1)} 0 R >>`
		})
		objects.push({ dict: "<< >>", stream: new TextEncoder().encode(`BT /F1 24 Tf 72 760 Td (Page ${String(index + 1)}) Tj ET`) })
	}

	return writePdf(objects, 1)
}

function pageIndicator(page: Page, current: number): ReturnType<Page["getByText"]> {
	return page.getByText(preview.previewPdfPageIndicator.replace("{{current}}", String(current)).replace("{{total}}", String(PAGES)))
}

test("the outline pane goes to a chapter, follows the page and works with the keys", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await page.setViewportSize({ width: 1280, height: 900 })

	await withScratchDirectory(page, "pdf-outline", async ({ listbox, runId }) => {
		const name = `e2e-pdf-outline-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(outlinedPdf()) }], listbox)
		await listbox.getByRole("option", { name }).dblclick()
		await expect(page.getByRole("region", { name: new RegExp(`Page 1 of ${String(PAGES)}`, "u") })).toBeVisible({
			timeout: LAZY_VIEWER_TIMEOUT_MS
		})

		const toggle = page.getByRole("button", { name: preview.previewPdfOutlinePane })

		await toggle.click()
		await expect(toggle).toHaveAttribute("aria-pressed", "true")

		const tree = page.getByRole("tree", { name: preview.previewPdfOutlinePane })

		await expect(tree.getByRole("treeitem")).toHaveCount(CHAPTERS.length)
		await expect(tree.getByRole("treeitem", { name: "Chapter 1" })).toHaveAttribute("aria-current", "location")

		await tree.getByRole("treeitem", { name: "Chapter 3" }).click()
		await expect(pageIndicator(page, 9)).toBeVisible()
		await expect(tree.getByRole("treeitem", { name: "Chapter 3" })).toHaveAttribute("aria-current", "location")

		// The keys: up to Chapter 2, Enter goes there.
		await page.keyboard.press("ArrowUp")
		await expect(tree.getByRole("treeitem", { name: "Chapter 2" })).toBeFocused()
		await page.keyboard.press("Enter")
		await expect(pageIndicator(page, 5)).toBeVisible()
		await expect(tree.getByRole("treeitem", { name: "Chapter 2" })).toHaveAttribute("aria-current", "location")

		// Closing hands focus back to the pages.
		await page.getByRole("button", { name: preview.previewPdfOutlinePaneClose }).click()
		await expect(tree).toHaveCount(0)
		await expect(toggle).toHaveAttribute("aria-pressed", "false")
	})

	expect(cspViolations).toEqual([])
})
