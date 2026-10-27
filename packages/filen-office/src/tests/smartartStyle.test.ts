import { describe, expect, it } from "vitest"
import { DiagramStyles, drawingMarkup, pickColor } from "../core/smartart/style"
import { drawingReader } from "../core/drawingml/reader"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { A, DGM } from "./smartartFixtures"

// Shape styles from a diagram's style and colour definitions (ECMA-376 §21.4.4, §21.4.5), on definitions written
// for these tests.

function doc(markup: string): ReturnType<typeof parseXml> {
	return parseXml(encodeUtf8(markup))
}

const COLORS = doc(`<dgm:colorsDef xmlns:dgm="${DGM}" xmlns:x="${A}" uniqueId="c">
	<dgm:styleLbl name="node1">
		<dgm:fillClrLst meth="repeat"><x:schemeClr val="accent2"/><x:schemeClr val="accent3"><x:lumMod val="75000"/></x:schemeClr></dgm:fillClrLst>
		<dgm:linClrLst meth="repeat"><x:schemeClr val="lt1"/></dgm:linClrLst>
		<dgm:txFillClrLst meth="repeat"><x:schemeClr val="lt1"/></dgm:txFillClrLst>
	</dgm:styleLbl>
	<dgm:styleLbl name="revTx"><dgm:fillClrLst meth="repeat"/><dgm:linClrLst/><dgm:txFillClrLst><x:schemeClr val="tx1"/></dgm:txFillClrLst></dgm:styleLbl>
</dgm:colorsDef>`)

const STYLE = doc(`<dgm:styleDef xmlns:dgm="${DGM}" xmlns:a="${A}" uniqueId="s">
	<dgm:styleLbl name="node1"><dgm:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></dgm:scene3d>
	<dgm:style><a:lnRef idx="2"/><a:fillRef idx="1"/><a:effectRef idx="3"/><a:fontRef idx="major"/></dgm:style></dgm:styleLbl>
</dgm:styleDef>`)

describe("SmartArt colour lists", () => {
	it("picks repeat, cycle and span entries for a shape's place among its label's shapes", () => {
		expect([0, 1, 2, 3, 4].map(i => pickColor("repeat", i, 5, 3))).toEqual([0, 1, 2, 0, 1])
		expect([0, 1, 2, 3, 4, 5].map(i => pickColor("cycle", i, 6, 3))).toEqual([0, 1, 2, 1, 0, 1])
		expect([0, 1, 2, 3, 4].map(i => pickColor("span", i, 5, 3))).toEqual([0, 1, 1, 2, 2])
		expect(pickColor(undefined, 0, 1, 4)).toBe(0)
	})

	it("writes a colour again with the a: prefix whatever prefix the definition binds", () => {
		const reader = drawingReader(COLORS)
		const node = COLORS.documentElement()
		let found = -1

		for (let n = 0; n < COLORS.count; n++) if (COLORS.localName(n) === "schemeClr" && reader.attr(n, "val") === "accent3") found = n

		expect(node).toBeGreaterThanOrEqual(0)
		expect(drawingMarkup(reader, found)).toBe('<a:schemeClr val="accent3"><a:lumMod val="75000"/></a:schemeClr>')
	})
})

describe("SmartArt shape styles", () => {
	const styles = new DiagramStyles(STYLE, COLORS)

	it("takes the style definition's fontRef colour for text when the colour definition lists none", () => {
		const style = doc(`<dgm:styleDef xmlns:dgm="${DGM}" xmlns:a="${A}" uniqueId="s"><dgm:styleLbl name="node1">
			<dgm:style><a:lnRef idx="2"/><a:fillRef idx="1"/><a:effectRef idx="0"/><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dgm:style></dgm:styleLbl></dgm:styleDef>`)
		const colors = doc(`<dgm:colorsDef xmlns:dgm="${DGM}" xmlns:a="${A}" uniqueId="c"><dgm:styleLbl name="node1">
			<dgm:fillClrLst meth="repeat"><a:schemeClr val="accent1"/></dgm:fillClrLst><dgm:txFillClrLst/></dgm:styleLbl></dgm:colorsDef>`)

		expect(new DiagramStyles(style, colors).shape("node1", 0, 1).text).toBe('<a:schemeClr val="lt1"/>')
	})

	it("gives each shape of a label its fill, line and text colour and the label's theme references", () => {
		const first = styles.shape("node1", 0, 3)
		const second = styles.shape("node1", 1, 3)

		expect(first.fill).toBe('<a:solidFill><a:schemeClr val="accent2"/></a:solidFill>')
		expect(second.fill).toBe('<a:solidFill><a:schemeClr val="accent3"><a:lumMod val="75000"/></a:schemeClr></a:solidFill>')
		expect(first.line).toBe('<a:solidFill><a:schemeClr val="lt1"/></a:solidFill>')
		expect(first.text).toBe('<a:schemeClr val="lt1"/>')
		expect([first.lnRef, first.fillRef, first.effectRef, first.fontRef]).toEqual(["2", "1", "3", "major"])
		expect(first.scene3d).toBe('<a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d>')
	})

	it("draws no fill or line where the label's list is written empty, and nothing is invented for an unknown label", () => {
		const text = styles.shape("revTx", 0, 1)
		const unknown = styles.shape("nowhere", 0, 1)

		expect(text.fill).toBe("<a:noFill/>")
		expect(text.line).toBe("<a:noFill/>")
		expect(text.text).toBe('<a:schemeClr val="tx1"/>')
		expect(unknown.fill).toBeUndefined()
		expect(unknown.line).toBeUndefined()
		expect([unknown.lnRef, unknown.fillRef, unknown.effectRef, unknown.fontRef]).toEqual(["2", "1", "0", "minor"])
	})

	it("styles from the defaults alone when the diagram has no definitions", () => {
		const bare = new DiagramStyles(undefined, undefined).shape("node1", 0, 1)

		expect(bare.fill).toBeUndefined()
		expect(bare.fontRef).toBe("minor")
	})
})
