import { describe, expect, it } from "vitest"
import type { ShapeNode } from "../core/presentation/model"
import { openOdpFixture, page, slideOf } from "./odpFixtures"

// style:font-independent-line-spacing (ODF 1.3 Part 3 §20.297) is a paragraph property, valid on any paragraph style,
// but LibreOffice 7.5 lays a shape's text out by the rule of the shape's own style chain alone, the face's ascent and
// descent unless that chain says font-independent (measured, five 24 pt Times lines in a growing frame: 0.936 cm a
// line under a paragraph style saying true over a graphic style saying nothing, 1.2 times the size under a graphic
// style saying true). The reader follows LibreOffice.

const GRAPHIC = (name: string, rule: string) =>
	`<style:style style:name="${name}" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none"/>` +
	`<style:paragraph-properties${rule === "" ? "" : ` style:font-independent-line-spacing="${rule}"`}/></style:style>`

const AUTOMATIC =
	GRAPHIC("Gnone", "") +
	GRAPHIC("Gtrue", "true") +
	GRAPHIC("Gfalse", "false") +
	'<style:style style:name="Ptrue" style:family="paragraph"><style:paragraph-properties style:font-independent-line-spacing="true"/></style:style>' +
	'<style:style style:name="Pfalse" style:family="paragraph"><style:paragraph-properties style:font-independent-line-spacing="false"/></style:style>'

const frame = (name: string, graphic: string, paragraph: string) =>
	`<draw:frame draw:name="${name}" draw:style-name="${graphic}" svg:x="1cm" svg:y="1cm" svg:width="10cm" svg:height="3cm">` +
	`<draw:text-box><text:p text:style-name="${paragraph}">Line</text:p></draw:text-box></draw:frame>`

// The rule a shape's first paragraph is laid out by: its own, else its shape's.
function rule(shapes: readonly ShapeNode[], name: string): boolean {
	const shape = shapes.find(each => each.name === name)
	const own = shape?.text?.paragraphs[0]?.pPr.fontIndependentLineSpacing
	const level = shape?.text?.lstStyle?.levels[0]?.fontIndependentLineSpacing

	return (own ?? level) !== false
}

describe("an ODP shape's line-spacing rule", () => {
	it("is its own style chain's: a paragraph style's is not taken, and none said is the face's", async () => {
		const opened = await openOdpFixture({
			automatic: AUTOMATIC,
			body: page(
				frame("NoneOverTrue", "Gnone", "Ptrue") +
					frame("TrueOverFalse", "Gtrue", "Pfalse") +
					frame("FalseOverTrue", "Gfalse", "Ptrue") +
					frame("TrueOverTrue", "Gtrue", "Ptrue")
			)
		})
		const shapes = (await slideOf(opened, 0)).shapes

		expect(rule(shapes, "NoneOverTrue")).toBe(false)
		expect(rule(shapes, "TrueOverFalse")).toBe(true)
		expect(rule(shapes, "FalseOverTrue")).toBe(false)
		expect(rule(shapes, "TrueOverTrue")).toBe(true)
	})
})
