import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/io"
import { openOdp } from "../core/odp/read/document"
import { pageFragment, scanPages } from "../core/odp/read/scan"
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
		expect(second.head.attributes(second.head.firstChildElement(second.head.documentElement())).map(a => a.name)).toEqual([
			"d:name",
			"xmlns:d",
			"xmlns"
		])
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
