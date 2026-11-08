import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, openDocxPackage } from "@filen/office/core/docx"
import { DocxEditorSession, openDocxEditContext } from "@filen/office/core/docx/edit"
import { saveDocx } from "@filen/office/core/docx/write"
import { stampCoreProperties } from "../core/opc/coreProperties"
import { XmlEditor, decodeUtf8, parseXml } from "../core/xml/index"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"

// Word sets dcterms:modified, cp:lastModifiedBy and cp:revision of docProps/core.xml on every save that changes the
// document (ECMA-376 Part 2 §11); the rest of the part is kept byte for byte.

const CP = 'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
const DC = 'xmlns:dc="http://purl.org/dc/elements/1.1/"'
const DCTERMS = 'xmlns:dcterms="http://purl.org/dc/terms/"'
const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const NOW = Date.UTC(2026, 9, 12, 8, 30, 15, 789)
const STAMP = "2026-10-12T08:30:15Z"

function withCore(core: string, settings?: string): SyntheticDocx {
	return {
		body: p("Some text"),
		...(settings === undefined ? {} : { settings }),
		parts: [{ name: "docProps/core.xml", contentType: "application/vnd.openxmlformats-package.core-properties+xml", data: core }],
		packageRelationships: [
			{
				id: "rIdCore",
				type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
				target: "docProps/core.xml"
			}
		]
	}
}

async function save(
	spec: SyntheticDocx,
	edit: boolean,
	author: string | null = "Ann Lee"
): Promise<{ changed: readonly string[]; files: Record<string, Uint8Array> }> {
	const opened = await openDocxPackage(bytesSource(buildDocx(spec)))

	if (!opened.ok) throw new Error(opened.reason)

	const model = await buildDocxModel(opened.package)
	const context = await openDocxEditContext(opened.package, model, { ...(author === null ? {} : { author }), clock: () => NOW })
	const session = new DocxEditorSession(context)

	if (edit) session.dispatch(session.state.tr.insertText("Z", 2))

	const result = await saveDocx({ pkg: opened.package, context, sessions: [session] })

	return { changed: result.changedParts, files: unzipSync(result.bytes as Uint8Array) }
}

const core = (files: Record<string, Uint8Array>): string | undefined => {
	const bytes = files["docProps/core.xml"]

	return bytes === undefined ? undefined : decodeUtf8(bytes)
}

describe("docx save: core properties", () => {
	it("stamps modified, last modified by and the revision, keeping every other byte", async () => {
		const before =
			`${HEAD}<cp:coreProperties ${CP} ${DC} ${DCTERMS} ${XSI}><dc:title>Report</dc:title><dc:creator>Bo</dc:creator>` +
			"<cp:lastModifiedBy>Bo</cp:lastModifiedBy><cp:revision>4</cp:revision>" +
			'<dcterms:created xsi:type="dcterms:W3CDTF">2020-01-01T00:00:00Z</dcterms:created>' +
			'<dcterms:modified xsi:type="dcterms:W3CDTF">2020-01-02T00:00:00Z</dcterms:modified></cp:coreProperties>'
		const { changed, files } = await save(withCore(before), true)

		expect(changed).toContain("docProps/core.xml")
		expect(core(files)).toBe(
			before
				.replace("<cp:lastModifiedBy>Bo<", "<cp:lastModifiedBy>Ann Lee<")
				.replace("<cp:revision>4<", "<cp:revision>5<")
				.replace("2020-01-02T00:00:00Z", STAMP)
		)
	})

	it("adds missing properties with the namespaces they need", async () => {
		const before = `${HEAD}<cp:coreProperties ${CP} ${DC}><dc:title>Report</dc:title></cp:coreProperties>`
		const { files } = await save(withCore(before), true, "A & B")

		expect(core(files)).toBe(
			`${HEAD}<cp:coreProperties ${CP} ${DC} ${DCTERMS} ${XSI}><dc:title>Report</dc:title>` +
				`<dcterms:modified xsi:type="dcterms:W3CDTF">${STAMP}</dcterms:modified><cp:lastModifiedBy>A &amp; B</cp:lastModifiedBy></cp:coreProperties>`
		)
	})

	it("leaves the part of a save that changes nothing, and of a package without one", async () => {
		const before = `${HEAD}<cp:coreProperties ${CP} ${DC}><dc:title>Report</dc:title></cp:coreProperties>`

		expect((await save(withCore(before), false)).changed).toEqual([])

		const { files } = await save({ body: p("Some text") }, true)

		expect(core(files)).toBeUndefined()
	})

	it("writes a control bound to the title and the stamp in one part", async () => {
		const before = `${HEAD}<cp:coreProperties ${CP} ${DC} ${DCTERMS} ${XSI}><dc:title>Old</dc:title></cp:coreProperties>`
		const bound =
			'<w:p><w:sdt><w:sdtPr><w:id w:val="7"/><w:dataBinding w:prefixMappings="xmlns:ns0=\'http://purl.org/dc/elements/1.1/\' ' +
			"xmlns:ns1='http://schemas.openxmlformats.org/package/2006/metadata/core-properties'\" " +
			'w:xpath="/ns1:coreProperties[1]/ns0:title[1]" w:storeItemID="{6C3C8BC8-F283-45AE-878A-BAB7291924A1}"/><w:text/></w:sdtPr>' +
			"<w:sdtContent><w:r><w:t>Old</w:t></w:r></w:sdtContent></w:sdt></w:p>"
		const opened = await openDocxPackage(bytesSource(buildDocx({ ...withCore(before), body: bound })))

		if (!opened.ok) throw new Error(opened.reason)

		const context = await openDocxEditContext(opened.package, await buildDocxModel(opened.package), { author: "Ann", clock: () => NOW })
		const session = new DocxEditorSession(context)
		let at = -1

		session.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === "Old") at = pos
		})
		expect(session.dispatch(session.state.tr.insertText("New", at + 1, at + 2))).toBe(true)

		const saved = unzipSync((await saveDocx({ pkg: opened.package, context, sessions: [session] })).bytes as Uint8Array)

		expect(core(saved)).toBe(
			`${HEAD}<cp:coreProperties ${CP} ${DC} ${DCTERMS} ${XSI}><dc:title>ONewd</dc:title>` +
				`<dcterms:modified xsi:type="dcterms:W3CDTF">${STAMP}</dcterms:modified><cp:lastModifiedBy>Ann</cp:lastModifiedBy></cp:coreProperties>`
		)
	})

	it("writes no name without an author, or when the document removes personal information", async () => {
		const before = `${HEAD}<cp:coreProperties ${CP} ${DCTERMS} ${XSI}><cp:lastModifiedBy>Bo</cp:lastModifiedBy></cp:coreProperties>`
		const expected = `${HEAD}<cp:coreProperties ${CP} ${DCTERMS} ${XSI}><cp:lastModifiedBy>Bo</cp:lastModifiedBy><dcterms:modified xsi:type="dcterms:W3CDTF">${STAMP}</dcterms:modified></cp:coreProperties>`

		expect(core((await save(withCore(before), true, null)).files)).toBe(expected)
		expect(core((await save(withCore(before, "<w:removePersonalInformation/>"), true)).files)).toBe(expected)
	})
})

describe("stampCoreProperties", () => {
	const stamp = (xml: string, lastModifiedBy?: string): string => {
		const editor = new XmlEditor(parseXml(new TextEncoder().encode(xml)))

		stampCoreProperties(editor, { modified: NOW, lastModifiedBy })

		return decodeUtf8(editor.serialize())
	}

	it("keeps a revision that is not a count, and the prefixes the part uses", () => {
		expect(
			stamp(
				'<coreProperties xmlns="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:t="http://purl.org/dc/terms/" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><revision>draft</revision><t:modified>x</t:modified></coreProperties>',
				"Ann"
			)
		).toBe(
			`<coreProperties xmlns="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:t="http://purl.org/dc/terms/" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><revision>draft</revision><t:modified i:type="t:W3CDTF">${STAMP}</t:modified><lastModifiedBy>Ann</lastModifiedBy></coreProperties>`
		)
	})

	it("counts past the safe integer range and declares a free prefix", () => {
		expect(
			stamp(`<cp:coreProperties ${CP} xmlns:xsi="urn:other"><cp:revision>9007199254740993</cp:revision></cp:coreProperties>`)
		).toBe(
			`<cp:coreProperties ${CP} xmlns:xsi="urn:other" ${DCTERMS} xmlns:xsi1="http://www.w3.org/2001/XMLSchema-instance"><cp:revision>9007199254740994</cp:revision><dcterms:modified xsi1:type="dcterms:W3CDTF">${STAMP}</dcterms:modified></cp:coreProperties>`
		)
	})

	it("leaves a part whose root is not core properties", () => {
		const xml = "<other><revision>1</revision></other>"

		expect(stamp(xml, "Ann")).toBe(xml)
	})
})
