import { describe, expect, it } from "vitest"
import { Fragment } from "../core/odp/read/context"
import { pageFragment } from "../core/odp/read/scan"
import { Namespaces } from "../core/xml/index"
import { DEFAULT_MASTER, openOdpFixture, page, slideOf } from "./odpFixtures"

// draw:fill-image-width/height given as lengths: the tile drawn at that size, as LibreOffice and PowerPoint draw it,
// its scale the length over the picture's own size (a:tile sx/sy in 1/1,000 %).

// A 100 × 50 px PNG without pHYs: 75 × 37.5 pt at 96 per inch.
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 100, 0, 0, 0, 50, 8, 6, 0, 0, 0
])
const EXTRA = [{ name: "Pictures/a.png", data: PNG, mediaType: "image/png" }]
const RESOURCE =
	'<draw:fill-image draw:name="Marble" xlink:href="Pictures/a.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>'
const PT_PER_CM = 72 / 2.54

function scale(cm: number, points: number): number {
	return Math.round(((cm * PT_PER_CM) / points) * 100_000)
}

function bitmap(width: string, height: string, extra = ""): string {
	return `draw:fill="bitmap" draw:fill-image-name="Marble" style:repeat="repeat" draw:fill-image-width="${width}" draw:fill-image-height="${height}"${extra}`
}

function stylesAutomatic(master: string): string {
	return (
		'<style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm"/></style:page-layout>' +
		`<style:style style:name="Mdp" style:family="drawing-page"><style:drawing-page-properties ${master}/></style:style>`
	)
}

describe("ODP bitmap tiles sized by lengths", () => {
	it("scales a page background's tile by its lengths over the picture's own size", async () => {
		const opened = await openOdpFixture({
			styles: RESOURCE,
			extra: EXTRA,
			automatic: `<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties ${bitmap("0.483cm", "1cm")}/></style:style>`,
			body: page("", 'draw:master-page-name="M" draw:style-name="dp1"')
		})
		const slide = await slideOf(opened, 0)

		expect(slide.background).toEqual({
			kind: "fill",
			fill: {
				kind: "picture",
				part: "/Pictures/a.png",
				tile: { tx: 0, ty: 0, sx: scale(0.483, 75), sy: scale(1, 37.5), flip: "none", algn: "tl" }
			}
		})

		// The writer's synchronous reading of the same page (pageFields) gives the same background: the size is held.
		const span = opened.parts.span(slide.ref)

		if (span === undefined) throw new Error("no span")

		const document = pageFragment(opened.parts.content, span)
		const fragment = new Fragment(document, new Namespaces(document, { lenient: true }), "content.xml", span.start, "content", 0)

		expect(opened.parts.pageFields(fragment, document.firstChildElement(document.documentElement())).background).toEqual(
			slide.background
		)
	})

	it("scales a shape's tile, keeps a percent side as written, and places it by draw:fill-image-ref-point", async () => {
		const opened = await openOdpFixture({
			styles: RESOURCE,
			extra: EXTRA,
			automatic: `<style:style style:name="g1" style:family="graphic"><style:graphic-properties ${bitmap("1cm", "50%", ' draw:fill-image-ref-point="center"')}/></style:style>`,
			body: page('<draw:rect draw:style-name="g1" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="3cm"/>')
		})
		const fill = (await slideOf(opened, 0)).shapes[0]?.props?.fill

		expect(fill).toEqual({
			kind: "picture",
			part: "/Pictures/a.png",
			tile: { tx: 0, ty: 0, sx: scale(1, 75), sy: 50_000, flip: "none", algn: "ctr" }
		})
	})

	it("scales a master background's tile once the deck is open", async () => {
		const opened = await openOdpFixture({
			styles: RESOURCE,
			extra: EXTRA,
			stylesAutomatic: stylesAutomatic(bitmap("0.483cm", "0.483cm")),
			masters: DEFAULT_MASTER,
			body: page("")
		})
		const ref = opened.deck.masters[0]
		const master = ref === undefined ? undefined : opened.deck.nodes.get(ref)

		expect(master?.background).toMatchObject({
			kind: "fill",
			fill: { kind: "picture", tile: { sx: scale(0.483, 75), sy: scale(0.483, 37.5) } }
		})
	})

	it("keeps the picture's own size for 0cm and a percent's scale for a percent", async () => {
		const opened = await openOdpFixture({
			styles: RESOURCE,
			extra: EXTRA,
			automatic:
				`<style:style style:name="g1" style:family="graphic"><style:graphic-properties ${bitmap("0cm", "0cm")}/></style:style>` +
				`<style:style style:name="g2" style:family="graphic"><style:graphic-properties ${bitmap("25%", "200%")}/></style:style>`,
			body: page(
				'<draw:rect draw:style-name="g1" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="3cm"/>' +
					'<draw:rect draw:style-name="g2" svg:x="1cm" svg:y="5cm" svg:width="5cm" svg:height="3cm"/>'
			)
		})
		const [zero, percent] = (await slideOf(opened, 0)).shapes

		expect(zero?.props?.fill).toMatchObject({ tile: { sx: 100_000, sy: 100_000, algn: "tl" } })
		expect(percent?.props?.fill).toMatchObject({ tile: { sx: 25_000, sy: 200_000 } })
	})

	it("keeps 100% when the picture's size cannot be read", async () => {
		const opened = await openOdpFixture({
			styles: RESOURCE,
			extra: [{ name: "Pictures/a.png", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }],
			automatic: `<style:style style:name="g1" style:family="graphic"><style:graphic-properties ${bitmap("1cm", "1cm")}/></style:style>`,
			body: page('<draw:rect draw:style-name="g1" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="3cm"/>')
		})

		expect((await slideOf(opened, 0)).shapes[0]?.props?.fill).toMatchObject({ tile: { sx: 100_000, sy: 100_000 } })
	})
})
