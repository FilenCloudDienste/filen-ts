import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { preview } from "@/locales/en/preview"
import { menuItemName } from "./menu"

// File ▸ Download as ▸ PDF from a Word document's toolbar in `scope` (the page, or an overlay holding the viewer); the
// menus open on the page.
export async function downloadDocxPdf(page: Page, scope: Page | Locator = page): Promise<void> {
	await scope.getByRole("button", { name: preview.previewDocxFileMenu, exact: true }).click()
	await page.getByRole("menuitem", { name: menuItemName(preview.previewDocxDownloadAs) }).click()
	await page.getByRole("menuitem", { name: menuItemName(preview.previewDocxDownloadPdf) }).click()
}

// A downloaded PDF read back with pdf.js: the document and the text of every page, a line per page.
export async function readPdf(path: string, password?: string): Promise<{ pdf: pdfjs.PDFDocumentProxy; text: string }> {
	const pdf = await pdfjs.getDocument({
		data: new Uint8Array(readFileSync(path)),
		verbosity: 0,
		...(password === undefined ? {} : { password })
	}).promise
	let text = ""

	for (let index = 1; index <= pdf.numPages; index++) {
		const content = await (await pdf.getPage(index)).getTextContent()

		text += content.items.map(item => ("str" in item ? item.str : "")).join("") + "\n"
	}

	return { pdf, text }
}
