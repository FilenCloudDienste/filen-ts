import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { writePdf } from "../scripts/pdf-fixtures/view/pdfWriter"

// A tagged PDF's structure tree reaches screen readers: its heading, paragraph and table become an accessible tree in
// the page's canvas, owning the text layer's spans; the canvas is then read instead of hidden. A file with a structure
// tree but no MarkInfo is tagged too (the tree decides, not the flag); an untagged file keeps the plain text layer.
// Under the CSP.
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"

const CONTENT = [
	"/H1 << /MCID 0 >> BDC BT /F1 18 Tf 72 760 Td (Structure heading) Tj ET EMC",
	"/P << /MCID 1 >> BDC BT /F1 12 Tf 72 720 Td (A tagged paragraph) Tj ET EMC",
	"/TH << /MCID 2 >> BDC BT /F1 12 Tf 72 680 Td (Header cell) Tj ET EMC",
	"/TD << /MCID 3 >> BDC BT /F1 12 Tf 272 680 Td (Data cell) Tj ET EMC"
].join("\n")

// Objects: 1 catalog, 2 pages, 3 page, 4 font, 5 content, 6 StructTreeRoot, 7 Document, 8 H1, 9 P, 10 Table, 11 TR,
// 12 TH, 13 TD, 14 ParentTree.
function taggedPdf(markInfo: boolean): Uint8Array {
	const element = (type: string, parent: number, kids: string): { dict: string } => ({
		dict: `<< /Type /StructElem /S /${type} /P ${String(parent)} 0 R /Pg 3 0 R /K ${kids} >>`
	})

	return writePdf(
		[
			{
				dict: `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R ${markInfo ? "/MarkInfo << /Marked true >>" : ""} /Lang (en) >>`
			},
			{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
			{
				dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /StructParents 0 /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
			},
			{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
			{ dict: "<< >>", stream: new TextEncoder().encode(CONTENT) },
			{ dict: "<< /Type /StructTreeRoot /K 7 0 R /ParentTree 14 0 R >>" },
			element("Document", 6, "[8 0 R 9 0 R 10 0 R]"),
			element("H1", 7, "0"),
			element("P", 7, "1"),
			element("Table", 7, "[11 0 R]"),
			element("TR", 10, "[12 0 R 13 0 R]"),
			element("TH", 11, "2"),
			element("TD", 11, "3"),
			{ dict: "<< /Nums [0 [8 0 R 9 0 R 12 0 R 13 0 R]] >>" }
		],
		1
	)
}

const UNTAGGED = writePdf(
	[
		{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
		{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
		{ dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>" },
		{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
		{ dict: "<< >>", stream: new TextEncoder().encode("BT /F1 12 Tf 72 720 Td (Plain untagged text) Tj ET") }
	],
	1
)

async function open(page: Page, listbox: Locator, name: string): Promise<Locator> {
	await listbox.getByRole("option", { name }).dblclick()

	const region = page.getByRole("region", { name: /Page 1 of 1/u })

	await expect(region).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(region.locator(".fo-pdf-text-layer span").first()).toBeAttached({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return region
}

// The text of what an element of the tree owns (its aria-owns ids, resolved in the page).
async function ownedText(element: Locator): Promise<string> {
	return await element.evaluate(node =>
		(node.getAttribute("aria-owns") ?? "")
			.split(" ")
			.map(id => node.ownerDocument.getElementById(id)?.textContent ?? "")
			.join(" ")
	)
}

async function closePreview(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("region", { name: /Page 1 of 1/u })).toHaveCount(0)
}

test("a tagged PDF's structure is read from its canvas, and an untagged one keeps its plain text layer", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "pdf-structure", async ({ listbox, runId }) => {
		const tagged = `e2e-pdf-tagged-${runId}.pdf`
		const noMarkInfo = `e2e-pdf-tagged-nomark-${runId}.pdf`
		const untagged = `e2e-pdf-untagged-${runId}.pdf`

		await uploadFiles(
			page,
			[
				{ name: tagged, mimeType: PDF_MIME, buffer: Buffer.from(taggedPdf(true)) },
				{ name: noMarkInfo, mimeType: PDF_MIME, buffer: Buffer.from(taggedPdf(false)) },
				{ name: untagged, mimeType: PDF_MIME, buffer: Buffer.from(UNTAGGED) }
			],
			listbox
		)

		for (const name of [tagged, noMarkInfo]) {
			const region = await open(page, listbox, name)
			const canvas = region.locator("canvas")
			const heading = canvas.locator('[role="heading"][aria-level="1"]')

			await expect(heading).toBeAttached({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await expect(canvas).not.toHaveAttribute("aria-hidden", "true")
			expect(await ownedText(heading)).toContain("Structure heading")
			expect(await ownedText(canvas.locator('[role="paragraph"]'))).toContain("A tagged paragraph")
			await expect(canvas.locator('[role="table"] [role="row"] [role="columnheader"]')).toHaveCount(1)
			expect(await ownedText(canvas.locator('[role="cell"]'))).toContain("Data cell")

			await closePreview(page)
		}

		const region = await open(page, listbox, untagged)

		await expect(region.getByText("Plain untagged text")).toBeAttached()
		await expect(region.locator("canvas")).toHaveAttribute("aria-hidden", "true")
		await expect(region.locator(".structTree")).toHaveCount(0)
	})

	expect(cspViolations).toEqual([])
})
