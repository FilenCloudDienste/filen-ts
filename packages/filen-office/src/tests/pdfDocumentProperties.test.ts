import { describe, expect, it } from "vitest"
import { PdfWriter, type PdfDocumentProperties } from "../core/pdfwrite"
import { buildDocx } from "./docxSynthetic"
import { openPdf, pdfOf, snapshotOf } from "./docxPdfFixtures"

// Word's Save as PDF carries the document properties (Info /Author, /Subject, /Keywords, and the XMP dc:creator,
// dc:description and pdf:Keywords that mirror them, ISO 32000-1 §14.3.3).

const CORE_RELATIONSHIP = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"

async function written(properties: PdfDocumentProperties | undefined, password?: string): Promise<Uint8Array> {
	const writer = await PdfWriter.create({
		tagged: true,
		deterministic: true,
		deflate: null,
		title: "Report",
		...(properties === undefined ? {} : { properties }),
		...(password === undefined ? {} : { password })
	})
	const page = writer.beginPage(100, 100)
	const node = writer.open("P")

	page.beginContent(node)
	page.rect(0, 0, 1, 1).fill()
	page.endContent()
	writer.close(node)
	await writer.endPage(page)

	const output = await writer.finish()
	const chunks: Uint8Array[] = []

	for (const part of output.parts) chunks.push(part instanceof Uint8Array ? part : new Uint8Array(await part.arrayBuffer()))

	return Buffer.concat(chunks)
}

function docxWithCore(core: string): Uint8Array {
	return buildDocx({
		body: "<w:p><w:r><w:t>Body</w:t></w:r></w:p>",
		parts: [
			{
				name: "docProps/core.xml",
				contentType: "application/vnd.openxmlformats-package.core-properties+xml",
				data:
					'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
					'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
					'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
					core +
					"</cp:coreProperties>"
			}
		],
		packageRelationships: [{ id: "rIdCore", type: CORE_RELATIONSHIP, target: "docProps/core.xml" }]
	})
}

describe("PDF document properties", () => {
	it("writes author, subject and keywords to the Info dictionary and the XMP packet", async () => {
		const bytes = await written({ author: "Ann & Bo", subject: "Q3 <figures>", keywords: "rivers, money" })
		const text = new TextDecoder("latin1").decode(bytes)

		expect(text).toContain("<dc:creator><rdf:Seq><rdf:li>Ann &amp; Bo</rdf:li></rdf:Seq></dc:creator>")
		expect(text).toContain(
			'<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Q3 &lt;figures&gt;</rdf:li></rdf:Alt></dc:description>'
		)
		expect(text).toContain("<pdf:Keywords>rivers, money</pdf:Keywords>")

		const metadata = await (await openPdf(bytes)).getMetadata()

		expect(metadata.info).toMatchObject({ Title: "Report", Author: "Ann & Bo", Subject: "Q3 <figures>", Keywords: "rivers, money" })
		expect(metadata.metadata?.get("dc:creator")).toEqual(["Ann & Bo"])
		expect(metadata.metadata?.get("dc:description")).toBe("Q3 <figures>")
		expect(metadata.metadata?.get("pdf:keywords")).toBe("rivers, money")
	})

	it("writes no entry for a blank or absent property", async () => {
		for (const properties of [undefined, { author: " ", subject: "\t", keywords: "" }]) {
			const text = new TextDecoder("latin1").decode(await written(properties))

			expect(text).not.toMatch(/\/Author|\/Subject|\/Keywords|dc:creator|dc:description|pdf:Keywords/u)
		}
	})

	it("dates the XMP packet as the Info dictionary, and only when the output is not deterministic", async () => {
		const writer = await PdfWriter.create({ deflate: null, title: "Report" })

		await writer.endPage(writer.beginPage(100, 100))

		const chunks: Uint8Array[] = []

		for (const part of (await writer.finish()).parts)
			chunks.push(part instanceof Uint8Array ? part : new Uint8Array(await part.arrayBuffer()))

		const text = new TextDecoder("latin1").decode(Buffer.concat(chunks))
		const info = /\/CreationDate \(D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z\)/u.exec(text)
		const xmp = /<xmp:CreateDate>([^<]*)<\/xmp:CreateDate>/u.exec(text)

		expect(info).not.toBeNull()
		expect(text).toContain('xmlns:xmp="http://ns.adobe.com/xap/1.0/"')
		expect(xmp?.[1]).toBe(`${info?.[1]}-${info?.[2]}-${info?.[3]}T${info?.[4]}:${info?.[5]}:${info?.[6]}Z`)
		expect(new TextDecoder("latin1").decode(await written(undefined))).not.toMatch(/CreationDate|xmp:CreateDate/u)
	})

	it("encrypts the properties with the rest of an encrypted document", async () => {
		const bytes = await written({ author: "Ann", subject: "Plans", keywords: "secret" }, "pw")

		expect(new TextDecoder("latin1").decode(bytes)).not.toContain("(Ann)")
		expect((await (await openPdf(bytes, "pw")).getMetadata()).info).toMatchObject({
			Author: "Ann",
			Subject: "Plans",
			Keywords: "secret"
		})
	})

	it("exports a document's core properties as Word's Save as PDF does", async () => {
		const docx = docxWithCore(
			"<dc:title>Plan</dc:title><dc:creator>  Ann\n Author </dc:creator><dc:subject>Budget</dc:subject><cp:keywords>alpha; beta</cp:keywords>"
		)
		const snapshot = await snapshotOf(docx)

		expect(snapshot.properties).toEqual({ author: "Ann Author", subject: "Budget", keywords: "alpha; beta" })

		const metadata = await (await openPdf((await pdfOf(snapshot)).bytes)).getMetadata()

		expect(metadata.info).toMatchObject({ Title: "Plan", Author: "Ann Author", Subject: "Budget", Keywords: "alpha; beta" })
		expect(metadata.metadata?.get("dc:creator")).toEqual(["Ann Author"])
	})

	it("leaves out what the core part does not name", async () => {
		const snapshot = await snapshotOf(docxWithCore("<dc:title>Plan</dc:title><dc:creator> </dc:creator>"))
		const info = (await (await openPdf((await pdfOf(snapshot)).bytes)).getMetadata()).info as Record<string, unknown>

		expect(info["Title"]).toBe("Plan")
		expect(info["Author"]).toBeUndefined()
		expect(info["Subject"]).toBeUndefined()
		expect(info["Keywords"]).toBeUndefined()
	})
})
