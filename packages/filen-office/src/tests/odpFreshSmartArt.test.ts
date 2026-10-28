import { describe, expect, it } from "vitest"
import { freshOdp } from "../core/odp/write/fresh"
import { slideRef, type ShapeNode } from "../core/presentation/model"
import { FIXTURE_FIRST_SLIDE, fixtureBody, fixtureDeck } from "./fixtures/presentation/deck"

// ODF has no diagrams: a laid-out SmartArt frame (its shapes as children, in the frame's own space) is written whole
// as the group of them; one with no shapes yet is omitted and reported, never dropped in silence.

const BOX = { x: 914_400, y: 914_400, cx: 3_000_000, cy: 1_000_000, rot: 0, flipH: false, flipV: false }

function node(id: number, text: string, x: number): ShapeNode {
	return {
		id,
		name: `Node ${text}`,
		hidden: false,
		kind: "sp",
		xfrm: { x, y: 0, cx: 900_000, cy: 1_000_000, rot: 0, flipH: false, flipV: false },
		props: { geometry: { kind: "preset", preset: "rect", guides: [] } },
		text: fixtureBody([text])
	}
}

function diagram(children?: ShapeNode[]): ShapeNode {
	return {
		id: 40,
		name: "Diagram 39",
		hidden: false,
		kind: "frame",
		xfrm: BOX,
		frame: { kind: "smartart", data: "/ppt/diagrams/data1.xml", layout: "/ppt/diagrams/layout1.xml", style: "s", colors: "c" },
		...(children === undefined ? {} : { children })
	}
}

async function content(shape: ShapeNode, diagram?: (frame: ShapeNode) => readonly ShapeNode[] | undefined) {
	const deck = fixtureDeck(1)
	const slide = deck.nodes.get(slideRef(FIXTURE_FIRST_SLIDE))

	if (slide === undefined) throw new Error("fixture slide missing")

	slide.shapes.push(shape)

	const fresh = await freshOdp(deck, {
		theme: () => undefined,
		picture: () => Promise.resolve(undefined),
		...(diagram === undefined ? {} : { diagram })
	})

	if ("kind" in fresh) throw new Error(`refused ${fresh.reason}`)

	const part = fresh.parts.find(change => change.name === "content.xml")

	return { xml: part === undefined ? "" : new TextDecoder().decode(part.bytes as Uint8Array), report: fresh.report }
}

describe("fresh ODP of SmartArt", () => {
	it("writes a laid-out diagram as one group of its shapes, with every node's text", async () => {
		const { xml, report } = await content(diagram([node(41, "Alpha", 0), node(42, "Beta", 1_000_000), node(43, "Gamma", 2_000_000)]))
		const group = /<draw:g\b[^>]*draw:name="Diagram 39"[\s\S]*?<\/draw:g>/u.exec(xml)?.[0] ?? ""

		for (const text of ["Alpha", "Beta", "Gamma"]) expect(group).toContain(text)
		expect(report.omitted["smartart frame"]).toBeUndefined()
	})

	it("writes a diagram its source lays out (its drawing's shapes) as one group of them", async () => {
		const frame = diagram()
		const { xml, report } = await content(frame, shape =>
			shape === frame ? [node(41, "Alpha", 0), node(42, "Beta", 1_000_000)] : undefined
		)
		const group = /<draw:g\b[^>]*draw:name="Diagram 39"[\s\S]*?<\/draw:g>/u.exec(xml)?.[0] ?? ""

		for (const text of ["Alpha", "Beta"]) expect(group).toContain(text)
		expect(report.omitted["smartart frame"]).toBeUndefined()
	})

	it("omits a diagram with no shapes yet, and reports it", async () => {
		const { xml, report } = await content(diagram())

		expect(xml).not.toContain("Diagram 39")
		expect(report.omitted["smartart frame"]).toBe(1)
	})
})
