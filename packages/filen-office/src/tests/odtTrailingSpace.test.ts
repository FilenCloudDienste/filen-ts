import { describe, expect, it } from "vitest"
import { convertText } from "../core/convert/text/index"
import { bytesSource, ZipArchive } from "../core/opc/index"
import { decodeUtf8 } from "../core/xml/index"
import { buildDocx } from "./docxSynthetic"

// ODF 1.3 Part 3 §6.1.2 step 5: a consumer removes trailing spaces of a paragraph, so a typed one is a text:s.

async function content(body: string): Promise<string> {
	const converted = await convertText(buildDocx({ body }), "docx", "odt")

	if (!converted.ok) throw new Error(converted.refusal.message)

	const archive = await ZipArchive.open(bytesSource(converted.bytes))
	const entry = archive.entries.find(candidate => candidate.name === "content.xml")

	if (entry === undefined) throw new Error("no content.xml")

	return decodeUtf8(await archive.read(entry))
}

const run = (text: string, rPr: string = ""): string =>
	`<w:r>${rPr === "" ? "" : `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`

describe("odt writer trailing space", () => {
	it("writes a paragraph's trailing space as text:s", async () => {
		const xml = await content(`<w:p>${run("word ")}</w:p>`)

		expect(xml).toMatch(/>word<text:s\/><\/text:p>/u)
	})

	it("writes it as text:s inside a closing span", async () => {
		const xml = await content(`<w:p>${run("plain ")}${run("bold ", "<w:b/>")}</w:p>`)

		expect(xml).toMatch(/plain <text:span[^>]*>bold<text:s\/><\/text:span><\/text:p>/u)
	})

	it("writes it as text:s before a closing bookmark", async () => {
		const xml = await content(`<w:p><w:bookmarkStart w:id="0" w:name="mark"/>${run("word ")}<w:bookmarkEnd w:id="0"/></w:p>`)

		expect(xml).toMatch(/word<text:s\/><text:bookmark-end text:name="mark"\/><\/text:p>/u)
	})

	it("keeps inner single spaces raw", async () => {
		const xml = await content(`<w:p>${run("a b ")}${run("c")}</w:p>`)

		expect(xml).toMatch(/>a b c<\/text:p>/u)
	})

	it("writes a tracked deletion's trailing space as text:s", async () => {
		const xml = await content(
			`<w:p>${run("kept")}<w:del w:id="1" w:author="A" w:date="2024-01-02T03:04:05Z"><w:r><w:delText xml:space="preserve">gone </w:delText></w:r></w:del></w:p>`
		)

		expect(xml).toMatch(/gone<text:s\/><\/text:p>/u)
	})
})
