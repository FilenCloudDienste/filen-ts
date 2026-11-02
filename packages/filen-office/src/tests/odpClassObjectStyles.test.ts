import { describe, expect, it } from "vitest"
import type { ShapeNode } from "../core/presentation/model"
import { openOdpFixture, slideOf } from "./odpFixtures"

// Presentation objects of a deck whose masters write no class styles, read as LibreOffice 7.5 draws them (its pixels,
// sampled inside and on the edge of each box): an object naming no presentation style takes the standard graphic
// style's fill and line; one whose presentation style has no parent takes the fill its chain gives and no line.

const STANDARD =
	'<style:default-style style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#ff0000" draw:stroke="solid" svg:stroke-color="#0000ff" svg:stroke-width="0.2cm"/></style:default-style>'

const box = (y: number): string => `svg:x="1cm" svg:y="${String(y)}cm" svg:width="8cm" svg:height="4cm"`

const RED = { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } }
const BLUE_LINE = { w: 72_000, fill: { kind: "solid", color: { kind: "srgb", rgb: "0000FF" } } }

async function shapes(): Promise<ShapeNode[]> {
	const opened = await openOdpFixture({
		styles: STANDARD,
		automatic:
			'<style:style style:name="pr1" style:family="presentation"><style:graphic-properties draw:textarea-vertical-align="middle"/></style:style>' +
			'<style:style style:name="pr2" style:family="presentation"><style:graphic-properties draw:fill="solid" draw:fill-color="#00ff00"/></style:style>',
		body:
			'<draw:page draw:name="p1" draw:master-page-name="M">' +
			`<draw:frame draw:name="title" presentation:class="title" ${box(1)}><draw:text-box><text:p>t</text:p></draw:text-box></draw:frame>` +
			`<draw:frame draw:name="outline" presentation:class="outline" ${box(6)}><draw:text-box><text:p>o</text:p></draw:text-box></draw:frame>` +
			`<draw:custom-shape draw:name="shape" presentation:class="title" ${box(11)}><draw:enhanced-geometry draw:type="rectangle"/></draw:custom-shape>` +
			`<draw:frame draw:name="pr1" presentation:class="title" presentation:style-name="pr1" ${box(16)}><draw:text-box><text:p>t</text:p></draw:text-box></draw:frame>` +
			`<draw:frame draw:name="pr2" presentation:class="outline" presentation:style-name="pr2" ${box(21)}><draw:text-box><text:p>o</text:p></draw:text-box></draw:frame>` +
			"</draw:page>"
	})

	return (await slideOf(opened, 0)).shapes
}

describe("presentation objects under masters without class styles", () => {
	it("read with LibreOffice's fill and line", async () => {
		const read = Object.fromEntries((await shapes()).map(shape => [shape.name, { fill: shape.props?.fill, ln: shape.props?.ln }]))

		expect(read["title"]).toMatchObject({ fill: RED, ln: BLUE_LINE })
		expect(read["outline"]).toMatchObject({ fill: RED, ln: BLUE_LINE })
		expect(read["shape"]).toMatchObject({ fill: RED, ln: BLUE_LINE })
		expect(read["pr1"]).toMatchObject({ fill: RED, ln: "none" })
		expect(read["pr2"]).toMatchObject({ fill: { kind: "solid", color: { kind: "srgb", rgb: "00FF00" } }, ln: "none" })
	})
})
