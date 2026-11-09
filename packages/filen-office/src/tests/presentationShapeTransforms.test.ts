import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { canGroup, canUngroup, ungroupOps } from "../core/presentation/edit/commands/group"
import { lineEndXfrm, lineEnds, moveOp, nudgeOp, rotateOp, type PlacedShape } from "../core/presentation/edit/commands/shape"
import { slideRef, type Xfrm } from "../core/presentation/model"
import { ShapeDrag } from "../react/presentation/edit/handles"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { buildPptx, sp, xfrm } from "./pptxFixtures"

const slide = slideRef(256)
const box = (x: number, y: number, cx: number, cy: number, more: Partial<Xfrm> = {}): Xfrm => ({
	x,
	y,
	cx,
	cy,
	rot: 0,
	flipH: false,
	flipV: false,
	...more
})
const round = (point: { x: number; y: number }): [number, number] => [Math.round(point.x), Math.round(point.y)]
const NO_KEYS = { shift: false, ctrl: false, alt: false }

describe("dragging a line's ends", () => {
	it("a horizontal line's right end dragged up moves that end and keeps the left one", () => {
		const line = box(0, 1000, 1000, 0)
		const next = lineEndXfrm(line, "end", { x: 1000, y: 500 })
		const ends = lineEnds(next)

		expect(round(ends.start)).toEqual([0, 1000])
		expect(round(ends.end)).toEqual([1000, 500])
		expect(next).toMatchObject({ cx: 1000, cy: 500, flipV: true, flipH: false })
	})

	it("an end dragged past the other flips the box instead of collapsing it", () => {
		const line = box(1000, 1000, 1000, 500)
		const next = lineEndXfrm(line, "end", { x: 500, y: 800 })
		const ends = lineEnds(next)

		expect(round(ends.start)).toEqual([1000, 1000])
		expect(round(ends.end)).toEqual([500, 800])
		expect(next).toMatchObject({ x: 500, y: 800, cx: 500, cy: 200, flipH: true, flipV: true })
	})

	it("a flipped line's ends are where it draws them, and a turned line keeps its turn", () => {
		const flipped = box(0, 0, 1000, 500, { flipH: true })

		expect(round(lineEnds(flipped).start)).toEqual([1000, 0])
		expect(round(lineEnds(flipped).end)).toEqual([0, 500])

		const turned = box(0, 0, 1000, 0, { rot: 90 * 60000 })
		const ends = lineEnds(turned)

		expect(round(ends.start)).toEqual([500, -500])
		expect(round(ends.end)).toEqual([500, 500])

		const next = lineEndXfrm(turned, "end", { x: 500, y: 1500 })

		expect(next.rot).toBe(90 * 60000)
		expect(round(lineEnds(next).start)).toEqual([500, -500])
		expect(round(lineEnds(next).end)).toEqual([500, 1500])
	})

	it("with Shift the line from the other end lands on a 15° step", () => {
		const next = lineEndXfrm(box(0, 0, 1000, 0), "end", { x: 1000, y: 30 }, true)
		const end = lineEnds(next).end

		expect(Math.round(end.y)).toBe(0)
	})

	it("an end drag changes only the line, as one op", () => {
		const line: PlacedShape = { id: 3, xfrm: box(0, 1000, 1000, 0), line: true }
		const other: PlacedShape = { id: 4, xfrm: box(5000, 5000, 100, 100) }
		const drag = new ShapeDrag({
			kind: "end",
			slide,
			shapes: [line, other],
			id: 3,
			end: "end",
			start: { x: 1000, y: 1000 },
			threshold: 0
		})

		drag.move({ x: 1000, y: 500 }, NO_KEYS)
		expect(drag.end()).toMatchObject({ kind: "setXfrm", target: { id: 3 }, xfrm: { cy: 500, flipV: true } })
	})
})

describe("the file's own locks in commands", () => {
	const locked: PlacedShape = { id: 3, xfrm: box(0, 0, 1000, 500), locks: { noMove: true, noRot: true } }
	const free: PlacedShape = { id: 4, xfrm: box(2000, 0, 1000, 500) }

	it("a move, a nudge or a turn leaves a shape locked against it where it is", () => {
		expect(moveOp(slide, [locked, free], 100, 0)).toMatchObject({ kind: "setXfrm", target: { id: 4 } })
		expect(nudgeOp(slide, [locked], "left", false)).toBeUndefined()
		expect(rotateOp(slide, [locked, free], 1)).toMatchObject({ kind: "setXfrm", target: { id: 4 } })
	})

	it("a corner of a picture with a locked aspect keeps its proportions, and Shift frees them", () => {
		const picture: PlacedShape = { id: 5, xfrm: box(0, 0, 2000, 1000), locks: { noChangeAspect: true } }
		const drag = (shift: boolean) => {
			const each = new ShapeDrag({
				kind: "resize",
				slide,
				shapes: [picture],
				id: 5,
				handle: "se",
				start: { x: 2000, y: 1000 },
				threshold: 0
			})

			each.move({ x: 3000, y: 1100 }, { ...NO_KEYS, shift })

			return each.current.shapes[0]?.xfrm
		}

		expect(drag(false)).toMatchObject({ cx: 3000, cy: 1500 })
		expect(drag(true)).toMatchObject({ cx: 3000, cy: 1100 })

		const side = new ShapeDrag({
			kind: "resize",
			slide,
			shapes: [picture],
			id: 5,
			handle: "e",
			start: { x: 2000, y: 500 },
			threshold: 0
		})

		side.move({ x: 4000, y: 500 }, NO_KEYS)
		// The other side scales about its middle.
		expect(side.current.shapes[0]?.xfrm).toMatchObject({ x: 0, y: -500, cx: 4000, cy: 2000 })
	})

	it("a drag of the selection moves only what may move, and a resize leaves a shape locked against resizing", () => {
		const fixed: PlacedShape = { id: 6, xfrm: box(0, 0, 1000, 1000), locks: { noResize: true } }
		const move = new ShapeDrag({ kind: "move", slide, shapes: [locked, free], start: { x: 0, y: 0 }, threshold: 0 })

		move.move({ x: 500, y: 0 }, NO_KEYS)
		expect(move.current.shapes.map(shape => shape.xfrm.x)).toEqual([0, 2500])

		const resize = new ShapeDrag({
			kind: "resize",
			slide,
			shapes: [free, fixed],
			id: 4,
			handle: "e",
			start: { x: 3000, y: 250 },
			threshold: 0
		})

		resize.move({ x: 4000, y: 250 }, NO_KEYS)
		expect(resize.current.shapes[1]?.xfrm).toEqual(fixed.xfrm)
	})

	it("grouping and ungrouping honour noGrp and noUngrp", () => {
		expect(
			canGroup([
				{ id: 1, role: "shape" },
				{ id: 2, role: "shape", locks: { noGrp: true } }
			])
		).toBe(false)
		expect(canUngroup([{ id: 1, role: "group", locks: { noUngrp: true } }])).toBe(false)
		expect(ungroupOps(slide, [{ id: 1, role: "group", locks: { noUngrp: true } }])).toEqual([])
	})
})

describe("Ctrl+drag duplicates", () => {
	const back: PlacedShape = { id: 7, xfrm: box(0, 0, 1000, 500) }
	const front: PlacedShape = { id: 8, xfrm: box(2000, 0, 1000, 500) }
	const pinned: PlacedShape = { id: 9, xfrm: box(4000, 0, 1000, 500), locks: { noMove: true } }
	const CTRL = { shift: false, ctrl: true, alt: false }

	it("a move with Ctrl held ends in one duplicate of what may move, at the drop offset", () => {
		const drag = new ShapeDrag({ kind: "move", slide, shapes: [back, front, pinned], start: { x: 0, y: 0 }, threshold: 0 })
		const frame = drag.move({ x: 300, y: 700 }, CTRL)

		expect(frame.copy).toBe(true)
		// The boxes shown are the copies'; the locked shape has none.
		expect(frame.shapes.map(shape => [shape.id, shape.xfrm.x, shape.xfrm.y])).toEqual([
			[7, 300, 700],
			[8, 2300, 700]
		])
		expect(drag.end()).toEqual({ family: "shape", kind: "duplicate", slide, shapes: [7, 8], dx: 300, dy: 700 })
	})

	it("Ctrl pressed or released during the drag decides at the drop, and Shift still constrains the copy", () => {
		const drag = new ShapeDrag({ kind: "move", slide, shapes: [back], start: { x: 0, y: 0 }, threshold: 0 })

		drag.move({ x: 300, y: 50 }, CTRL)
		drag.move({ x: 300, y: 50 }, NO_KEYS)
		expect(drag.current.copy).toBeUndefined()
		expect(drag.end()).toMatchObject({ kind: "setXfrm" })

		drag.move({ x: 300, y: 50 }, { shift: true, ctrl: true, alt: false })
		expect(drag.end()).toMatchObject({ kind: "duplicate", dx: 300, dy: 0 })
	})

	it("a Ctrl+drag back to where it started copies nothing, and Ctrl on a resize still sizes from the centre", () => {
		const drag = new ShapeDrag({ kind: "move", slide, shapes: [back], start: { x: 0, y: 0 }, threshold: 0 })

		drag.move({ x: 0, y: 0 }, CTRL)
		expect(drag.end()).toBeUndefined()

		const resize = new ShapeDrag({
			kind: "resize",
			slide,
			shapes: [back],
			id: 7,
			handle: "e",
			start: { x: 1000, y: 250 },
			threshold: 0
		})

		expect(resize.move({ x: 1500, y: 250 }, CTRL).copy).toBeUndefined()
		expect(resize.current.shapes[0]?.xfrm).toMatchObject({ x: -500, cx: 2000 })
	})
})

describe("ungroup", () => {
	it("a nested group without a child space keeps its children where they showed when its parent is ungrouped", async () => {
		const inner =
			'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="11" name="Inner"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000" cy="500"/></a:xfrm></p:grpSpPr>' +
			sp(12, "Leaf", undefined, `${xfrm(0, 0, 500, 500)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`) +
			sp(13, "Leaf2", undefined, `${xfrm(500, 0, 500, 500)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`) +
			"</p:grpSp>"
		const outer =
			'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Outer"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="5000" y="5000"/><a:ext cx="2000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="500"/></a:xfrm></p:grpSpPr>' +
			inner +
			"</p:grpSp>"
		const h = await editHarness(buildPptx({ slides: [{ shapes: outer }] }), { emit: emitPptx } as never)
		const node = await h.slide(0)

		for (const op of ungroupOps(node.ref, [{ id: 10, role: "group" }])) expect(await h.command(op)).toMatchObject({ ok: true })

		const group = shapeById(node.shapes, 11)?.xfrm as Xfrm
		// Leaf 12 (0,0) of the inner space shows at (5000, 5000), scaled by 2.
		const sx = group.cx / (group.chCx ?? group.cx)

		expect([group.x, group.cx, group.chX, group.chCx]).toEqual([5000, 2000, 0, 1000])
		expect(group.x + (0 - (group.chX ?? group.x)) * sx).toBe(5000)
		h.close()
	})
})
