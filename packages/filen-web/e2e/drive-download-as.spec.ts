import { readFileSync } from "node:fs"
import type { Download, Locator, Page } from "@playwright/test"
import { writeXlsx } from "hucre/xlsx"
import JSZip from "jszip"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, toasts, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { openRowMenu, openTrash, revealRow } from "./helpers/archive"
import { buildZip } from "./helpers/archiveFixtures"
import { DOCX_FIXTURE_TEXT, DOCX_MIME, docxFixtureBytes } from "./helpers/docxFixtures"
import { ENCRYPTED_DOCX_PASSWORD, ENCRYPTED_DOCX_TEXT, encryptedDocxBytes } from "./helpers/docxEncryptedFixtures"
import { holdChunks } from "./helpers/jobs"
import { MOD_KEY } from "./helpers/modkey"
import { trackCspViolations } from "./helpers/csp"
import { storedPassword, trackPasswordCanary } from "./helpers/passwordCanary"
import { drive } from "@/locales/en/drive"
import { preview } from "@/locales/en/preview"
import { transfers } from "@/locales/en/transfers"

// Download as ▸ PDF from the drive's item menu, end to end against the backend: the saved file read, laid out in the
// workers without opening its viewer, and downloaded as "<name>.pdf"; byte for byte the File menu's export of the
// same file (deterministic PDFs in this lane); a password-protected file's password asked, checked and protecting the
// PDF; Cancel mid-export; the whole selection from the selection bar; never offered in the trash, disabled offline.
// Nothing is written to the drive.

test.describe.configure({ mode: "default" })

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
// features/office/lib/pdfTestMode.ts's key: an E2E build makes every PDF deterministic once it is set.
const PDF_DETERMINISTIC_KEY = "filen-e2e-pdf-deterministic"
// features/office/lib/officeAutosave.ts's key: the editors this spec opens never save.
const AUTOSAVE_KEY = "filen-e2e-docx-autosave"
const EXPORT_TIMEOUT_MS = 120_000
// The password's key derivation (100,000 SHA-512 rounds).
const UNLOCK_TIMEOUT_MS = 60_000

test.beforeEach(async ({ page }) => {
	await page.context().addInitScript(
		([deterministic, autosave]) => {
			sessionStorage.setItem(deterministic, "on")
			sessionStorage.setItem(autosave, "off")
		},
		[PDF_DETERMINISTIC_KEY, AUTOSAVE_KEY] as const
	)
})

async function xlsxBytes(): Promise<Buffer> {
	return Buffer.from(
		await writeXlsx({
			sheets: [
				{
					name: "Budget",
					rows: [["Item", "Cost"], ...Array.from({ length: 60 }, (_, k) => [`Item ${String(k + 1)}`, (k + 1) * 10])]
				},
				{ name: "Notes", rows: [["second sheet"]] }
			]
		})
	)
}

// A Word document of `paragraphs` paragraphs of text: long enough to cancel while its pages are written.
function longDocx(paragraphs: number): Buffer {
	const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
	const body = Array.from(
		{ length: paragraphs },
		(_, k) =>
			`<w:p><w:r><w:t>Paragraph ${String(k + 1)} of a long document, written to be cancelled while it exports.</w:t></w:r></w:p>`
	).join("")

	return buildZip([
		{
			name: "[Content_Types].xml",
			data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
		},
		{
			name: "_rels/.rels",
			data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
		},
		{
			name: "word/document.xml",
			data: `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`
		}
	])
}

async function readPdf(path: string, password?: string): Promise<{ pages: number; text: string }> {
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

	return { pages: pdf.numPages, text }
}

// Download as ▸ PDF from an open menu; resolves with the download.
async function pickPdf(page: Page): Promise<{ name: string; path: string }> {
	await page.getByRole("menuitem", { name: drive.driveActionDownloadAs, exact: true }).click()

	const downloading = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS })

	await page.getByRole("menuitem", { name: drive.driveDownloadAsPdf, exact: true }).click()

	const download = await downloading

	return { name: download.suggestedFilename(), path: await download.path() }
}

// The preview's File menu export of the same file (the editor for a document the user may edit).
async function fileMenuPdf(page: Page, listbox: Locator, name: string): Promise<string> {
	await listbox.getByRole("option", { name }).dblclick()

	const dialog = page.getByRole("dialog").first()
	const fileMenu = dialog.getByRole("button", { name: preview.previewDocxFileMenu, exact: true })

	await expect(fileMenu).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await fileMenu.click()
	await page.getByRole("menuitem", { name: preview.previewDocxDownloadAs, exact: true }).click()

	const downloading = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS })

	await page.getByRole("menuitem", { name: preview.previewDocxDownloadPdf, exact: true }).click()

	const path = await (await downloading).path()

	await page.keyboard.press("Escape")
	await expect(page.getByRole("dialog")).toHaveCount(0)

	return path
}

test("a document and a spreadsheet download as PDF from the item menu, byte for byte the File menu's export", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "download-as", async ({ listbox, runId }) => {
		const document = `e2e-${runId}-headers.docx`
		const workbook = `e2e-${runId}-budget.xlsx`

		await uploadFiles(
			page,
			[
				{ name: document, mimeType: DOCX_MIME, buffer: docxFixtureBytes("w3-headers.docx") },
				{ name: workbook, mimeType: XLSX_MIME, buffer: await xlsxBytes() }
			],
			listbox
		)

		const exported: string[] = []

		for (const name of [document, workbook]) {
			await openRowMenu(page, listbox, name)

			const drivePdf = await pickPdf(page)

			expect(drivePdf.name).toBe(name.replace(/\.[^.]+$/, ".pdf"))
			expect(readFileSync(drivePdf.path)).toEqual(readFileSync(await fileMenuPdf(page, listbox, name)))
			exported.push(drivePdf.path)
		}

		expect((await readPdf(exported[0] ?? "")).text).toContain(DOCX_FIXTURE_TEXT["w3-headers.docx"])
		expect((await readPdf(exported[1] ?? "")).text).toContain("Item 60")
		expect(cspViolations).toEqual([])
	})
})

test("the preview header's More actions menu offers Download as too", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "download-as-preview", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-notes.docx`

		await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: docxFixtureBytes("notes.docx") }], listbox)
		await listbox.getByRole("option", { name }).dblclick()

		const dialog = page.getByRole("dialog").first()

		await dialog.getByRole("button", { name: drive.driveItemMenuTrigger, exact: true }).click()

		const pdf = await pickPdf(page)

		expect(pdf.name).toBe(name.replace(/\.docx$/, ".pdf"))
		expect((await readPdf(pdf.path)).text).toContain(DOCX_FIXTURE_TEXT["notes.docx"])
	})
})

test("a password-protected document asks its password, refuses a wrong one and protects the PDF with it", async ({ page }) => {
	test.slow()

	const canary = trackPasswordCanary(page, ENCRYPTED_DOCX_PASSWORD)

	await withScratchDirectory(page, "download-as-password", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-secret.docx`

		await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: await encryptedDocxBytes() }], listbox)
		await openRowMenu(page, listbox, name)
		await page.getByRole("menuitem", { name: drive.driveActionDownloadAs, exact: true }).click()
		await page.getByRole("menuitem", { name: drive.driveDownloadAsPdf, exact: true }).click()

		const prompt = page.getByRole("dialog", { name: preview.previewOfficePdfPasswordTitle })
		const field = prompt.getByLabel(preview.previewOfficePdfPasswordLabel)

		await expect(prompt).toContainText(name)
		await field.fill("not the password")
		await prompt.getByRole("button", { name: preview.previewOfficePdfPasswordSubmit, exact: true }).click()
		await expect(prompt.getByText(preview.previewOfficePdfPasswordWrong)).toBeVisible({ timeout: UNLOCK_TIMEOUT_MS })

		const downloading = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS })

		await field.fill(ENCRYPTED_DOCX_PASSWORD)
		await prompt.getByRole("button", { name: preview.previewOfficePdfPasswordSubmit, exact: true }).click()

		const path = await (await downloading).path()

		await expect(prompt).toBeHidden()
		await expect(readPdf(path)).rejects.toThrow()
		expect((await readPdf(path, ENCRYPTED_DOCX_PASSWORD)).text).toContain(ENCRYPTED_DOCX_TEXT)
		expect(canary.leaks).toEqual([])
		expect(await storedPassword(page, ENCRYPTED_DOCX_PASSWORD)).toEqual([])
	})
})

test("Cancel on the progress toast stops the export: no download, the toast goes", async ({ page, browserName }) => {
	test.slow()
	// The export is held at its file's download so the Cancel lands mid-run, not after it; WebKit cannot hold the
	// SDK worker's requests, and an unheld export of any size can finish before the click.
	test.skip(browserName === "webkit", "WebKit cannot hold the SDK worker's requests")

	await withScratchDirectory(page, "download-as-cancel", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-long.docx`
		let downloads = 0

		page.on("download", () => downloads++)
		await uploadFiles(page, [{ name, mimeType: DOCX_MIME, buffer: longDocx(6000) }], listbox)

		const hold = await holdChunks(page, browserName, { hosts: "egest" })

		try {
			await openRowMenu(page, listbox, name)
			await page.getByRole("menuitem", { name: drive.driveActionDownloadAs, exact: true }).click()
			await page.getByRole("menuitem", { name: drive.driveDownloadAsPdf, exact: true }).click()
			await expect.poll(() => hold?.held() ?? 0, { timeout: EXPORT_TIMEOUT_MS }).toBeGreaterThan(0)

			const progress = toasts(page).filter({ has: page.getByRole("button", { name: preview.previewDocxPdfCancel, exact: true }) })

			await progress.getByRole("button", { name: preview.previewDocxPdfCancel, exact: true }).click()
			await expect(progress).toHaveCount(0)
		} finally {
			hold?.release()
			await hold?.dispose()
		}

		await page.waitForTimeout(3000)
		expect(downloads).toBe(0)
	})
})

test("the whole selection downloads as one archive of PDFs from the selection bar", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "download-as-bulk", async ({ listbox, runId }) => {
		const document = `e2e-${runId}-a.docx`
		const workbook = `e2e-${runId}-b.xlsx`
		const downloads: Download[] = []

		page.on("download", download => downloads.push(download))
		await uploadFiles(
			page,
			[
				{ name: document, mimeType: DOCX_MIME, buffer: docxFixtureBytes("notes.docx") },
				{ name: workbook, mimeType: XLSX_MIME, buffer: await xlsxBytes() }
			],
			listbox
		)
		await listbox.getByRole("option", { name: document }).click()
		await listbox.getByRole("option", { name: workbook }).click({ modifiers: [MOD_KEY] })
		await page.getByRole("button", { name: drive.driveActionDownloadAs, exact: true }).click()
		await page.getByRole("menuitem", { name: drive.driveDownloadAsPdf, exact: true }).click()
		// Several files arrive as one zip (no browser limit on downloads started without a click drops any).
		await expect.poll(() => downloads.length, { timeout: EXPORT_TIMEOUT_MS }).toBe(1)

		const [download] = downloads

		expect(download?.suggestedFilename()).toBe(transfers.transfersZipDownloadDefaultName)

		const zip = await JSZip.loadAsync(readFileSync((await download?.path()) ?? ""))
		const entries = Object.keys(zip.files).sort()

		expect(entries).toEqual([document.replace(/\.docx$/, ".pdf"), workbook.replace(/\.xlsx$/, ".pdf")].sort())

		for (const entry of entries) {
			expect((await zip.file(entry)?.async("string"))?.startsWith("%PDF-")).toBe(true)
		}
	})
})

test("Download as is never offered in the trash, and is disabled offline", async ({ page }) => {
	test.slow()

	await withScratchDirectory(page, "download-as-gates", async ({ listbox, runId }) => {
		const kept = `e2e-${runId}-kept.docx`
		const trashed = `e2e-${runId}-trashed.docx`

		await uploadFiles(
			page,
			[
				{ name: kept, mimeType: DOCX_MIME, buffer: docxFixtureBytes("notes.docx") },
				{ name: trashed, mimeType: DOCX_MIME, buffer: docxFixtureBytes("notes.docx") }
			],
			listbox
		)

		await page.context().setOffline(true)
		await openRowMenu(page, listbox, kept)
		await expect(page.getByRole("menuitem", { name: drive.driveActionDownloadAs, exact: true })).toHaveAttribute(
			"aria-disabled",
			"true"
		)
		await page.keyboard.press("Escape")
		await page.context().setOffline(false)

		await listbox.getByRole("option", { name: trashed }).click()
		await page.getByRole("button", { name: "Trash", exact: true }).click()
		await page.getByRole("alertdialog", { name: "Move to trash?" }).getByRole("button", { name: "Trash", exact: true }).click()
		await expect(listbox.getByRole("option", { name: trashed })).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		const trash = await openTrash(page)
		const row = trash.getByRole("option", { name: trashed })

		await revealRow(trash, row, LIVE_WRITE_TIMEOUT_MS)
		await openRowMenu(page, trash, trashed)
		await expect(page.getByRole("menuitem", { name: drive.driveActionDownloadAs, exact: true })).toHaveCount(0)
	})
})
