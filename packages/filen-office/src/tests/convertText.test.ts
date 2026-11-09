import { describe, expect, it } from "vitest"
import { canConvertText, convertOdtEditToDocx, convertText, textSourceFormat, withoutOrigins } from "../core/convert/text/index"
import { translationPackage } from "../core/odt/write/source"
import { standaloneParts } from "../core/convert/text/odtPackage"
import { LossyCounts } from "../core/convert/text/report"
import { bytesSource, ZipArchive } from "../core/opc/index"
import { translateOdt } from "../core/odt/index"
import { decodeUtf8, encodeUtf8 } from "../core/xml/index"
import { odtBytes } from "./odtFixtures"

async function entries(bytes: Uint8Array): Promise<Map<string, string>> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const out = new Map<string, string>()

	for (const entry of archive.entries) if (/\.(?:xml|rels)$/u.test(entry.name)) out.set(entry.name, decodeUtf8(await archive.read(entry)))

	return out
}

// Any revision-session attribute (§17.3.2.27 w:rsidR and its kin) or w:compatSetting this engine invented.
function leaks(parts: ReadonlyMap<string, string>): string[] {
	const found: string[] = []

	for (const [name, xml] of parts) {
		for (const match of xml.matchAll(/\sw:rsid[A-Za-z]*="[^"]*"/gu)) found.push(`${name}: ${match[0]}`)
		for (const match of xml.matchAll(
			/<w:compatSetting w:name="(?!compatibilityMode|overrideTableStyleFontSizeAndJustification|enableOpenTypeFeatures|doNotFlipMirrorIndents|differentiateMultirowTableHeaders|useWord2013TrackBottomHyphenation|allowHyphenationAtTrackBottom|allowTextAfterFloatingTableBreak)[^"]*"/gu
		))
			found.push(`${name}: ${match[0]}`)
	}

	return found
}

const W =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const OVERLINE = {
	automatic:
		'<style:style style:name="T1" style:family="text"><style:text-properties style:text-overline-style="solid" style:text-overline-width="auto" style:text-overline-color="font-color"/></style:style>',
	body: '<text:p>Plain <text:span text:style-name="T1">over</text:span> text<text:note text:id="n1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>In <text:span text:style-name="T1">note</text:span></text:p></text:note-body></text:note></text:p>'
}

describe("convertText", () => {
	it("offers exactly the four conversions", () => {
		expect(canConvertText("docx", "odt")).toBe(true)
		expect(canConvertText("odt", "docx")).toBe(true)
		expect(canConvertText("rtf", "docx")).toBe(true)
		expect(canConvertText("doc", "docx")).toBe(true)
		expect(canConvertText("docx", "docx")).toBe(false)
		expect(canConvertText("rtf", "odt")).toBe(false)
		expect(textSourceFormat("a.DOTM")).toBe("docx")
		expect(textSourceFormat("a.ott")).toBe("odt")
		expect(textSourceFormat("a.dot")).toBe("doc")
		expect(textSourceFormat("a.txt")).toBeUndefined()
	})

	it("refuses a conversion that does not exist, and bytes that are not the source format", async () => {
		expect(await convertText(new Uint8Array(4), "rtf", "odt")).toMatchObject({ ok: false, refusal: { reason: "unsupported" } })
		expect(await convertText(encodeUtf8("hello"), "odt", "docx")).toMatchObject({ ok: false, refusal: { reason: "notSource" } })
		expect(await convertText(encodeUtf8("hello"), "rtf", "docx")).toMatchObject({ ok: false, refusal: { reason: "notSource" } })
		expect(await convertText(encodeUtf8("hello"), "doc", "docx")).toMatchObject({ ok: false, refusal: { reason: "notSource" } })
	})

	it("never writes the ODT translator's origin offsets into a .docx", async () => {
		const source = odtBytes(OVERLINE)
		const translated = await translateOdt(bytesSource(source))

		if (!translated.ok) throw new Error(translated.message)

		const parts = translated.translation.parts
		const marked = [...parts].filter(([, part]) => part instanceof Uint8Array && /<w:r w:rsidR="/u.test(decodeUtf8(part)))

		// The translation marks the overlined spans (body and note): what the conversion must leave out.
		expect(marked.map(([name]) => name).sort()).toEqual(["word/document.xml", "word/footnotes.xml"])

		const converted = await convertText(source, "odt", "docx")

		if (!converted.ok) throw new Error(converted.refusal.message)

		const written = await entries(converted.bytes)

		expect(leaks(written)).toEqual([])
		expect(written.get("word/document.xml")).toContain('<w:t xml:space="preserve">over</w:t>')
		expect(converted.lossy.features).toContainEqual({ kind: "untranslatedText", count: 1 })
	})

	it("writes the editor's edited copy of an ODT (its translation package) as a standalone .docx", async () => {
		const translated = await translateOdt(bytesSource(odtBytes(OVERLINE)))

		if (!translated.ok) throw new Error(translated.message)

		const edited = await translationPackage(translated.translation)
		const converted = await convertOdtEditToDocx(edited)

		if (!converted.ok) throw new Error(converted.refusal.message)

		const written = await entries(converted.bytes)

		expect(leaks(written)).toEqual([])
		expect(written.get("word/document.xml")).toContain('<w:t xml:space="preserve">over</w:t>')
		expect(await convertOdtEditToDocx(encodeUtf8("x"))).toMatchObject({ ok: false, refusal: { reason: "notSource" } })
	})

	it("leaves text that reads like a marker alone", () => {
		const run = '<w:r w:rsidR="0000001A"><w:t>&lt;w:r w:rsidR="0000001A"&gt;</w:t></w:r>'
		const stripped = decodeUtf8(withoutOrigins(encodeUtf8(`<w:p>${run}<w:r w:rsidR="00000xyz"><w:t/></w:r></w:p>`)))

		expect(stripped).toBe('<w:p><w:r><w:t>&lt;w:r w:rsidR="0000001A"&gt;</w:t></w:r><w:r w:rsidR="00000xyz"><w:t/></w:r></w:p>')

		const none = encodeUtf8("<w:p><w:r><w:t>a</w:t></w:r></w:p>")

		expect(withoutOrigins(none)).toBe(none)
	})

	it("drops the translator's flow-with-text setting and counts it where floats are anchored", async () => {
		const converted = await convertText(odtBytes({ body: "<text:p>a</text:p>" }), "odt", "docx")

		if (!converted.ok) throw new Error(converted.refusal.message)

		const written = await entries(converted.bytes)

		expect(written.get("word/settings.xml")).not.toContain("flow-with-text")
		expect(converted.lossy.features.map(feature => feature.kind)).not.toContain("floatsOnAnchorPage")
	})

	it("writes a standalone package: revision ids, long bookmarks and their fields, header relationships", async () => {
		const longName = "attribute-xlink:href_element-text:section-source-and-more"
		const source = odtBytes({
			automatic:
				'<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style>',
			body:
				'<text:tracked-changes><text:changed-region text:id="c1"><text:insertion><office:change-info><dc:creator>A</dc:creator><dc:date>2024-01-01T00:00:00</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes>' +
				`<text:p text:style-name="Standard"><text:bookmark text:name="${longName}"/>x<text:change-start text:change-id="c1"/>one</text:p><text:p>two<text:change-end text:change-id="c1"/><text:bookmark-ref text:reference-format="text" text:ref-name="${longName}">x</text:bookmark-ref></text:p>`,
			masters:
				'<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p><text:a xlink:type="simple" xlink:href="https://filen.io/">link</text:a></text:p></style:header></style:master-page>'
		})
		const converted = await convertText(source, "odt", "docx")

		if (!converted.ok) throw new Error(converted.refusal.message)

		const written = await entries(converted.bytes)
		const body = written.get("word/document.xml") ?? ""

		const ids = [...body.matchAll(/<w:ins w:id="(\d+)"/gu)].map(match => match[1])

		// The two inserted runs and the paragraph mark the insertion runs over (§17.13.5.16).
		expect(ids.length).toBe(3)
		expect(new Set(ids).size).toBe(3)

		const names = [...body.matchAll(/<w:bookmarkStart w:id="\d+" w:name="([^"]*)"/gu)].map(match => match[1] ?? "")

		expect(names.every(name => name.length <= 40)).toBe(true)
		expect(body).not.toContain(longName)
		expect(body).toContain(`REF ${names[0] ?? ""} `)

		const header = [...written.keys()].find(name => /^word\/header\d+\.xml$/u.test(name))

		expect(header).toBeDefined()

		const headerXml = written.get(header ?? "") ?? ""
		const linkId = /<w:hyperlink r:id="([^"]+)"/u.exec(headerXml)?.[1]
		const rels = written.get(`word/_rels/${(header ?? "").slice("word/".length)}.rels`) ?? ""

		expect(linkId).toBeDefined()
		expect(rels).toContain(`Id="${linkId ?? ""}"`)
		expect(rels).toContain('Target="https://filen.io/"')
	})

	it("puts property children in schema order, the last of a repeated one kept, and font lists as their first family", () => {
		const parts = new Map([
			[
				"word/document.xml",
				encodeUtf8(
					`<w:document ${W}><w:body><w:p><w:pPr><w:pStyle w:val="A"/><w:pageBreakBefore/><w:keepNext/><w:pageBreakBefore w:val="0"/><w:rPr><w:vertAlign w:val="subscript"/><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="20"/><w:rFonts w:ascii="'Liberation Serif', 'Times New Roman'"/><w:vertAlign w:val="superscript"/><w:vertAlign w:val="superscript"/></w:rPr><w:t>a</w:t></w:r></w:p></w:body></w:document>`
				)
			]
		])
		const lossy = new LossyCounts()

		standaloneParts(parts, lossy)

		expect(decodeUtf8(parts.get("word/document.xml") ?? new Uint8Array())).toBe(
			`<w:document ${W}><w:body><w:p><w:pPr><w:pStyle w:val="A"/><w:keepNext/><w:pageBreakBefore w:val="0"/><w:rPr><w:b/><w:vertAlign w:val="subscript"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Liberation Serif"/><w:sz w:val="20"/><w:vertAlign w:val="superscript"/></w:rPr><w:t>a</w:t></w:r></w:p></w:body></w:document>`
		)
	})

	it("puts a tracked change inside a hyperlink, and moves comment marks out of comments", () => {
		const parts = new Map([
			[
				"word/document.xml",
				encodeUtf8(
					`<w:document ${W}><w:body><w:p><w:commentRangeStart w:id="0"/><w:r><w:t>a</w:t></w:r><w:del w:id="9" w:author="X"><w:r><w:delText>b</w:delText></w:r><w:hyperlink r:id="rId1"><w:r><w:delText>c</w:delText></w:r></w:hyperlink></w:del></w:p></w:body></w:document>`
				)
			],
			[
				"word/comments.xml",
				encodeUtf8(
					`<w:comments ${W}><w:comment w:id="0"><w:p><w:r><w:t>x</w:t></w:r></w:p></w:comment><w:comment w:id="1"><w:p><w:r><w:t>y</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p></w:comment></w:comments>`
				)
			]
		])
		const lossy = new LossyCounts()

		standaloneParts(parts, lossy)

		const body = decodeUtf8(parts.get("word/document.xml") ?? new Uint8Array())

		expect(body).toContain(
			'<w:del w:id="1" w:author="X"><w:r><w:delText>b</w:delText></w:r></w:del><w:hyperlink r:id="rId1"><w:del w:id="2" w:author="X"><w:r><w:delText>c</w:delText></w:r></w:del></w:hyperlink>'
		)
		expect(body).toContain('<w:commentRangeStart w:id="0"/><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>')
		expect(decodeUtf8(parts.get("word/comments.xml") ?? new Uint8Array())).not.toMatch(/commentRange|commentReference/u)
		expect(lossy.report("odt", "docx").features).toEqual([{ kind: "commentRange", count: 2 }])
	})

	it("writes the translator's field codes that would not update as their results", async () => {
		const source = odtBytes({
			body:
				'<text:p><text:bookmark text:name="has space"/>a<text:drop-down><text:label text:value="One"/>Pick</text:drop-down>' +
				'<text:variable-get text:name="v">7</text:variable-get><text:bookmark-ref text:reference-format="text" text:ref-name="missing">m</text:bookmark-ref>' +
				'<text:bookmark-ref text:reference-format="text" text:ref-name="has space">h</text:bookmark-ref></text:p>'
		})
		const converted = await convertText(source, "odt", "docx")

		if (!converted.ok) throw new Error(converted.refusal.message)

		const body = (await entries(converted.bytes)).get("word/document.xml") ?? ""
		const instructions = [...body.matchAll(/w:instr="([^"]*)"/gu)].map(match => match[1]?.trim())

		expect(instructions).toEqual(["REF has_space \\h"])
		expect(body).toContain('<w:bookmarkStart w:id="1" w:name="has_space"/>')
		expect(body).toMatch(/Pick.*7.*m.*h/su)
		expect(converted.lossy.features).toContainEqual({ kind: "fieldAsText", count: 3 })
	})

	it("converts an RTF file to its .docx translation", async () => {
		const converted = await convertText(encodeUtf8("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello {\\b world}\\par}"), "rtf", "docx")

		if (!converted.ok) throw new Error(converted.refusal.message)

		const written = await entries(converted.bytes)

		expect(written.get("word/document.xml")).toMatch(/Hello.*world/su)
		expect(leaks(written)).toEqual([])
		expect(converted.lossy).toEqual({ from: "rtf", to: "docx", features: [] })
	})

	it("converts RTF saved under .doc as RTF", async () => {
		const converted = await convertText(encodeUtf8("{\\rtf1\\ansi Hi\\par}"), "doc", "docx")

		expect(converted.ok).toBe(true)
	})
})
