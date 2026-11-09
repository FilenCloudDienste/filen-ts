import { describe, expect, it } from "vitest"
import { EMU_PER_PX } from "../core/drawingml/reader"
import { slideRef, type Xfrm } from "../core/presentation/model"
import type { LayerRole, SlideLayer, SlideRender } from "../core/presentation/output"
import { SnapTargets, snapThreshold } from "../react/presentation/edit/guides"
import { ShapeDrag, boxPoint, handleAt, handleCursor, multiply, previewMatrix, rotatePoint } from "../react/presentation/edit/handles"
import { cycleTarget, objectKeyAction, parseCombo, type KeyLike, type ObjectKeyBindings } from "../react/presentation/edit/keyboard"
import {
	boundsOf,
	createShapeSelection,
	onShape,
	selectedShapes,
	selectionKinds,
	shapeAt,
	shapesInside,
	slideShapes
} from "../react/presentation/edit/selection"

const ref = slideRef(256)
const DEG = 60000
const box = (x: number, y: number, cx: number, cy: number, rot = 0): Xfrm => ({ x, y, cx, cy, rot, flipH: false, flipV: false })

function layer(id: number, xfrm: Xfrm | undefined, role: LayerRole = "shape", top = id): SlideLayer {
	return {
		shape: { slide: ref, id },
		role,
		drawing: { width: 1, height: 1 },
		matrix: [1, 0, 0, 1, 0, 0],
		...(xfrm === undefined ? {} : { box: { id: top, xfrm } })
	} as unknown as SlideLayer
}

function renderOf(layers: readonly SlideLayer[], slide = ref): SlideRender {
	return {
		ref: slide,
		index: 0,
		revision: 1,
		hidden: false,
		background: {},
		layers,
		notesText: "",
		animated: false
	} as unknown as SlideRender
}

const BINDINGS: ObjectKeyBindings = {
	selectAll: "mod+a",
	group: "mod+g",
	ungroup: "mod+shift+g",
	bringToFront: "mod+shift+]",
	sendToBack: "mod+shift+[",
	bringForward: "mod+]",
	sendBackward: "mod+["
}

function key(code: string, key: string, modifiers: Partial<KeyLike> = {}): KeyLike {
	return { code, key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers }
}

describe("presentation shape selection", () => {
	it("lists the slide's own top-level shapes once each, back to front, without master or layout layers", () => {
		const render = renderOf([
			layer(90, undefined, "master"),
			layer(3, box(0, 0, 100, 100)),
			layer(3, box(0, 0, 100, 100)),
			layer(6, box(500, 500, 200, 200), "group"),
			// A table inside group 6, drawn as a layer of its own: it is the group's.
			layer(11, box(500, 500, 200, 200), "table", 6),
			layer(4, box(50, 50, 100, 100), "picture")
		])
		const shapes = slideShapes(render)

		expect(shapes.map(shape => [shape.id, shape.role, shape.layers])).toEqual([
			[3, "shape", [1, 2]],
			[6, "group", [3, 4]],
			[4, "picture", [5]]
		])
		expect(slideShapes(render)).toBe(shapes)
		expect([...selectionKinds(shapes)]).toEqual(["shape", "picture"])
	})

	it("hits the front-most shape, a turned box by its turned outline, a line within the slack", () => {
		const shapes = slideShapes(
			renderOf([layer(3, box(0, 0, 1000, 1000)), layer(4, box(500, 500, 1000, 1000)), layer(5, box(0, 3000, 1000, 0))])
		)

		expect(shapeAt(shapes, { x: 700, y: 700 }, 0)?.id).toBe(4)
		expect(shapeAt(shapes, { x: 100, y: 100 }, 0)?.id).toBe(3)
		expect(shapeAt(shapes, { x: 500, y: 3010 }, 20)?.id).toBe(5)
		expect(shapeAt(shapes, { x: 500, y: 3050 }, 20)).toBeUndefined()

		// A 2:1 box turned a quarter stands upright about its centre.
		const turned = box(0, 0, 2000, 1000, 90 * DEG)

		expect(onShape(turned, 1000, 1400, 0)).toBe(true)
		expect(onShape(turned, 1800, 500, 0)).toBe(false)
		expect(boundsOf(turned)).toEqual({ x: 500, y: -500, r: 1500, b: 1500 })
	})

	it("a marquee selects the shapes it holds whole", () => {
		const shapes = slideShapes(
			renderOf([layer(3, box(0, 0, 100, 100)), layer(4, box(50, 50, 100, 100)), layer(5, box(500, 500, 10, 10))])
		)

		expect(shapesInside(shapes, { x: -1, y: -1, r: 120, b: 120 })).toEqual([3])
		expect(shapesInside(shapes, { x: -1, y: -1, r: 1000, b: 1000 })).toEqual([3, 4, 5])
	})

	it("the store clears on another slide, toggles, and selects what a group or ungroup made once its render arrives", () => {
		const store = createShapeSelection()
		const seen: number[][] = []

		store.subscribe(() => seen.push([...store.getSnapshot().ids]))
		store.show(ref)
		store.set([3, 4])
		store.toggle(4)
		store.toggle(5)
		expect(store.getSnapshot().ids).toEqual([3, 5])

		store.selectNew(ref, [3, 4, 5])
		// An older render (no new shape yet) changes nothing.
		store.reconcile(renderOf([layer(3, box(0, 0, 1, 1)), layer(4, box(0, 0, 1, 1)), layer(5, box(0, 0, 1, 1))]))
		expect(store.getSnapshot().ids).toEqual([3, 5])
		store.reconcile(renderOf([layer(4, box(0, 0, 1, 1)), layer(9, box(0, 0, 1, 1), "group")]))
		expect(store.getSnapshot()).toEqual({ slide: ref, ids: [9] })

		// A shape the next render no longer has leaves the selection.
		store.set([4, 9])
		store.reconcile(renderOf([layer(9, box(0, 0, 1, 1), "group")]))
		expect(store.getSnapshot().ids).toEqual([9])
		expect(selectedShapes(renderOf([layer(9, box(0, 0, 1, 1), "group")]), store.getSnapshot()).map(shape => shape.id)).toEqual([9])

		store.show(slideRef(257))
		expect(store.getSnapshot()).toEqual({ slide: slideRef(257), ids: [] })
		expect(seen.length).toBeGreaterThan(0)
	})
})

describe("presentation smart guides", () => {
	const slide = { cx: 10000, cy: 6000 }

	it("snaps an edge to another shape's edge within the threshold and draws the guide across both", () => {
		const targets = new SnapTargets([{ x: 1000, y: 1000, r: 2000, b: 2000 }], slide)
		const snap = targets.snapMove({ x: 2030, y: 3000, r: 2530, b: 3400 }, 50)

		expect(snap.dx).toBe(-30)
		expect(snap.guides).toContainEqual({ axis: "x", at: 2000, from: 1000, to: 3400 })
		expect(targets.snapMove({ x: 2100, y: 3000, r: 2600, b: 3400 }, 50).dx).toBe(0)
	})

	it("snaps a box's centre to the slide's centre", () => {
		const targets = new SnapTargets([], slide)
		const snap = targets.snapMove({ x: 4020, y: 100, r: 6020, b: 300 }, 50)

		expect(snap.dx).toBe(-20)
		expect(snap.guides).toContainEqual({ axis: "x", at: 5000, from: 0, to: 6000 })
	})

	it("places a box with equal gaps between two shapes of its row, and after a pair at their gap", () => {
		const row = [
			{ x: 0, y: 1000, r: 1000, b: 2000 },
			{ x: 3000, y: 1000, r: 4000, b: 2000 }
		]
		const between = new SnapTargets(row, slide).snapMove({ x: 1430, y: 1700, r: 2430, b: 2700 }, 100)

		// Equal gaps of 500 either side.
		expect(between.dx).toBe(1500 - 1430)
		expect(between.spacing).toEqual([
			{ axis: "x", from: 1000, to: 1500, at: 1850 },
			{ axis: "x", from: 2500, to: 3000, at: 1850 }
		])

		const after = new SnapTargets(row, slide).snapMove({ x: 6040, y: 1000, r: 7040, b: 2000 }, 100)

		// The pair's gap is 2000: the box lands 2000 after the second.
		expect(after.dx).toBe(6000 - 6040)
		expect(after.spacing[0]).toEqual({ axis: "x", from: 1000, to: 3000, at: 1500 })
	})

	it("counts the slide's edges as neighbours: the same margin as the shape beside it", () => {
		const targets = new SnapTargets([{ x: 500, y: 0, r: 1500, b: 1000 }], { cx: 10000, cy: 50000 })
		// The shape sits 500 from the left edge; a box right of it lands 500 after it.
		const snap = targets.snapMove({ x: 2050, y: 40000, r: 2550, b: 40500 }, 100)

		expect(snap.dx).toBe(0)

		const row = targets.snapMove({ x: 2040, y: 200, r: 2540, b: 700 }, 100)

		expect(row.dx).toBe(2000 - 2040)
	})

	it("the threshold is 6 screen px at the zoom", () => {
		expect(snapThreshold(0.5, EMU_PER_PX)).toBe(12 * EMU_PER_PX)
		expect(snapThreshold(0, EMU_PER_PX)).toBe(0)
	})
})

describe("presentation drag", () => {
	const shapes = [
		{ id: 3, xfrm: box(1000, 1000, 1000, 1000) },
		{ id: 4, xfrm: box(3000, 1000, 500, 500) }
	]

	it("moves the selection with snapping, along one axis with Shift, without snapping with Alt", () => {
		const others = [{ x: 0, y: 5000, r: 990, b: 6000 }]
		const drag = new ShapeDrag({
			kind: "move",
			slide: ref,
			shapes,
			start: { x: 0, y: 0 },
			snap: { others, slide: { cx: 100000, cy: 100000 } },
			threshold: 30
		})
		const free = { shift: false, ctrl: false, alt: false }

		// The selection's left edge (1000 - 20) comes within 30 of the other's right edge (990).
		expect(drag.move({ x: -20, y: 7 }, free).shapes[0]?.xfrm).toMatchObject({ x: 990, y: 1007 })
		expect(drag.move({ x: -20, y: 7 }, { ...free, alt: true }).shapes[0]?.xfrm).toMatchObject({ x: 980, y: 1007 })
		expect(drag.move({ x: 400, y: 30 }, { ...free, shift: true }).shapes.map(shape => shape.xfrm.y)).toEqual([1000, 1000])
		expect(drag.end()).toMatchObject({ family: "shape", kind: "setXfrms", slide: ref })
	})

	it("resizes the pressed shape by its handle and the others by the same proportions", () => {
		const drag = new ShapeDrag({ kind: "resize", slide: ref, shapes, id: 3, handle: "se", start: { x: 0, y: 0 }, threshold: 0 })
		const frame = drag.move({ x: 500, y: 1000 }, { shift: false, ctrl: false, alt: false })

		expect(frame.shapes).toEqual([
			{ id: 3, xfrm: box(1000, 1000, 1500, 2000) },
			{ id: 4, xfrm: box(3000, 1000, 750, 1000) }
		])
	})

	it("turns by the rotate handle, in 15° steps with Shift", () => {
		const drag = new ShapeDrag({
			kind: "rotate",
			slide: ref,
			shapes: [shapes[0] as (typeof shapes)[number]],
			id: 3,
			start: { x: 1500, y: 0 },
			threshold: 0
		})

		expect(drag.move({ x: 3000, y: 1600 }, { shift: true, ctrl: false, alt: false }).shapes[0]?.xfrm.rot).toBe(90 * DEG)
		expect(drag.end()).toMatchObject({ kind: "setXfrm", target: { slide: ref, id: 3 }, xfrm: { rot: 90 * DEG } })
	})

	it("an unmoved drag ends with no op", () => {
		const drag = new ShapeDrag({ kind: "move", slide: ref, shapes, start: { x: 0, y: 0 }, threshold: 0 })

		drag.move({ x: 0, y: 0 }, { shift: false, ctrl: false, alt: false })
		expect(drag.end()).toBeUndefined()
	})

	it("finds the handle under the pointer, the rotate knob above the top edge, and turns the cursor with the box", () => {
		const xfrm = box(0, 0, 10000, 5000)
		const placed = [{ id: 3, xfrm }]

		expect(handleAt(placed, { x: 10000, y: 5000 }, 100, 2000, 10)).toEqual({ kind: "resize", id: 3, handle: "se" })
		expect(handleAt(placed, { x: 5000, y: -2000 }, 100, 2000, 10)).toEqual({ kind: "rotate", id: 3 })
		expect(handleAt(placed, { x: 5000, y: 2500 }, 100, 2000, 10)).toBeUndefined()
		const knob = rotatePoint(box(0, 0, 100, 100, 90 * DEG), 50)

		expect(knob.x).toBeCloseTo(150, 9)
		expect(knob.y).toBeCloseTo(50, 9)
		expect(handleCursor(xfrm, "e")).toBe("ew-resize")
		expect(handleCursor(box(0, 0, 10, 10, 90 * DEG), "e")).toBe("ns-resize")
		expect(handleCursor(box(0, 0, 10, 10, 30 * DEG), "e")).toBe("nwse-resize")
	})

	it("the preview matrix carries every corner of the old box onto the new one", () => {
		const from = box(9525, 9525 * 2, 9525 * 100, 9525 * 50, 0)
		const to = box(9525 * 30, 9525 * 10, 9525 * 60, 9525 * 80, 45 * DEG)
		const matrix = previewMatrix(from, to)

		for (const [fx, fy] of [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1]
		] as const) {
			const a = boxPoint(from, fx, fy)
			const b = boxPoint(to, fx, fy)
			const [x = 0, y = 0] = [
				(matrix[0] as number) * (a.x / EMU_PER_PX) + (matrix[2] as number) * (a.y / EMU_PER_PX) + (matrix[4] as number),
				(matrix[1] as number) * (a.x / EMU_PER_PX) + (matrix[3] as number) * (a.y / EMU_PER_PX) + (matrix[5] as number)
			]

			expect(x).toBeCloseTo(b.x / EMU_PER_PX, 6)
			expect(y).toBeCloseTo(b.y / EMU_PER_PX, 6)
		}

		// n first, then m.
		expect(multiply([1, 0, 0, 1, 5, 6], [2, 0, 0, 2, 1, 1])).toEqual([2, 0, 0, 2, 6, 7])
	})
})

describe("presentation canvas keys", () => {
	it("parses react-hotkeys-hook combos and matches them by key code, Mod as Cmd on Apple and Ctrl elsewhere", () => {
		expect(parseCombo("mod+shift+]")).toEqual({ mod: true, ctrl: false, meta: false, shift: true, alt: false, code: "BracketRight" })
		expect(parseCombo("a>b")).toBeUndefined()

		// Shift+] types "}", but the code is still BracketRight.
		expect(objectKeyAction(key("BracketRight", "}", { metaKey: true, shiftKey: true }), BINDINGS, true)).toEqual({
			kind: "command",
			command: "bringToFront"
		})
		expect(objectKeyAction(key("BracketRight", "}", { metaKey: true, shiftKey: true }), BINDINGS, false)).toBeUndefined()
		expect(objectKeyAction(key("KeyG", "g", { ctrlKey: true }), BINDINGS, false)).toEqual({ kind: "command", command: "group" })
		expect(objectKeyAction(key("KeyA", "a", { ctrlKey: true }), BINDINGS, false)).toEqual({ kind: "command", command: "selectAll" })
	})

	it("Mod+D duplicates the selected objects (Ctrl+D, Cmd+D on a Mac), not the slide", () => {
		expect(objectKeyAction(key("KeyD", "d", { ctrlKey: true }), BINDINGS, false)).toEqual({ kind: "duplicate" })
		expect(objectKeyAction(key("KeyD", "d", { metaKey: true }), BINDINGS, true)).toEqual({ kind: "duplicate" })
		expect(objectKeyAction(key("KeyD", "d", { ctrlKey: true }), BINDINGS, true)).toBeUndefined()
		// Mod+Shift+D is the slide's (the editor's), not the canvas's.
		expect(objectKeyAction(key("KeyD", "D", { ctrlKey: true, shiftKey: true }), BINDINGS, false)).toBeUndefined()
	})

	it("Alt+Left/Right turn 15°; on a Mac Cmd+arrows nudge and Shift+arrows resize", () => {
		for (const apple of [false, true]) {
			expect(objectKeyAction(key("ArrowRight", "ArrowRight", { altKey: true }), BINDINGS, apple)).toEqual({
				kind: "rotate",
				clockwise: true
			})
			expect(objectKeyAction(key("ArrowLeft", "ArrowLeft", { altKey: true }), BINDINGS, apple)).toEqual({
				kind: "rotate",
				clockwise: false
			})
			expect(objectKeyAction(key("ArrowUp", "ArrowUp", { altKey: true }), BINDINGS, apple)).toBeUndefined()
			expect(objectKeyAction(key("ArrowRight", "ArrowRight", { altKey: true, shiftKey: true }), BINDINGS, apple)).toBeUndefined()
			expect(objectKeyAction(key("ArrowDown", "ArrowDown", { ctrlKey: true }), BINDINGS, apple)).toBeUndefined()
		}

		expect(objectKeyAction(key("ArrowUp", "ArrowUp", { metaKey: true }), BINDINGS, true)).toEqual({
			kind: "nudge",
			direction: "up",
			large: false
		})
		expect(objectKeyAction(key("ArrowUp", "ArrowUp", { metaKey: true }), BINDINGS, false)).toBeUndefined()
		expect(objectKeyAction(key("ArrowUp", "ArrowUp", { metaKey: true, shiftKey: true }), BINDINGS, true)).toBeUndefined()
		expect(objectKeyAction(key("ArrowRight", "ArrowRight", { shiftKey: true }), BINDINGS, true)).toEqual({
			kind: "resize",
			direction: "right"
		})
		expect(objectKeyAction(key("ArrowRight", "ArrowRight", { shiftKey: true }), BINDINGS, false)).toEqual({
			kind: "nudge",
			direction: "right",
			large: true
		})
	})

	it("arrows nudge (Shift further), Delete deletes, Tab cycles, Enter edits, Escape leaves; modified arrows are not the canvas's", () => {
		expect(objectKeyAction(key("ArrowLeft", "ArrowLeft"), BINDINGS, false)).toEqual({ kind: "nudge", direction: "left", large: false })
		expect(objectKeyAction(key("ArrowDown", "ArrowDown", { shiftKey: true }), BINDINGS, false)).toEqual({
			kind: "nudge",
			direction: "down",
			large: true
		})
		expect(objectKeyAction(key("ArrowDown", "ArrowDown", { ctrlKey: true }), BINDINGS, false)).toBeUndefined()
		expect(objectKeyAction(key("Delete", "Delete"), BINDINGS, false)).toEqual({ kind: "delete" })
		expect(objectKeyAction(key("Backspace", "Backspace"), BINDINGS, false)).toEqual({ kind: "delete" })
		expect(objectKeyAction(key("Tab", "Tab", { shiftKey: true }), BINDINGS, false)).toEqual({ kind: "cycle", back: true })
		// Enter selects the shape's text (PowerPoint's "Select text within an object"); F2 opens it with the caret.
		expect(objectKeyAction(key("Enter", "Enter"), BINDINGS, false)).toEqual({ kind: "enter", selectAll: true })
		expect(objectKeyAction(key("F2", "F2"), BINDINGS, false)).toEqual({ kind: "enter", selectAll: false })
		expect(objectKeyAction(key("Escape", "Escape"), BINDINGS, false)).toEqual({ kind: "escape" })
		// A character goes into the selected shape's text (PowerPoint: select the shape, then type).
		expect(objectKeyAction(key("KeyX", "x"), BINDINGS, false)).toEqual({ kind: "type", text: "x" })
		expect(objectKeyAction(key("KeyX", "x", { ctrlKey: true }), BINDINGS, false)).toBeUndefined()
	})

	it("Tab goes to the shape after the front-most selected one, wrapping; Shift+Tab before the back-most", () => {
		expect(cycleTarget([1, 2, 3], [], false)).toBe(1)
		expect(cycleTarget([1, 2, 3], [], true)).toBe(3)
		expect(cycleTarget([1, 2, 3], [2], false)).toBe(3)
		expect(cycleTarget([1, 2, 3], [3], false)).toBe(1)
		expect(cycleTarget([1, 2, 3], [2, 3], true)).toBe(1)
		expect(cycleTarget([], [], false)).toBeUndefined()
	})
})
