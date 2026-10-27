import { describe, expect, it } from "vitest"
import { DEFAULT_SMARTART_BUDGETS, parseDataModel, SmartArtError } from "../core/smartart/data"
import { layoutDiagram, type Box } from "../core/smartart/interp"
import { parseLayoutDef } from "../core/smartart/layoutDef"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { boxes, data, DGM, layout, measurer, MM, NO_MARGINS, round, run } from "./smartartFixtures"

// The layout interpreter over small layout definitions written for these tests (ECMA-376 §21.4).

const NODES = [
	{ id: "n1", text: "One" },
	{ id: "n2", text: "Two" },
	{ id: "n3", text: "Three" }
]

const ROW_OF_NODES = (constraints: string, alg: string) =>
	layout(`${alg}<dgm:constrLst>${constraints}</dgm:constrLst>
	<dgm:forEach name="each" axis="ch" ptType="node">
		<dgm:layoutNode name="node"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode>
		<dgm:forEach name="gap" axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="gap"><dgm:alg type="sp"/></dgm:layoutNode></dgm:forEach>
	</dgm:forEach>`)

describe("SmartArt data model", () => {
	it("orders each node between its parent and sibling transitions", () => {
		const model = parseDataModel(parseXml(encodeUtf8(data(NODES))))

		expect(model.root.children.map(p => p.id)).toEqual(["n1p", "n1", "n1s", "n2p", "n2", "n2s", "n3p", "n3", "n3s"])
		expect(model.points.get("n2")?.paragraphs).toEqual(["Two"])
		expect(model.points.get("n2")?.depth).toBe(1)
	})

	it("keeps the first parent of a point and never follows a cycle", () => {
		const xml = `<dgm:dataModel xmlns:dgm="${DGM}"><dgm:ptLst><dgm:pt modelId="d" type="doc"/><dgm:pt modelId="a"/><dgm:pt modelId="b"/></dgm:ptLst>
			<dgm:cxnLst><dgm:cxn modelId="1" srcId="d" destId="a" srcOrd="0"/><dgm:cxn modelId="2" srcId="a" destId="b" srcOrd="0"/>
			<dgm:cxn modelId="3" srcId="b" destId="a" srcOrd="0"/><dgm:cxn modelId="4" srcId="d" destId="b" srcOrd="1"/></dgm:cxnLst></dgm:dataModel>`
		const model = parseDataModel(parseXml(encodeUtf8(xml)))

		expect(model.points.get("a")?.parent?.id).toBe("d")
		expect(model.points.get("b")?.parent?.id).toBe("a")
		expect(model.root.children.map(p => p.id)).toEqual(["a"])
	})

	it("refuses more points than the budget allows", () => {
		const xml = data(Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` })))

		expect(() => parseDataModel(parseXml(encodeUtf8(xml)), { ...DEFAULT_SMARTART_BUDGETS, maxPoints: 30 })).toThrow(SmartArtError)
	})

	it("refuses a model without a doc point as malformed", () => {
		const xml = `<dgm:dataModel xmlns:dgm="${DGM}"><dgm:ptLst><dgm:pt modelId="a"/></dgm:ptLst></dgm:dataModel>`

		expect(() => parseDataModel(parseXml(encodeUtf8(xml)))).toThrow(expect.objectContaining({ reason: "malformed" }))
	})
})

describe("SmartArt iteration and conditions", () => {
	it("iterates the child nodes and hides the last sibling transition", () => {
		const result = run(data(NODES), ROW_OF_NODES("", '<dgm:alg type="lin"/>'), 300 * MM, 100 * MM)
		const root = result.root

		expect(root.children.map(c => `${c.name}:${c.point.id}`)).toEqual(["node:n1", "gap:n1s", "node:n2", "gap:n2s", "node:n3"])
		expect(result.shapes.map(s => s.text.map(p => p.id).join())).toEqual(["n1", "n2", "n3"])
	})

	it("takes the else branch when the presentation point overrides dir", () => {
		const xml = layout(`<dgm:varLst><dgm:dir/></dgm:varLst><dgm:choose name="c">
			<dgm:if name="i" func="var" arg="dir" op="equ" val="norm"><dgm:layoutNode name="normal"><dgm:shape type="rect"/></dgm:layoutNode></dgm:if>
			<dgm:else name="e"><dgm:layoutNode name="reversed"><dgm:shape type="rect"/></dgm:layoutNode></dgm:else></dgm:choose>`)

		expect(run(data(NODES), xml, MM, MM).shapes.map(s => s.name)).toEqual(["normal"])

		const overridden = data(NODES, [{ id: "p", prSet: 'presName="root" presAssocID="doc"', vars: '<dgm:dir val="rev"/>' }])

		expect(run(overridden, xml, MM, MM).shapes.map(s => s.name)).toEqual(["reversed"])
	})

	it("chooses by the count of child nodes and by position in an iteration", () => {
		const xml = layout(`<dgm:choose name="c"><dgm:if name="i" axis="ch" ptType="node" func="cnt" op="gte" val="3">
			<dgm:forEach name="f" axis="ch" ptType="node"><dgm:choose name="d">
				<dgm:if name="j" func="posOdd" op="equ" val="1"><dgm:layoutNode name="odd"><dgm:shape type="rect"/></dgm:layoutNode></dgm:if>
				<dgm:else name="k"><dgm:layoutNode name="even"><dgm:shape type="rect"/></dgm:layoutNode></dgm:else></dgm:choose></dgm:forEach>
			</dgm:if></dgm:choose>`)

		expect(run(data(NODES), xml, MM, MM).shapes.map(s => s.name)).toEqual(["odd", "even", "odd"])
		expect(run(data(NODES.slice(0, 2)), xml, MM, MM).shapes).toEqual([])
	})

	it("walks one step per entry of a list-valued iterator", () => {
		const xml = layout(
			'<dgm:layoutNode name="first"><dgm:shape type="rect"/><dgm:presOf axis="ch desOrSelf" ptType="node node" st="2 1" cnt="1 0"/></dgm:layoutNode>'
		)

		expect(run(data(NODES), xml, MM, MM).shapes[0]?.text.map(p => p.id)).toEqual(["n2"])
	})

	it("refuses more layout nodes than the budget allows", () => {
		const model = parseDataModel(parseXml(encodeUtf8(data(NODES))))
		const def = parseLayoutDef(parseXml(encodeUtf8(ROW_OF_NODES("", '<dgm:alg type="lin"/>'))))
		const budgets = { ...DEFAULT_SMARTART_BUDGETS, maxLayoutNodes: 4 }

		expect(() => layoutDiagram(model, def, undefined, undefined, { x: 0, y: 0, w: MM, h: MM }, measurer, { budgets })).toThrow(
			expect.objectContaining({ reason: "tooLarge" })
		)
	})

	it("ignores constraints whose value is unbounded or undefined", () => {
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst><dgm:constr type="t" for="ch" forName="a" val="INF"/>
			<dgm:constr type="l" for="ch" forName="a" refType="w" fact="NaN"/></dgm:constrLst><dgm:layoutNode name="a"><dgm:shape type="rect"/></dgm:layoutNode>`)

		expect(round(boxes(run(data(NODES), xml, 10 * MM, 10 * MM), "a")[0] as Box)).toEqual({ x: 0, y: 0, w: 10 * MM, h: 10 * MM })
	})

	it("refuses forEach nesting deeper than the budget", () => {
		let body = '<dgm:layoutNode name="leaf"/>'

		for (let i = 0; i < 40; i++) body = `<dgm:forEach name="f${i}" axis="self">${body}</dgm:forEach>`

		expect(() => run(data(NODES), layout(body), MM, MM)).toThrow(expect.objectContaining({ reason: "tooDeep" }))
	})
})

describe("SmartArt constraints and algorithms", () => {
	it("places composite children from edges, centres and offsets", () => {
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="a" refType="w" fact="0.5"/><dgm:constr type="h" for="ch" forName="a" refType="h" fact="0.25"/>
			<dgm:constr type="ctrX" for="ch" forName="a" refType="w" fact="0.5"/><dgm:constr type="b" for="ch" forName="a" refType="h"/>
			<dgm:constr type="l" for="ch" forName="b" refType="r" refFor="ch" refForName="a"/><dgm:constr type="r" for="ch" forName="b" refType="w"/>
			<dgm:constr type="rOff" for="ch" forName="b" refType="w" refFor="ch" refForName="a" fact="-0.1"/>
			<dgm:constr type="t" for="ch" forName="b" val="10"/><dgm:constr type="h" for="ch" forName="b" refType="h" refFor="ch" refForName="a"/>
			</dgm:constrLst><dgm:layoutNode name="a"><dgm:shape type="rect"/></dgm:layoutNode><dgm:layoutNode name="b"><dgm:shape type="rect"/></dgm:layoutNode>`)
		const result = run(data(NODES), xml, 200 * MM, 100 * MM)

		expect(round(boxes(result, "a")[0] as Box)).toEqual({ x: 50 * MM, y: 75 * MM, w: 100 * MM, h: 25 * MM })
		expect(round(boxes(result, "b")[0] as Box)).toEqual({ x: 150 * MM, y: 10 * MM, w: 40 * MM, h: 25 * MM })
	})

	it("fits a linear row by shrinking the sizes derived from the main extent, centred", () => {
		const constraints = `<dgm:constr type="w" for="ch" forName="node" refType="w"/>
			<dgm:constr type="w" for="ch" forName="gap" refType="w" refFor="ch" refForName="node" fact="-0.1"/>`
		const xml = ROW_OF_NODES(constraints, '<dgm:alg type="lin"/>').replace(
			'<dgm:presOf axis="self"/>',
			'<dgm:presOf axis="self"/><dgm:constrLst><dgm:constr type="h" refType="w" op="equ" fact="0.4"/></dgm:constrLst>'
		)
		const nodes = boxes(run(data(NODES), xml, 280 * MM, 100 * MM), "node").map(round)

		// 3 w - 0.2 w = 280 mm: w = 100 mm, h = 40 mm, centred across.
		expect(nodes).toEqual([
			{ x: 0, y: 30 * MM, w: 100 * MM, h: 40 * MM },
			{ x: 90 * MM, y: 30 * MM, w: 100 * MM, h: 40 * MM },
			{ x: 180 * MM, y: 30 * MM, w: 100 * MM, h: 40 * MM }
		])
	})

	it("wraps a snake into the grid that gives the largest nodes and centres a short row", () => {
		const constraints = `<dgm:constr type="w" for="ch" forName="node" refType="w"/>
			<dgm:constr type="h" for="ch" forName="node" refType="w" refFor="ch" refForName="node" fact="0.5"/>
			<dgm:constr type="w" for="ch" forName="gap" refType="w" refFor="ch" refForName="node" fact="0.1"/>
			<dgm:constr type="sp" refType="w" refFor="ch" refForName="gap"/>`
		const alg =
			'<dgm:alg type="snake"><dgm:param type="grDir" val="tL"/><dgm:param type="flowDir" val="row"/><dgm:param type="off" val="ctr"/></dgm:alg>'
		const nodes = boxes(run(data(NODES), ROW_OF_NODES(constraints, alg), 210 * MM, 105 * MM), "node").map(round)

		// Two per row: 2.1 w = 210 mm and 2 × 0.5 w + 0.1 w = 110 mm ≤ 105 mm fails, so w = 95.45 mm.
		const w = 105 / 1.1
		const left = (210 - 2.1 * w) / 2

		expect(nodes.map(b => b.w)).toEqual([w, w, w].map(v => Math.round(v * MM)))
		expect(nodes[0]?.x).toBe(Math.round(left * MM))
		expect(nodes[1]?.x).toBe(Math.round((left + 1.1 * w) * MM))
		expect(nodes[2]?.x).toBe(Math.round((210 / 2 - w / 2) * MM))
		expect(nodes[2]?.y).toBe(Math.round(0.6 * w * MM))
	})

	it("lowers the font size to fit within the rule's floor in half points", () => {
		const xml =
			layout(`<dgm:alg type="composite"/><dgm:constrLst><dgm:constr type="primFontSz" for="ch" forName="t" val="40"/></dgm:constrLst>
			<dgm:layoutNode name="t"><dgm:alg type="tx"/>${NO_MARGINS}<dgm:shape type="rect"/><dgm:presOf axis="ch" ptType="node" cnt="1"/>
			<dgm:ruleLst><dgm:rule type="primFontSz" val="10"/></dgm:ruleLst></dgm:layoutNode>`)
		// "One": 3 chars × 0.5 em must fit 1 in (72 pt): 48 pt fits, 40 pt is the start.
		const wide = run(data(NODES), xml, 914400, 914400).shapes[0]
		// 0.5 in: 24 pt by width, 30 pt by height; the largest half point that fits is 24.
		const narrow = run(data(NODES), xml, 457200, 457200).shapes[0]
		// 0.1 in fits only 4.8 pt, below the floor: the floor holds.
		const tiny = run(data(NODES), xml, 91440, 91440).shapes[0]

		expect([wide?.fontPt, narrow?.fontPt, tiny?.fontPt]).toEqual([40, 24, 10])
	})

	it("applies the user's custom scale about the centre and the neighbour offset in unscaled sizes", () => {
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="a" val="100"/>
			<dgm:constr type="h" for="ch" forName="a" val="50"/><dgm:constr type="ctrX" for="ch" forName="a" val="100"/><dgm:constr type="ctrY" for="ch" forName="a" val="50"/>
			</dgm:constrLst><dgm:layoutNode name="a"><dgm:shape type="rect"/></dgm:layoutNode>`)
		const pres = [{ id: "pa", prSet: 'presName="a" presAssocID="doc" custScaleX="120000" custLinFactNeighborY="-10000"' }]
		const box = round(boxes(run(data(NODES, pres), xml, 200 * MM, 100 * MM), "a")[0] as Box)

		expect(box).toEqual({ x: 40 * MM, y: 20 * MM, w: 120 * MM, h: 50 * MM })
	})

	it("flows custom-scaled sizes in a snake: each row as deep as its deepest node, the block fitted and centred", () => {
		const constraints = `<dgm:constr type="w" for="ch" forName="node" refType="w"/>
			<dgm:constr type="h" for="ch" forName="node" refType="w" refFor="ch" refForName="node" fact="0.5"/>
			<dgm:constr type="w" for="ch" forName="gap" refType="w" refFor="ch" refForName="node" fact="0.2"/>
			<dgm:constr type="sp" refType="w" refFor="ch" refForName="gap"/>`
		const alg = '<dgm:alg type="snake"><dgm:param type="bkpt" val="fixed"/><dgm:param type="bkPtFixedVal" val="2"/></dgm:alg>'
		const pres = [
			{ id: "p1", prSet: 'presName="node" presAssocID="n1" custScaleY="200000"' },
			{ id: "p2", prSet: 'presName="node" presAssocID="n2" custScaleX="150000"' }
		]
		const nodes = boxes(run(data(NODES, pres), ROW_OF_NODES(constraints, alg), 270 * MM, 200 * MM), "node").map(round)
		// Unit w: row 1 is w + 0.2 w + 1.5 w = 2.7 w wide and max(1 w, 0.5 w) deep; row 2 is 0.5 w deep; with the
		// 0.2 w row gap the block is 2.7 w × 1.7 w, so w = 100 mm fits 270 × 200 mm; the block is centred vertically.
		const top = (200 - 170) / 2

		expect(nodes).toEqual([
			{ x: 0, y: top * MM, w: 100 * MM, h: 100 * MM },
			{ x: 120 * MM, y: (top + 25) * MM, w: 150 * MM, h: 50 * MM },
			{ x: 0, y: (top + 120) * MM, w: 100 * MM, h: 50 * MM }
		])
	})

	it("flows custom-scaled sizes along a lin row and sizes a row by its scaled content", () => {
		const xml = layout(`<dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/></dgm:alg><dgm:constrLst>
			<dgm:constr type="h" for="ch" forName="row" refType="h" fact="0.5"/></dgm:constrLst>
			<dgm:forEach name="f" axis="ch" ptType="node" cnt="2"><dgm:layoutNode name="row"><dgm:alg type="lin"/>
			<dgm:constrLst><dgm:constr type="w" for="ch" forName="cell" refType="w" fact="0.5"/></dgm:constrLst>
			<dgm:layoutNode name="cell"><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:layoutNode></dgm:forEach>`)
		const pres = [{ id: "p1", prSet: 'presName="cell" presAssocID="n1" custScaleX="50000" custScaleY="40000"' }]
		const cells = boxes(run(data(NODES, pres), xml, 200 * MM, 100 * MM), "cell").map(round)

		// Row 1's cell is scaled to 50 × 20 mm, so row 1 takes 20 mm; row 2 takes its full 50 mm; the column of
		// 70 mm is centred in 100 mm.
		expect(cells).toEqual([
			{ x: 75 * MM, y: 15 * MM, w: 50 * MM, h: 20 * MM },
			{ x: 50 * MM, y: 35 * MM, w: 100 * MM, h: 50 * MM }
		])
	})

	it("shifts the whole diagram by half the difference of a root child's growth past either edge", () => {
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="a" refType="w"/><dgm:constr type="h" for="ch" forName="a" val="20"/>
			<dgm:constr type="b" for="ch" forName="a" refType="h"/>
			<dgm:constr type="w" for="ch" forName="b" val="10"/><dgm:constr type="h" for="ch" forName="b" val="10"/>
			</dgm:constrLst><dgm:layoutNode name="a"><dgm:shape type="rect"/></dgm:layoutNode><dgm:layoutNode name="b"><dgm:shape type="rect"/></dgm:layoutNode>`)
		const pres = [{ id: "pa", prSet: 'presName="a" presAssocID="doc" custScaleY="200000"' }]
		const result = run(data(NODES, pres), xml, 100 * MM, 100 * MM)

		// a grows from 20 to 40 mm about its centre, 10 mm past the bottom; the extent is centred on the frame, so
		// everything moves up 5 mm.
		expect(round(boxes(result, "a")[0] as Box)).toEqual({ x: 0, y: 65 * MM, w: 100 * MM, h: 40 * MM })
		expect(round(boxes(result, "b")[0] as Box)).toEqual({ x: 0, y: -5 * MM, w: 10 * MM, h: 10 * MM })
	})

	it("keeps an offset node inside the frame when it fits", () => {
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="a" val="50"/>
			<dgm:constr type="h" for="ch" forName="a" val="50"/></dgm:constrLst><dgm:layoutNode name="a"><dgm:shape type="rect"/></dgm:layoutNode>`)
		const pres = [{ id: "pa", prSet: 'presName="a" presAssocID="doc" custLinFactNeighborX="-50000" custLinFactNeighborY="300000"' }]

		expect(round(boxes(run(data(NODES, pres), xml, 100 * MM, 100 * MM), "a")[0] as Box)).toEqual({
			x: 0,
			y: 50 * MM,
			w: 50 * MM,
			h: 50 * MM
		})
	})
})

describe("SmartArt constraint resolution", () => {
	const composite = (constraints: string, children = "ab") =>
		layout(
			`<dgm:alg type="composite"/><dgm:constrLst>${constraints}</dgm:constrLst>` +
				[...children].map(n => `<dgm:layoutNode name="${n}"><dgm:shape type="rect"/></dgm:layoutNode>`).join("")
		)

	it("defers a reference to a value set later in constrLst order and retries it", () => {
		const xml = composite(`<dgm:constr type="w" for="ch" forName="b" refType="w" refFor="ch" refForName="a" fact="0.5"/>
			<dgm:constr type="w" for="ch" forName="a" val="40"/>`)

		expect(round(boxes(run(data(NODES), xml, 100 * MM, 100 * MM), "b")[0] as Box).w).toBe(20 * MM)
	})

	it("infers an edge from the two other values on its axis", () => {
		const xml = composite(`<dgm:constr type="l" for="ch" forName="a" val="10"/><dgm:constr type="w" for="ch" forName="a" val="30"/>
			<dgm:constr type="l" for="ch" forName="b" refType="r" refFor="ch" refForName="a"/>
			<dgm:constr type="t" for="ch" forName="b" refType="ctrX" refFor="ch" refForName="a"/>`)
		const b = round(boxes(run(data(NODES), xml, 100 * MM, 100 * MM), "b")[0] as Box)

		expect([b.x, b.y]).toEqual([40 * MM, 25 * MM])
	})

	it("applies an ancestor's des constraints to grandchildren before the parent's own fill the rest", () => {
		const xml =
			layout(`<dgm:alg type="composite"/><dgm:constrLst><dgm:constr type="w" for="des" forName="leaf" val="30"/></dgm:constrLst>
			<dgm:layoutNode name="mid"><dgm:alg type="composite"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="leaf" val="70"/>
			<dgm:constr type="h" for="ch" forName="leaf" val="20"/></dgm:constrLst>
			<dgm:layoutNode name="leaf"><dgm:shape type="rect"/><dgm:constrLst><dgm:constr type="h" val="5"/></dgm:constrLst></dgm:layoutNode></dgm:layoutNode>`)
		const leaf = round(boxes(run(data(NODES), xml, 100 * MM, 100 * MM), "leaf")[0] as Box)

		// The parent's own ch constraint comes after the ancestor's des one and wins; the leaf's own h only fills
		// what the parent left open, which it did not.
		expect([leaf.w, leaf.h]).toEqual([70 * MM, 20 * MM])
	})

	it("treats lte and gte as bounds on rules, not as clamps on the values constraints set", () => {
		const xml = composite(
			'<dgm:constr type="w" for="ch" forName="a" val="80"/><dgm:constr type="w" for="ch" forName="a" op="lte" val="50"/>',
			"a"
		)

		expect(round(boxes(run(data(NODES), xml, 100 * MM, 100 * MM), "a")[0] as Box).w).toBe(80 * MM)
	})

	it("keeps an unbounded size (INF) as the content's: a lin child takes the extent of what it holds", () => {
		const xml = layout(`<dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/><dgm:param type="vertAlign" val="t"/></dgm:alg>
			<dgm:constrLst><dgm:constr type="h" for="ch" forName="group" val="INF"/><dgm:constr type="h" for="des" forName="item" val="15"/></dgm:constrLst>
			<dgm:forEach name="f" axis="ch" ptType="node" cnt="2"><dgm:layoutNode name="group"><dgm:alg type="lin"/>
			<dgm:layoutNode name="item"><dgm:shape type="rect"/></dgm:layoutNode></dgm:layoutNode></dgm:forEach>`)
		const items = boxes(run(data(NODES), xml, 100 * MM, 100 * MM), "item").map(b => Math.round(b.y))

		expect(items).toEqual([0, 15 * MM])
	})
})

describe("SmartArt rules", () => {
	// A tx child "t" of a composite, 60 × 20 mm, its text at 20 pt: "Three" is 5 × 10 pt = 50 pt wide, 24 pt tall.
	const rules = (ruleLst: string, size = 'val="60"') =>
		layout(`<dgm:alg type="composite"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="t" ${size}/>
			<dgm:constr type="h" for="ch" forName="t" val="20"/><dgm:constr type="primFontSz" for="ch" forName="t" val="20"/></dgm:constrLst>
			<dgm:ruleLst>${ruleLst}</dgm:ruleLst>
			<dgm:layoutNode name="t"><dgm:alg type="tx"/>${NO_MARGINS}<dgm:shape type="rect"/><dgm:presOf axis="ch" ptType="node" st="3" cnt="1"/></dgm:layoutNode>`)

	it("shrinks a font size by a des rule in half points until the text fits", () => {
		// 10 mm wide holds 5 chars × 0.5 em up to 11.34 pt: the rule takes 20 pt down to 11 pt.
		const shape = run(data(NODES), rules('<dgm:rule type="primFontSz" for="ch" forName="t" val="5"/>', 'val="10"'), 100 * MM, 100 * MM)
			.shapes[0]

		expect(shape?.fontPt).toBe(11)
	})

	it("stops a font rule at its floor when the text still does not fit", () => {
		const shape = run(data(NODES), rules('<dgm:rule type="primFontSz" for="ch" forName="t" val="10"/>', 'val="1"'), 100 * MM, 100 * MM)
			.shapes[0]

		expect(shape?.fontPt).toBe(10)
	})

	it("grows a size by a rule only as far as the text needs, within the room left", () => {
		// 20 pt text 50 pt wide (17.64 mm) needs the 10 mm box to grow.
		const xml = rules('<dgm:rule type="w" for="ch" forName="t" val="INF"/>', 'val="10"')
		const w = (boxes(run(data(NODES), xml, 100 * MM, 100 * MM), "t")[0] as Box).w

		expect(w).toBeGreaterThanOrEqual(50 * 12700)
		expect(w).toBeLessThan(50 * 12700 + 0.2 * MM)
	})

	it("undoes a geometry rule that cannot make the text fit", () => {
		const xml = rules('<dgm:rule type="w" for="ch" forName="t" val="0"/>', 'val="1"')

		expect((boxes(run(data(NODES), xml, 100 * MM, 100 * MM), "t")[0] as Box).w).toBe(1 * MM)
	})

	it("relaxes no further than the rule step budget", () => {
		const xml = rules('<dgm:rule type="primFontSz" for="ch" forName="t" val="1"/>', 'val="3"')
		const result = run(data(NODES), xml, 100 * MM, 100 * MM, { budgets: { ...DEFAULT_SMARTART_BUDGETS, maxRuleSteps: 2 } })

		expect(result.ruleSteps).toBeLessThanOrEqual(2)
	})
})

describe("SmartArt drawing order", () => {
	it("draws a chOrder=t node's children top first and moves a shape back by zOrderOff", () => {
		const shapes = (attributes: string, zOrderOff = 0) =>
			run(
				data(NODES),
				layout(
					`<dgm:layoutNode name="p" ${attributes}><dgm:layoutNode name="a"><dgm:shape type="rect"/></dgm:layoutNode>
					<dgm:layoutNode name="b"><dgm:shape type="rect"/></dgm:layoutNode>
					<dgm:layoutNode name="c"><dgm:shape type="rect" zOrderOff="${zOrderOff}"/></dgm:layoutNode></dgm:layoutNode>`
				),
				MM,
				MM
			).shapes.map(s => s.name)

		expect(shapes("")).toEqual(["a", "b", "c"])
		expect(shapes('chOrder="t"')).toEqual(["c", "b", "a"])
		expect(shapes("", -2)).toEqual(["c", "a", "b"])
	})
})
