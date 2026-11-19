import { describe, expect, it } from "vitest"
import { NUDGE_LARGE_PX, NUDGE_PX, nudgedShapes, nudgeOp, type PlacedShape } from "../core/presentation/edit/commands/shape"
import { EMU_PER_PX } from "../core/drawingml/reader"
import { slideRef, type Xfrm } from "../core/presentation/model"

// The boxes the overlay shows after an arrow key until the render arrives are the ones the nudge op writes.

const slide = slideRef(256)
const box = (x: number, y: number): Xfrm => ({ x, y, cx: 100, cy: 100, rot: 0, flipH: false, flipV: false })

describe("nudgedShapes", () => {
	const shapes: PlacedShape[] = [
		{ id: 3, xfrm: box(1000.4, 2000.6) },
		{ id: 4, xfrm: box(-50, 7) },
		{ id: 5, xfrm: box(10, 10), locks: { noMove: true } }
	]

	for (const large of [false, true]) {
		it(`gives the boxes the op writes, ${large ? "with" : "without"} Shift`, () => {
			const step = (large ? NUDGE_LARGE_PX : NUDGE_PX) * EMU_PER_PX

			for (const direction of ["left", "right", "up", "down"] as const) {
				const boxes = nudgedShapes(shapes, direction, large)
				const op = nudgeOp(slide, shapes, direction, large)

				expect(op?.family === "shape" && op.kind === "setXfrms" ? op.xfrms : undefined).toEqual(
					boxes.filter(shape => shape.id !== 5).map(shape => ({ id: shape.id, xfrm: shape.xfrm }))
				)
				expect(boxes[2]).toBe(shapes[2])
			}

			expect(nudgedShapes(shapes, "right", large)[0]?.xfrm).toMatchObject({ x: Math.round(1000.4 + step), y: Math.round(2000.6) })
		})
	}

	it("moves nothing, and makes no op, when every shape is locked", () => {
		const locked: PlacedShape[] = [{ id: 5, xfrm: box(10, 10), locks: { noMove: true } }]

		expect(nudgedShapes(locked, "up", true)).toEqual(locked)
		expect(nudgeOp(slide, locked, "up", true)).toBeUndefined()
	})
})
