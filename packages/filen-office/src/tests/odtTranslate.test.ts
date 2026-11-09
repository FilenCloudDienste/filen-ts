import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openOdtAsDocx, translateOdt } from "../core/odt/index"
import { decodeUtf8 } from "../core/xml/index"
import { documentXml, odtBytes, partText, translated } from "./odtFixtures"
import { png } from "./security/generate"

describe("ODT text and paragraphs", () => {
	it("collapses white space as ODF does and keeps text:s spaces", async () => {
		const xml = await documentXml({ body: '<text:p>  a \n\t b<text:s text:c="2"/> c<text:tab/>d</text:p>' })

		expect(xml).toContain('<w:t xml:space="preserve">a b   c</w:t>')
		expect(xml).toContain("<w:tab/>")
	})

	it("writes an automatic style as direct formatting over its common parent", async () => {
		const xml = await documentXml({
			styles: '<style:style style:name="Body" style:family="paragraph"><style:text-properties fo:font-size="11pt"/></style:style>',
			automatic:
				'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Body"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.5cm"/><style:text-properties fo:font-weight="bold" fo:font-size="150%"/></style:style>',
			body: '<text:p text:style-name="P1">x</text:p>'
		})

		expect(xml).toContain('<w:pStyle w:val="Body"/>')
		expect(xml).toContain('<w:jc w:val="center"/>')
		// Space below alone sets space above to 0 (LibreOffice reads the pair as one setting).
		expect(xml).toContain('<w:spacing w:before="0" w:after="283"/>')
		// 150 % of the parent's 11 pt.
		expect(xml).toMatch(/<w:b\/>.*<w:sz w:val="33"\/>/)
	})

	it("starts a new section with the page style a paragraph names, restarting the page count", async () => {
		const xml = await documentXml({
			stylesAutomatic:
				'<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout><style:page-layout style:name="pm2"><style:page-layout-properties fo:page-width="29.7cm" fo:page-height="21cm" style:print-orientation="landscape" fo:margin-top="1cm" fo:margin-bottom="1cm" fo:margin-left="1cm" fo:margin-right="1cm"/></style:page-layout>',
			masters:
				'<style:master-page style:name="Standard" style:page-layout-name="pm1"/><style:master-page style:name="Wide" style:page-layout-name="pm2"/>',
			automatic:
				'<style:style style:name="P1" style:family="paragraph" style:master-page-name="Wide"><style:paragraph-properties style:page-number="5"/></style:style>',
			body: '<text:p>one</text:p><text:p text:style-name="P1">two</text:p>'
		})
		const sections = [...xml.matchAll(/<w:sectPr>.*?<\/w:sectPr>/g)].map(match => match[0])

		expect(sections).toHaveLength(2)
		expect(sections[0]).toContain('w:w="11906"')
		expect(sections[1]).toContain('w:orient="landscape"')
		expect(sections[1]).toContain('<w:pgNumType w:start="5"/>')
		// The first section's sectPr closes it in its last paragraph, not in a paragraph of its own.
		expect(xml).toMatch(/one<\/w:t><\/w:r><\/w:p>/)
		expect(xml.indexOf("<w:sectPr>")).toBeLessThan(xml.indexOf("two"))
	})

	it("makes a first-page chain a title page with the first master's header", async () => {
		const translation = await translated({
			stylesAutomatic:
				'<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/><style:header-style><style:header-footer-properties fo:min-height="0.5cm" fo:margin-bottom="0.25cm"/></style:header-style></style:page-layout>',
			masters:
				'<style:master-page style:name="First_20_Page" style:page-layout-name="pm1" style:next-style-name="Standard"><style:header><text:p>Cover</text:p></style:header></style:master-page><style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>Running</text:p></style:header></style:master-page>',
			automatic: '<style:style style:name="P1" style:family="paragraph" style:master-page-name="First_20_Page"/>',
			body: '<text:p text:style-name="P1">x</text:p>'
		})
		const xml = partText(translation, "word/document.xml")
		const rels = partText(translation, "word/_rels/document.xml.rels")
		const target = (type: string): string => {
			const id = new RegExp(`<w:headerReference w:type="${type}" r:id="([^"]+)"`).exec(xml)?.[1] ?? ""

			return new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? ""
		}

		expect(xml).toContain("<w:titlePg/>")
		expect(partText(translation, `word/${target("first")}`)).toContain("Cover")
		expect(partText(translation, `word/${target("default")}`)).toContain("Running")
		// The body starts below the header: margin and minimum height, which includes the spacing.
		expect(xml).toContain(`w:top="${Math.round(((2.5 / 2.54) * 72 + 0) * 20)}"`)
		expect(xml).toContain('w:header="1134"')
	})

	it.each([
		["header", "footer"],
		["footer", "header"]
	] as const)("gives the first page the regular %s when only the %s has a first-page variant", async (plain, firstOnly) => {
		const translation = await translated({
			masters: `<style:master-page style:name="Standard"><style:${firstOnly}><text:p>Running ${firstOnly}</text:p></style:${firstOnly}><style:${firstOnly}-first><text:p>Cover ${firstOnly}</text:p></style:${firstOnly}-first><style:${plain}><text:p>Page ${plain}</text:p></style:${plain}></style:master-page>`,
			body: "<text:p>x</text:p>"
		})
		const xml = partText(translation, "word/document.xml")
		const rels = partText(translation, "word/_rels/document.xml.rels")
		const target = (tag: string, type: string): string => {
			const id = new RegExp(`<w:${tag}Reference w:type="${type}" r:id="([^"]+)"`).exec(xml)?.[1] ?? ""

			return new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? ""
		}

		expect(xml).toContain("<w:titlePg/>")
		expect(partText(translation, `word/${target(firstOnly, "first")}`)).toContain(`Cover ${firstOnly}`)
		expect(partText(translation, `word/${target(firstOnly, "default")}`)).toContain(`Running ${firstOnly}`)
		// titlePg with no first reference would blank this region on page 1 (ECMA-376 Part 1 §17.10.5).
		expect(target(plain, "first")).toBe(target(plain, "default"))
		expect(partText(translation, `word/${target(plain, "first")}`)).toContain(`Page ${plain}`)
	})

	it("turns notes into footnotes and endnotes with their references", async () => {
		const translation = await translated({
			body: '<text:p>a<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>foot</text:p></text:note-body></text:note>b<text:note text:note-class="endnote"><text:note-citation text:label="*">*</text:note-citation><text:note-body><text:p>end</text:p></text:note-body></text:note></text:p>'
		})

		expect(partText(translation, "word/document.xml")).toContain('<w:footnoteReference w:id="1"/>')
		expect(partText(translation, "word/document.xml")).toContain('<w:endnoteReference w:customMarkFollows="1" w:id="1"/>')
		expect(partText(translation, "word/footnotes.xml")).toMatch(/<w:footnote w:id="1">.*<w:footnoteRef\/>.*foot/)
		expect(partText(translation, "word/endnotes.xml")).toContain("end")
	})

	it("keeps hyperlinks, internal links and bookmarks", async () => {
		const translation = await translated({
			body: '<text:p><text:bookmark-start text:name="here"/>x<text:bookmark-end text:name="here"/><text:a xlink:href="https://example.com/">web</text:a><text:a xlink:href="#here|outline">in</text:a></text:p>'
		})
		const xml = partText(translation, "word/document.xml")

		expect(xml).toMatch(/<w:bookmarkStart w:id="(\d+)" w:name="here"\/>.*<w:bookmarkEnd w:id="\1"\/>/)
		expect(xml).toContain('<w:hyperlink w:anchor="here">')
		expect(partText(translation, "word/_rels/document.xml.rels")).toContain('Target="https://example.com/" TargetMode="External"')
	})

	it("shows tracked changes as insertions and deletions", async () => {
		const xml = await documentXml({
			body: '<text:tracked-changes><text:changed-region text:id="c1"><text:insertion><office:change-info><dc:creator>Ann</dc:creator><dc:date>2024-01-02T03:04:05</dc:date></office:change-info></text:insertion></text:changed-region><text:changed-region text:id="c2"><text:deletion><office:change-info><dc:creator>Bob</dc:creator><dc:date>2024-01-02T03:04:05</dc:date></office:change-info><text:p>gone</text:p></text:deletion></text:changed-region></text:tracked-changes><text:p>keep <text:change-start text:change-id="c1"/>added<text:change-end text:change-id="c1"/> <text:change text:change-id="c2"/>end</text:p>'
		})

		expect(xml).toMatch(
			/<w:ins w:id="\d+" w:author="Ann" w:date="2024-01-02T03:04:05"><w:r><w:t xml:space="preserve">added<\/w:t><\/w:r><\/w:ins>/
		)
		expect(xml).toMatch(/<w:del w:id="\d+" w:author="Bob"[^>]*><w:r><w:delText xml:space="preserve">gone<\/w:delText><\/w:r><\/w:del>/)
	})

	it("turns annotations into comments over the range they mark", async () => {
		const translation = await translated({
			body: '<text:p>a<office:annotation office:name="n1"><dc:creator>Ann</dc:creator><dc:date>2024-01-02T03:04:05.123</dc:date><text:p>note</text:p></office:annotation>marked<office:annotation-end office:name="n1"/>after<office:annotation><dc:creator>Bob</dc:creator><text:p>point</text:p></office:annotation></text:p>'
		})
		const xml = partText(translation, "word/document.xml")

		expect(xml).toMatch(
			/<w:commentRangeStart w:id="0"\/>.*marked.*<w:commentRangeEnd w:id="0"\/><w:r><w:commentReference w:id="0"\/><\/w:r>.*after/
		)
		expect(xml).toMatch(/<w:commentRangeStart w:id="1"\/><w:commentRangeEnd w:id="1"\/><w:r><w:commentReference w:id="1"\/><\/w:r>/)
		expect(partText(translation, "word/comments.xml")).toContain('<w:comment w:id="0" w:author="Ann" w:date="2024-01-02T03:04:05">')
	})

	it("records each top-level block's byte span in content.xml", async () => {
		const blocks = [
			'<text:p text:style-name="Standard">first</text:p>',
			"<table:table><table:table-column/><table:table-row><table:table-cell><text:p>c</text:p></table:table-cell></table:table-row></table:table>",
			"<text:p/>"
		]
		const bytes = odtBytes({ body: blocks.join("") })
		const result = await translateOdt(bytesSource(bytes))

		if (!result.ok) throw new Error(result.message)

		const content = decodeUtf8(await contentXml(bytes))
		const origins = result.translation.origins.filter(origin => origin.stream === "content.xml")

		expect(origins.map(origin => content.slice(origin.start, origin.end))).toEqual(blocks)
		expect(origins.map(origin => [origin.first, origin.count])).toEqual([
			[0, 1],
			[1, 1],
			[2, 1]
		])
		expect(result.translation.originsExact).toBe(true)
	})

	it("opens as a word-processing package whose pictures stay in the ODF archive", async () => {
		const image = png(4, 3)
		const opened = await openOdtAsDocx(
			bytesSource(
				odtBytes({
					body: '<text:p><draw:frame text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p>',
					extra: [{ name: "Pictures/a.png", data: image }]
				})
			)
		)

		if (!opened.ok) throw new Error(opened.message)

		expect(opened.package.mainPart).toBe("word/document.xml")
		expect(await opened.package.opc.read("word/media/image1.png")).toEqual(image)
		expect(opened.translation.parts.get("word/media/image1.png")).not.toBeInstanceOf(Uint8Array)
	})
})

async function contentXml(odt: Uint8Array): Promise<Uint8Array> {
	const { ZipArchive } = await import("@filen/office/core/opc")
	const archive = await ZipArchive.open(bytesSource(odt))
	const entry = archive.get("content.xml")

	if (entry === undefined) throw new Error("no content.xml")

	return archive.read(entry)
}
