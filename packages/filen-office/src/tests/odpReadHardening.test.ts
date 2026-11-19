import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/io"
import { MAX_CELLS, MAX_SERIES } from "../core/odp/localTable"
import { openOdp } from "../core/odp/read/document"
import { pageFragment, pageHead, scanPages } from "../core/odp/read/scan"
import { PresentationError } from "../core/presentation/model"
import { encodeUtf8 } from "../core/xml/index"
import { ODP_NS, odpBytes, openOdpFixture, page, plainText, slideOf } from "./odpFixtures"
import { budget, cpuMs } from "./timing"

const DRAWING = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"

function refuseLimit(): never {
	throw new Error("limit")
}

function scan(xml: string): ReturnType<typeof scanPages> {
	return scanPages(encodeUtf8(xml), 100, refuseLimit)
}

function frame(inner: string): string {
	return `<draw:frame svg:x="1cm" svg:y="1cm" svg:width="2cm" svg:height="2cm"><draw:text-box>${inner}</draw:text-box></draw:frame>`
}

describe("odp page scan", () => {
	it("scans a page of 40,000 end tags in linear time", () => {
		const inner = "<text:span>x</text:span>".repeat(40_000)
		const bytes = encodeUtf8(
			`<?xml version="1.0"?><office:document-content ${ODP_NS}><office:body><office:presentation><draw:page draw:name="p1">${frame(`<text:p>${inner}</text:p>`)}</draw:page><draw:page draw:name="p2"/></office:presentation></office:body></office:document-content>`
		)
		const start = cpuMs()
		const scanned = scanPages(bytes, 100, refuseLimit)

		expect(cpuMs() - start).toBeLessThan(budget(100))
		expect(scanned.pages.length).toBe(2)
		expect(scanned.pages[0]?.end).toBe(scanned.pages[1]?.start)
	}, 30_000)

	it("refuses a draw:page that never ends quickly", async () => {
		const bytes = odpBytes({ body: '<draw:page draw:name="p" draw:master-page-name="M">' + "<text:p>x</text:p>".repeat(100_000) })
		const start = cpuMs()
		const opened = await openOdp(bytesSource(bytes))

		expect(cpuMs() - start).toBeLessThan(budget(500))
		expect(opened.kind === "refused" && opened.reason).toBe("malformed")
	}, 30_000)

	it("ends a page at its own end tag, not at a longer name or one inside a comment", () => {
		const scanned = scan(
			`<office:document-content ${ODP_NS}><office:body><office:presentation><draw:page draw:name="a"><!-- </draw:page> --><draw:page-thumbnail/></draw:page-x></draw:page><draw:page draw:name="b"/></office:presentation></office:body></office:document-content>`
		)

		expect(scanned.pages.length).toBe(2)
		expect(
			new TextDecoder()
				.decode(scanned.bytes.subarray(scanned.pages[0]?.start, scanned.pages[0]?.end))
				.endsWith("</draw:page-x></draw:page>")
		).toBe(true)
	})

	it("finds a page whose drawing namespace is declared on the page itself", () => {
		const scanned = scan(
			`<?xml version="1.0"?><office:document-content xmlns:office="${OFFICE}"><office:body><office:presentation><d:page xmlns:d="${DRAWING}" d:name="p1"/></office:presentation></office:body></office:document-content>`
		)

		expect(scanned.pages.length).toBe(1)
	})

	it("finds pages whose drawing namespace is declared on an ancestor, and parses them alone", () => {
		const scanned = scan(
			`<office:document-content xmlns:office="${OFFICE}"><office:body><office:presentation xmlns:d="${DRAWING}" xmlns="${DRAWING}"><d:page d:name="p1"><d:frame/></d:page><page d:name="p2"/></office:presentation></office:body></office:document-content>`
		)
		const [first, second] = scanned.pages

		expect(scanned.pages.length).toBe(2)

		if (first === undefined || second === undefined) throw new Error("pages")

		const fragment = pageFragment(scanned, first)
		const pageNode = fragment.firstChildElement(fragment.documentElement())

		expect(fragment.name(pageNode)).toBe("d:page")
		expect(fragment.attributes(pageNode).map(attribute => attribute.name)).toEqual(["d:name", "xmlns:d", "xmlns"])
		const head = pageHead(scanned, second)

		expect("head" in second).toBe(false)
		expect(head.attributes(head.firstChildElement(head.documentElement())).map(a => a.name)).toEqual(["d:name", "xmlns:d", "xmlns"])
	})

	it("ignores an element named page in another namespace", () => {
		const scanned = scan(
			`<office:document-content xmlns:office="${OFFICE}" xmlns:draw="${DRAWING}"><office:body><office:presentation><x:page xmlns:x="urn:other"/><draw:page draw:name="p"/></office:presentation></office:body></office:document-content>`
		)

		expect(scanned.pages.length).toBe(1)
	})

	it("opens a deck whose pages bind the drawing namespace themselves", async () => {
		const opened = await openOdpFixture({
			body: `<d:page xmlns:d="${DRAWING}" d:name="p1" d:master-page-name="M">${frame("<text:p>hello</text:p>").replaceAll("draw:", "d:")}</d:page>`
		})
		const slide = await slideOf(opened, 0)

		expect(opened.deck.slides.length).toBe(1)
		expect(plainText(slide.shapes.find(shape => plainText(shape) === "hello"))).toBe("hello")
	})
})

describe("odp text nesting", () => {
	async function readBody(inner: string): Promise<string> {
		const opened = await openOdpFixture({ body: page(frame(inner)) })

		try {
			return plainText((await slideOf(opened, 0)).shapes[0])
		} catch (error) {
			if (error instanceof PresentationError) return `refused ${error.reason}`

			throw error
		}
	}

	it("refuses spans nested past the limit instead of dropping their text", async () => {
		expect(await readBody(`<text:p>a${"<text:span>".repeat(100)}deep${"</text:span>".repeat(100)}</text:p>`)).toBe("refused tooDeep")
	})

	it("reads spans nested up to the limit", async () => {
		expect(await readBody(`<text:p>a${"<text:span>".repeat(60)}deep${"</text:span>".repeat(60)}</text:p>`)).toBe("adeep")
	})

	it("refuses lists nested past the limit instead of dropping their items", async () => {
		const open = "<text:list><text:list-item><text:p>x</text:p>".repeat(40)
		const close = "</text:list-item></text:list>".repeat(40)

		expect(await readBody(open + close)).toBe("refused tooDeep")
	})
})

describe("odp font-independent line spacing", () => {
	const OFF = '<style:paragraph-properties style:font-independent-line-spacing="false"/>'

	async function lineRule(fixture: { styles?: string; automatic?: string; text: string; shape?: string }): Promise<{
		level: boolean | undefined
		paragraph: boolean | undefined
	}> {
		const opened = await openOdpFixture({
			...(fixture.styles === undefined ? {} : { styles: fixture.styles }),
			...(fixture.automatic === undefined ? {} : { automatic: fixture.automatic }),
			body: page(fixture.shape ?? frame(fixture.text))
		})
		const body = (await slideOf(opened, 0)).shapes[0]?.text

		return {
			level: body?.lstStyle?.levels[0]?.fontIndependentLineSpacing,
			paragraph: body?.paragraphs[0]?.pPr.fontIndependentLineSpacing
		}
	}

	it("takes the rule off from the graphic default style", async () => {
		expect(
			await lineRule({
				styles: `<style:default-style style:family="graphic">${OFF}</style:default-style>`,
				text: "<text:p>x</text:p>"
			})
		).toEqual({ level: false, paragraph: undefined })
	})

	it("takes the rule off from the presentation default style for a presentation object", async () => {
		const shape =
			'<draw:frame presentation:class="title" presentation:style-name="pr1" svg:x="1cm" svg:y="1cm" svg:width="2cm" svg:height="2cm"><draw:text-box><text:p>x</text:p></draw:text-box></draw:frame>'

		expect(
			await lineRule({
				styles: `<style:default-style style:family="presentation">${OFF}</style:default-style>`,
				automatic: '<style:style style:name="pr1" style:family="presentation"/>',
				text: "",
				shape
			})
		).toEqual({ level: false, paragraph: undefined })
	})

	it("keeps the font-independent rule only where the shape's chain says so; absent, it is the face's", async () => {
		expect(await lineRule({ text: "<text:p>x</text:p>" })).toEqual({ level: false, paragraph: undefined })
		expect(
			await lineRule({
				styles: '<style:default-style style:family="graphic"><style:paragraph-properties style:font-independent-line-spacing="true"/></style:default-style>',
				text: "<text:p>x</text:p>"
			})
		).toEqual({ level: undefined, paragraph: undefined })
	})

	// LibreOffice 7.5 lays a shape's text out by its own style chain's rule alone (measured): a paragraph style's says
	// nothing either way.
	it("takes no rule from a paragraph style", async () => {
		expect(
			await lineRule({
				automatic: `<style:style style:name="P1" style:family="paragraph">${OFF}</style:style>`,
				styles: '<style:default-style style:family="graphic"><style:paragraph-properties style:font-independent-line-spacing="true"/></style:default-style>',
				text: '<text:p text:style-name="P1">x</text:p>'
			})
		).toEqual({ level: undefined, paragraph: undefined })
		expect(
			await lineRule({
				styles: `<style:default-style style:family="graphic">${OFF}</style:default-style>`,
				automatic:
					'<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties style:font-independent-line-spacing="true"/></style:style>',
				text: '<text:p text:style-name="P1">x</text:p>'
			})
		).toEqual({ level: false, paragraph: undefined })
	})
})

// A chart object (§11.1) holding `plot` in its plot area and `rows` in its own table.
function chartDeck(plot: string, rows: string): Uint8Array {
	const chart = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:chart><chart:chart chart:class="chart:bar"><chart:plot-area>${plot}</chart:plot-area><table:table table:name="local-table"><table:table-rows>${rows}</table:table-rows></table:table></chart:chart></office:chart></office:body></office:document-content>`

	return odpBytes({
		extra: [{ name: "Object 1/content.xml", data: encodeUtf8(chart), mediaType: "text/xml" }],
		manifestEntries:
			'<manifest:file-entry manifest:full-path="Object 1/" manifest:media-type="application/vnd.oasis.opendocument.chart"/>',
		body: page('<draw:frame svg:width="8cm" svg:height="6cm"><draw:object xlink:href="./Object 1"/></draw:frame>')
	})
}

describe("odp chart object bounds", () => {
	async function frameOf(bytes: Uint8Array): Promise<{ readonly kind: string | undefined; readonly ms: number }> {
		const opened = await openOdp(bytesSource(bytes))

		if (opened.kind !== "opened") throw new Error(opened.reason)

		const start = cpuMs()
		const slide = await slideOf(opened, 0)

		return { kind: slide.shapes[0]?.frame?.kind, ms: cpuMs() - start }
	}

	it("shows the replacement picture for a chart of more series than a table holds", async () => {
		const series = '<chart:series chart:values-cell-range-address="local-table.$A$1:.$A$10000"/>'.repeat(100_000)
		const read = await frameOf(chartDeck(series, '<table:table-row><table:table-cell office:value="1"/></table:table-row>'))

		expect(read.kind).toBe("ole")
		expect(read.ms).toBeLessThan(budget(2000))
	}, 60_000)

	it("shows the replacement picture for a table of more cells than a chart reads", async () => {
		const rows = '<table:table-row><table:table-cell table:number-columns-repeated="1000" office:value="1"/></table:table-row>'.repeat(
			10_000
		)
		const read = await frameOf(chartDeck('<chart:series chart:values-cell-range-address="local-table.$A$1:.$A$3"/>', rows))

		expect(read.kind).toBe("ole")
		expect(read.ms).toBeLessThan(budget(2000))
	}, 60_000)

	it("shows the replacement picture for series whose rows and columns lay out more cells than a table holds", async () => {
		const series = '<chart:series chart:values-cell-range-address="local-table.$A$1:.$A$10000"/>'.repeat(200)
		const read = await frameOf(chartDeck(series, '<table:table-row><table:table-cell office:value="1"/></table:table-row>'))

		expect(read.kind).toBe("ole")
	}, 60_000)

	it("shows the replacement picture for a series name joined from a long repeated cell", async () => {
		const rows = `<table:table-row><table:table-cell table:number-columns-repeated="1000"><text:p>${"x".repeat(700_000)}</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell office:value="1"/></table:table-row>`
		const read = await frameOf(
			chartDeck(
				'<chart:series chart:label-cell-address="local-table.$A$1:.$ALL$1" chart:values-cell-range-address="local-table.$A$2:.$A$2"/>',
				rows
			)
		)

		expect(read.kind).toBe("ole")
		expect(read.ms).toBeLessThan(budget(2000))
	}, 60_000)

	it("shows the replacement picture for categories taken from long repeated cells", async () => {
		const text = `<table:table-row><table:table-cell table:number-columns-repeated="1000"><text:p>${"x".repeat(20_000)}</text:p></table:table-cell></table:table-row>`
		const rows = `${text.repeat(10)}<table:table-row><table:table-cell office:value="1"/></table:table-row>`
		const read = await frameOf(
			chartDeck(
				'<chart:axis chart:dimension="x"><chart:categories table:cell-range-address="local-table.$A$1:.$ALL$10"/></chart:axis><chart:series chart:values-cell-range-address="local-table.$A$11:.$A$11"/>',
				rows
			)
		)

		expect(read.kind).toBe("ole")
		expect(read.ms).toBeLessThan(budget(2000))
	}, 60_000)

	it("reads a row number past any grid as the grid's end, not a range of no size", async () => {
		const huge = "9".repeat(400)
		const series = `<chart:series chart:values-cell-range-address="local-table.$A$${huge}:.$A$${huge}"/>`.repeat(MAX_SERIES)
		const read = await frameOf(chartDeck(series, '<table:table-row><table:table-cell office:value="1"/></table:table-row>'))

		expect(read.kind).toBe("chart")
		expect(read.ms).toBeLessThan(budget(2000))
	}, 60_000)

	it("draws a table of exactly the cells the writer lays out at its limit", async () => {
		// chartObject.ts's layout: names in row 1, categories in column A, a column per series; 9,999 points of 99
		// series is (9,999 + 1) * (99 + 1) = MAX_CELLS cells.
		const points = 9_999
		const count = MAX_CELLS / (points + 1) - 1
		const letter = (index: number): string =>
			index < 26
				? String.fromCharCode(65 + index)
				: String.fromCharCode(64 + Math.floor(index / 26)) + String.fromCharCode(65 + (index % 26))
		const series = Array.from({ length: count }, (_, index) => {
			const col = letter(index + 1)

			return `<chart:series chart:label-cell-address="local-table.$${col}$1" chart:values-cell-range-address="local-table.$${col}$2:.$${col}$${points + 1}"/>`
		}).join("")
		const header = `<table:table-row><table:table-cell/><table:table-cell table:number-columns-repeated="${count}"><text:p>s</text:p></table:table-cell></table:table-row>`
		const row = `<table:table-row><table:table-cell><text:p>c</text:p></table:table-cell><table:table-cell table:number-columns-repeated="${count}" office:value-type="float" office:value="1"/></table:table-row>`
		const read = await frameOf(
			chartDeck(
				`<chart:axis chart:dimension="x"><chart:categories table:cell-range-address="local-table.$A$2:.$A$${points + 1}"/></chart:axis>${series}`,
				header + row.repeat(points)
			)
		)

		expect(read.kind).toBe("chart")
	}, 120_000)

	it("still draws a chart within the bounds", async () => {
		const read = await frameOf(
			chartDeck(
				'<chart:series chart:values-cell-range-address="local-table.$A$1:.$A$2"/>',
				'<table:table-row><table:table-cell office:value-type="float" office:value="1"/></table:table-row><table:table-row><table:table-cell office:value-type="float" office:value="2"/></table:table-row>'
			)
		)

		expect(read.kind).toBe("chart")
	})
})

describe("odp lookups by names from the file", () => {
	it('reads presentation:class="constructor" as no placeholder', async () => {
		const opened = await openOdpFixture({
			body: page(
				'<draw:frame presentation:class="constructor" svg:x="1cm" svg:y="1cm" svg:width="2cm" svg:height="2cm"><draw:text-box><text:p>x</text:p></draw:text-box></draw:frame>'
			)
		})
		const shape = (await slideOf(opened, 0)).shapes[0]

		expect(shape?.ph).toBeUndefined()
		expect(plainText(shape)).toBe("x")
	})

	it("gives a picture named a.constructor the type its bytes say", async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(300).fill(0)])
		const opened = await openOdpFixture({
			extra: [{ name: "Pictures/a.constructor", data: png }],
			body: page('<draw:frame svg:width="2cm" svg:height="2cm"><draw:image xlink:href="Pictures/a.constructor"/></draw:frame>')
		})
		const slide = await slideOf(opened, 0)

		expect(slide.shapes.length).toBe(1)
		expect(opened.parts.contentTypes.typeOf("Pictures/a.constructor")).toBe("image/png")
		expect(opened.parts.contentTypes.typeOf("Pictures/b.toString")).toBeUndefined()
	})

	it('reads fo:text-align="__proto__" as the default alignment', async () => {
		const opened = await openOdpFixture({
			automatic:
				'<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="__proto__"/></style:style>',
			body: page(frame('<text:p text:style-name="P1">x</text:p>'))
		})
		const paragraph = (await slideOf(opened, 0)).shapes[0]?.text?.paragraphs[0]

		expect(paragraph?.pPr.algn).toBeUndefined()
	})
})
