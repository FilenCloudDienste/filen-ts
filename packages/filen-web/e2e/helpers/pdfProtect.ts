import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { expect } from "../fixtures"
import { LAZY_VIEWER_TIMEOUT_MS } from "./listing"
import { writePdf } from "../../scripts/pdf-fixtures/view/pdfWriter"
import { preview } from "@/locales/en/preview"

// The Protect tab's e2e helpers: a two-page text PDF, opening a file in the preview, the ribbon's Protect tab, the
// saved file as the preview downloads it, and its text and permissions as pdf.js reads them (in Node).

export const PDF_MIME = "application/pdf"
// The first change swaps in the editor engine (about 10 MB of wasm on a cold cache).
export const ENGINE_TIMEOUT_MS = 60_000

// Two pages of Helvetica text, each line one text object; `lines[page]` are the page's lines.
export function textPdf(lines: readonly (readonly string[])[]): Uint8Array {
	const escape = (text: string): string => text.replace(/[\\()]/g, match => `\\${match}`)
	const objects: { dict: string; stream?: Uint8Array }[] = [
		{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
		{
			dict: `<< /Type /Pages /Kids [${lines.map((_, index) => `${String(4 + index * 2)} 0 R`).join(" ")}] /Count ${String(lines.length)} >>`
		},
		{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" }
	]

	for (const page of lines) {
		const content = page.map((line, index) => `BT /F1 18 Tf 72 ${String(720 - index * 40)} Td (${escape(line)}) Tj ET`).join("\n")
		const contentsNumber = objects.length + 2

		objects.push({
			dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(contentsNumber)} 0 R >>`
		})
		objects.push({ dict: "<< >>", stream: new TextEncoder().encode(content) })
	}

	return writePdf(objects, 1)
}

export async function openPdf(page: Page, listbox: Locator, name: string): Promise<Locator> {
	await listbox.getByRole("option", { name }).dblclick()

	const dialog = page.getByRole("dialog").first()

	await expect(dialog.locator("canvas.block").first()).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	return dialog
}

export async function closePreview(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.locator("canvas")).toHaveCount(0)
}

export async function protectTab(dialog: Locator): Promise<void> {
	await dialog.getByRole("tab", { name: preview.previewPdfTabProtect }).click()
}

// The file as the preview downloads it.
export async function downloaded(page: Page, dialog: Locator): Promise<Buffer> {
	const downloading = page.waitForEvent("download")

	await dialog.getByRole("button", { name: preview.previewDownloadAction, exact: true }).click()

	return readFileSync(await (await downloading).path())
}

export type PdfjsRead =
	{ readonly status: "open"; readonly text: string; readonly permissions: readonly number[] | null } | { readonly status: "password" }

// The file's text and permissions as pdf.js reads them, or "password" when it asks for one.
export async function pdfjsRead(bytes: Uint8Array, password?: string): Promise<PdfjsRead> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, ...(password === undefined ? {} : { password }) })

	try {
		const document = await task.promise
		let text = ""

		for (let index = 1; index <= document.numPages; index++) {
			const content = await (await document.getPage(index)).getTextContent()

			text += `${content.items.map(item => ("str" in item ? item.str : "")).join("")}\n`
		}

		const permissions = await document.getPermissions()

		return { status: "open", text, permissions: permissions === null ? null : [...permissions] }
	} catch (error) {
		if (error instanceof Error && error.name === "PasswordException") return { status: "password" }

		throw error
	} finally {
		await task.destroy()
	}
}
