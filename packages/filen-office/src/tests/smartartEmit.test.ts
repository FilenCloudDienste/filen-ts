import { describe, expect, it } from "vitest"
import { DrawingList, ItemKind } from "../core/drawingml/displayList"
import { drawingTheme } from "../core/drawingml/color"
import { D, drawingReader } from "../core/drawingml/reader"
import { convertSmartArt } from "../core/drawingml/smartart"
import { emitDiagram } from "../core/smartart/emit"
import { layoutDiagram } from "../core/smartart/interp"
import { encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { A, DGM, MM, data, definition, layout, measurer, model } from "./smartartFixtures"

// A laid-out diagram written as the drawing PowerPoint caches (MS-ODRAWXML dsp:drawing) and as model shapes.

const COLORS = parseXml(
	encodeUtf8(`<dgm:colorsDef xmlns:dgm="${DGM}" xmlns:a="${A}" uniqueId="c"><dgm:styleLbl name="node1">
	<dgm:fillClrLst meth="repeat"><a:schemeClr val="accent1"/><a:schemeClr val="accent2"/></dgm:fillClrLst>
	<dgm:linClrLst meth="repeat"><a:schemeClr val="lt1"/></dgm:linClrLst><dgm:txFillClrLst meth="repeat"><a:schemeClr val="lt1"/></dgm:txFillClrLst>
	</dgm:styleLbl></dgm:colorsDef>`)
)

const ROW =
	layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="box" val="40"/><dgm:constr type="h" for="ch" forName="box" val="20"/>
	<dgm:constr type="primFontSz" for="ch" forName="box" val="20"/></dgm:constrLst>
	<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="box" styleLbl="node1"><dgm:alg type="tx"><dgm:param type="txAnchorVert" val="t"/></dgm:alg>
	<dgm:shape type="roundRect"><dgm:adjLst><dgm:adj idx="1" val="0.1"/></dgm:adjLst></dgm:shape><dgm:presOf axis="self"/>
	<dgm:constrLst><dgm:constr type="lMarg" refType="primFontSz" fact="0.3"/><dgm:constr type="tMarg" val="2"/></dgm:constrLst></dgm:layoutNode></dgm:forEach>`)

const NODES = [
	{ id: "a", text: "Alpha" },
	{ id: "b", text: "Beta" }
]

function emitted(
	dataXml: string,
	layoutXml: string,
	w: number,
	h: number
): { xml: string; document: XmlDocument; shapes: ReturnType<typeof emitDiagram>["shapes"] } {
	const laid = layoutDiagram(model(dataXml), definition(layoutXml), undefined, COLORS, { x: 0, y: 0, w, h }, measurer)
	const dataDocument = parseXml(encodeUtf8(dataXml))
	const reader = drawingReader(dataDocument)
	const ts = new Map<string, number>()

	for (const pt of reader.children(reader.child(dataDocument.documentElement(), D.Dgm, "ptLst"), D.Dgm, "pt")) {
		const t = reader.child(pt, D.Dgm, "t")

		if (t >= 0) ts.set(reader.attr(pt, "modelId") ?? "", t)
	}

	const out = emitDiagram(laid, {
		text: point => {
			const node = ts.get(point.id)

			return node === undefined ? undefined : { reader, node }
		}
	})

	return { xml: out.drawingXml, document: parseXml(encodeUtf8(out.drawingXml)), shapes: out.shapes }
}

describe("SmartArt drawing", () => {
	it("writes one dsp:sp per shape with its box, preset geometry and adjustments, and the colour definition's colours", () => {
		const { document, xml } = emitted(data(NODES), ROW, 80 * MM, 20 * MM)
		const reader = drawingReader(document)
		const tree = reader.child(document.documentElement(), D.Dsp, "spTree")
		const shapes = reader.children(tree, D.Dsp, "sp")

		expect(reader.is(document.documentElement(), D.Dsp, "drawing")).toBe(true)
		expect(shapes).toHaveLength(2)
		expect(xml).toContain('<a:off x="1440000" y="0"/><a:ext cx="1440000" cy="720000"/>')
		expect(xml).toContain('<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 10000"/></a:avLst></a:prstGeom>')
		expect(xml).toContain(
			'<a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln>'
		)
		expect(xml).toContain('<a:solidFill><a:schemeClr val="accent2"/></a:solidFill>')
		// The text colour rides on fontRef, as PowerPoint caches it and as the slide text reads it.
		expect(xml).toContain('<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef>')
	})

	it("writes the points' own text at the size layout gave it, inside the margins its constraints give", () => {
		const { xml } = emitted(data(NODES), ROW, 80 * MM, 20 * MM)

		expect(xml).toContain('<a:r><a:rPr lang="en-US" sz="2000"/><a:t>Alpha</a:t></a:r>')
		// lMarg is 0.3 × 20 pt; tMarg 2 pt.
		expect(xml).toContain('lIns="76200" tIns="25400"')
		expect(xml).toContain('anchor="t"')
	})

	it("writes PowerPoint's paragraph spacing where the data sets none, and keeps the data's own", () => {
		const tree =
			layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="box" val="60"/><dgm:constr type="h" for="ch" forName="box" val="40"/>
			<dgm:constr type="primFontSz" for="ch" forName="box" val="24"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node" cnt="1"><dgm:layoutNode name="box" styleLbl="node1"><dgm:varLst><dgm:bulletEnabled val="1"/></dgm:varLst><dgm:alg type="tx"/>
			<dgm:shape type="rect"/><dgm:presOf axis="desOrSelf" ptType="node"/></dgm:layoutNode></dgm:forEach>`)
		const nodes = [
			{ id: "a", text: "Alpha" },
			{ id: "b", parent: "a", text: "Beta" }
		]
		const { xml } = emitted(data(nodes), tree, 80 * MM, 40 * MM)
		const spacing = (after: number): string =>
			`<a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:spcAft><a:spcPct val="${String(after)}"/></a:spcAft>`

		expect(xml).toContain(`algn="ctr">${spacing(35000)}<a:buNone/>`)
		// The child's bullet hangs 0.75 of its 24 pt size.
		expect(xml).toContain(`marL="228600" lvl="1" indent="-228600" algn="l">${spacing(15000)}<a:buChar`)

		const own = data(nodes).replace(
			"<a:p><a:r><a:t>Alpha",
			'<a:p><a:pPr><a:lnSpc><a:spcPct val="100000"/></a:lnSpc></a:pPr><a:r><a:t>Alpha'
		)
		const kept = emitted(own, tree, 80 * MM, 40 * MM).xml

		expect(kept).toContain(
			'<a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:spcAft><a:spcPct val="35000"/></a:spcAft>'
		)
	})

	it("levels a shape's text from its own point: a node presenting its children bullets them from the first", () => {
		const tree =
			layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="box" val="60"/><dgm:constr type="h" for="ch" forName="box" val="40"/>
			<dgm:constr type="primFontSz" for="ch" forName="box" val="24"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node" cnt="1"><dgm:layoutNode name="box" styleLbl="node1"><dgm:varLst><dgm:bulletEnabled val="1"/></dgm:varLst>
			<dgm:alg type="tx"><dgm:param type="stBulletLvl" val="1"/></dgm:alg><dgm:shape type="rect"/><dgm:presOf axis="des" ptType="node"/></dgm:layoutNode></dgm:forEach>`)
		const nodes = [
			{ id: "a", text: "Parent" },
			{ id: "b", parent: "a", text: "First" },
			{ id: "c", parent: "a", text: "Second" }
		]
		const { xml } = emitted(data(nodes), tree, 80 * MM, 40 * MM)

		expect(xml.match(/lvl="1"[^>]*algn="l">[^]*?<a:buChar char="•"\/>/gu)).toHaveLength(2)
		expect(xml).not.toContain('lvl="0"')
	})

	it("writes a presentation point's own fill (a picture in its placeholder) over the style's", () => {
		const dataXml = data(NODES, [{ id: "pa", type: "pres", prSet: 'presName="box" presAssocID="a"' }])
		const laid = layoutDiagram(model(dataXml), definition(ROW), undefined, COLORS, { x: 0, y: 0, w: 80 * MM, h: 20 * MM }, measurer)
		const props = parseXml(
			encodeUtf8(
				`<dgm:spPr xmlns:dgm="${DGM}" xmlns:a="${A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></dgm:spPr>`
			)
		)
		const reader = drawingReader(props)
		const xml = emitDiagram(laid, {
			shapeProps: point => (point.id === "pa" ? { reader, node: props.documentElement() } : undefined)
		}).drawingXml

		expect(xml).toContain('<dsp:sp modelId="pa">')
		expect(xml).toContain('<a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>')
		expect(xml.match(/<a:blipFill>/gu)).toHaveLength(1)
		expect(() => parseXml(encodeUtf8(xml))).not.toThrow()
	})

	it("keeps the runs' own sizes where the user set the text size", () => {
		const nodes = [{ id: "a", prSet: 'custT="1"', text: "Alpha" }]
		const custom = data(nodes).replace("<a:r><a:t>Alpha</a:t></a:r>", '<a:r><a:rPr sz="1100"/><a:t>Alpha</a:t></a:r>')
		const { xml } = emitted(custom, ROW, 80 * MM, 20 * MM)

		expect(xml).toContain('<a:rPr sz="1100"/>')
		expect(xml).not.toContain('sz="2000"')
	})

	it("keeps the child runs' own sizes too where the user set the text size and a secondary size is given", () => {
		const tree =
			layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="box" val="60"/><dgm:constr type="h" for="ch" forName="box" val="40"/>
			<dgm:constr type="primFontSz" for="ch" forName="box" val="65"/><dgm:constr type="secFontSz" for="ch" forName="box" val="65"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node" cnt="1"><dgm:layoutNode name="box" styleLbl="node1"><dgm:alg type="tx"/><dgm:shape type="rect"/>
			<dgm:presOf axis="des" ptType="node"/></dgm:layoutNode></dgm:forEach>`)
		const nodes = [
			{ id: "a", text: "Parent" },
			{ id: "b", parent: "a", prSet: 'custT="1"', text: "Child" }
		]
		const custom = data(nodes).replace("<a:r><a:t>Child</a:t></a:r>", '<a:r><a:rPr sz="1600"/><a:t>Child</a:t></a:r>')
		const { xml } = emitted(custom, tree, 80 * MM, 40 * MM)

		expect(xml).toContain('<a:rPr sz="1600"/>')
		expect(xml).not.toContain('sz="6500"')
	})

	it("draws as a shape tree the slide renderer converts, one path per shape", () => {
		const { document } = emitted(data(NODES), ROW, 80 * MM, 20 * MM)
		const list = new DrawingList()

		list.width = (80 * MM) / 9525
		list.height = (20 * MM) / 9525

		const conversion = convertSmartArt(
			{ list, theme: drawingTheme(undefined, () => undefined), images: () => undefined, effects: false },
			document,
			80 * MM,
			20 * MM
		)
		let paths = 0

		for (let i = 0; i < list.itemCount; i++) if (list.kind(i) === ItemKind.PATH) paths++

		expect(conversion?.unsupported).toBe(0)
		expect(paths).toBeGreaterThanOrEqual(2)
	})

	it("puts a hidden-geometry text node's text on the geometry of the same point, its box the text box", () => {
		const xml =
			layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="cell" val="40"/><dgm:constr type="h" for="ch" forName="cell" val="20"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="cell"><dgm:alg type="composite"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="plate" refType="w"/><dgm:constr type="h" for="ch" forName="plate" refType="h"/>
			<dgm:constr type="w" for="ch" forName="label" refType="w" fact="0.5"/><dgm:constr type="h" for="ch" forName="label" refType="h"/>
			<dgm:constr type="ctrX" for="ch" forName="label" refType="w" fact="0.5"/></dgm:constrLst>
			<dgm:layoutNode name="plate" styleLbl="node1"><dgm:shape type="trapezoid"/><dgm:presOf/></dgm:layoutNode>
			<dgm:layoutNode name="label"><dgm:alg type="tx"/><dgm:shape type="rect" hideGeom="1"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:layoutNode></dgm:forEach>`)
		const { document, shapes } = emitted(data([{ id: "a", text: "Alpha" }]), xml, 40 * MM, 20 * MM)
		const reader = drawingReader(document)
		const sps = reader.children(reader.child(document.documentElement(), D.Dsp, "spTree"), D.Dsp, "sp")
		const sp = sps[0] ?? -1
		const txXfrm = reader.child(sp, D.Dsp, "txXfrm")

		expect(sps).toHaveLength(1)
		expect(reader.attr(reader.child(reader.child(sp, D.Dsp, "spPr"), D.A, "prstGeom"), "prst")).toBe("trapezoid")
		expect(reader.attr(reader.child(txXfrm, D.A, "off"), "x")).toBe(String(10 * MM))
		expect(reader.attr(reader.child(txXfrm, D.A, "ext"), "cx")).toBe(String(20 * MM))
		expect(shapes[0]?.text?.paragraphs[0]?.runs[0]).toMatchObject({ kind: "r", text: "Alpha" })
	})

	it("keeps a turned shape's upright text in its geometry's text rectangle, turned into place with the shape", () => {
		// An up-arrow callout turned half way round (Process 4's down arrows): its text box is the callout's box part,
		// which the turn takes from the bottom to the top.
		const xml =
			layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="box" val="40"/><dgm:constr type="h" for="ch" forName="box" val="20"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="box" styleLbl="node1"><dgm:alg type="tx"/><dgm:shape type="upArrowCallout" rot="180"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach>`)
		const { document } = emitted(data([{ id: "a", text: "Alpha" }]), xml, 40 * MM, 20 * MM)
		const reader = drawingReader(document)
		const sp = reader.children(reader.child(document.documentElement(), D.Dsp, "spTree"), D.Dsp, "sp")[0] ?? -1
		const txXfrm = reader.child(sp, D.Dsp, "txXfrm")
		const top = Number(reader.attr(reader.child(txXfrm, D.A, "off"), "y"))
		const height = Number(reader.attr(reader.child(txXfrm, D.A, "ext"), "cy"))

		expect(reader.attr(txXfrm, "rot")).toBe("-10800000")
		expect(top).toBe(0)
		expect(height).toBeGreaterThan(5 * MM)
		expect(height).toBeLessThan(20 * MM)
		expect(reader.attr(reader.child(txXfrm, D.A, "ext"), "cx")).toBe(String(40 * MM))
	})

	it("writes a one-dimensional connector as its route, unfilled, with its arrowhead", () => {
		const xml = layout(`<dgm:alg type="lin"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="box" val="40"/><dgm:constr type="h" for="ch" forName="box" val="20"/><dgm:constr type="w" for="ch" forName="link" val="20"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode>
			<dgm:forEach axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="link"><dgm:alg type="conn"><dgm:param type="dim" val="1D"/></dgm:alg>
			<dgm:shape type="conn"/></dgm:layoutNode></dgm:forEach></dgm:forEach>`)
		const out = emitted(data(NODES), xml, 100 * MM, 20 * MM).xml

		expect(out).toContain(
			'<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="0" b="0"/><a:pathLst><a:path w="720000" h="91440" fill="none">'
		)
		expect(out).toContain('<a:noFill/><a:ln><a:tailEnd type="arrow"/></a:ln>')
	})

	it("gives the model a shape per drawn shape with its box, preset, fill and text", () => {
		const { shapes } = emitted(data(NODES), ROW, 80 * MM, 20 * MM)

		expect(shapes.map(shape => [shape.kind, shape.xfrm?.x, shape.xfrm?.cx])).toEqual([
			["sp", 0, 40 * MM],
			["sp", 40 * MM, 40 * MM]
		])
		expect(shapes[0]?.props?.geometry).toEqual({ kind: "preset", preset: "roundRect", guides: [{ name: "adj", formula: "val 10000" }] })
		expect(shapes[1]?.props?.fill).toEqual({ kind: "solid", color: { kind: "scheme", slot: "accent2" } })
		expect(shapes[1]?.text?.paragraphs[0]?.runs[0]).toMatchObject({ kind: "r", text: "Beta", rPr: { sz: 2000 } })
	})
})
