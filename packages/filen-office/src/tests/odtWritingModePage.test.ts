import { describe, expect, it } from "vitest"
import { partText, translated } from "./odtFixtures"

// style:writing-mode "page" (and none) takes the page's direction (ODF 1.3 Part 3 §20.404.3); Word shows such a
// document right to left through w:bidi on the paragraphs and section (ECMA-376 Part 1 §17.3.1.1, §17.6.1).

const LAYOUT = (name: string, mode: string): string =>
	`<style:page-layout style:name="${name}"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm" style:writing-mode="${mode}"/></style:page-layout>`

const PAGE_DEFAULT =
	'<style:default-style style:family="paragraph"><style:paragraph-properties style:writing-mode="page"/></style:default-style><style:style style:name="Standard" style:family="paragraph"/>'

function pPrOf(xml: string, text: string): string {
	const at = xml.indexOf(`>${text}</w:t>`)
	const start = xml.lastIndexOf("<w:p>", at)

	// The paragraph's own properties, without a section's it closes.
	return (xml.slice(start, at).match(/<w:pPr>.*?<\/w:pPr>/u)?.[0] ?? "").replace(/<w:sectPr>.*<\/w:sectPr>/u, "")
}

describe("ODT writing mode page", () => {
	it("makes the styles and section of a right-to-left page style bidi", async () => {
		const translation = await translated({
			styles: PAGE_DEFAULT,
			stylesAutomatic: LAYOUT("pm1", "rl-tb"),
			body: "<text:p>שלום</text:p>"
		})
		const styles = partText(translation, "word/styles.xml")
		const document = partText(translation, "word/document.xml")

		expect(styles).toMatch(/<w:pPrDefault><w:pPr>[^]*<w:bidi\/>[^]*<\/w:pPr><\/w:pPrDefault>/u)
		expect(styles).not.toContain('<w:bidi w:val="0"/>')
		expect(document).toMatch(/<w:sectPr>.*<w:bidi\/><\/w:sectPr>/u)
	})

	it("writes w:bidi for a document with no writing mode on a right-to-left page", async () => {
		const translation = await translated({ stylesAutomatic: LAYOUT("pm1", "rl-tb"), body: "<text:p>x</text:p>" })

		expect(partText(translation, "word/styles.xml")).toMatch(/<w:pPrDefault><w:pPr><w:bidi\/><\/w:pPr><\/w:pPrDefault>/u)
	})

	it("leaves a left-to-right page's paragraphs and section without bidi", async () => {
		const translation = await translated({ styles: PAGE_DEFAULT, stylesAutomatic: LAYOUT("pm1", "lr-tb"), body: "<text:p>x</text:p>" })

		expect(partText(translation, "word/styles.xml")).not.toContain("<w:bidi/>")
		expect(partText(translation, "word/document.xml")).not.toContain("<w:bidi")
	})

	it("takes each section's own page direction where it differs from the first page style's", async () => {
		const xml = partText(
			await translated({
				styles: PAGE_DEFAULT,
				stylesAutomatic: LAYOUT("pm1", "lr-tb") + LAYOUT("pm2", "rl-tb"),
				masters:
					'<style:master-page style:name="Standard" style:page-layout-name="pm1"/><style:master-page style:name="Hebrew" style:page-layout-name="pm2"/>',
				automatic:
					'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="Hebrew"/><style:style style:name="P2" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties style:writing-mode="page"/></style:style><style:style style:name="P3" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties style:writing-mode="lr-tb"/></style:style>',
				body: '<text:p>one</text:p><text:p text:style-name="P1">two</text:p><text:p>three</text:p><text:p text:style-name="P2">four</text:p><text:p text:style-name="P3">five</text:p>'
			}),
			"word/document.xml"
		)

		expect(pPrOf(xml, "one")).not.toContain("bidi")
		expect(pPrOf(xml, "two")).toContain("<w:bidi/>")
		expect(pPrOf(xml, "three")).toContain("<w:bidi/>")
		expect(pPrOf(xml, "four")).toContain("<w:bidi/>")
		expect(pPrOf(xml, "five")).toContain('<w:bidi w:val="0"/>')

		const sections = [...xml.matchAll(/<w:sectPr>.*?<\/w:sectPr>/gu)].map(match => match[0])

		expect(sections).toHaveLength(2)
		expect(sections[0]).not.toContain("<w:bidi/>")
		expect(sections[1]).toContain("<w:bidi/>")
	})

	it("puts a left-to-right page's paragraphs back to left to right in a right-to-left first page style's document", async () => {
		const xml = partText(
			await translated({
				styles: PAGE_DEFAULT,
				stylesAutomatic: LAYOUT("pm1", "rl-tb") + LAYOUT("pm2", "lr-tb"),
				masters:
					'<style:master-page style:name="Standard" style:page-layout-name="pm1"/><style:master-page style:name="Latin" style:page-layout-name="pm2"/>',
				automatic:
					'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="Latin"/>',
				body: '<text:p>one</text:p><text:p text:style-name="P1">two</text:p>'
			}),
			"word/document.xml"
		)

		expect(pPrOf(xml, "one")).not.toContain("bidi")
		expect(pPrOf(xml, "two")).toContain('<w:bidi w:val="0"/>')
	})

	it("takes a table cell's direction over the page's", async () => {
		const xml = partText(
			await translated({
				styles: PAGE_DEFAULT,
				stylesAutomatic: LAYOUT("pm1", "lr-tb"),
				automatic:
					'<style:style style:name="C1" style:family="table-cell"><style:table-cell-properties style:writing-mode="rl-tb"/></style:style>',
				body: '<table:table table:name="T"><table:table-column/><table:table-row><table:table-cell table:style-name="C1"><text:p>cell</text:p></table:table-cell></table:table-row></table:table><text:p>after</text:p>'
			}),
			"word/document.xml"
		)

		expect(pPrOf(xml, "cell")).toContain("<w:bidi/>")
		expect(pPrOf(xml, "after")).not.toContain("bidi")
	})

	it("writes a header in its master page's direction", async () => {
		const translation = await translated({
			styles: PAGE_DEFAULT,
			stylesAutomatic: LAYOUT("pm1", "lr-tb") + LAYOUT("pm2", "rl-tb"),
			masters:
				'<style:master-page style:name="Standard" style:page-layout-name="pm1"/><style:master-page style:name="Hebrew" style:page-layout-name="pm2"><style:header><text:p>head</text:p></style:header></style:master-page>',
			automatic:
				'<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="Hebrew"/>',
			body: '<text:p>one</text:p><text:p text:style-name="P1">two</text:p>'
		})
		const header = [...translation.parts.keys()].find(name => name.startsWith("word/header"))

		expect(header).toBeDefined()
		expect(pPrOf(partText(translation, header ?? ""), "head")).toContain("<w:bidi/>")
	})

	it("maps start and end to jc left and right whatever the direction, as Word reads them by it", async () => {
		const xml = partText(
			await translated({
				styles: PAGE_DEFAULT,
				stylesAutomatic: LAYOUT("pm1", "rl-tb"),
				automatic:
					'<style:style style:name="S" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="start" style:writing-mode="rl-tb"/></style:style><style:style style:name="E" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="end" style:writing-mode="rl-tb"/></style:style>',
				body: '<text:p text:style-name="S">start</text:p><text:p text:style-name="E">end</text:p>'
			}),
			"word/document.xml"
		)

		expect(pPrOf(xml, "start")).toContain('<w:jc w:val="left"/>')
		expect(pPrOf(xml, "end")).toContain('<w:jc w:val="right"/>')
	})
})
