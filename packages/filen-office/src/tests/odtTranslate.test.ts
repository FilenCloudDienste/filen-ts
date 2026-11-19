import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openOdtAsDocx, translateOdt } from "../core/odt/index"
import { imageKind } from "../core/odt/frames"
import { decodeUtf8, encodeUtf8 } from "../core/xml/index"
import { documentXml, odtBytes, partText, translated, type OdtParts } from "./odtFixtures"
import { png } from "./security/generate"
import { buildZip } from "./zipBuilder"

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

describe("ODT translation budget", () => {
	const table = (inner: string, repeat: number): string =>
		`<table:table><table:table-column/><table:table-row table:number-rows-repeated="${repeat}"><table:table-cell>${inner}</table:table-cell></table:table-row></table:table>`

	async function refusal(body: string): Promise<string | undefined> {
		const result = await translateOdt(bytesSource(odtBytes({ body })))

		return result.ok ? undefined : result.reason
	}

	// Bounded by the test's timeout: without the budget this is 10⁹ rows translated.
	it("refuses tables nested three deep with rows repeated 1,000 times as malformed, in bounded time", { timeout: 15_000 }, async () => {
		expect(await refusal(table(table(table("<text:p>x</text:p>", 1000), 1000), 1000))).toBe("malformed")
	})

	it("refuses cells repeated across nested tables past the budget as malformed", { timeout: 15_000 }, async () => {
		const cells = (inner: string): string =>
			`<table:table><table:table-column table:number-columns-repeated="60"/><table:table-row><table:table-cell table:number-columns-repeated="60">${inner}</table:table-cell></table:table-row></table:table>`

		expect(await refusal(cells(cells(cells(cells("<text:p>x</text:p>")))))).toBe("malformed")
	})

	// Copies charged for what they hold: a few hundred copies of a cell of many empty paragraphs (no text emitted).
	it("refuses nested tables repeated 40 × 40 around a cell of 8,000 empty paragraphs as malformed", { timeout: 15_000 }, async () => {
		expect(await refusal(table(table("<text:p/>".repeat(8000), 40), 40))).toBe("malformed")
	})

	it("refuses one row repeated 1,000 times over a cell of 100,000 empty paragraphs as malformed", { timeout: 15_000 }, async () => {
		expect(await refusal(table("<text:p/>".repeat(100_000), 1000))).toBe("malformed")
	})

	it("refuses one row repeated 1,000 times over tabs and line breaks as malformed", { timeout: 15_000 }, async () => {
		expect(await refusal(table(`<text:p>${"<text:tab/><text:line-break/>".repeat(50_000)}</text:p>`, 1000))).toBe("malformed")
	})

	it("refuses one row repeated 1,000 times over a cell of 100,000 comments as malformed", { timeout: 15_000 }, async () => {
		expect(await refusal(table(`<text:p/>${"<!---->".repeat(100_000)}`, 1000))).toBe("malformed")
	})

	it("translates a row of 63 cells repeated 1,000 times", { timeout: 15_000 }, async () => {
		const xml = await documentXml({
			body: `<table:table><table:table-column table:number-columns-repeated="63"/><table:table-row table:number-rows-repeated="1000">${"<table:table-cell><text:p>c<text:span>s</text:span></text:p></table:table-cell>".repeat(63)}</table:table-row></table:table>`
		})

		expect(xml.match(/<w:tr>/g)).toHaveLength(1000)
		expect(xml.match(/<w:tc>/g)).toHaveLength(63_000)
	})

	it("refuses text:s spaces summing past the budget as malformed", async () => {
		expect(await refusal(`<text:p>${'<text:s text:c="10000"/>'.repeat(7000)}</text:p>`)).toBe("malformed")
	})

	it("translates a table with a row repeated 1,000 times and a paragraph of a few thousand spaces as before", async () => {
		const xml = await documentXml({
			body: `${table("<text:p>row</text:p>", 1000)}<text:p>a${'<text:s text:c="1000"/>'.repeat(4)}b</text:p>`
		})

		expect(xml.match(/<w:tr>/g)).toHaveLength(1000)
		expect(xml).toContain(`a${" ".repeat(4000)}b`)
	})
})

describe("ODT headers translated mid-body", () => {
	// The first section's header is translated where the paragraph naming another page style closes that section.
	const parts = (header: string, body: string, extra: Partial<OdtParts> = {}): OdtParts => ({
		masters: `<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header>${header}</style:header></style:master-page><style:master-page style:name="Wide" style:page-layout-name="pm1"/>`,
		automatic: `<style:style style:name="P1" style:family="paragraph" style:master-page-name="Wide"/>${extra.automatic ?? ""}`,
		body,
		...(extra.stylesAutomatic === undefined
			? {}
			: {
					stylesAutomatic: `<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout>${extra.stylesAutomatic}`
				}),
		...(extra.extra === undefined ? {} : { extra: extra.extra })
	})
	const headerText = (translation: Awaited<ReturnType<typeof translated>>): string =>
		[...translation.parts.keys()]
			.filter(name => name.startsWith("word/header"))
			.map(name => partText(translation, name))
			.join("")

	it("keeps a body frame anchored to the page in the body", async () => {
		const translation = await translated(
			parts(
				"<text:p>Head</text:p>",
				'<text:p>one</text:p><draw:frame text:anchor-type="page" text:anchor-page-number="1" svg:x="1cm" svg:y="1cm" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="Pictures/a.png"/></draw:frame><text:p text:style-name="P1">two</text:p>',
				{ extra: [{ name: "Pictures/a.png", data: png(4, 3) }] }
			)
		)
		const header = headerText(translation)

		expect(header).toContain("Head")
		expect(header).not.toContain("<w:drawing>")
		expect(partText(translation, "word/document.xml")).toMatch(/<w:drawing>.*two/)
	})

	it("names no body span on a header's runs, whatever span styles of either part are called", async () => {
		const overline = '<style:text-properties style:text-overline-style="solid" style:text-overline-width="auto"/>'
		const translation = await translated(
			parts(
				'<text:p>Head <text:span text:style-name="T1">span</text:span> <text:span text:style-name="T2">over</text:span></text:p>',
				'<text:p>one</text:p><text:p text:style-name="P1">two <text:span text:style-name="T1">body</text:span></text:p><text:p>three <text:span text:style-name="T1">more</text:span></text:p>',
				{
					automatic: `<style:style style:name="T1" style:family="text">${overline}</style:style>`,
					stylesAutomatic: `<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style><style:style style:name="T2" style:family="text">${overline}</style:style>`
				}
			)
		)
		const xml = partText(translation, "word/document.xml")

		expect(headerText(translation)).not.toContain("w:rsidR")
		expect(xml).toMatch(/<w:r w:rsidR="[0-9A-F]{8}">(?:(?!<\/w:r>).)*body/)
		expect(xml).toMatch(/<w:r w:rsidR="[0-9A-F]{8}">(?:(?!<\/w:r>).)*more/)
	})

	it("leaves a tracked insertion open across the page style change out of the header", async () => {
		const translation = await translated(
			parts(
				"<text:p>Head</text:p>",
				'<text:tracked-changes><text:changed-region text:id="c1"><text:insertion><office:change-info><dc:creator>Ann</dc:creator><dc:date>2024-01-02T03:04:05</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes><text:p>one <text:change-start text:change-id="c1"/>added</text:p><text:p text:style-name="P1">two<text:change-end text:change-id="c1"/></text:p>'
			)
		)
		const header = headerText(translation)

		expect(header).toContain("Head")
		expect(header).not.toContain("<w:ins")
		expect(partText(translation, "word/document.xml")).toMatch(/<w:ins [^>]*><w:r><w:t xml:space="preserve">two<\/w:t>/)
	})

	it("breaks no body page after a header paragraph's break after", async () => {
		const translation = await translated(
			parts(
				'<text:p text:style-name="HB">Head</text:p>',
				'<text:p>one</text:p><text:p text:style-name="P1">two</text:p><text:p>three</text:p>',
				{
					stylesAutomatic:
						'<style:style style:name="HB" style:family="paragraph"><style:paragraph-properties fo:break-after="page"/></style:style>'
				}
			)
		)
		const xml = partText(translation, "word/document.xml")

		expect(headerText(translation)).toContain("Head")
		expect(xml).not.toMatch(/<w:pageBreakBefore\/>(?:(?!<\/w:p>).)*three/)
	})
})

describe("ODT picture sniffing", () => {
	const svg = (prolog: string): Uint8Array =>
		encodeUtf8(`${prolog}<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`)
	const comment = `<!-- ${"Created with an editor that writes a long comment. ".repeat(20)}-->`
	const doctype = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [ <!ENTITY a "b"> ]>'
	const prologs = {
		"an XML declaration, a long comment and a DOCTYPE": `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${comment}\n${doctype}\n`,
		"a byte order mark and an XML declaration": `\uFEFF<?xml version="1.0"?>${comment}`
	}

	it.each(Object.entries(prologs))("classes an SVG after %s as svg", (_, prolog) => {
		expect(imageKind(svg(prolog))).toBe("svg")
	})

	it("keeps the binary signatures first", () => {
		expect(imageKind(png(2, 2))).toBe("png")
		expect(imageKind(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg")
		expect(imageKind(encodeUtf8("GIF89a<svg "))).toBe("gif")
		expect(imageKind(encodeUtf8("<!-- <svg > -->"))).toBe("unknown")
	})

	it.each([
		["an unterminated DOCTYPE with many brackets", `<!DOCTYPE${"[]".repeat(2000)}`],
		["an unterminated comment", `<!--${"a".repeat(4092)}`],
		["an unterminated processing instruction", `<?${"a".repeat(4094)}`],
		["an unterminated internal subset", `<!DOCTYPE svg [${"<!ENTITY a 'b'>".repeat(250)}`]
	])("classes a head with %s as unknown in linear time", (_, head) => {
		const started = performance.now()

		expect(imageKind(encodeUtf8(head))).toBe("unknown")
		expect(performance.now() - started).toBeLessThan(100)
	})

	it("skips a DOCTYPE without an internal subset", () => {
		expect(imageKind(svg('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n'))).toBe("svg")
	})

	for (const stored of [false, true]) {
		it(`shows an SVG picture with a long prolog ${stored ? "stored" : "deflated"} in the package`, async () => {
			const parts = {
				body: '<text:p><draw:frame text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="Pictures/a.svg"/></draw:frame></text:p>',
				extra: [{ name: "Pictures/a.svg", data: svg(prologs["an XML declaration, a long comment and a DOCTYPE"]) }]
			}
			const result = await translateOdt(bytesSource(stored ? await storing(odtBytes(parts), "Pictures/a.svg") : odtBytes(parts)))

			if (!result.ok) throw new Error(result.message)

			expect(result.translation.parts.has("word/media/image1.svg")).toBe(true)
			expect(result.translation.lossy.has("unsupportedImage")).toBe(false)
		})
	}
})

// The package rebuilt with entry `name` stored rather than deflated.
async function storing(odt: Uint8Array, name: string): Promise<Uint8Array> {
	const { ZipArchive } = await import("@filen/office/core/opc")
	const archive = await ZipArchive.open(bytesSource(odt))
	const entries = []

	for (const entry of archive.entries) {
		entries.push({
			name: entry.name,
			data: await archive.read(entry),
			method: entry.name === "mimetype" || entry.name === name ? 0 : 8
		} as const)
	}

	return buildZip(entries)
}

async function contentXml(odt: Uint8Array): Promise<Uint8Array> {
	const { ZipArchive } = await import("@filen/office/core/opc")
	const archive = await ZipArchive.open(bytesSource(odt))
	const entry = archive.get("content.xml")

	if (entry === undefined) throw new Error("no content.xml")

	return archive.read(entry)
}
