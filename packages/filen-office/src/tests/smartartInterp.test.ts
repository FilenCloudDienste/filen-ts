import { describe, expect, it } from "vitest"
import { DEFAULT_SMARTART_BUDGETS, parseDataModel, SmartArtError } from "../core/smartart/data"
import { layoutDiagram, type Box, type TextMeasurer } from "../core/smartart/interp"
import { parseLayoutDef } from "../core/smartart/layoutDef"
import { encodeUtf8, parseXml } from "../core/xml/index"

// The layout interpreter over small layout definitions written for these tests (ECMA-376 §21.4).

const DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const MM = 36000

const measurer: TextMeasurer = {
	// Every character is half an em wide, lines are 1.2 em; no wrapping.
	measure(text, fontPt) {
		const lines = text.split("\n")

		return { width: Math.max(...lines.map(l => l.length)) * fontPt * 6350, height: lines.length * fontPt * 12700 * 1.2 }
	}
}

interface PointSpec {
	readonly id: string
	readonly text?: string
	readonly type?: string
	readonly prSet?: string
	readonly vars?: string
}

// A data model: `nodes` under the doc point in order, each with its parent and sibling transitions.
function data(nodes: readonly PointSpec[], extra: readonly PointSpec[] = [], prSetDoc = ""): string {
	let pts = `<dgm:pt modelId="doc" type="doc"><dgm:prSet ${prSetDoc}/></dgm:pt>`
	let cxns = ""

	nodes.forEach((node, index) => {
		const t = node.text === undefined ? "" : `<dgm:t><a:bodyPr/><a:p><a:r><a:t>${node.text}</a:t></a:r></a:p></dgm:t>`

		pts += `<dgm:pt modelId="${node.id}"><dgm:prSet ${node.prSet ?? ""}/>${t}</dgm:pt>`
		pts += `<dgm:pt modelId="${node.id}p" type="parTrans" cxnId="c${node.id}"/><dgm:pt modelId="${node.id}s" type="sibTrans" cxnId="c${node.id}"/>`
		cxns += `<dgm:cxn modelId="c${node.id}" srcId="doc" destId="${node.id}" srcOrd="${index}" destOrd="0" parTransId="${node.id}p" sibTransId="${node.id}s"/>`
	})

	for (const point of extra) {
		const vars = point.vars === undefined ? "" : `<dgm:presLayoutVars>${point.vars}</dgm:presLayoutVars>`

		pts += `<dgm:pt modelId="${point.id}" type="${point.type ?? "pres"}"><dgm:prSet ${point.prSet ?? ""}>${vars}</dgm:prSet></dgm:pt>`
	}

	return `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${A}"><dgm:ptLst>${pts}</dgm:ptLst><dgm:cxnLst>${cxns}</dgm:cxnLst></dgm:dataModel>`
}

function layout(body: string): string {
	return `<dgm:layoutDef xmlns:dgm="${DGM}" uniqueId="test"><dgm:layoutNode name="root">${body}</dgm:layoutNode></dgm:layoutDef>`
}

function run(dataXml: string, layoutXml: string, w: number, h: number) {
	const model = parseDataModel(parseXml(encodeUtf8(dataXml)))
	const def = parseLayoutDef(parseXml(encodeUtf8(layoutXml)))

	return layoutDiagram(model, def, w, h, { measurer })
}

function boxes(result: ReturnType<typeof run>, name: string): Box[] {
	return result.shapes.filter(s => s.name === name).map(s => s.box)
}

function round(box: Box): Box {
	return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }
}

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

		expect(() => layoutDiagram(model, def, MM, MM, { measurer, budgets })).toThrow(expect.objectContaining({ reason: "tooLarge" }))
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
			<dgm:layoutNode name="t"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="ch" ptType="node" cnt="1"/>
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
})
