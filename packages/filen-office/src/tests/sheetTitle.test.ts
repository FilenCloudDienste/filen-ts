import { describe, expect, it } from "vitest"
import { inThreadSheetHost } from "../dom/sheet/host"
import { BASIC, IMMEDIATE, openFixture } from "./sheetSessionFixtures"
import { odsBytes, table } from "./odsFixtures"

// A workbook's own title (docProps/core.xml dc:title, or an OpenDocument spreadsheet's meta.xml dc:title) comes with
// the open, so its PDF is titled as the document is; a workbook naming none (or a text file) has none, and its PDF is
// titled from its file name.

const CORE =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title> Budget  2026 </dc:title></cp:coreProperties>'
const CORE_REL =
	'<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
const META =
	'<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"><office:meta><dc:title>Stock count</dc:title></office:meta></office:document-meta>'

async function opened(bytes: Uint8Array, kind: "ods" | "csv"): Promise<{ readonly title?: string }> {
	const result = await inThreadSheetHost().open(bytes, { kind, slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(result.kind)

	return result.info
}

describe("a workbook's own title", () => {
	it("is read from an .xlsx file's core properties", async () => {
		const { info } = await openFixture({
			...BASIC,
			parts: { "docProps/core.xml": { text: CORE, type: "application/vnd.openxmlformats-package.core-properties+xml" } },
			packageRelationships: CORE_REL
		})

		expect(info.title).toBe("Budget 2026")
		expect((await openFixture(BASIC)).info.title).toBeUndefined()
	})

	it("comes with the core part's author, subject and keywords, as Excel's Save as PDF carries them", async () => {
		const core = CORE.replace(
			"</cp:coreProperties>",
			"<dc:creator> Ann\n Author </dc:creator><dc:subject>Q3</dc:subject><cp:keywords> </cp:keywords></cp:coreProperties>"
		)
		const { info } = await openFixture({
			...BASIC,
			parts: { "docProps/core.xml": { text: core, type: "application/vnd.openxmlformats-package.core-properties+xml" } },
			packageRelationships: CORE_REL
		})

		expect(info.properties).toEqual({ author: "Ann Author", subject: "Q3" })
		expect((await openFixture(BASIC)).info.properties).toBeUndefined()
	})

	it("is read from an OpenDocument spreadsheet's meta.xml", async () => {
		const body = table("Sheet1", '<table:table-row><table:table-cell office:value-type="float" office:value="1"/></table:table-row>')

		expect((await opened(odsBytes({ body, extra: [{ name: "meta.xml", data: new TextEncoder().encode(META) }] }), "ods")).title).toBe(
			"Stock count"
		)
		expect((await opened(odsBytes({ body }), "ods")).title).toBeUndefined()
	})

	it("is none, and the spreadsheet still opens, when meta.xml's title holds an invalid character reference", async () => {
		const body = table("Sheet1", '<table:table-row><table:table-cell office:value-type="float" office:value="1"/></table:table-row>')
		const data = new TextEncoder().encode(META.replace("Stock count", "a&#x1;b"))

		expect((await opened(odsBytes({ body, extra: [{ name: "meta.xml", data }] }), "ods")).title).toBeUndefined()
	})

	it("is none for a text file", async () => {
		expect((await opened(new TextEncoder().encode("a,b\n1,2\n"), "csv")).title).toBeUndefined()
	})
})
