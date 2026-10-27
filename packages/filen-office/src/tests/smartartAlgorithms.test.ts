import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { CORPUS_DIR } from "./corpusDir"
import { connectorRoute, MIN_CONNECTOR_EXTENT } from "../core/smartart/algorithms/conn"
import type { Box, DiagramLayout } from "../core/smartart/interp"
import { MM, boxes, data, layout, round, run } from "./smartartFixtures"

// The cycle, pyramid, hierarchy and connector algorithms and the composite and linear fitting rules, on layout
// definitions written for these tests (ECMA-376 L.4.15.6.1.1).

const THREE = [
	{ id: "a", text: "A" },
	{ id: "b", text: "B" },
	{ id: "c", text: "C" }
]
const FOUR = [...THREE, { id: "d", text: "D" }]

function centre(box: Box): { x: number; y: number } {
	return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
}

// Degrees clockwise from the top, of `point` seen from `origin`.
function bearing(origin: { x: number; y: number }, point: { x: number; y: number }): number {
	return Math.round((Math.atan2(point.x - origin.x, origin.y - point.y) * 180) / Math.PI)
}

function shapeOf(result: DiagramLayout, name: string): DiagramLayout["shapes"][number][] {
	return result.shapes.filter(s => s.name === name)
}

describe("SmartArt cycle", () => {
	const ring = (params: string, constraints = "", centred = false): string =>
		layout(`<dgm:alg type="cycle">${params}</dgm:alg><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="node" val="20"/><dgm:constr type="h" for="ch" forName="node" val="20"/>
			<dgm:constr type="w" for="ch" forName="hub" val="30"/><dgm:constr type="h" for="ch" forName="hub" val="30"/>${constraints}</dgm:constrLst>
			${centred ? '<dgm:forEach axis="ch" ptType="node" cnt="1"><dgm:layoutNode name="hub"><dgm:alg type="tx"/><dgm:shape type="ellipse"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach><dgm:forEach axis="ch" ptType="node" st="2">' : '<dgm:forEach axis="ch" ptType="node">'}
			<dgm:layoutNode name="node"><dgm:alg type="tx"/><dgm:shape type="ellipse"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach>`)

	it("spaces a full turn equally from the start angle, neighbours sibSp apart, fitted and centred", () => {
		const result = run(data(FOUR), ring('<dgm:param type="stAng" val="0"/>', '<dgm:constr type="sibSp" val="10"/>'), 300 * MM, 300 * MM)
		const nodes = boxes(result, "node")
		const middle = { x: 150 * MM, y: 150 * MM }

		expect(nodes.map(box => bearing(middle, centre(box)))).toEqual([0, 90, 180, -90])

		// Neighbours a quarter turn apart: the chord between centres is r√2 and they must keep 10 mm clear along it,
		// each reaching 10 mm along the diagonal of a round shape.
		const r = (centre(nodes[0] as Box).y - middle.y) * -1

		expect(r * Math.SQRT2).toBeCloseTo(30 * MM, -2)
		expect(nodes.every(box => box.w === 20 * MM && box.h === 20 * MM)).toBe(true)
	})

	it("takes both ends of an arc and puts the first node in the centre, the ring sp clear of it", () => {
		const params = '<dgm:param type="stAng" val="-75"/><dgm:param type="spanAng" val="150"/><dgm:param type="ctrShpMap" val="fNode"/>'
		const result = run(
			data([{ id: "h", text: "H" }, ...FOUR]),
			ring(params, '<dgm:constr type="sp" val="5"/>', true),
			400 * MM,
			400 * MM
		)
		const hub = centre(boxes(result, "hub")[0] as Box)
		const nodes = boxes(result, "node")

		expect(nodes.map(box => bearing(hub, centre(box)))).toEqual([-75, -25, 25, 75])

		// Every ring node sits at the radius the furthest-reaching one needs: 15 + 5 + 10 mm for round shapes.
		for (const box of nodes) expect(Math.hypot(centre(box).x - hub.x, centre(box).y - hub.y)).toBeCloseTo(30 * MM, -2)
	})

	it("turns each node to its angle along the path", () => {
		const result = run(data(FOUR), ring('<dgm:param type="rotPath" val="alongPath"/>'), 300 * MM, 300 * MM)

		expect(shapeOf(result, "node").map(s => s.rot)).toEqual([0, 90, 180, 270])
	})

	it("closes a cycle: the last node's sibling transition, kept by hideLastTrans 0, joins it to the first", () => {
		const xml = layout(`<dgm:alg type="cycle"><dgm:param type="stAng" val="0"/></dgm:alg><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="node" val="20"/><dgm:constr type="h" for="ch" forName="node" val="20"/>
			<dgm:constr type="h" for="ch" forName="link" val="6"/><dgm:constr type="sibSp" val="10"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="node"><dgm:alg type="tx"/><dgm:shape type="ellipse"/><dgm:presOf axis="self"/></dgm:layoutNode>
			<dgm:forEach axis="followSib" ptType="sibTrans" hideLastTrans="0" cnt="1"><dgm:layoutNode name="link"><dgm:alg type="conn"/><dgm:shape type="conn"/>
			<dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach></dgm:forEach>`)
		const result = run(data(THREE), xml, 200 * MM, 200 * MM)
		const nodes = boxes(result, "node").map(centre)
		const links = shapeOf(result, "link")
		const last = links[2] === undefined ? undefined : connectorRoute(links[2].node)
		const end = last?.points[last.points.length - 1]

		expect(links).toHaveLength(3)
		expect(links.every(link => link.box.w > 0)).toBe(true)
		// From the third node towards the first: its end is nearer the first node than the third.
		expect(Math.hypot((end?.x ?? 0) - (nodes[0]?.x ?? 0), (end?.y ?? 0) - (nodes[0]?.y ?? 0))).toBeLessThan(
			Math.hypot((end?.x ?? 0) - (nodes[2]?.x ?? 0), (end?.y ?? 0) - (nodes[2]?.y ?? 0))
		)
	})

	it("grows a diam its rule lets grow until neighbours keep sibSp apart", () => {
		// cycle2 (Pitchbook): diam 150 mm with rule diam INF, nodes as wide as the diagram, sibSp half a node.
		const xml = layout(`<dgm:alg type="cycle"/><dgm:constrLst><dgm:constr type="diam" val="150"/>
			<dgm:constr type="w" for="ch" forName="node" val="200"/><dgm:constr type="h" for="ch" forName="node" val="200"/><dgm:constr type="sibSp" val="100"/></dgm:constrLst>
			<dgm:ruleLst><dgm:rule type="diam" val="INF"/></dgm:ruleLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="node"><dgm:alg type="tx"/><dgm:shape type="ellipse"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach>`)
		const nodes = boxes(run(data(FOUR), xml, 200 * MM, 200 * MM), "node")
		const a = centre(nodes[0] as Box)
		const b = centre(nodes[1] as Box)
		const w = (nodes[0] as Box).w

		// Round nodes a node wide, sibSp half of one: centres at least 1.5 node widths apart.
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(w * 1.5 - 1)
	})

	it("scales the drawing down into a box too small for it", () => {
		const result = run(data(FOUR), ring("", '<dgm:constr type="sibSp" val="10"/>'), 40 * MM, 40 * MM)

		for (const box of boxes(result, "node")) {
			expect(box.x).toBeGreaterThanOrEqual(-1)
			expect(box.x + box.w).toBeLessThanOrEqual(40 * MM + 1)
			expect(box.w).toBeLessThan(20 * MM)
		}
	})
})

describe("SmartArt pyramid", () => {
	const pyramid = (dir: string): string =>
		layout(`<dgm:alg type="pyra"><dgm:param type="linDir" val="${dir}"/><dgm:param type="pyraLvlNode" val="level"/></dgm:alg>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="level"><dgm:alg type="tx"/><dgm:shape type="trapezoid"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach>`)

	it("stacks equal-height levels widening to the base, their sides lined up", () => {
		const result = run(data(THREE), pyramid("fromB"), 150 * MM, 90 * MM)

		expect(boxes(result, "level").map(round)).toEqual([
			{ x: 50 * MM, y: 0, w: 50 * MM, h: 30 * MM },
			{ x: 25 * MM, y: 30 * MM, w: 100 * MM, h: 30 * MM },
			{ x: 0, y: 60 * MM, w: 150 * MM, h: 30 * MM }
		])

		// Each side insets half the base over the count (25 mm): the trapezoid adjustment over the shorter side.
		const adjustments = shapeOf(result, "level").map(s => s.node.shape?.adj[0]?.val)

		expect(adjustments.map(v => Math.round((v ?? 0) * 1000))).toEqual([833, 833, 833])
	})

	it("turns an inverted pyramid's levels upside down, narrowing downwards", () => {
		const result = run(data(THREE), pyramid("fromT"), 150 * MM, 90 * MM)

		expect(boxes(result, "level").map(box => Math.round(box.w / MM))).toEqual([150, 100, 50])
		expect(shapeOf(result, "level").map(s => s.rot)).toEqual([180, 180, 180])
	})

	it("gives a level's text node its box through the level's composite constraints", () => {
		const xml = layout(`<dgm:alg type="pyra"><dgm:param type="pyraLvlNode" val="level"/></dgm:alg>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="slot"><dgm:alg type="composite"/><dgm:constrLst>
				<dgm:constr type="w" for="ch" forName="level" val="1"/><dgm:constr type="h" for="ch" forName="level" val="1"/>
				<dgm:constr type="ctrX" for="ch" forName="label" refType="ctrX" refFor="ch" refForName="level"/>
				<dgm:constr type="ctrY" for="ch" forName="label" refType="ctrY" refFor="ch" refForName="level"/>
				<dgm:constr type="w" for="ch" forName="label" refType="w" refFor="ch" refForName="level" fact="0.5"/>
				<dgm:constr type="h" for="ch" forName="label" refType="h" refFor="ch" refForName="level"/></dgm:constrLst>
				<dgm:layoutNode name="level"><dgm:shape type="trapezoid"/></dgm:layoutNode>
				<dgm:layoutNode name="label"><dgm:alg type="tx"/><dgm:shape type="rect" hideGeom="1"/><dgm:presOf axis="self"/></dgm:layoutNode>
			</dgm:layoutNode></dgm:forEach>`)
		const result = run(data(THREE), xml, 150 * MM, 90 * MM)

		const labels: Box[] = []
		const walk = (node: DiagramLayout["root"]): void => {
			if (node.name === "label") labels.push(node.box)

			for (const child of node.children) walk(child)
		}

		walk(result.root)

		expect(round(labels[2] as Box)).toEqual({ x: 37.5 * MM, y: 60 * MM, w: 75 * MM, h: 30 * MM })
	})
})

describe("SmartArt connectors", () => {
	const row = (conn: string, connConstraints = ""): string =>
		layout(`<dgm:alg type="lin"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="node" val="40"/><dgm:constr type="h" for="ch" forName="node" val="20"/>
			<dgm:constr type="w" for="ch" forName="link" val="20"/><dgm:constr type="h" for="ch" forName="link" val="8"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="node"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode>
			<dgm:forEach axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="link"><dgm:alg type="conn">${conn}</dgm:alg><dgm:shape type="conn"/>
			<dgm:presOf axis="self"/><dgm:constrLst>${connConstraints}</dgm:constrLst></dgm:layoutNode></dgm:forEach></dgm:forEach>`)

	it("draws a two-dimensional arrow across the gap between the nodes it joins, less its pads", () => {
		const result = run(
			data(THREE),
			row("", '<dgm:constr type="begPad" refType="connDist" fact="0.1"/><dgm:constr type="endPad" refType="connDist" fact="0.1"/>'),
			160 * MM,
			40 * MM
		)
		const links = shapeOf(result, "link")

		expect(links.map(s => s.type)).toEqual(["rightArrow", "rightArrow"])
		// The gap is 20 mm (the link's width in the line); 10% of it is padded off each end.
		expect(round(links[0]?.box as Box)).toEqual({ x: 42 * MM, y: 16 * MM, w: 16 * MM, h: 8 * MM })
		expect(links.map(s => s.rot)).toEqual([0, 0])
	})

	it("routes a one-dimensional bent connector between the facing sides and keeps its box 0.1 in deep", () => {
		const result = run(
			data(THREE),
			row(
				'<dgm:param type="dim" val="1D"/><dgm:param type="connRout" val="bend"/><dgm:param type="begPts" val="midR bCtr"/><dgm:param type="endPts" val="midL tCtr"/>'
			),
			160 * MM,
			40 * MM
		)
		const link = shapeOf(result, "link")[0]

		expect(link?.type).toBe("line")
		expect(round(link?.box as Box)).toEqual({
			x: 40 * MM,
			y: Math.round(20 * MM - MIN_CONNECTOR_EXTENT / 2),
			w: 20 * MM,
			h: MIN_CONNECTOR_EXTENT
		})

		const route = link === undefined ? undefined : connectorRoute(link.node)

		expect(route?.points.map(p => [Math.round(p.x / MM), Math.round(p.y / MM)])).toEqual([
			[40, 20],
			[50, 20],
			[50, 20],
			[60, 20]
		])
		expect(route?.endArrow).toBe(true)
	})

	// gear1's connectors as PowerPoint caches them: a circle of the diam constraint through both ends, the arrow
	// from the begin point to its head's tip on the end point, 0.6 h thick with a 1.4 h head.
	const gear = (diam: number, beg: string, end: string, src: string, dst: string): string =>
		layout(`<dgm:alg type="composite"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="src" val="1"/><dgm:constr type="h" for="ch" forName="src" val="1"/>
			<dgm:constr type="w" for="ch" forName="dst" val="1"/><dgm:constr type="h" for="ch" forName="dst" val="1"/>${src}${dst}
			<dgm:constr type="diam" for="ch" forName="link" val="${String(diam)}"/><dgm:constr type="h" for="ch" forName="link" val="5.5"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node" cnt="1"><dgm:layoutNode name="src"><dgm:alg type="sp"/><dgm:shape type="rect" hideGeom="1"/><dgm:presOf axis="self"/></dgm:layoutNode>
			<dgm:layoutNode name="dst"><dgm:alg type="sp"/><dgm:shape type="rect" hideGeom="1"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach>
			<dgm:forEach axis="ch" ptType="sibTrans" cnt="1"><dgm:layoutNode name="link"><dgm:alg type="conn"><dgm:param type="connRout" val="curve"/>
			<dgm:param type="srcNode" val="src"/><dgm:param type="dstNode" val="dst"/><dgm:param type="begPts" val="${beg}"/><dgm:param type="endPts" val="${end}"/></dgm:alg>
			<dgm:shape type="conn"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach>`)
	const adj = (shape: DiagramLayout["shapes"][number] | undefined): number[] =>
		(shape?.node.shape?.adj ?? []).map(a => Math.round(a.val * 100000))
	// Within one unit: PowerPoint's rounding of halves differs from ours.
	const near = (actual: readonly number[], expected: readonly number[]): void => {
		expect(actual).toHaveLength(expected.length)
		actual.forEach((value, i) => expect(Math.abs(value - (expected[i] ?? 0)), `${String(i)}: ${String(value)}`).toBeLessThanOrEqual(1))
	}

	it("draws a curved two-dimensional connector with a diam as a circular arrow through both ends, clockwise", () => {
		const result = run(
			data(THREE),
			gear(
				63.25,
				"midR",
				"tCtr",
				'<dgm:constr type="l" for="ch" forName="src" val="72"/><dgm:constr type="t" for="ch" forName="src" val="40"/>',
				'<dgm:constr type="r" for="ch" forName="dst" val="98"/><dgm:constr type="t" for="ch" forName="dst" val="95"/>'
			),
			100 * MM,
			100 * MM
		)
		const link = shapeOf(result, "link")[0]

		expect(link?.type).toBe("circularArrow")
		expect(link?.rot).toBe(0)
		// PowerPoint: off 1461337 1324852, ext 2534400; avLst 4687 299029 2500236 15896029 5469.
		const box = link?.box as Box

		near([box.x, box.y, box.w, box.h], [1461337, 1324852, 2534400, 2534400])
		near(adj(link), [4687, 299029, 2500236, 15896029, 5469])
	})

	it("turns a connector with a negative diam the other way, as a left circular arrow", () => {
		const result = run(
			data(THREE),
			gear(
				-44,
				"midL",
				"midL",
				'<dgm:constr type="l" for="ch" forName="src" val="23"/><dgm:constr type="t" for="ch" forName="src" val="28"/>',
				'<dgm:constr type="l" for="ch" forName="dst" val="10"/><dgm:constr type="t" for="ch" forName="dst" val="53"/>'
			),
			100 * MM,
			100 * MM
		)
		const link = shapeOf(result, "link")[0]

		// PowerPoint (gear1's second connector): off 212979 835932, ext 1841400; avLst 6452 429999 10489124 14837806 7527.
		expect(link?.type).toBe("leftCircularArrow")
		const box = link?.box as Box

		near([box.x, box.y, box.w, box.h], [212979, 835932, 1841400, 1841400])
		near(adj(link), [6452, 429999, 10489124, 14837806, 7527])
	})

	it("finds a named end inside the sibling either side of it", () => {
		// process3: the arrow between two composites joins the parTx inside each.
		const xml = layout(`<dgm:alg type="lin"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="cell" val="40"/><dgm:constr type="h" for="ch" forName="cell" val="40"/>
			<dgm:constr type="w" for="ch" forName="link" val="20"/><dgm:constr type="h" for="ch" forName="link" val="8"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="cell"><dgm:alg type="composite"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="box" refType="w" fact="0.5"/><dgm:constr type="h" for="ch" forName="box" refType="h" fact="0.5"/></dgm:constrLst>
			<dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:layoutNode>
			<dgm:forEach axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="link"><dgm:alg type="conn"><dgm:param type="srcNode" val="box"/>
			<dgm:param type="dstNode" val="box"/></dgm:alg><dgm:shape type="conn"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach></dgm:forEach>`)
		const result = run(
			data([
				{ id: "a", text: "A" },
				{ id: "b", text: "B" }
			]),
			xml,
			100 * MM,
			40 * MM
		)
		const link = shapeOf(result, "link")[0]

		expect(link?.type).toBe("rightArrow")
		expect(link?.box.w).toBeGreaterThan(30 * MM)
	})

	it("joins a parent transition's parent to its child, from the edge of a round parent", () => {
		const xml = layout(`<dgm:alg type="cycle"><dgm:param type="ctrShpMap" val="fNode"/></dgm:alg><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="hub" val="20"/><dgm:constr type="h" for="ch" forName="hub" val="20"/>
			<dgm:constr type="w" for="ch" forName="leaf" val="10"/><dgm:constr type="h" for="ch" forName="leaf" val="10"/>
			<dgm:constr type="h" for="ch" forName="spoke" val="4"/><dgm:constr type="sp" val="20"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node" cnt="1"><dgm:layoutNode name="hub"><dgm:alg type="tx"/><dgm:shape type="ellipse"/><dgm:presOf axis="self"/></dgm:layoutNode>
			<dgm:forEach axis="ch"><dgm:forEach axis="self" ptType="parTrans"><dgm:layoutNode name="spoke"><dgm:alg type="conn"><dgm:param type="endPts" val="ctr"/></dgm:alg><dgm:shape type="conn"/></dgm:layoutNode></dgm:forEach>
			<dgm:forEach axis="self" ptType="node"><dgm:layoutNode name="leaf"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach></dgm:forEach></dgm:forEach>`)
		const result = run(
			data([
				{ id: "h", text: "H" },
				{ id: "x", parent: "h", text: "X" },
				{ id: "y", parent: "h", text: "Y" }
			]),
			xml,
			200 * MM,
			200 * MM
		)
		const hub = centre(boxes(result, "hub")[0] as Box)
		const leaves = boxes(result, "leaf")
		const spokes = shapeOf(result, "spoke")

		expect(spokes).toHaveLength(2)

		for (let i = 0; i < 2; i++) {
			const spoke = spokes[i]
			const leaf = centre(leaves[i] as Box)
			const route = spoke === undefined ? undefined : connectorRoute(spoke.node)
			const start = route?.points[0]
			const end = route?.points[1]

			// From the hub's outline (10 mm out) to the leaf's centre.
			expect(Math.hypot((start?.x ?? 0) - hub.x, (start?.y ?? 0) - hub.y)).toBeCloseTo(10 * MM, -2)
			expect(Math.round(end?.x ?? 0)).toBe(Math.round(leaf.x))
			expect(spoke?.type).toBe("rightArrow")
			expect(Math.round(spoke?.box.h ?? 0)).toBe(4 * MM)
		}
	})
})

describe("SmartArt hierarchy", () => {
	const tree = (align: string, vars = ""): string =>
		layout(`<dgm:alg type="hierRoot"/><dgm:constrLst>
			<dgm:constr type="w" for="des" forName="box" val="30"/><dgm:constr type="h" for="des" forName="box" val="10"/>
			<dgm:constr type="sp" for="des" forName="tree" val="10"/><dgm:constr type="sibSp" for="des" forName="kids" val="5"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node" cnt="1"><dgm:layoutNode name="tree"><dgm:alg type="hierRoot"><dgm:param type="hierAlign" val="${align}"/></dgm:alg>${vars}
			<dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode>
			<dgm:layoutNode name="kids"><dgm:alg type="hierChild"/><dgm:forEach name="sub" axis="ch" ptType="node"><dgm:layoutNode name="tree"><dgm:alg type="hierRoot"><dgm:param type="hierAlign" val="${align}"/></dgm:alg>
			<dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode>
			<dgm:layoutNode name="kids"><dgm:alg type="hierChild"/><dgm:forEach axis="ch" ptType="node" ref="sub"/></dgm:layoutNode></dgm:layoutNode></dgm:forEach></dgm:layoutNode></dgm:layoutNode></dgm:forEach>`)
	const org = [
		{ id: "r", text: "R" },
		{ id: "a", parent: "r", text: "A" },
		{ id: "b", parent: "r", text: "B" },
		{ id: "c", parent: "r", text: "C" }
	]

	it("puts the root centred over its children, sp above them, the children sibSp apart", () => {
		const result = run(data(org), tree("tCtrCh"), 200 * MM, 100 * MM)
		const all = boxes(result, "box").map(round)

		// Children: 3 × 30 + 2 × 5 = 100 mm wide, 10 mm below the root; the 100 × 30 mm tree centred in the box.
		expect(all).toEqual([
			{ x: 85 * MM, y: 35 * MM, w: 30 * MM, h: 10 * MM },
			{ x: 50 * MM, y: 55 * MM, w: 30 * MM, h: 10 * MM },
			{ x: 85 * MM, y: 55 * MM, w: 30 * MM, h: 10 * MM },
			{ x: 120 * MM, y: 55 * MM, w: 30 * MM, h: 10 * MM }
		])
	})

	it("aligns the root to the start of its children and scales a tree too wide for the box", () => {
		const result = run(data(org), tree("tL"), 50 * MM, 100 * MM)
		const [root, first] = boxes(result, "box")

		expect(Math.round(root?.x ?? -1)).toBe(Math.round(first?.x ?? -2))
		expect(Math.round(root?.w ?? 0)).toBe(15 * MM)
	})

	it("hangs the children of a node with hierBranch l in a column", () => {
		const result = run(data(org), tree("tL", '<dgm:varLst><dgm:hierBranch val="l"/></dgm:varLst>'), 200 * MM, 200 * MM)
		const [, a, b, c] = boxes(result, "box")

		expect(Math.round(a?.x ?? 0)).toBe(Math.round(b?.x ?? 1))
		expect(Math.round(b?.x ?? 0)).toBe(Math.round(c?.x ?? 1))
		expect(Math.round((b?.y ?? 0) - (a?.y ?? 0))).toBe(15 * MM)
	})
})

describe("SmartArt composite and linear fitting", () => {
	it("lays a composite with an aspect ratio in the largest box of that shape, centred", () => {
		const xml = layout(`<dgm:alg type="composite"><dgm:param type="ar" val="1"/></dgm:alg><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="disc" refType="w"/><dgm:constr type="h" for="ch" forName="disc" refType="h"/></dgm:constrLst>
			<dgm:layoutNode name="disc"><dgm:shape type="ellipse"/></dgm:layoutNode>`)

		expect(round(boxes(run(data(THREE), xml, 300 * MM, 100 * MM), "disc")[0] as Box)).toEqual({
			x: 100 * MM,
			y: 0,
			w: 100 * MM,
			h: 100 * MM
		})
	})

	it("draws a shape its definition turns by other than a quarter turn inside its box, footprint and all", () => {
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="gear" val="48"/><dgm:constr type="h" for="ch" forName="gear" val="48"/>
			<dgm:constr type="l" for="ch" forName="gear" val="10"/><dgm:constr type="t" for="ch" forName="gear" val="0"/></dgm:constrLst>
			<dgm:layoutNode name="gear"><dgm:alg type="sp"/><dgm:shape rot="-15" type="gear6"/></dgm:layoutNode>`)
		const gear = run(data(THREE), xml, 100 * MM, 100 * MM).shapes.find(s => s.name === "gear")
		const side = (48 * MM) / (Math.cos(Math.PI / 12) + Math.sin(Math.PI / 12))

		// gear1's gear3 in PowerPoint's cache: 1410906 EMU for a 48 mm box, about the box's centre.
		expect(Math.round(side)).toBe(1410906)
		expect(round(gear?.box as Box)).toEqual(round({ x: 34 * MM - side / 2, y: 24 * MM - side / 2, w: side, h: side }))
		expect(gear?.rot).toBe(-15)
	})

	it("scales a column of composites with an aspect ratio down whole, their spacing with them", () => {
		// AlternatingHexagons: composites as large as the diagram at ar 3.6, overlapping by 0.042 of their width.
		const xml = layout(`<dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/></dgm:alg><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="row" refType="w"/><dgm:constr type="h" for="ch" forName="row" refType="h"/>
			<dgm:constr type="h" for="ch" forName="gap" refType="w" refFor="ch" refForName="row" fact="-0.042"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="row"><dgm:alg type="composite"><dgm:param type="ar" val="3.6"/></dgm:alg>
			<dgm:constrLst><dgm:constr type="w" for="ch" forName="cell" refType="w"/><dgm:constr type="h" for="ch" forName="cell" refType="h"/></dgm:constrLst>
			<dgm:layoutNode name="cell"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode></dgm:layoutNode>
			<dgm:forEach axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="gap"><dgm:alg type="sp"/></dgm:layoutNode></dgm:forEach></dgm:forEach>`)
		const cells = boxes(run(data(THREE), xml, 1200150, 800100), "cell").map(round)
		// PowerPoint's cache: 296586 high, 3.6 times as wide, centred, 251742 apart.
		const h = 800100 / (3 - 2 * 0.042 * 3.6)

		expect(cells.map(c => c.h)).toEqual([0, 1, 2].map(() => Math.round(h)))
		expect(cells.map(c => c.w)).toEqual([0, 1, 2].map(() => Math.round(h * 3.6)))
		expect(cells.map(c => c.x)).toEqual([0, 1, 2].map(() => Math.round((1200150 - h * 3.6) / 2)))
		expect(cells.map(c => c.y)).toEqual([0, 1, 2].map(i => Math.round(i * h * (1 - 0.042 * 3.6))))
	})

	it("makes a line centred across its direction as deep as its children there", () => {
		// hProcess3: the row is the diagram's height by constraint, centred; PowerPoint starts its 40 mm content
		// (its tallest child) at the middle less 20 mm.
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="row" refType="w"/><dgm:constr type="h" for="ch" forName="row" refType="h"/>
			<dgm:constr type="ctrX" for="ch" forName="row" refType="w" fact="0.5"/><dgm:constr type="ctrY" for="ch" forName="row" refType="h" fact="0.5"/></dgm:constrLst>
			<dgm:layoutNode name="row"><dgm:alg type="lin"><dgm:param type="nodeVertAlign" val="t"/></dgm:alg><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="cell" val="20"/><dgm:constr type="h" for="ch" forName="cell" val="20"/>
			<dgm:constr type="w" for="ch" forName="tall" val="20"/><dgm:constr type="h" for="ch" forName="tall" val="40"/></dgm:constrLst>
			<dgm:layoutNode name="cell"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode>
			<dgm:layoutNode name="tall"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode></dgm:layoutNode>`)
		const result = run(data(THREE), xml, 100 * MM, 100 * MM)

		expect(round(boxes(result, "tall")[0] as Box).y).toBe(30 * MM)
		expect(round(boxes(result, "cell")[0] as Box).y).toBe(30 * MM)
	})

	it("flows composites with an aspect ratio in a snake at that shape", () => {
		// PictureStrips: strips at ar 3 as large as the diagram stack in one column.
		const xml = layout(`<dgm:alg type="snake"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="strip" refType="w"/><dgm:constr type="h" for="ch" forName="strip" refType="h"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="strip"><dgm:alg type="composite"><dgm:param type="ar" val="3"/></dgm:alg>
			<dgm:constrLst><dgm:constr type="w" for="ch" forName="cell" refType="w"/><dgm:constr type="h" for="ch" forName="cell" refType="h"/></dgm:constrLst>
			<dgm:layoutNode name="cell"><dgm:alg type="sp"/><dgm:shape type="rect"/></dgm:layoutNode></dgm:layoutNode></dgm:forEach>`)
		const cells = boxes(run(data(THREE), xml, 170 * MM, 150 * MM), "cell")

		expect(new Set(cells.map(c => Math.round(c.x))).size).toBe(1)
		expect(Math.round((cells[0] as Box).w / (cells[0] as Box).h)).toBe(3)
	})

	it("takes a sibling's position the algorithm gave it when a constraint refers to it", () => {
		const xml = layout(`<dgm:alg type="composite"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="outer" val="100"/><dgm:constr type="h" for="ch" forName="outer" val="100"/>
			<dgm:constr type="w" for="ch" forName="inner" val="50"/><dgm:constr type="h" for="ch" forName="inner" val="50"/>
			<dgm:constr type="ctrX" for="ch" forName="inner" refType="ctrX" refFor="ch" refForName="outer"/>
			<dgm:constr type="b" for="ch" forName="inner" refType="b" refFor="ch" refForName="outer"/></dgm:constrLst>
			<dgm:layoutNode name="outer"><dgm:shape type="ellipse"/></dgm:layoutNode><dgm:layoutNode name="inner"><dgm:shape type="ellipse"/></dgm:layoutNode>`)

		expect(round(boxes(run(data(THREE), xml, 100 * MM, 100 * MM), "inner")[0] as Box)).toEqual({
			x: 25 * MM,
			y: 50 * MM,
			w: 50 * MM,
			h: 50 * MM
		})
	})

	it("shrinks a line of sizes taken from an ancestor along the line, and their contents with them", () => {
		const xml = layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="w" for="des" forName="cell" refType="w"/>
			<dgm:constr type="h" for="des" forName="cell" refType="h" fact="0.5"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="cell"><dgm:alg type="composite"/><dgm:constrLst>
			<dgm:constr type="w" for="ch" forName="mark" refType="w" fact="0.5"/><dgm:constr type="h" for="ch" forName="mark" refType="h"/></dgm:constrLst>
			<dgm:layoutNode name="mark"><dgm:shape type="rect"/></dgm:layoutNode></dgm:layoutNode></dgm:forEach>`)
		const result = run(data(THREE), xml, 300 * MM, 100 * MM)

		expect(boxes(result, "mark").map(box => [Math.round(box.x / MM), Math.round(box.w / MM), Math.round(box.h / MM)])).toEqual([
			[0, 50, 50],
			[100, 50, 50],
			[200, 50, 50]
		])
	})
})

describe("SmartArt hierarchy blocks", () => {
	it("keeps sp between an assistants' block and the staff block as between the root and the first", () => {
		const xml = layout(`<dgm:alg type="hierRoot"/><dgm:constrLst><dgm:constr type="sp" val="8"/>
			<dgm:constr type="w" for="des" forName="box" val="20"/><dgm:constr type="h" for="des" forName="box" val="10"/></dgm:constrLst>
			<dgm:forEach axis="ch" ptType="node" cnt="1"><dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode>
			<dgm:layoutNode name="staff"><dgm:alg type="hierChild"/><dgm:forEach axis="ch" ptType="nonAsst"><dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach></dgm:layoutNode>
			<dgm:layoutNode name="assistants"><dgm:alg type="hierChild"/><dgm:forEach axis="ch" ptType="asst"><dgm:layoutNode name="box"><dgm:alg type="tx"/><dgm:shape type="rect"/><dgm:presOf axis="self"/></dgm:layoutNode></dgm:forEach></dgm:layoutNode></dgm:forEach>`)
		const result = run(
			data([
				{ id: "m", text: "M" },
				{ id: "a", parent: "m", type: "asst", text: "A" },
				{ id: "s", parent: "m", text: "S" }
			]),
			xml,
			200 * MM,
			200 * MM
		)
		const box = (id: string): Box => result.shapes.find(shape => shape.text[0]?.id === id)?.box as Box
		const scale = box("m").h / (10 * MM)

		// Root, then the assistant (sp below the root), then the staff (sp below the assistant).
		expect(box("a").y - (box("m").y + box("m").h)).toBeCloseTo(8 * MM * scale, -3)
		expect(box("s").y - (box("a").y + box("a").h)).toBeCloseTo(8 * MM * scale, -3)
	})
})

describe("SmartArt org chart connectors (orgChart1 as the corpus deck embeds it)", () => {
	const deck = join(CORPUS_DIR, "pptx/oxsdk__SmartArt_OrgChart1_3D_Animation_Fly_In_by_level_one_by_one_.pptx")

	async function orgChart(): Promise<string | undefined> {
		if (!existsSync(deck)) return undefined

		const pkg = await OpcPackage.open(bytesSource(readFileSync(deck)))

		return new TextDecoder().decode(await pkg.read("ppt/diagrams/layout1.xml"))
	}

	it("hangs a manager's staff in a column set in from it, each line dropping from the manager's bottom into the staff box's side", async () => {
		const layoutXml = await orgChart()

		if (layoutXml === undefined) return

		const result = run(
			data([
				{ id: "top", text: "Top" },
				{ id: "mid", text: "Mid", parent: "top" },
				{ id: "b1", text: "B1", parent: "mid" },
				{ id: "b2", text: "B2", parent: "mid" }
			]),
			layoutXml,
			8128000,
			5418667
		)
		const box = (id: string): Box => result.shapes.find(s => s.text[0]?.id === id)?.box as Box
		const mid = box("mid")

		for (const id of ["b1", "b2"]) {
			const child = box(id)
			const line = result.shapes.find(s => s.type === "line" && s.node.point.type === "parTrans" && joinsTo(s.node.point.id, id))
			const route = line === undefined ? undefined : connectorRoute(line.node)
			const first = route?.points[0]
			const last = route?.points[route.points.length - 1]

			expect(child.x).toBeGreaterThan(mid.x)
			// From the manager's bottom edge (begPts bCtr of its rootConnector) to the middle of the staff box's left side.
			expect(Math.abs((first?.y ?? 0) - (mid.y + mid.h))).toBeLessThan(MM)
			expect(Math.abs((last?.x ?? 0) - child.x)).toBeLessThan(MM)
			expect(Math.abs((last?.y ?? 0) - (child.y + child.h / 2))).toBeLessThan(MM)
			expect(route?.points).toHaveLength(3)
		}
	})
})

// The data fixture names a parent transition after its child (`<id>p`).
function joinsTo(transition: string, child: string): boolean {
	return transition === `${child}p`
}
