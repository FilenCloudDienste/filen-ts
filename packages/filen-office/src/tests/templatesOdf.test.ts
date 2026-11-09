import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { blankOdt } from "../core/templates/odt"
import { blankOds } from "../core/templates/ods"
import { blankOdp } from "../core/templates/odp"
import { bytesSource } from "@filen/office/core/opc"
import { decodeUtf8 } from "../core/xml/index"
import { openOds } from "../core/ods/open"
import { inThreadSheetHost } from "../dom/sheet/host"
import { layOutOdt, partText } from "./odtFixtures"
import { editOdt, saveOdt } from "./odtWriteFixtures"
import { odsDocument, shownRows } from "./odsFixtures"
import { IMMEDIATE } from "./sheetSessionFixtures"

// The blank OpenDocument templates New ▸ Office ▸ OpenDocument creates. FILEN_OFFICE_TEMPLATES_ODF_OUT names a
// directory each template is written to, for jing against the OASIS ODF 1.3 RELAX NG schema and the ODF validator
// (0 errors each). Opt-in.

const OUT = process.env["FILEN_OFFICE_TEMPLATES_ODF_OUT"] || undefined
const LIMIT = 3 * 1024

function partsOf(bytes: Uint8Array): Record<string, string> {
	return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, data]) => [name, decodeUtf8(data)]))
}

// The first local file header (APPNOTE 4.3.7): name, method and extra-field length.
function firstEntry(bytes: Uint8Array): { name: string; method: number; extra: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const nameLength = view.getUint16(26, true)

	return {
		name: decodeUtf8(bytes.subarray(30, 30 + nameLength)),
		method: view.getUint16(8, true),
		extra: view.getUint16(28, true)
	}
}

async function openBlankOds(bytes: Uint8Array) {
	const opened = await openOds(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.message)

	const document = odsDocument(opened)

	await document.readyAllSheets()

	return { opened, document }
}

describe.each([
	["odt", (locale: string) => blankOdt({ locale }), "application/vnd.oasis.opendocument.text"],
	["ods", (locale: string) => blankOds({ locale, sheetName: "Sheet1" }), "application/vnd.oasis.opendocument.spreadsheet"]
] as const)("blank %s package", (_kind, build, mediaType) => {
	it("is under 3 KB, the same bytes every time, and holds nothing about the user", async () => {
		const bytes = await build("de-DE")
		const text = Object.values(partsOf(bytes)).join("")

		expect(bytes.length).toBeLessThan(LIMIT)
		expect(await build("de-DE")).toEqual(bytes)
		expect(Object.keys(partsOf(bytes)).sort()).toEqual(["META-INF/manifest.xml", "content.xml", "mimetype", "styles.xml"])
		expect(text).not.toMatch(/creator|author|initial-creator|generator|date/i)
	})

	it("starts with its media type, stored, without an extra field (ODF 1.3 Part 2 §3.3)", async () => {
		const bytes = await build("en-US")

		expect(firstEntry(bytes)).toEqual({ name: "mimetype", method: 0, extra: 0 })
		expect(partsOf(bytes)["mimetype"]).toBe(mediaType)
	})

	it("declares ODF 1.3 on every stream and lists every stream in its manifest", async () => {
		const parts = partsOf(await build("en-US"))

		expect(parts["content.xml"]).toMatch(/<office:document-content [^>]*office:version="1\.3"/)
		expect(parts["styles.xml"]).toMatch(/<office:document-styles [^>]*office:version="1\.3"/)
		expect(parts["META-INF/manifest.xml"]).toContain('manifest:version="1.3"')
		expect(parts["META-INF/manifest.xml"]).toContain(
			`<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${mediaType}"/>`
		)

		for (const stream of ["content.xml", "styles.xml"])
			expect(parts["META-INF/manifest.xml"]).toContain(
				`<manifest:file-entry manifest:full-path="${stream}" manifest:media-type="text/xml"/>`
			)
	})

	it("defaults to Calibri 11 pt in the user's language, on the paper of the user's region", async () => {
		const de = partsOf(await build("de-DE"))["styles.xml"] ?? ""
		const us = partsOf(await build("en-US"))["styles.xml"] ?? ""
		const bare = partsOf(await build("ja"))["styles.xml"] ?? ""

		expect(de).toContain('<style:font-face style:name="Calibri" svg:font-family="Calibri"')
		expect(de).toMatch(/<style:text-properties style:font-name="Calibri" fo:font-size="11pt" fo:language="de" fo:country="DE"/)
		expect(us).toContain('fo:language="en" fo:country="US"')
		expect(de).not.toMatch(/(language|country)-(asian|complex)=/)
		expect(bare).toContain('fo:language="en" fo:country="US" style:language-asian="ja" style:country-asian="JP" ')
		expect(de).toContain('fo:page-width="21cm" fo:page-height="29.7cm"')
		expect(us).toContain('fo:page-width="8.5in" fo:page-height="11in"')
	})

	// ODF 1.3 Part 3 §20.276 / §20.277: East Asian and complex-script languages have their own slots; the Latin
	// slot keeps a Latin language so Latin text is not proofed as the user's script.
	it("puts an East Asian or complex-script language in its own slot, not in fo:language", async () => {
		const zh = partsOf(await build("zh-CN"))["styles.xml"] ?? ""
		const ar = partsOf(await build("ar-SA"))["styles.xml"] ?? ""
		const he = partsOf(await build("he-IL"))["styles.xml"] ?? ""

		expect(zh).toContain('fo:language="en" fo:country="US" style:language-asian="zh" style:country-asian="CN" ')
		expect(ar).toContain('fo:language="en" fo:country="US" style:language-complex="ar" style:country-complex="SA" ')
		expect(he).toContain('fo:language="en" fo:country="US" style:language-complex="he" style:country-complex="IL" ')
		expect(ar).not.toContain('-asian="ar"')
	})

	// ODF 1.3 Part 3 fo:script / style:script-asian: the script subtag has its own attribute, never fo:country.
	it("writes a script the locale names as fo:script", async () => {
		const sr = partsOf(await build("sr-Latn-RS"))["styles.xml"] ?? ""
		const zh = partsOf(await build("zh-Hant-TW"))["styles.xml"] ?? ""

		expect(sr).toContain('fo:language="sr" fo:script="Latn" fo:country="RS" ')
		expect(zh).toContain('style:language-asian="zh" style:script-asian="Hant" style:country-asian="TW" ')
		expect(sr).not.toContain('fo:country="Latn"')
	})
})

describe("blankOdt", () => {
	it("opens through the document reader as one empty page of its paper, in Calibri 11 pt", async () => {
		for (const [locale, width, height] of [
			["en-US", 12240, 15840],
			["en-GB", 11906, 16838]
		] as const) {
			const { pages, translation } = await layOutOdt(await blankOdt({ locale }))
			const document = partText(translation, "word/document.xml")
			const styles = partText(translation, "word/styles.xml")

			expect(pages).toBe(1)
			expect(document).toMatch(new RegExp(`<w:pgSz w:w="${String(width)}" w:h="${String(height)}"`))
			expect(document.match(/<w:p[ >/]/g)?.length).toBe(1)
			expect(document).not.toMatch(/<w:t[ >]/)
			expect(styles).toMatch(/w:ascii="Calibri"/)
			expect(styles).toMatch(/<w:sz w:val="22"\/>/)
		}
	})

	it("takes typing in the editor, saves through the ODT writer and reopens with the text", async () => {
		const editing = await editOdt(await blankOdt({ locale: "en-US" }))
		editing.session.dispatch(editing.session.state.tr.insertText("Hello from a new document", 1))

		const written = await saveOdt(editing)

		expect(written.bytes).toBeDefined()
		expect(partsOf(written.bytes)["content.xml"]).toContain("Hello from a new document")
		expect((await layOutOdt(written.bytes)).pages).toBe(1)
	})
})

describe("blankOds", () => {
	it("opens through the workbook reader as one empty sheet under the caller's name", async () => {
		const { opened, document } = await openBlankOds(await blankOds({ locale: "de-DE", sheetName: "Tabelle1" }))

		expect(opened.workbook.sheets.map(sheet => sheet.name)).toEqual(["Tabelle1"])
		expect(shownRows(document, 0)).toEqual([])
	})

	it("escapes the sheet name and cuts it down to one both formats take", async () => {
		const escaped = partsOf(await blankOds({ locale: "en-US", sheetName: 'R&D "Q1"' }))
		const cut = await openBlankOds(await blankOds({ locale: "en-US", sheetName: "a/b:c*d?e[f]g\\h-0123456789012345678901234567" }))
		const empty = await openBlankOds(await blankOds({ locale: "en-US", sheetName: "///" }))

		expect(escaped["content.xml"]).toContain('table:name="R&amp;D &quot;Q1&quot;"')
		expect(cut.opened.workbook.sheets[0]?.name).toBe("abcdefgh-0123456789012345678901")
		expect(empty.opened.workbook.sheets[0]?.name).toBe("Sheet1")
	})

	it("is writable, takes a cell edit, saves and reopens with it", async () => {
		const host = inThreadSheetHost()
		const result = await host.open(
			await blankOds({ locale: "en-US", sheetName: "Sheet1" }),
			{ kind: "ods", slicing: IMMEDIATE, settings: { clock: () => Date.UTC(2023, 2, 15, 12), author: "Test" } },
			() => undefined
		)

		if (result.kind !== "opened") throw new Error(result.kind)

		const { session } = result
		const sheet = result.info.sheets[0]?.id ?? 0

		expect((await session.intent()).state).toBe("writable")
		expect(
			(
				await session.command({
					type: "cells.set",
					sheet,
					cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["42"] }
				})
			).ok
		).toBe(true)

		const saved = await session.save()

		session.close()

		if (!saved.ok) throw new Error(saved.message)

		expect(shownRows((await openBlankOds(saved.bytes)).document, 0)).toEqual([["42"]])
	})
})

describe.skipIf(OUT === undefined)("blank OpenDocument templates for the ODF 1.3 schema and validator", () => {
	it("writes each template per paper", async () => {
		const out = OUT as string

		mkdirSync(out, { recursive: true })
		writeFileSync(join(out, "letter.odt"), await blankOdt({ locale: "en-US" }))
		writeFileSync(join(out, "a4.odt"), await blankOdt({ locale: "de-DE" }))
		writeFileSync(join(out, "letter.ods"), await blankOds({ locale: "en-US", sheetName: "Sheet1" }))
		writeFileSync(join(out, "a4.ods"), await blankOds({ locale: "fr-FR", sheetName: "Feuille 1 & co" }))
	})
})

describe("blankOdp", () => {
	it("puts the deck's East Asian or complex-script language in its own slot", async () => {
		const ja = partsOf(await blankOdp({ locale: "ja-JP" }))["styles.xml"] ?? ""
		const ar = partsOf(await blankOdp({ locale: "ar-SA" }))["styles.xml"] ?? ""
		const de = partsOf(await blankOdp({ locale: "de-DE" }))["styles.xml"] ?? ""

		expect(ja).toContain('fo:language="en" fo:country="US" style:language-asian="ja" style:country-asian="JP" ')
		expect(ja).not.toContain('fo:language="ja"')
		expect(ar).toContain('fo:language="en" fo:country="US" style:language-complex="ar" style:country-complex="SA" ')
		expect(de).toContain('fo:language="de" fo:country="DE" style:font-name-asian=')
	})
})
