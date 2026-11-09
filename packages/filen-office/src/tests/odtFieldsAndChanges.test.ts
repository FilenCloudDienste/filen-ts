import { afterEach, describe, expect, it, vi } from "vitest"
import { ZipArchive, bytesSource } from "@filen/office/core/opc"
import { decodeUtf8 } from "@filen/office/core/xml"
import { parseFieldCode } from "../core/docx/fields/code"
import { StyleMapper } from "../core/odt/styles"
import { documentXml, odtBytes, partText, translated } from "./odtFixtures"
import { editOdt, saveOdt } from "./odtWriteFixtures"

// Cross-references, dates, comment ranges, tracked paragraph changes, conditional sections and tab origins as
// LibreOffice shows them, and as Word reads their WordprocessingML.

function instructions(xml: string): string[] {
	return [...xml.matchAll(/<w:fldSimple w:instr="([^"]*)"/gu)].map(match =>
		(match[1] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
	)
}

const CHANGES =
	'<text:tracked-changes><text:changed-region text:id="i1"><text:insertion><office:change-info><dc:creator>Ann</dc:creator><dc:date>2024-01-01T00:00:00</dc:date></office:change-info></text:insertion></text:changed-region>' +
	'<text:changed-region text:id="d1"><text:deletion><office:change-info><dc:creator>Bob</dc:creator><dc:date>2024-01-02T00:00:00</dc:date></office:change-info><text:p>gone</text:p></text:deletion></text:changed-region></text:tracked-changes>'

describe("ODT cross-references", () => {
	it("names the bookmark as the bookmark itself is named, quoted where it has a space", async () => {
		const xml = await documentXml({
			body: '<text:p><text:bookmark text:name="Bookmark 1"/>x <text:bookmark-ref text:reference-format="text" text:ref-name="Bookmark 1">x</text:bookmark-ref> <text:bookmark-ref text:ref-name="plain">p</text:bookmark-ref></text:p>'
		})
		const name = /<w:bookmarkStart w:id="\d+" w:name="([^"]*)"/u.exec(xml)?.[1]
		const [quoted, plain] = instructions(xml)

		expect(name).toBe("Bookmark 1")
		expect(quoted).toBe(' REF "Bookmark 1" \\h ')
		expect(parseFieldCode(quoted ?? "").args).toEqual(["Bookmark 1"])
		expect(plain).toBe(" REF plain \\h ")
	})

	it("writes what text:reference-format shows: a page number, above or below, list numbers", async () => {
		const reference = (format: string): string =>
			`<text:bookmark-ref text:reference-format="${format}" text:ref-name="b">r</text:bookmark-ref>`
		const translation = await translated({
			body: `<text:p><text:bookmark text:name="b"/>${["page", "direction", "number", "number-no-superior", "number-all-superior", "chapter"].map(reference).join("")}</text:p>`
		})
		const xml = partText(translation, "word/document.xml")

		expect(instructions(xml)).toEqual([
			" PAGEREF b \\h ",
			" REF b \\p \\h ",
			" REF b \\r \\h ",
			" REF b \\n \\h ",
			" REF b \\w \\h ",
			" REF b \\h "
		])
		// A chapter has no field: its result stays.
		expect(xml).toMatch(/<w:fldSimple w:instr=" REF b \\h " w:fldLock="1">/u)
		expect(xml.match(/w:fldLock/gu)).toHaveLength(1)
		expect(translation.lossy.get("fieldAsText")).toBe(1)
	})

	it("locks references to a sequence or a note, which name no bookmark", async () => {
		const translation = await translated({
			body: '<text:p><text:sequence text:name="Figure" text:ref-name="refFigure0">1</text:sequence> <text:sequence-ref text:reference-format="value" text:ref-name="refFigure0">1</text:sequence-ref> <text:note-ref text:note-class="footnote" text:reference-format="text" text:ref-name="ftn0">1</text:note-ref></text:p>'
		})
		const xml = partText(translation, "word/document.xml")

		expect(xml).toContain('<w:fldSimple w:instr=" REF refFigure0 \\h " w:fldLock="1">')
		expect(xml).toContain('<w:fldSimple w:instr=" NOTEREF ftn0 \\h " w:fldLock="1">')
	})
})

describe("ODT dates and times", () => {
	it("shows a date that is not fixed as DATE in its data style's form, a fixed one as saved", async () => {
		const xml = await documentXml({
			automatic:
				'<number:date-style xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" style:name="N1"><number:day/><number:text>. </number:text><number:month number:textual="true" number:style="long"/><number:text> </number:text><number:year number:style="long"/></number:date-style>' +
				'<number:time-style xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" style:name="N2"><number:hours/><number:text>:</number:text><number:minutes number:style="long"/><number:text> </number:text><number:am-pm/></number:time-style>',
			body: '<text:p><text:date style:data-style-name="N1" text:date-value="2026-10-23">23. October 2026</text:date>|<text:time style:data-style-name="N2">3:04 PM</text:time>|<text:date text:fixed="true">fixed</text:date>|<text:date text:date-adjust="P1D">tomorrow</text:date>|<text:date>plain</text:date></text:p>'
		})

		expect(instructions(xml)).toEqual([
			' DATE \\@ "d. MMMM yyyy" ',
			' TIME \\@ "h:mm AM/PM" ',
			" DOCPROPERTY text_date ",
			" DOCPROPERTY text_date ",
			" DATE "
		])
	})

	it("saves a date an update changed as the source's element with the new result", async () => {
		const bytes = odtBytes({
			automatic:
				'<number:date-style xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" style:name="N1"><number:year number:style="long"/></number:date-style>',
			body: '<text:p>Year <text:date style:data-style-name="N1" text:date-value="1999-01-01">1999</text:date></text:p>'
		})
		const editing = await editOdt(bytes)

		await editing.editor.execute({ type: "field.updateAll" })

		const archive = await ZipArchive.open(bytesSource((await saveOdt(editing)).bytes))
		const entry = archive.get("content.xml")

		if (entry === undefined) throw new Error("no content.xml")

		const content = decodeUtf8(await archive.read(entry))

		expect(content).toContain(
			`<text:date style:data-style-name="N1" text:date-value="1999-01-01">${new Date().getFullYear()}</text:date>`
		)
	})
})

describe("ODT comment ranges", () => {
	it("ends a range at its office:annotation-end in a later paragraph", async () => {
		const xml = await documentXml({
			body: '<text:p>one<office:annotation office:name="n"><dc:creator>A</dc:creator><text:p>c</text:p></office:annotation>a</text:p><text:p>two<office:annotation-end office:name="n"/>after</text:p>'
		})
		const second = xml.slice(xml.indexOf(">two<"))

		expect(xml.slice(0, xml.indexOf(">two<"))).not.toContain("commentRangeEnd")
		expect(second).toMatch(/two<\/w:t><\/w:r><w:commentRangeEnd w:id="0"\/><w:r><w:commentReference w:id="0"\/><\/w:r>.*after/u)
	})

	it("ends a range left open at the end of its story, and one of the body at the body's end", async () => {
		const xml = await documentXml({
			body:
				'<table:table><table:table-column/><table:table-row><table:table-cell><text:p>a<office:annotation office:name="cell"><text:p>c</text:p></office:annotation>b</text:p><text:p>c2</text:p></table:table-cell></table:table-row></table:table>' +
				'<text:p>x<office:annotation office:name="body"><text:p>d</text:p></office:annotation>y</text:p><text:p>last</text:p>'
		})

		expect(xml).toMatch(/c2<\/w:t><\/w:r><w:commentRangeEnd w:id="0"\/>.*<\/w:tc>/u)
		expect(xml).toMatch(/last<\/w:t><\/w:r><w:commentRangeEnd w:id="1"\/><w:r><w:commentReference w:id="1"\/><\/w:r><\/w:p>/u)
	})
})

describe("ODT tracked paragraph changes", () => {
	it("marks the paragraph marks an insertion runs over as inserted, each revision with its own id", async () => {
		const xml = await documentXml({
			body: `${CHANGES}<text:p>a<text:change-start text:change-id="i1"/>b</text:p><text:p>c<text:change-end text:change-id="i1"/>d</text:p>`
		})
		const [first, second] = xml.match(/<w:p>.*?<\/w:p>/gu) ?? []
		const ids = [...xml.matchAll(/<w:ins w:id="(\d+)"/gu)].map(match => match[1])

		expect(first).toMatch(/<w:pPr>(?:(?!<\/w:pPr>).)*<w:rPr><w:ins w:id="\d+" w:author="Ann" w:date="2024-01-01T00:00:00"\/>/u)
		expect(second).not.toMatch(/<w:rPr><w:ins /u)
		expect(ids).toHaveLength(3)
		expect(new Set(ids).size).toBe(3)
	})

	it("shows a paragraph deleted between blocks as a deleted paragraph", async () => {
		const translation = await translated({
			body: `${CHANGES}<text:p>before</text:p><text:change text:change-id="d1"/><text:p>after</text:p>`
		})
		const xml = partText(translation, "word/document.xml")

		expect(xml).toMatch(
			/<w:p><w:pPr><w:rPr><w:del w:id="\d+" w:author="Bob" w:date="2024-01-02T00:00:00"\/><\/w:rPr><\/w:pPr><w:del w:id="\d+" w:author="Bob" w:date="2024-01-02T00:00:00"><w:r><w:delText xml:space="preserve">gone<\/w:delText><\/w:r><\/w:del><\/w:p>/u
		)
		expect(translation.lossy.has("trackedChange")).toBe(false)
	})
})

describe("ODT conditional sections", () => {
	it("shows a section whose constant condition is false, hides a true or unknown one, flagging the unknown", async () => {
		const section = (condition: string, text: string): string =>
			`<text:section text:name="${text}" text:display="condition" text:condition="${condition}"><text:p>${text}</text:p></text:section>`
		const translation = await translated({
			body: `${section("ooow:false", "shown")}${section("ooow:1", "hidden")}${section("ooow:Var == 2", "unknown")}`
		})
		const xml = partText(translation, "word/document.xml")

		expect(xml).toContain("shown")
		expect(xml).not.toContain("hidden")
		expect(xml).not.toContain("unknown")
		expect(translation.lossy.get("sectionProperties")).toBe(1)
	})
})

describe("ODT tab stops relative to the indent", () => {
	const TABS =
		'<style:style style:name="Tabbed" style:family="paragraph"><style:paragraph-properties fo:margin-left="1cm"><style:tab-stops><style:tab-stop style:position="2cm"/></style:tab-stops></style:paragraph-properties></style:style>'
	const SETTINGS = '<config:config-item config:name="TabsRelativeToIndent" config:type="boolean">true</config:config-item>'
	const tabsOf = (xml: string): string[] => [...xml.matchAll(/<w:tabs>(.*?)<\/w:tabs>/gu)].map(match => match[1] ?? "")

	it("moves a style's stops for an automatic style with another margin, clearing where Word would put them", async () => {
		const translation = await translated({
			styles: TABS,
			settings: SETTINGS,
			automatic:
				'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Tabbed"><style:paragraph-properties fo:margin-left="3cm"/></style:style>',
			body: '<text:p text:style-name="P1">a<text:tab/>b</text:p><text:p text:style-name="Tabbed">c<text:tab/>d</text:p>'
		})
		const twips = (cm: number): number => Math.round((cm / 2.54) * 1440)

		// The style's own at 1 cm + 2 cm; the first paragraph's at 3 cm + 2 cm, the style's cleared; the second takes
		// the style's.
		expect(tabsOf(partText(translation, "word/styles.xml"))).toEqual([`<w:tab w:val="left" w:pos="${twips(3)}"/>`])
		expect(tabsOf(partText(translation, "word/document.xml"))).toEqual([
			`<w:tab w:val="clear" w:pos="${twips(3)}"/><w:tab w:val="left" w:pos="${twips(5)}"/>`
		])
	})

	it("counts a list paragraph's stops from the list level's indent", async () => {
		const xml = await documentXml({
			styles: TABS,
			settings: SETTINGS,
			automatic:
				'<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.5cm" fo:margin-left="4cm"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>',
			body: '<text:list text:style-name="L1"><text:list-item><text:p text:style-name="Tabbed">a<text:tab/>b</text:p></text:list-item></text:list>'
		})
		const twips = (cm: number): number => Math.round((cm / 2.54) * 1440)

		expect(tabsOf(xml)).toEqual([`<w:tab w:val="clear" w:pos="${twips(3)}"/><w:tab w:val="left" w:pos="${twips(6)}"/>`])
	})
})

describe("ODT run properties", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("builds a span's run properties once for all its text, spaces, tabs and breaks", async () => {
		const runProperties = vi.spyOn(StyleMapper.prototype, "runProperties")

		await documentXml({
			automatic: '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>',
			body: '<text:p><text:span text:style-name="T1">a<text:s/>b<text:tab/>c<text:line-break/>d<text:s text:c="2"/>e</text:span></text:p>'
		})

		// The span's, and the paragraph mark's.
		expect(runProperties).toHaveBeenCalledTimes(2)
	})
})
