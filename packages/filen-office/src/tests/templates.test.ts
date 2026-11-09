import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { DocxEditorSession } from "@filen/office/core/docx/edit"
import { saveDocx } from "@filen/office/core/docx/write"
import { blankDocx, blankXlsx, templateLocale } from "@filen/office/core/templates"
import { decodeUtf8 } from "../core/xml/index"
import { CellKind } from "../core/xlsx/model/types"
import { openBytes } from "./docxEditFixtures"
import { Region } from "@filen/office/core/docx"
import { layOut, pageLines } from "./layoutFixtures"
import { openWorkbook, saved } from "./xlsxWriteFixtures"

const LIMIT = 3 * 1024
// Twips to CSS px (1440 per inch, 96 px per inch).
const PX = 96 / 1440

function partsOf(bytes: Uint8Array): Record<string, string> {
	return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, data]) => [name, decodeUtf8(data)]))
}

function bodyText(xml: string): string {
	return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(match => match[1]).join("")
}

describe("templateLocale", () => {
	// CLDR supplementalData paperSize US-Letter: BZ CA CL CO CR GT MX NI PA PE PH PR SV US VE.
	it("gives Letter to the CLDR US-Letter regions, A4 elsewhere", () => {
		for (const tag of ["en-US", "en-CA", "fr-CA", "es-MX", "en-PH", "fil-PH", "es-CO", "es-CL", "es-PR", "es-VE", "en-BZ", "es-CR"])
			expect(templateLocale(tag).paper).toBe("letter")
		for (const tag of ["en-GB", "de-DE", "fr", "ja-JP", "es-419", "es-ES", "pt-BR", "es-AR"])
			expect(templateLocale(tag).paper).toBe("a4")
	})

	it("keeps a script the locale names, so Latin-script Serbian is not written as its Cyrillic default", () => {
		expect(templateLocale("sr-Latn-RS")).toEqual({ tag: "sr-Latn-RS", paper: "a4" })
		expect(templateLocale("sr-Cyrl-RS")).toEqual({ tag: "sr-Cyrl-RS", paper: "a4" })
		expect(templateLocale("uz-Latn")).toEqual({ tag: "uz-Latn-UZ", paper: "a4" })
		expect(templateLocale("sr")).toEqual({ tag: "sr-RS", paper: "a4" })
		expect(templateLocale("en-US")).toEqual({ tag: "en-US", paper: "letter" })
	})

	it("fills in the likely region of a bare language and keeps the language tag w:lang carries", () => {
		expect(templateLocale("de")).toEqual({ tag: "de-DE", paper: "a4" })
		expect(templateLocale("en")).toEqual({ tag: "en-US", paper: "letter" })
		expect(templateLocale("zh-TW")).toEqual({ tag: "zh-TW", paper: "a4" })
		expect(templateLocale("zh-Hant-TW")).toEqual({ tag: "zh-Hant-TW", paper: "a4" })
	})

	it("falls back to en-US for a tag that is not BCP 47", () => {
		expect(templateLocale("not a locale")).toEqual({ tag: "en-US", paper: "letter" })
		expect(templateLocale("")).toEqual({ tag: "en-US", paper: "letter" })
	})
})

describe("blankDocx", () => {
	it("is under 3 KB, the same bytes every time, and holds nothing about the user", async () => {
		const bytes = await blankDocx({ locale: "de-DE" })
		const text = Object.values(partsOf(bytes)).join("")

		expect(bytes.length).toBeLessThan(LIMIT)
		expect(await blankDocx({ locale: "de-DE" })).toEqual(bytes)
		expect(Object.keys(partsOf(bytes)).sort()).toEqual([
			"[Content_Types].xml",
			"_rels/.rels",
			"word/_rels/document.xml.rels",
			"word/document.xml",
			"word/settings.xml",
			"word/styles.xml"
		])
		expect(text).not.toMatch(/creator|author|lastModifiedBy|docProps|rsid/i)
	})

	it("defaults to Calibri 11 pt in the user's language, on the paper of the user's region", async () => {
		const de = partsOf(await blankDocx({ locale: "de-DE" }))
		const us = partsOf(await blankDocx({ locale: "en-US" }))

		expect(de["word/styles.xml"]).toContain('<w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>')
		expect(de["word/styles.xml"]).toContain('<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="de-DE"/>')
		expect(us["word/styles.xml"]).toContain('<w:lang w:val="en-US"/>')
		expect(partsOf(await blankDocx({ locale: "sr-RS" }))["word/styles.xml"]).toContain('<w:lang w:val="sr-RS"/>')
		expect(de["word/document.xml"]).toContain('<w:pgSz w:w="11906" w:h="16838"/>')
		expect(us["word/document.xml"]).toContain('<w:pgSz w:w="12240" w:h="15840"/>')
		expect(de["word/settings.xml"]).toContain('w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"')
	})

	// ECMA-376 Part 1 §17.3.2.20: w:val is the Latin language, w:eastAsia the East Asian, w:bidi the complex-script.
	// Word's localized Normal keeps en-US in w:val and puts a CJK or RTL locale in its own slot.
	it("puts an East Asian or complex-script language in w:eastAsia or w:bidi, keeping en-US for Latin text", async () => {
		for (const [locale, lang] of [
			["ja-JP", '<w:lang w:val="en-US" w:eastAsia="ja-JP"/>'],
			["zh-CN", '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>'],
			["zh-TW", '<w:lang w:val="en-US" w:eastAsia="zh-TW"/>'],
			["ko", '<w:lang w:val="en-US" w:eastAsia="ko-KR"/>'],
			["ar-SA", '<w:lang w:val="en-US" w:bidi="ar-SA"/>'],
			["he-IL", '<w:lang w:val="en-US" w:bidi="he-IL"/>'],
			["fa-IR", '<w:lang w:val="en-US" w:bidi="fa-IR"/>'],
			["th-TH", '<w:lang w:val="en-US" w:bidi="th-TH"/>'],
			["hi-IN", '<w:lang w:val="en-US" w:bidi="hi-IN"/>']
		] as const)
			expect(partsOf(await blankDocx({ locale }))["word/styles.xml"], locale).toContain(lang)
	})

	it("opens through the document reader and lays out as one empty page of its paper", async () => {
		for (const [locale, width, height] of [
			["en-US", 12240, 15840],
			["en-GB", 11906, 16838]
		] as const) {
			const layout = await layOut(await blankDocx({ locale }))
			const page = layout.pages[0]

			expect(layout.pages.length).toBe(1)
			expect(page?.width).toBeCloseTo(width * PX, 1)
			expect(page?.height).toBeCloseTo(height * PX, 1)
			expect(
				pageLines(layout, 0)
					.filter(line => line.region === Region.BODY)
					.map(line => line.text)
			).toEqual([""])
		}
	})

	it("takes typing in the editor, saves through both gates and reopens with the text", async () => {
		const opened = await openBytes(await blankDocx({ locale: "en-US" }))
		const session = new DocxEditorSession(opened.context)

		session.dispatch(session.state.tr.insertText("Hello from a new document", 1))

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })

		expect(result.bytes).toBeDefined()

		const reopened = partsOf(result.bytes ?? new Uint8Array())

		expect(bodyText(reopened["word/document.xml"] ?? "")).toBe("Hello from a new document")
		const layout = await layOut(result.bytes ?? new Uint8Array())

		expect(layout.pages.length).toBe(1)
		expect(
			pageLines(layout, 0)
				.filter(line => line.region === Region.BODY)
				.map(line => line.text)
		).toEqual(["Hello from a new document"])
	})
})

describe("blankXlsx", () => {
	it("is under 3 KB, the same bytes every time, and holds nothing about the user", async () => {
		const bytes = await blankXlsx({ locale: "en-US", sheetName: "Sheet1" })
		const text = Object.values(partsOf(bytes)).join("")

		expect(bytes.length).toBeLessThan(LIMIT)
		expect(await blankXlsx({ locale: "en-US", sheetName: "Sheet1" })).toEqual(bytes)
		expect(text).not.toMatch(/creator|author|lastModifiedBy|docProps/i)
	})

	it("opens through the workbook reader as one empty sheet under the caller's name", async () => {
		const workbook = await openWorkbook(await blankXlsx({ locale: "de-DE", sheetName: "Tabelle1" }))

		expect(workbook.sheets.map(sheet => sheet.name)).toEqual(["Tabelle1"])
		expect((await workbook.load(0)).store.cellCount).toBe(0)
	})

	it("defaults to Calibri 11 pt on the paper of the user's region", async () => {
		const us = partsOf(await blankXlsx({ locale: "en-US", sheetName: "Sheet1" }))
		const de = partsOf(await blankXlsx({ locale: "de-DE", sheetName: "Tabelle1" }))

		expect(us["xl/styles.xml"]).toContain(
			'<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>'
		)
		expect(us["xl/worksheets/sheet1.xml"]).toContain('<pageSetup paperSize="1" orientation="portrait"/>')
		expect(de["xl/worksheets/sheet1.xml"]).toContain('<pageSetup paperSize="9" orientation="portrait"/>')
	})

	it("links the body font to a theme part, so a theme font change reaches it", async () => {
		const parts = partsOf(await blankXlsx({ locale: "en-US", sheetName: "Sheet1" }))
		const theme = parts["xl/theme/theme1.xml"] ?? ""

		expect(theme).toContain('<a:majorFont><a:latin typeface="Calibri Light"/>')
		expect(theme).toContain('<a:minorFont><a:latin typeface="Calibri"/>')
		expect(theme).toContain('<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>')
		expect(parts["xl/_rels/workbook.xml.rels"]).toContain(
			'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"'
		)
		expect(parts["[Content_Types].xml"]).toContain(
			'<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
		)

		const workbook = await openWorkbook(await blankXlsx({ locale: "en-US", sheetName: "Sheet1" }))

		expect(workbook.sheets.map(sheet => sheet.name)).toEqual(["Sheet1"])
	})

	it("escapes the sheet name and cuts it down to one Excel takes", async () => {
		const escaped = partsOf(await blankXlsx({ locale: "en-US", sheetName: 'R&D "Q1"' }))
		const cut = await openWorkbook(await blankXlsx({ locale: "en-US", sheetName: "a/b:c*d?e[f]g\\h-0123456789012345678901234567" }))
		const empty = await openWorkbook(await blankXlsx({ locale: "en-US", sheetName: "///" }))

		expect(escaped["xl/workbook.xml"]).toContain('name="R&amp;D &quot;Q1&quot;"')
		expect(cut.sheets[0]?.name).toBe("abcdefgh-0123456789012345678901")
		expect(empty.sheets[0]?.name).toBe("Sheet1")
	})

	it("takes a cell edit, saves and reopens with it", async () => {
		const workbook = await openWorkbook(await blankXlsx({ locale: "en-US", sheetName: "Sheet1" }))
		const sheet = await workbook.load(0)

		sheet.store.setCell(0, 0, CellKind.NUMBER, 42, 0, -1)
		workbook.changes.sheetRows(0)

		const reopened = await openWorkbook(await saved(workbook))
		const read = await reopened.load(0)

		expect(read.store.cellCount).toBe(1)
		expect(read.store.locate(0, 0)).toBeGreaterThanOrEqual(0)
	})
})
