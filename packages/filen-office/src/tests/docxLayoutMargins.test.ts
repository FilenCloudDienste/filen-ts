import { describe, expect, it } from "vitest"
import { OBJECT_FLOATS, Region, type DocumentLayout } from "@filen/office/core/docx"
import { buildDocx, type SyntheticDocx } from "./docxSynthetic"
import { layOut, pageLines, type LineInfo } from "./layoutFixtures"

// Letter paper, 1 in margins (96 px), header and footer 0.5 in from the edges: a 624 px wide text area.
const MARGINS =
	'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua"

function p(text: string, pPr = ""): string {
	return `<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

function words(count: number): string {
	const all = WORDS.split(" ")

	return Array.from({ length: count }, (_, k) => all[k % all.length]).join(" ")
}

async function layout(spec: SyntheticDocx & { section: string }): Promise<DocumentLayout> {
	return layOut(buildDocx({ ...spec, body: `${spec.body ?? ""}${spec.section}` }))
}

function numbers(result: DocumentLayout): LineInfo[] {
	return pageLines(result, 0).filter(line => line.region === Region.LINE_NUMBER)
}

function body(result: DocumentLayout): LineInfo[] {
	return pageLines(result, 0).filter(line => line.region === Region.BODY)
}

// A 1 x 1 in picture anchored at (x, y) EMU from `hFrom` / `vFrom`.
function anchor(wrap: string, hFrom: string, vFrom: string, x: number, y: number, cx = 914400, cy = 914400): string {
	return (
		'<w:r><w:drawing><wp:anchor behindDoc="0" allowOverlap="1" layoutInCell="1" relativeHeight="1" simplePos="0" locked="0"><wp:simplePos x="0" y="0"/>' +
		`<wp:positionH relativeFrom="${hFrom}"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="${vFrom}"><wp:posOffset>${y}</wp:posOffset></wp:positionV>` +
		`<wp:extent cx="${cx}" cy="${cy}"/>${wrap}<wp:docPr id="2" name="f"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"/></a:graphic></wp:anchor></w:drawing></w:r>`
	)
}

function objectY(result: DocumentLayout, index: number): number | undefined {
	const page = result.pages[0]

	return page === undefined || index >= page.objectCount ? undefined : page.objectFloats[index * OBJECT_FLOATS + 1]
}

describe("line numbers", () => {
	const numbered = (extra = ""): string => `<w:sectPr>${MARGINS}<w:lnNumType w:distance="360"/>${extra}</w:sectPr>`

	it("draws every number the same distance from the column's text margin, whatever the line's indent or alignment", async () => {
		const result = await layout({
			body:
				p("left") +
				p("centred", '<w:jc w:val="center"/>') +
				p("indented", '<w:ind w:left="1440"/>') +
				p("right", '<w:jc w:val="right"/>'),
			section: numbered()
		})
		const labels = numbers(result)

		expect(labels.map(line => line.text)).toEqual(["1", "2", "3", "4"])

		for (const label of labels) expect(label.x + label.width).toBeCloseTo(96 - 24, 1)
	})

	it("numbers the lines of each column beside that column", async () => {
		const result = await layout({
			body: Array.from({ length: 70 }, (_, k) => p(`line ${k + 1}`, '<w:jc w:val="center"/>')).join(""),
			section: numbered('<w:cols w:num="2" w:space="720"/>')
		})
		const labels = numbers(result)
		// Two columns of (624 - 48) / 2 = 288 px: the second starts at 96 + 336.
		const second = labels.filter(line => line.x > 300)

		expect(labels.filter(line => line.x + line.width < 96).length).toBeGreaterThan(0)
		expect(second.length).toBeGreaterThan(0)

		for (const label of second) expect(label.x + label.width).toBeCloseTo(96 + 336 - 24, 1)
	})

	it("draws them right of the text in a right-to-left section", async () => {
		const result = await layout({ body: p("one", "<w:bidi/>") + p("two"), section: numbered("<w:bidi/>") })

		for (const label of numbers(result)) expect(label.x).toBeCloseTo(96 + 624 + 24, 1)
	})

	it("leaves the lines of a paragraph with w:suppressLineNumbers unnumbered and uncounted", async () => {
		const result = await layout({
			body: p("one") + p(words(40), "<w:suppressLineNumbers/>") + p("three"),
			section: numbered()
		})
		const lines = body(result)
		const labels = numbers(result)

		expect(labels.map(line => line.text)).toEqual(["1", "2"])
		expect(labels[0]?.top).toBeCloseTo(lines[0]?.top ?? Number.NaN, 1)
		expect(labels[1]?.top).toBeCloseTo(lines.find(line => line.text === "three")?.top ?? Number.NaN, 1)
	})
})

describe("header and footer floats", () => {
	const section = (headers: string): string => `<w:sectPr>${headers}${MARGINS}</w:sectPr>`

	it("wraps the body's text around a wrapping float anchored in the header", async () => {
		// 1 in square at the left margin, 1 in from the page top: it covers the body's first 96 px.
		const header = `<w:p>${anchor('<wp:wrapSquare wrapText="bothSides"/>', "margin", "page", 0, 914400)}<w:r><w:t>head</w:t></w:r></w:p>`
		const result = await layout({
			body: p(words(200)),
			headers: { rId30: header },
			section: section('<w:headerReference w:type="default" r:id="rId30"/>')
		})
		const lines = body(result)

		expect(lines[0]?.x).toBeGreaterThanOrEqual(96 + 96)
		expect(lines.find(line => line.top >= 96 + 96)?.x).toBe(96)
	})

	it("wraps the body's text around a wrapping float anchored in the footer, where the footer ends up", async () => {
		// Anchored 1.5 in above its paragraph: the footer's paragraph is near the page bottom, so the square
		// covers the body's last lines.
		const footer = `<w:p>${anchor("<wp:wrapTopAndBottom/>", "margin", "paragraph", 0, -1371600)}<w:r><w:t>foot</w:t></w:r></w:p>`
		const plain = await layout({ body: p(words(2000)), section: section("") })
		const result = await layout({
			body: p(words(2000)),
			footers: { rId31: footer },
			section: section('<w:footerReference w:type="default" r:id="rId31"/>')
		})
		const objectTop = objectY(result, 0) ?? Number.NaN

		expect(objectTop).toBeGreaterThan(96 + 600)
		expect(body(result).every(line => line.bottom <= objectTop + 0.01 || line.top >= objectTop + 96 - 0.01)).toBe(true)
		expect(body(result).length).toBeLessThan(body(plain).length)
	})

	it("puts a footer's float placed on the page where the page says, and wraps the body's text around it", async () => {
		const footer = `<w:p>${anchor("<wp:wrapTopAndBottom/>", "margin", "page", 0, 914400)}<w:r><w:t>foot</w:t></w:r></w:p>`
		const result = await layout({
			body: p(words(200)),
			footers: { rId31: footer },
			section: section('<w:footerReference w:type="default" r:id="rId31"/>')
		})
		const foot = pageLines(result, 0).find(line => line.region === Region.FOOTER)

		expect(objectY(result, 0)).toBeCloseTo(96, 1)
		expect(body(result)[0]?.top).toBeGreaterThanOrEqual(96 + 96)
		expect(foot?.bottom).toBeCloseTo(1056 - 48, 0)
	})

	it("keeps the header's own text unwrapped", async () => {
		const header = `<w:p>${anchor('<wp:wrapSquare wrapText="bothSides"/>', "margin", "paragraph", 0, 0)}<w:r><w:t>head</w:t></w:r></w:p>`
		const result = await layout({
			body: p("body"),
			headers: { rId30: header },
			section: section('<w:headerReference w:type="default" r:id="rId30"/>')
		})

		expect(pageLines(result, 0).find(line => line.region === Region.HEADER)?.x).toBe(96)
	})
})

describe("section vertical alignment", () => {
	it("leaves objects placed on the page where they are and moves those that follow the text", async () => {
		const page = anchor("<wp:wrapNone/>", "page", "page", 0, 914400)
		const text = anchor("<wp:wrapNone/>", "column", "paragraph", 0, 0).replace('id="2"', 'id="3"')
		const result = await layout({
			body: `<w:p>${page}${text}<w:r><w:t>title</w:t></w:r></w:p>`,
			section: `<w:sectPr>${MARGINS}<w:vAlign w:val="center"/></w:sectPr>`
		})
		const title = body(result)[0]

		expect(title?.top).toBeGreaterThan(400)
		expect(objectY(result, 0)).toBeCloseTo(96, 1)
		expect(objectY(result, 1)).toBeCloseTo(title?.top ?? Number.NaN, 1)
	})
})
