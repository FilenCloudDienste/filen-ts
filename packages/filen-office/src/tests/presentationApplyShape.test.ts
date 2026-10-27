import { describe, expect, it } from "vitest"
import { applyOp, type ApplyContext } from "../core/presentation/edit/apply"
import { nextShapeId } from "../core/presentation/ids"
import { slideRef, type ShapeNode, type SlideRef } from "../core/presentation/model"
import { FIXTURE_FIRST_SLIDE, fixtureDeck } from "./fixtures/presentation/deck"

// Inserting shapes on the model: ids stay unique on the slide, whatever the page sent.

function ids(shapes: readonly ShapeNode[], into: number[] = []): number[] {
	for (const shape of shapes) {
		into.push(shape.id)
		ids(shape.children ?? [], into)
	}

	return into
}

describe("shape insert", () => {
	it("gives each id-less child of an inserted group its own id", () => {
		const deck = fixtureDeck()
		const slide = slideRef(FIXTURE_FIRST_SLIDE)
		const context: ApplyContext = {
			sourceBytes: () => new Uint8Array(0),
			newShapeId: (ref: SlideRef) => nextShapeId(deck.nodes.get(ref)?.shapes ?? []),
			newSlideRef: () => slideRef(99)
		}
		const child = (name: string): ShapeNode => ({
			id: 0,
			name,
			hidden: false,
			kind: "sp",
			xfrm: { x: 0, y: 0, cx: 10, cy: 10, rot: 0, flipH: false, flipV: false }
		})
		const group: ShapeNode = { id: 0, name: "G", hidden: false, kind: "grpSp", children: [child("a"), child("b"), child("c")] }

		expect(applyOp(deck, { family: "shape", kind: "insert", slide, shape: group }, context).kind).toBe("applied")

		const all = ids(deck.nodes.get(slide)?.shapes ?? [])

		expect(new Set(all).size).toBe(all.length)
		expect(all.every(id => id > 0)).toBe(true)
	})
})
