import { describe, expect, it } from "vitest"
import { alignOp, distributeOp } from "../core/presentation/edit/commands/align"
import { canZOrder, zOrderOp } from "../core/presentation/edit/commands/arrange"
import { canGroup, canUngroup, groupOp, ungroupOps } from "../core/presentation/edit/commands/group"
import {
	actionOp,
	altOp,
	constrainMove,
	dragTurn,
	flipOp,
	moveOp,
	nudgeOp,
	resizedXfrm,
	rotateOp,
	scaledXfrm,
	steppedShapes,
	turnedShapes,
	turnedXfrm,
	xfrmsOp
} from "../core/presentation/edit/commands/shape"
import { slideRef, type Xfrm } from "../core/presentation/model"

const slide = slideRef(256)
const box = (x: number, y: number, cx: number, cy: number, rot = 0): Xfrm => ({ x, y, cx, cy, rot, flipH: false, flipV: false })
const DEG = 60000

// The box's centre and the slide point its corner (fx, fy) shows at.
function corner(xfrm: Xfrm, fx: number, fy: number): { x: number; y: number } {
	const angle = (xfrm.rot / DEG / 180) * Math.PI
	const lx = (fx - 0.5) * xfrm.cx
	const ly = (fy - 0.5) * xfrm.cy

	return {
		x: xfrm.x + xfrm.cx / 2 + lx * Math.cos(angle) - ly * Math.sin(angle),
		y: xfrm.y + xfrm.cy / 2 + lx * Math.sin(angle) + ly * Math.cos(angle)
	}
}

describe("presentation shape transforms", () => {
	it("a box changed in one shape is setXfrm; in several, one setXfrms; unchanged boxes are left out", () => {
		const a = { id: 3, xfrm: box(0, 0, 100, 100) }
		const b = { id: 4, xfrm: box(200, 0, 100, 100) }

		expect(xfrmsOp(slide, [a, b], [a, b])).toBeUndefined()
		expect(xfrmsOp(slide, [a, b], [{ id: 3, xfrm: box(5, 0, 100, 100) }, b])).toEqual({
			family: "shape",
			kind: "setXfrm",
			target: { slide, id: 3 },
			xfrm: box(5, 0, 100, 100)
		})
		expect(moveOp(slide, [a, b], 10, -20)).toEqual({
			family: "shape",
			kind: "setXfrms",
			slide,
			xfrms: [
				{ id: 3, xfrm: box(10, -20, 100, 100) },
				{ id: 4, xfrm: box(210, -20, 100, 100) }
			]
		})
	})

	it("an arrow key nudges by 1 slide px, by 10 with Shift", () => {
		const shapes = [{ id: 3, xfrm: box(1000, 1000, 100, 100) }]

		expect(nudgeOp(slide, shapes, "right", false)).toMatchObject({ xfrm: { x: 1000 + 9525, y: 1000 } })
		expect(nudgeOp(slide, shapes, "up", true)).toMatchObject({ xfrm: { x: 1000, y: 1000 - 95250 } })
	})

	it("Shift keeps a drag on the axis it moved most along", () => {
		expect(constrainMove(30, -10)).toEqual({ dx: 30, dy: 0 })
		expect(constrainMove(3, -10)).toEqual({ dx: 0, dy: -10 })
	})

	it("dragging the east handle of an unturned box widens it and keeps its west edge", () => {
		expect(resizedXfrm(box(100, 100, 400, 200), "e", 50, 999)).toEqual(box(100, 100, 450, 200))
		expect(resizedXfrm(box(100, 100, 400, 200), "nw", -100, -50)).toEqual(box(0, 50, 500, 250))
	})

	it("a turned box is resized along its own axes and its opposite corner stays on the slide", () => {
		const from = box(1000, 1000, 400, 200, 90 * DEG)
		const fixed = corner(from, 0, 0)
		// Turned a quarter clockwise, the box's own +x points down the slide: the se handle moved down 60 widens it.
		const to = resizedXfrm(from, "se", 0, 60)

		expect(to.cx).toBe(460)
		expect(to.cy).toBe(200)
		expect(to.rot).toBe(90 * DEG)

		const kept = corner(to, 0, 0)

		expect(Math.abs(kept.x - fixed.x)).toBeLessThanOrEqual(1)
		expect(Math.abs(kept.y - fixed.y)).toBeLessThanOrEqual(1)
	})

	it("Shift on a corner keeps the proportions; Ctrl resizes about the centre", () => {
		expect(resizedXfrm(box(0, 0, 400, 200), "se", 100, 0, { keepRatio: true })).toEqual(box(0, 0, 500, 250))
		expect(resizedXfrm(box(0, 0, 400, 200), "e", 50, 0, { fromCentre: true })).toEqual(box(-50, 0, 500, 200))
		// A side handle keeps them only when asked (a locked aspect): the other side scales about its middle.
		expect(resizedXfrm(box(0, 0, 400, 200), "e", 100, 0)).toEqual(box(0, 0, 500, 200))
		expect(resizedXfrm(box(0, 0, 400, 200), "e", 100, 0, { keepRatio: true })).toEqual(box(0, -25, 500, 250))
	})

	it("a box dragged past its opposite edge stops at zero size", () => {
		expect(resizedXfrm(box(0, 0, 400, 200), "e", -1000, 0)).toEqual(box(0, 0, 0, 200))
	})

	it("other shapes of a selection follow the dragged one's proportions from their own opposite handle", () => {
		expect(scaledXfrm(box(1000, 0, 200, 100), "se", 1.5, 2)).toEqual(box(1000, 0, 300, 200))
		expect(scaledXfrm(box(1000, 0, 200, 100), "nw", 2, 2)).toEqual(box(800, -100, 400, 200))
	})

	it("turning snaps to 15° steps with Shift and stays within one turn", () => {
		expect(turnedXfrm(box(0, 0, 10, 10), 37 * DEG, true).rot).toBe(30 * DEG)
		expect(turnedXfrm(box(0, 0, 10, 10, 350 * DEG), 20 * DEG, false).rot).toBe(10 * DEG)
		expect(turnedXfrm(box(0, 0, 10, 10), -10 * DEG, false).rot).toBe(350 * DEG)
		// From above the centre to the right of it: a quarter turn clockwise.
		expect(dragTurn(box(0, 0, 100, 100), { x: 50, y: -100 }, { x: 200, y: 50 })).toBe(90 * DEG)
	})

	it("Alt+arrows turn by 15° about each centre; a shape locked against turning keeps its box", () => {
		const free = { id: 3, xfrm: box(0, 0, 100, 50, 350 * DEG) }
		const locked = { id: 4, xfrm: box(0, 0, 100, 50), locks: { noRot: true as const } }

		expect(turnedShapes([free, locked], 15 * DEG)).toEqual([{ ...free, xfrm: box(0, 0, 100, 50, 5 * DEG) }, locked])
		expect(turnedShapes([free], -15 * DEG)[0]?.xfrm.rot).toBe(335 * DEG)
	})

	it("Shift+arrows on a Mac move the right or bottom edge one step along the box's axes, keeping locks and a minimum", () => {
		const step = 9525
		const plain = { id: 3, xfrm: box(1000, 1000, 100_000, 50_000) }

		expect(steppedShapes([plain], "right")[0]?.xfrm).toEqual(box(1000, 1000, 100_000 + step, 50_000))
		expect(steppedShapes([plain], "left")[0]?.xfrm).toEqual(box(1000, 1000, 100_000 - step, 50_000))
		expect(steppedShapes([plain], "down")[0]?.xfrm).toEqual(box(1000, 1000, 100_000, 50_000 + step))
		expect(steppedShapes([plain], "up")[0]?.xfrm).toEqual(box(1000, 1000, 100_000, 50_000 - step))

		// Turned a quarter: the box's own right edge grows, its left edge stays where it shows.
		const turned = { id: 3, xfrm: box(0, 0, 100_000, 50_000, 90 * DEG) }
		const grown = steppedShapes([turned], "right")[0]?.xfrm as Xfrm

		expect(grown.cx).toBe(100_000 + step)
		// Within the EMU the box's whole-number position rounds to.
		expect(Math.abs(corner(grown, 0, 0).x - corner(turned.xfrm, 0, 0).x)).toBeLessThanOrEqual(1)
		expect(Math.abs(corner(grown, 0, 0).y - corner(turned.xfrm, 0, 0).y)).toBeLessThanOrEqual(1)

		const aspect = { id: 4, xfrm: box(0, 0, 200_000, 100_000), locks: { noChangeAspect: true as const } }

		expect(steppedShapes([aspect], "right")[0]?.xfrm).toMatchObject({
			cx: 200_000 + step,
			cy: Math.round(100_000 * (1 + step / 200_000))
		})

		const fixed = { id: 5, xfrm: box(0, 0, 100_000, 50_000), locks: { noResize: true as const } }
		const tiny = { id: 6, xfrm: box(0, 0, step, 50_000) }

		expect(steppedShapes([fixed, tiny], "left")).toEqual([fixed, tiny])
	})

	it("Rotate turns each shape a quarter about its centre; Flip mirrors each in place and reverses its turn", () => {
		const shapes = [{ id: 3, xfrm: box(0, 0, 100, 50, 30 * DEG) }]

		expect(rotateOp(slide, shapes, 1)).toMatchObject({ kind: "setXfrm", xfrm: { rot: 120 * DEG, x: 0, y: 0 } })
		expect(rotateOp(slide, shapes, -1)).toMatchObject({ xfrm: { rot: 300 * DEG } })
		expect(flipOp(slide, shapes, "horizontal")).toMatchObject({ xfrm: { flipH: true, flipV: false, rot: 330 * DEG, x: 0, y: 0 } })
		expect(flipOp(slide, shapes, "vertical")).toMatchObject({ xfrm: { flipH: false, flipV: true, rot: 330 * DEG } })
	})
})

describe("presentation arrange commands", () => {
	it("z-order is offered only where an unselected shape lies in that direction", () => {
		const order = [1, 2, 3, 4]

		expect(canZOrder(order, new Set([4]), "front")).toBe(false)
		expect(canZOrder(order, new Set([4]), "forward")).toBe(false)
		expect(canZOrder(order, new Set([4]), "back")).toBe(true)
		expect(canZOrder(order, new Set([1, 2]), "backward")).toBe(false)
		expect(canZOrder(order, new Set([1, 3]), "back")).toBe(true)
		expect(canZOrder(order, new Set(), "front")).toBe(false)
		expect(zOrderOp(slide, [2, 3], "forward")).toEqual({ family: "shape", kind: "zOrder", slide, shapes: [2, 3], to: "forward" })
	})

	it("grouping needs two shapes and no placeholder; ungroup takes every selected group", () => {
		expect(canGroup([{ id: 1, role: "shape" }])).toBe(false)
		expect(
			canGroup([
				{ id: 1, role: "shape" },
				{ id: 2, role: "picture" }
			])
		).toBe(true)
		expect(
			canGroup([
				{ id: 1, role: "shape" },
				{ id: 2, role: "placeholder" }
			])
		).toBe(false)
		expect(groupOp(slide, [1, 1])).toBeUndefined()
		expect(groupOp(slide, [1, 2])).toEqual({ family: "shape", kind: "group", slide, shapes: [1, 2] })
		expect(canUngroup([{ id: 1, role: "shape" }])).toBe(false)
		expect(
			ungroupOps(slide, [
				{ id: 5, role: "group" },
				{ id: 6, role: "shape" },
				{ id: 7, role: "group" }
			])
		).toEqual([
			{
				family: "batch",
				kind: "batch",
				ops: [
					{ family: "shape", kind: "ungroup", slide, group: 5 },
					{ family: "shape", kind: "ungroup", slide, group: 7 }
				]
			}
		])
		// One group: its op alone.
		expect(ungroupOps(slide, [{ id: 5, role: "group" }])).toEqual([{ family: "shape", kind: "ungroup", slide, group: 5 }])
	})

	it("one shape aligns to the slide; distributing across the selection needs three", () => {
		expect(alignOp(slide, [3], "left", "selection")).toMatchObject({ relativeTo: "slide" })
		expect(alignOp(slide, [3, 4], "middle", "selection")).toMatchObject({ kind: "align", edge: "middle", relativeTo: "selection" })
		expect(alignOp(slide, [], "left", "slide")).toBeUndefined()
		expect(distributeOp(slide, [3, 4], "horizontal", "selection")).toBeUndefined()
		expect(distributeOp(slide, [3, 4, 5], "vertical", "selection")).toMatchObject({ axis: "vertical", relativeTo: "selection" })
		expect(distributeOp(slide, [3], "horizontal", "selection")).toMatchObject({ relativeTo: "slide" })
	})

	it("alt text is trimmed, a decorative shape keeps no description, and nothing left removes it", () => {
		const target = { slide, id: 3 }

		expect(altOp(target, { descr: "  A chart  ", title: "" })).toEqual({
			family: "shape",
			kind: "setAlt",
			target,
			alt: { descr: "A chart" }
		})
		expect(altOp(target, { descr: "x", decorative: true })).toEqual({
			family: "shape",
			kind: "setAlt",
			target,
			alt: { decorative: true }
		})
		expect(altOp(target, { descr: " ", title: "" })).toEqual({ family: "shape", kind: "setAlt", target, alt: undefined })
	})

	it("a refused action is never written by an edit; removing one is", () => {
		const target = { slide, id: 3 }

		expect(actionOp(target, "click", { kind: "refused", what: "program", raw: "ppaction://program" })).toBeUndefined()
		expect(actionOp(target, "click", undefined)).toEqual({
			family: "shape",
			kind: "setAction",
			target,
			trigger: "click",
			action: undefined
		})
		expect(actionOp(target, "click", { kind: "internal", jump: "next" })).toMatchObject({ action: { kind: "internal", jump: "next" } })
	})
})
