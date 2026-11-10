import { beforeEach, describe, expect, it, vi } from "vitest"
import { ZipArchive, bytesSource } from "@filen/office/core/opc"

vi.mock("@/features/drive/workers/officeTemplate.worker.ts?worker", () => ({ default: vi.fn() }))

import OfficeTemplateWorker from "@/features/drive/workers/officeTemplate.worker.ts?worker"
import { OFFICE_FILE_MIME, freeOfficeFileName, normalizeOfficeFileName, officeFileBytes } from "@/features/drive/lib/createOfficeFile"
import { inProcessTemplateWorker } from "@/tests/support/officeTemplateWorker"

const terminated = vi.fn()

async function part(bytes: Uint8Array, name: string): Promise<string> {
	const zip = await ZipArchive.open(bytesSource(bytes))
	const entry = zip.get(name)

	if (entry === undefined) throw new Error(`No part ${name}`)

	return new TextDecoder().decode(await zip.read(entry))
}

beforeEach(() => {
	vi.mocked(OfficeTemplateWorker).mockImplementation(inProcessTemplateWorker(terminated))
})

describe("normalizeOfficeFileName", () => {
	it("adds the extension when the name has none, or another one", () => {
		expect(normalizeOfficeFileName("Report", "docx")).toBe("Report.docx")
		expect(normalizeOfficeFileName("Report.txt", "docx")).toBe("Report.txt.docx")
		expect(normalizeOfficeFileName(".budget", "xlsx")).toBe(".budget.xlsx")
		expect(normalizeOfficeFileName("Report.docx", "odt")).toBe("Report.docx.odt")
		expect(normalizeOfficeFileName("Budget", "ods")).toBe("Budget.ods")
	})

	it("keeps the extension the name already ends with, in any case", () => {
		expect(normalizeOfficeFileName("Report.docx", "docx")).toBe("Report.docx")
		expect(normalizeOfficeFileName("Budget.XLSX", "xlsx")).toBe("Budget.XLSX")
	})
})

describe("freeOfficeFileName", () => {
	it("is the plain name while it is free", () => {
		expect(freeOfficeFileName("Untitled document", "docx", new Set())).toBe("Untitled document.docx")
	})

	it("numbers the name past every taken one, ignoring letter case", () => {
		const taken = new Set(["untitled document.docx", "untitled document (2).docx"])

		expect(freeOfficeFileName("Untitled document", "docx", taken)).toBe("Untitled document (3).docx")
	})
})

describe("officeFileBytes", () => {
	it("builds the file in a worker it ends afterwards", async () => {
		const bytes = await officeFileBytes("docx", { locale: "en-US", sheetName: "Sheet1" })

		expect(bytes.byteLength).toBeGreaterThan(0)
		expect(OfficeTemplateWorker).toHaveBeenCalledTimes(1)
		expect(terminated).toHaveBeenCalledTimes(1)
	})

	it("rejects, and ends the worker, when the worker fails to start", async () => {
		const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate: vi.fn() })

		vi.mocked(OfficeTemplateWorker).mockImplementation(function () {
			return worker as unknown as Worker
		})

		const bytes = officeFileBytes("pptx", { locale: "en-US", sheetName: "Sheet1" })

		worker.dispatchEvent(Object.assign(new Event("error"), { message: "load" }))

		await expect(bytes).rejects.toThrow("office template worker failed: load")
		expect(worker.terminate).toHaveBeenCalledTimes(1)
	})

	it("builds a blank document in the user's language and paper", async () => {
		const bytes = await officeFileBytes("docx", { locale: "de-DE", sheetName: "Sheet1" })

		expect(await part(bytes, "word/styles.xml")).toContain('<w:lang w:val="de-DE"/>')
		expect(await part(bytes, "word/document.xml")).toContain('<w:pgSz w:w="11906" w:h="16838"/>')
	})

	it("builds a blank document on the paper the user chose, whatever the region", async () => {
		const bytes = await officeFileBytes("docx", { locale: "de-DE", sheetName: "Sheet1", paper: "letter" })

		expect(await part(bytes, "word/document.xml")).toContain('<w:pgSz w:w="12240" w:h="15840"/>')
	})

	it("builds a blank workbook whose sheet has the localized name", async () => {
		const bytes = await officeFileBytes("xlsx", { locale: "en-US", sheetName: "Tabelle1" })

		expect(await part(bytes, "xl/workbook.xml")).toContain('<sheet name="Tabelle1" sheetId="1" r:id="rId1"/>')
	})

	it("builds a blank OpenDocument text document in the user's language and paper", async () => {
		const bytes = await officeFileBytes("odt", { locale: "de-DE", sheetName: "Sheet1" })
		const styles = await part(bytes, "styles.xml")

		expect(await part(bytes, "mimetype")).toBe("application/vnd.oasis.opendocument.text")
		expect(styles).toContain('fo:font-size="11pt" fo:language="de" fo:country="DE"')
		expect(styles).toContain('fo:page-width="21cm" fo:page-height="29.7cm"')
	})

	it("builds a blank OpenDocument spreadsheet whose sheet has the localized name", async () => {
		const bytes = await officeFileBytes("ods", { locale: "en-US", sheetName: "Tabelle1" })

		expect(await part(bytes, "mimetype")).toBe("application/vnd.oasis.opendocument.spreadsheet")
		expect(await part(bytes, "content.xml")).toContain('<table:table table:name="Tabelle1"')
	})

	it("uploads each kind under its Office Open XML or OpenDocument type", () => {
		expect(OFFICE_FILE_MIME).toEqual({
			docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			odt: "application/vnd.oasis.opendocument.text",
			ods: "application/vnd.oasis.opendocument.spreadsheet",
			odp: "application/vnd.oasis.opendocument.presentation"
		})
	})

	it("builds a blank 16:9 presentation on the plain Filen theme, its slide in the user's language", async () => {
		const bytes = await officeFileBytes("pptx", { locale: "de-DE", sheetName: "Sheet1" })

		expect(await part(bytes, "ppt/presentation.xml")).toContain('<p:sldSz cx="12192000" cy="6858000"/>')
		expect(await part(bytes, "ppt/theme/theme1.xml")).toContain('<a:majorFont><a:latin typeface="Calibri Light"/>')
		expect(await part(bytes, "ppt/slides/slide1.xml")).toContain('lang="de-DE"')
	})

	it("builds a blank OpenDocument presentation at 33.867 × 19.05 cm with Calibri declared", async () => {
		const bytes = await officeFileBytes("odp", { locale: "en-US", sheetName: "Sheet1" })
		const styles = await part(bytes, "styles.xml")

		expect(await part(bytes, "mimetype")).toBe("application/vnd.oasis.opendocument.presentation")
		expect(styles).toContain('fo:page-width="33.867cm" fo:page-height="19.05cm"')
		expect(styles).toContain('<style:font-face style:name="Calibri"')
	})
})
