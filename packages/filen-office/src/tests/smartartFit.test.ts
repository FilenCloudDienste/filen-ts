import { describe, expect, it } from "vitest"
import { boxes, data, layout, MM, NO_MARGINS, round, run } from "./smartartFixtures"

// Constraint scopes, nested lines and font fitting over small layout definitions written for these tests
// (ECMA-376 §21.4.2.8 constr, §21.4.2.24 rule, L.4.15.6.1.1 lin and tx).

const TREE = [
	{ id: "n1", text: "One" },
	{ id: "c1", text: "A", parent: "n1" },
	{ id: "c2", text: "B", parent: "n1" },
	{ id: "n2", text: "Two" },
	{ id: "c3", text: "C", parent: "n2" },
	{ id: "c4", text: "D", parent: "n2" }
]

describe("SmartArt constraint references", () => {
	it("reads a value its owner's constraints give a layout node the data does not create", () => {
		const xml = layout(`<dgm:alg type="sp"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="a" refType="w" fact="0.5"/>
			<dgm:constr type="w" for="des" forName="missing" refType="w" fact="0.2"/>
			<dgm:constr type="w" for="ch" forName="b" refType="w" refFor="des" refForName="missing" fact="0.5"/>
			<dgm:constr type="h" for="ch" refType="h"/></dgm:constrLst>
			<dgm:layoutNode name="a"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode>
			<dgm:layoutNode name="b"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode>`)
		const result = run(data([{ id: "n1" }]), xml, 100 * MM, 50 * MM)

		expect(round(boxes(result, "a")[0] ?? { x: 0, y: 0, w: 0, h: 0 }).w).toBe(50 * MM)
		expect(round(boxes(result, "b")[0] ?? { x: 0, y: 0, w: 0, h: 0 }).w).toBe(10 * MM)
	})
})

describe("SmartArt constraint units and bounds", () => {
	it("reads a geometry value as a margin in points, its number kept", () => {
		const xml = layout(`<dgm:alg type="sp"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="t" refType="w"/>
			<dgm:constr type="lMarg" for="ch" forName="t" refType="w" fact="0.075"/></dgm:constrLst>
			<dgm:layoutNode name="t"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode>`)
		const node = run(data([{ id: "n1" }]), xml, 200 * MM, 100 * MM).shapes[0]?.node

		// 0.075 × 200 mm = 15, as points.
		expect(node?.values.get("lMarg")).toBeCloseTo(15 * 12700, 3)
	})

	it("clamps a value by a bound its owner meets in order, on a value this resolution set", () => {
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="d" refType="w"/>
			<dgm:constr type="h" for="ch" forName="d" refType="h"/>
			<dgm:constr type="h" for="ch" forName="d" refType="w" refFor="ch" refForName="d" op="lte" fact="0.4"/></dgm:constrLst>
			<dgm:layoutNode name="d"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode>`)

		expect(round(boxes(run(data([{ id: "n1" }]), xml, 200 * MM, 100 * MM), "d")[0] ?? { x: 0, y: 0, w: 0, h: 0 }).h).toBe(80 * MM)
	})
})

describe("SmartArt nested lines", () => {
	// A tree as rows of columns: each column is a text box over the row of its children's columns.
	const NESTED = layout(`<dgm:alg type="lin"><dgm:param type="linDir" val="fromL"/><dgm:param type="nodeVertAlign" val="t"/></dgm:alg>
		<dgm:constrLst><dgm:constr type="w" for="ch" forName="col" refType="w"/><dgm:constr type="w" for="des" forName="t" refType="w"/>
		<dgm:constr type="w" for="des" forName="row" refType="w"/><dgm:constr type="h" for="des" forName="t" refType="h"/></dgm:constrLst>
		<dgm:forEach name="each" axis="ch" ptType="node">
			<dgm:layoutNode name="col"><dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/></dgm:alg>
				<dgm:constrLst><dgm:constr type="w" for="ch" forName="t" refType="w" refFor="ch" refForName="row" op="gte"/></dgm:constrLst>
				<dgm:layoutNode name="t"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode>
				<dgm:layoutNode name="row"><dgm:alg type="lin"><dgm:param type="linDir" val="fromL"/><dgm:param type="nodeVertAlign" val="t"/></dgm:alg>
					<dgm:forEach name="again" ref="each"/></dgm:layoutNode>
			</dgm:layoutNode>
		</dgm:forEach>`)

	it("lays every level out at its constraint size and scales the tree to fit, along and across each line", () => {
		const result = run(data(TREE), NESTED, 400 * MM, 200 * MM)
		const [one, two] = boxes(result, "t").filter(b => b.y === 0)

		// Leaves: a quarter of the width each (four of them), half the height (two levels); a parent spans its two.
		expect(
			boxes(result, "t")
				.filter(b => b.y > 0)
				.map(round)
		).toEqual([
			{ x: 0, y: 100 * MM, w: 100 * MM, h: 100 * MM },
			{ x: 100 * MM, y: 100 * MM, w: 100 * MM, h: 100 * MM },
			{ x: 200 * MM, y: 100 * MM, w: 100 * MM, h: 100 * MM },
			{ x: 300 * MM, y: 100 * MM, w: 100 * MM, h: 100 * MM }
		])
		expect(round(one ?? { x: 0, y: 0, w: 0, h: 0 })).toEqual({ x: 0, y: 0, w: 200 * MM, h: 100 * MM })
		expect(round(two ?? { x: 0, y: 0, w: 0, h: 0 })).toEqual({ x: 200 * MM, y: 0, w: 200 * MM, h: 100 * MM })
	})

	it("gives an empty row no room, so a leaf is as tall as its own text box", () => {
		const result = run(data([...TREE, { id: "n3", text: "Three" }]), NESTED, 500 * MM, 200 * MM)
		const leaf = boxes(result, "t").find(b => b.x >= 400 * MM)

		expect(round(leaf ?? { x: 0, y: 0, w: 0, h: 0 })).toEqual({ x: 400 * MM, y: 0, w: 100 * MM, h: 100 * MM })
	})
})

describe("SmartArt line rules", () => {
	it("relaxes a line's rule on its children's size until the line fits, the spaces that follow it shrinking too", () => {
		const xml = layout(`<dgm:alg type="lin"><dgm:param type="linDir" val="fromL"/></dgm:alg><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="pad" refType="w" fact="0.1"/><dgm:constr type="w" for="ch" forName="a" refType="w"/>
			<dgm:constr type="w" for="ch" forName="gap" refType="w" refFor="ch" refForName="a" fact="0.2"/>
			<dgm:constr type="h" for="ch" refType="h"/></dgm:constrLst>
			<dgm:ruleLst><dgm:rule type="w" for="ch" forName="a" val="0"/></dgm:ruleLst>
			<dgm:layoutNode name="pad"><dgm:alg type="sp"/></dgm:layoutNode>
			<dgm:forEach name="each" axis="ch" ptType="node">
				<dgm:layoutNode name="a"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode>
				<dgm:forEach name="gaps" axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="gap"><dgm:alg type="sp"/></dgm:layoutNode></dgm:forEach>
			</dgm:forEach>`)
		const result = run(data([{ id: "n1" }, { id: "n2" }, { id: "n3" }]), xml, 340 * MM, 100 * MM)
		const a = boxes(result, "a").map(round)

		// 0.9 × 340 mm over 3 boxes and 2 gaps of 0.2 of a box: 90 mm boxes, 18 mm gaps, the padding still 34 mm.
		expect(a.map(b => b.w)).toEqual([90 * MM, 90 * MM, 90 * MM])
		expect(a.map(b => b.x)).toEqual([34 * MM, 142 * MM, 250 * MM])
	})

	it("keeps a line's widths when only its font rules can shrink sizes a font size sets", () => {
		const xml = layout(`<dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/></dgm:alg><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="t" refType="w"/><dgm:constr type="primFontSz" for="ch" forName="t" val="100"/>
			<dgm:constr type="h" for="ch" forName="t" refType="primFontSz" refFor="ch" refForName="t" fact="0.5"/></dgm:constrLst>
			<dgm:forEach name="each" axis="ch" ptType="node" cnt="2"><dgm:layoutNode name="t"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode></dgm:forEach>`)

		expect(boxes(run(data([{ id: "n1" }, { id: "n2" }]), xml, 100 * MM, 20 * MM), "t").map(b => Math.round(b.w))).toEqual([
			100 * MM,
			100 * MM
		])
	})

	it("lays a line of lines no constraint sizes out at its descendants' sizes, scaled to fit", () => {
		const xml = layout(`<dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/><dgm:param type="nodeHorzAlign" val="l"/></dgm:alg>
			<dgm:constrLst><dgm:constr type="w" for="des" forName="box" refType="w"/>
			<dgm:constr type="h" for="des" forName="box" refType="w" refFor="des" refForName="box" fact="0.4"/></dgm:constrLst>
			<dgm:forEach name="each" axis="ch" ptType="node"><dgm:layoutNode name="row"><dgm:alg type="lin"><dgm:param type="linDir" val="fromL"/></dgm:alg>
				<dgm:layoutNode name="box"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode>
				<dgm:forEach name="kids" axis="ch" ptType="node"><dgm:layoutNode name="box"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode></dgm:forEach>
			</dgm:layoutNode></dgm:forEach>`)
		const result = run(
			data([{ id: "n1" }, { id: "c1", parent: "n1" }, { id: "n2" }, { id: "c2", parent: "n2" }]),
			xml,
			200 * MM,
			100 * MM
		)

		// Rows of two 200 × 80 mm boxes (400 × 80) stacked twice (400 × 160) fit 200 × 100 mm: half along a row,
		// five eighths down the column.
		expect(boxes(result, "box").map(round)).toEqual([
			{ x: 0, y: 0, w: 100 * MM, h: 50 * MM },
			{ x: 100 * MM, y: 0, w: 100 * MM, h: 50 * MM },
			{ x: 0, y: 50 * MM, w: 100 * MM, h: 50 * MM },
			{ x: 100 * MM, y: 50 * MM, w: 100 * MM, h: 50 * MM }
		])
	})
})

describe("SmartArt font fitting", () => {
	const fitted = (shape: string, text: string, margins = NO_MARGINS): number => {
		const xml = layout(`<dgm:alg type="sp"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="t" val="40"/>
			<dgm:constr type="h" for="ch" forName="t" val="100"/><dgm:constr type="primFontSz" for="ch" forName="t" val="65"/></dgm:constrLst>
			<dgm:layoutNode name="t"><dgm:alg type="tx"/>${margins}${shape}<dgm:presOf axis="ch" ptType="node" cnt="1"/>
			<dgm:ruleLst><dgm:rule type="primFontSz" val="5"/></dgm:ruleLst></dgm:layoutNode>`)

		return run(data([{ id: "n", text }]), xml, 100 * MM, 100 * MM).shapes[0]?.fontPt ?? 0
	}

	it("fits text inside the text rectangle of the node's geometry", () => {
		// Half an em per character: nine characters fit 40 mm at 25 pt in a rectangle; a rounded rectangle with a
		// 0.1 corner sets its text 0.29 of the radius in from each side, so 23.5 pt.
		expect(fitted('<dgm:shape type="rect"/>', "Quarterly")).toBe(25)
		expect(fitted('<dgm:shape type="roundRect"><dgm:adjLst><dgm:adj idx="1" val="0.1"/></dgm:adjLst></dgm:shape>', "Quarterly")).toBe(
			23.5
		)
	})

	it("gives a side no constraint sets a margin of 0.56 of the font size", () => {
		// 40 mm less 2 × 0.56 em: nine half-em characters fit at 25.2 pt with no margins, 40 mm / 5.62 em with them.
		expect(fitted('<dgm:shape type="rect"/>', "Quarterly", "")).toBe(20)

		const xml = layout(`<dgm:alg type="sp"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="t" val="40"/>
			<dgm:constr type="h" for="ch" forName="t" val="100"/><dgm:constr type="primFontSz" for="ch" forName="t" val="20"/></dgm:constrLst>
			<dgm:layoutNode name="t"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="ch" ptType="node" cnt="1"/></dgm:layoutNode>`)
		const values = run(data([{ id: "n", text: "Go" }]), xml, 100 * MM, 100 * MM).shapes[0]?.node.values

		expect(["lMarg", "tMarg", "rMarg", "bMarg"].map(name => values?.get(name))).toEqual(
			[0.56 * 20 * 12700, 0.56 * 20 * 12700, 0.56 * 20 * 12700, 0.56 * 20 * 12700].map(v => expect.closeTo(v, 3))
		)
	})

	it("gives the nodes one constraint sizes one size, and bounds a size by the size it must not exceed", () => {
		const xml =
			layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" val="40"/><dgm:constr type="h" for="ch" val="100"/>
			<dgm:constr type="primFontSz" for="ch" forName="a" val="65"/><dgm:constr type="primFontSz" for="ch" forName="b" val="65"/>
			<dgm:constr type="primFontSz" for="ch" forName="b" refType="primFontSz" refFor="ch" refForName="a" op="lte"/></dgm:constrLst>
			<dgm:forEach name="each" axis="ch" ptType="node" cnt="2">
				<dgm:layoutNode name="a"><dgm:alg type="tx"/>${NO_MARGINS}<dgm:shape type="rect"/><dgm:presOf axis="self"/>
					<dgm:ruleLst><dgm:rule type="primFontSz" val="5"/></dgm:ruleLst></dgm:layoutNode>
			</dgm:forEach>
			<dgm:forEach name="last" axis="ch" ptType="node" st="3">
				<dgm:layoutNode name="b"><dgm:alg type="tx"/>${NO_MARGINS}<dgm:shape type="rect"/><dgm:presOf axis="self"/>
					<dgm:ruleLst><dgm:rule type="primFontSz" val="5"/></dgm:ruleLst></dgm:layoutNode>
			</dgm:forEach>`)
		const result = run(
			data([
				{ id: "n1", text: "Go" },
				{ id: "n2", text: "Quarterly" },
				{ id: "n3", text: "Up" }
			]),
			xml,
			300 * MM,
			100 * MM
		)
		const sizes = (name: string) => result.shapes.filter(s => s.name === name).map(s => s.fontPt)

		// "Quarterly" fits at 25 pt, "Go" alone would take 65; "Up" would too, but may not exceed them.
		expect(sizes("a")).toEqual([25, 25])
		expect(sizes("b")).toEqual([25])
	})
})

describe("SmartArt process rows (process3)", () => {
	// Two composites as wide as the diagram, shrunk by the row's w rule; each as high as 1000 times its width with
	// h INF, holding a box 2.4 font sizes high.
	const xml = layout(`<dgm:alg type="lin"/><dgm:constrLst>
		<dgm:constr type="w" for="ch" forName="composite" refType="w"/>
		<dgm:constr type="w" for="ch" ptType="sibTrans" refType="w" refFor="ch" refForName="composite" fact="0.3333"/>
		<dgm:constr type="primFontSz" for="des" forName="box" val="65"/>
		<dgm:constr type="h" for="des" forName="box" refType="primFontSz" refFor="des" refForName="box" fact="2.4"/></dgm:constrLst>
		<dgm:ruleLst><dgm:rule type="w" for="ch" forName="composite" val="0"/><dgm:rule type="primFontSz" for="des" forName="box" val="5"/></dgm:ruleLst>
		<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="composite"><dgm:alg type="composite"/>
		<dgm:constrLst><dgm:constr type="h" refType="w" fact="1000"/><dgm:constr type="l" for="ch" forName="box"/><dgm:constr type="t" for="ch" forName="box"/>
		<dgm:constr type="w" for="ch" forName="box" refType="w"/></dgm:constrLst><dgm:ruleLst><dgm:rule type="h" val="INF"/></dgm:ruleLst>
		<dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:layoutNode>
		<dgm:forEach axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="gap"><dgm:alg type="sp"/></dgm:layoutNode></dgm:forEach></dgm:forEach>`)
	const result = run(
		data([
			{ id: "a", text: "A" },
			{ id: "b", text: "B" }
		]),
		xml,
		170 * MM,
		113 * MM
	)

	it("does not let a depth that may grow without bound shrink the row", () => {
		expect(round(boxes(result, "box")[0] as { x: number; y: number; w: number; h: number }).w).toBe(Math.round((170 * MM) / 2.3333))
	})

	it("shrinks the text sizes until the boxes drawn from them fit the frame", () => {
		const box = boxes(result, "box")[0] as { y: number; h: number }

		expect(box.y + box.h).toBeLessThanOrEqual(113 * MM * 1.01)
		expect(box.h).toBeGreaterThan(113 * MM * 0.9)
	})
})

describe("SmartArt line extent", () => {
	it("reaches as far as its cursor goes: a negative last child does not shorten the line it is centred by", () => {
		// hProcess3's column: 0.5, 1 and 0.5 font sizes, then -0.4; PowerPoint starts it at the top of its box.
		const xml = layout(`<dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/></dgm:alg><dgm:constrLst>
			<dgm:constr type="h" for="ch" forName="a" val="10"/><dgm:constr type="h" for="ch" forName="text" val="20"/>
			<dgm:constr type="h" for="ch" forName="b" val="10"/><dgm:constr type="h" for="ch" forName="back" val="-8"/></dgm:constrLst>
			<dgm:layoutNode name="a"><dgm:alg type="sp"/></dgm:layoutNode><dgm:layoutNode name="text"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode>
			<dgm:layoutNode name="b"><dgm:alg type="sp"/></dgm:layoutNode><dgm:layoutNode name="back"><dgm:alg type="sp"/></dgm:layoutNode>`)

		expect(
			round(boxes(run(data([{ id: "n1" }]), xml, 50 * MM, 40 * MM), "text")[0] as { x: number; y: number; w: number; h: number }).y
		).toBe(10 * MM)
	})
})

describe("SmartArt text nodes without presOf", () => {
	it("presents its own node, where an empty presOf presents nothing", () => {
		const xml =
			layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="t" val="20"/><dgm:constr type="h" for="ch" forName="t" val="20"/>
			<dgm:constr type="w" for="ch" forName="e" val="20"/><dgm:constr type="h" for="ch" forName="e" val="20"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="t"><dgm:alg type="tx"/><dgm:shape type="rect"/></dgm:layoutNode>
			<dgm:layoutNode name="e"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf/></dgm:layoutNode></dgm:forEach>`)
		const result = run(data([{ id: "n1", text: "One" }]), xml, 100 * MM, 50 * MM)

		expect(result.shapes.find(s => s.name === "t")?.text.map(p => p.id)).toEqual(["n1"])
		expect(result.shapes.find(s => s.name === "e")?.text).toEqual([])
	})
})

describe("SmartArt nested lines and sibling sizes", () => {
	it("makes a text box as wide as the row under it when its width is that row's (op equ)", () => {
		// The Pitchbook hierarchy: txOne w = horzOne w, horzOne a row of two columns each as wide as the diagram.
		const xml = layout(`<dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/></dgm:alg><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="row" refType="w"/><dgm:constr type="w" for="ch" forName="top" refType="w" refFor="ch" refForName="row" op="equ"/>
			<dgm:constr type="h" for="ch" forName="top" val="10"/></dgm:constrLst>
			<dgm:layoutNode name="top"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode>
			<dgm:layoutNode name="row"><dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="ch" forName="col" refType="w"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="col"><dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/></dgm:alg>
			<dgm:constrLst><dgm:constr type="w" for="ch" forName="leaf" refType="w"/><dgm:constr type="h" for="ch" forName="leaf" val="10"/></dgm:constrLst>
			<dgm:layoutNode name="leaf"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode>
			<dgm:layoutNode name="sub"><dgm:alg type="lin"/></dgm:layoutNode></dgm:layoutNode></dgm:forEach></dgm:layoutNode>`)
		const result = run(data([{ id: "a" }, { id: "b" }]), xml, 100 * MM, 50 * MM)
		const top = boxes(result, "top")[0] as { w: number }
		const leaves = boxes(result, "leaf")

		expect(Math.round(top.w)).toBe(Math.round(leaves.reduce((sum, leaf) => sum + leaf.w, 0)))
	})
})
