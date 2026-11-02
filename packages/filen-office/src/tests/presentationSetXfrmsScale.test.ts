import { describe, expect, it } from "vitest"
import { applyShape } from "../core/presentation/edit/apply/shape"
import type { ApplyContext } from "../core/presentation/edit/apply"
import { slideRef, type Deck, type ShapeNode, type SlideNode, type Xfrm } from "../core/presentation/model"
import { budget, cpuMs } from "./timing"

// Moving many shapes as one step (the arrange commands, an ink selection) costs time linear in the shapes moved: each
// is found once, by one index of the slide's shapes.

const BOX: Xfrm = { x: 0, y: 0, cx: 100, cy: 100, rot: 0, flipH: false, flipV: false }

function deckOf(count: number): { readonly deck: Deck; readonly node: SlideNode } {
	const ref = slideRef(256)
	const shapes: ShapeNode[] = Array.from({ length: count }, (_, k) => ({
		id: k + 2,
		name: "",
		hidden: false,
		kind: "sp",
		xfrm: { ...BOX, x: k }
	}))
	const node = {
		ref,
		kind: "slide",
		part: "/ppt/slides/slide1.xml",
		shapes,
		comments: [],
		revision: 0,
		showMasterShapes: true,
		hidden: false
	} as unknown as SlideNode
	const deck = { gate: [], format: "pptx", size: { cx: 12_192_000, cy: 6_858_000 }, nodes: new Map([[ref, node]]) } as unknown as Deck

	return { deck, node }
}

const CONTEXT = {} as ApplyContext

function moveAll(count: number): number {
	const { deck, node } = deckOf(count)
	const xfrms = node.shapes.map(shape => ({ id: shape.id, xfrm: { ...(shape.xfrm as Xfrm), y: 50 } }))
	let best = Number.POSITIVE_INFINITY

	for (let run = 0; run < 3; run++) {
		const start = cpuMs()
		const result = applyShape.apply(deck, { family: "shape", kind: "setXfrms", slide: node.ref, xfrms }, CONTEXT)

		best = Math.min(best, cpuMs() - start)
		expect(result.kind).toBe("applied")
	}

	expect(node.shapes.every(shape => shape.xfrm?.y === 50)).toBe(true)

	return best
}

describe("moving many shapes in one step", () => {
	it("moves 8,000 shapes in a few milliseconds of CPU", () => {
		moveAll(500)

		expect(moveAll(8000)).toBeLessThan(budget(25))
	})
})
