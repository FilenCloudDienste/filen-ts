import { describe, expect, it } from "vitest"
import type { PdfAnnotationInfo, PdfPoint, PdfRect } from "../core/pdfedit/annotations"
import { INK_IDLE, inkPointer, smoothStroke, type InkState } from "../react/pdfedit/tools/ink"
import { markupPointer, markupTool, quadsFromLines, type PdfTextLine } from "../react/pdfedit/tools/markup"
import { dragRect, placementKey, startPlacement } from "../react/pdfedit/tools/placement"
import {
	RECT_TOOL_IDLE,
	rectToolKey,
	rectToolPointer,
	shapeKey,
	shapePointer,
	shapeTool,
	snapAngle,
	stampSize
} from "../react/pdfedit/tools/rectTools"
import { resizeRect, SELECT_IDLE, selectKey, selectPointer, selectRefresh, type SelectState } from "../react/pdfedit/tools/select"
import { TEXT_BOX_IDLE, textBoxEdit, textBoxFinish, textBoxInput, textBoxKey, textBoxPointer } from "../react/pdfedit/tools/textBox"
import type { ToolPointer } from "../react/pdfedit/tools/types"

// The annotation tools' state machines: pointer gestures, keyboard placement and what each commits.

const BOX: PdfRect = [0, 0, 600, 800]
const PAGE = { page: 2, box: BOX }

function pointer(type: ToolPointer["type"], point: PdfPoint, shift = false): ToolPointer {
	return { type, page: 2, box: BOX, point, shift }
}

function info(id: number, rect: PdfRect, extra: Partial<PdfAnnotationInfo> = {}): PdfAnnotationInfo {
	return {
		page: 2,
		id,
		type: "Square",
		rect,
		color: [1, 0, 0],
		interiorColor: null,
		opacity: 1,
		width: 1,
		author: "",
		created: null,
		modified: null,
		text: "",
		replyTo: null,
		geometry: "rect",
		locked: false,
		...extra
	}
}

describe("keyboard placement", () => {
	it("places at the page centre, moves, resizes and commits", () => {
		let placement = startPlacement(PAGE, { width: 100, height: 50 })

		expect(placement.rect).toEqual([250, 375, 350, 425])

		placement = placementKey(placement, { key: "ArrowRight", shift: true }).state ?? placement
		placement = placementKey(placement, { key: "ArrowDown" }).state ?? placement
		expect(placement.rect).toEqual([260, 376, 360, 426])

		placement = placementKey(placement, { key: "ArrowLeft", alt: true }).state ?? placement
		expect(placement.rect).toEqual([260, 376, 359, 426])

		const done = placementKey(placement, { key: "Enter" })

		expect(done).toEqual({ state: null, commit: [260, 376, 359, 426] })
		expect(placementKey(placement, { key: "Escape" })).toEqual({ state: null })
	})

	it("stays on the page and keeps a locked aspect", () => {
		let placement = startPlacement(PAGE, { width: 100, height: 50, aspect: 2, lockAspect: true }, [5, 5])

		expect(placement.rect).toEqual([0, 0, 100, 50])

		placement = placementKey(placement, { key: "ArrowLeft", shift: true }).state ?? placement
		expect(placement.rect).toEqual([0, 0, 100, 50])

		placement = placementKey(placement, { key: "ArrowRight", shift: true, alt: true }).state ?? placement
		expect(placement.rect).toEqual([0, 0, 110, 55])
	})
})

describe("rect tools", () => {
	it("drags a rect, a constrained square, and places a click at the default size", () => {
		let state = rectToolPointer(RECT_TOOL_IDLE, pointer("down", [100, 100]), { width: 40, height: 20 }).state

		state = rectToolPointer(state, pointer("move", [160, 130]), { width: 40, height: 20 }).state

		const step = rectToolPointer(state, pointer("up", [160, 130]), { width: 40, height: 20 })

		expect(step.commit).toEqual({ page: 2, rect: [100, 100, 160, 130] })
		expect(dragRect([100, 100], [160, 130], true, undefined)).toEqual([100, 100, 160, 160])
		expect(dragRect([100, 100], [40, 130], true, 2)).toEqual([40, 100, 100, 130])

		const click = rectToolPointer(
			rectToolPointer(RECT_TOOL_IDLE, pointer("down", [100, 100]), { width: 40, height: 20 }).state,
			pointer("up", [101, 100]),
			{ width: 40, height: 20 }
		)

		expect(click.commit).toEqual({ page: 2, rect: [80, 90, 120, 110] })
	})

	it("places from the keyboard", () => {
		const started = rectToolKey(RECT_TOOL_IDLE, { key: "Enter" }, PAGE, { width: 40, height: 20 })

		expect(started.state.placement?.rect).toEqual([280, 390, 320, 410])
		expect(rectToolKey(started.state, { key: "Enter" }, PAGE, { width: 40, height: 20 }).commit).toEqual({
			page: 2,
			rect: [280, 390, 320, 410]
		})
		expect(rectToolKey(RECT_TOOL_IDLE, { key: "ArrowLeft" }, PAGE, { width: 40, height: 20 }).state).toBe(RECT_TOOL_IDLE)
	})

	it("draws shapes and lines, snapping lines to 45°", () => {
		let ellipse = shapeTool("Circle")

		ellipse = shapePointer(ellipse, pointer("down", [10, 10])).state
		ellipse = shapePointer(ellipse, pointer("move", [50, 30])).state
		expect(shapePointer(ellipse, pointer("up", [50, 30])).commit).toEqual({ kind: "Circle", page: 2, rect: [10, 10, 50, 30] })

		let line = shapePointer(shapeTool("Line"), pointer("down", [100, 100])).state

		line = shapePointer(line, pointer("move", [200, 190], true)).state

		const drawn = shapePointer(line, pointer("up", [200, 190]))

		expect(drawn.commit?.kind).toBe("Line")

		if (drawn.commit?.kind !== "Line") throw new Error("no line")

		expect(drawn.commit.to[0] - 100).toBeCloseTo(drawn.commit.to[1] - 100, 6)
		expect(snapAngle([0, 0], [10, 1])).toEqual([Math.hypot(10, 1), 0])

		const clicked = shapePointer(shapePointer(shapeTool("Line"), pointer("down", [100, 100])).state, pointer("up", [100, 100]))

		expect(clicked.commit).toEqual({ kind: "Line", page: 2, from: [100, 100], to: [220, 100] })

		const keyed = shapeKey(shapeKey(shapeTool("Line"), { key: "Enter" }, PAGE).state, { key: "Enter" }, PAGE)

		expect(keyed.commit).toEqual({ kind: "Line", page: 2, from: [240, 360], to: [360, 440] })
	})

	it("sizes stamps by their aspect", () => {
		expect(stampSize(300, 100)).toEqual({ width: 150, height: 50, aspect: 3, lockAspect: true })
		expect(stampSize(100, 400)).toEqual({ width: 50, height: 200, aspect: 0.25, lockAspect: true })
		expect(stampSize(0, 0).aspect).toBe(1)
	})
})

describe("text box", () => {
	it("places a box, takes text and commits on finish or a press outside", () => {
		let state = textBoxPointer(TEXT_BOX_IDLE, pointer("down", [100, 100])).state

		state = textBoxPointer(state, pointer("up", [100, 100])).state
		expect(state.editing).toEqual({ page: 2, rect: [0, 80, 200, 120], text: "" })

		state = textBoxInput(state, "Hello")
		// A press inside the box is the editor's.
		expect(textBoxPointer(state, pointer("down", [50, 100])).state).toBe(state)
		expect(textBoxPointer(state, pointer("down", [500, 500])).commit).toEqual({ page: 2, rect: [0, 80, 200, 120], text: "Hello" })
		expect(textBoxFinish(state).commit?.text).toBe("Hello")
	})

	it("drops an empty new box and Escape; keeps an emptied existing one for the host to delete", () => {
		const placed = textBoxKey(textBoxKey(TEXT_BOX_IDLE, { key: "Enter" }, PAGE).state, { key: "Enter" }, PAGE).state

		expect(placed.editing?.rect).toEqual([200, 380, 400, 420])
		expect(textBoxFinish(textBoxInput(placed, "  ")).commit).toBeUndefined()
		expect(textBoxKey(textBoxInput(placed, "x"), { key: "Escape" }, PAGE)).toEqual({ state: TEXT_BOX_IDLE })
		expect(textBoxFinish(textBoxInput(textBoxEdit(2, 7, [1, 1, 50, 20], "old"), "")).commit).toEqual({
			page: 2,
			rect: [1, 1, 50, 20],
			text: "",
			id: 7
		})
	})
})

describe("ink", () => {
	it("collects a stroke, drops jitter and commits it smoothed", () => {
		let state: InkState = inkPointer(INK_IDLE, pointer("down", [0, 0])).state

		for (let x = 1; x <= 100; x++) state = inkPointer(state, pointer("move", [x, x % 2 === 0 ? 0.2 : 0])).state

		// Points closer than the minimum step are dropped.
		state = inkPointer(state, pointer("move", [100.1, 0])).state
		expect(state.stroke?.length).toBe(202)

		const step = inkPointer(state, pointer("up", [100, 0]))

		expect(step.state).toBe(INK_IDLE)
		expect(step.commit?.page).toBe(2)
		// The jitter smoothed away: a straight line needs its two ends.
		expect(step.commit?.points).toEqual([
			[0, 0],
			[100, 0.2]
		])
	})

	it("keeps corners and makes a tap a dot", () => {
		const points = new Float64Array([0, 0, 50, 0, 100, 0, 100, 50, 100, 100])
		const smoothed = smoothStroke(points, points.length)

		expect(smoothed[0]).toEqual([0, 0])
		expect(smoothed[smoothed.length - 1]).toEqual([100, 100])
		expect(smoothed.length).toBeGreaterThanOrEqual(3)
		expect(smoothStroke(new Float64Array([5, 5]), 2)).toEqual([
			[5, 5],
			[5.01, 5]
		])
		expect(inkPointer(inkPointer(INK_IDLE, pointer("down", [1, 1])).state, pointer("cancel", [1, 1])).state).toBe(INK_IDLE)
	})
})

describe("text markup", () => {
	const lines: PdfTextLine[] = [
		{ rect: [10, 10, 110, 22], edges: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110] },
		{ rect: [10, 30, 70, 42], edges: [10, 20, 30, 40, 50, 60, 70] }
	]

	it("computes quads between two points across lines", () => {
		expect(quadsFromLines(lines, [31, 15], [52, 35])).toEqual([
			[30, 10, 110, 10, 30, 22, 110, 22],
			[10, 30, 50, 30, 10, 42, 50, 42]
		])
		// Backwards is the same selection.
		expect(quadsFromLines(lines, [52, 35], [31, 15])).toEqual(quadsFromLines(lines, [31, 15], [52, 35]))
		expect(quadsFromLines(lines, [31, 15], [32, 15])).toEqual([])
		expect(quadsFromLines([], [0, 0], [1, 1])).toEqual([])
	})

	it("commits the drag's quads once over text", () => {
		const geometry = { quads: (_page: number, from: PdfPoint, to: PdfPoint) => quadsFromLines(lines, from, to) }
		let state = markupPointer(markupTool("Underline"), pointer("down", [11, 15]), geometry).state

		state = markupPointer(state, pointer("move", [60, 15]), geometry).state
		expect(state.drag?.quads).toHaveLength(1)

		const done = markupPointer(state, pointer("up", [60, 15]), geometry)

		expect(done.commit).toEqual({ kind: "Underline", page: 2, quads: [[10, 10, 60, 10, 10, 22, 60, 22]] })

		const nothing = markupPointer(
			markupPointer(markupTool("Highlight"), pointer("down", [11, 15]), geometry).state,
			pointer("up", [11, 15]),
			geometry
		)

		expect(nothing.commit).toBeUndefined()
	})
})

describe("select", () => {
	const square = info(1, [100, 100, 200, 150])
	const markup = info(2, [150, 120, 300, 140], { type: "Highlight", geometry: null })
	const context = { annotations: [square, markup], tolerance: 3 }

	// Pressed, not yet released.
	function pressed(): SelectState {
		return selectPointer(SELECT_IDLE, pointer("down", [110, 110]), context).state
	}

	function selected(): SelectState {
		return selectPointer(pressed(), pointer("up", [110, 110]), context).state
	}

	it("selects the topmost annotation and deselects on empty page", () => {
		const step = selectPointer(SELECT_IDLE, pointer("down", [160, 130]), context)

		expect(step.state.selected?.id).toBe(2)
		expect(step.state.drag).toBeNull()
		expect(step.commit).toEqual({ kind: "select", ref: { page: 2, id: 2 } })
		expect(selectPointer(step.state, pointer("down", [500, 500]), context)).toEqual({
			state: SELECT_IDLE,
			commit: { kind: "select", ref: null }
		})
	})

	it("moves with one commit at the end and ignores a click", () => {
		let state = pressed()

		state = selectPointer(state, pointer("move", [130, 140]), context).state
		state = selectPointer(state, pointer("move", [140, 150]), context).state

		const step = selectPointer(state, pointer("up", [140, 150]), context)

		expect(step.commit).toEqual({ kind: "move", ref: { page: 2, id: 1 }, dx: 30, dy: 40 })
		expect(step.state.selected?.rect).toEqual([130, 140, 230, 190])

		const click = selectPointer(pressed(), pointer("up", [110, 110]), context)

		expect(click.commit).toBeUndefined()
	})

	it("resizes from a handle, keeping the minimum size", () => {
		let state = selected()

		state = selectPointer(state, pointer("down", [200, 150]), context).state
		expect(state.drag?.kind).toBe("resize")

		state = selectPointer(state, pointer("move", [260, 170]), context).state
		expect(selectPointer(state, pointer("up", [260, 170]), context).commit).toEqual({
			kind: "resize",
			ref: { page: 2, id: 1 },
			rect: [100, 100, 260, 170]
		})
		expect(resizeRect([0, 0, 10, 10], "nw", 50, 50, false)).toEqual([6, 6, 10, 10])
		expect(resizeRect([0, 0, 20, 10], "se", 20, 0, true)).toEqual([0, 0, 40, 20])
	})

	it("nudges, resizes, deletes and deselects from the keyboard; never moves markups or locked ones", () => {
		const state = selected()

		expect(selectKey(state, { key: "ArrowRight", shift: true }).commit).toEqual({
			kind: "move",
			ref: { page: 2, id: 1 },
			dx: 10,
			dy: 0
		})
		expect(selectKey(state, { key: "ArrowDown", alt: true }).commit).toEqual({
			kind: "resize",
			ref: { page: 2, id: 1 },
			rect: [100, 100, 200, 151]
		})
		expect(selectKey(state, { key: "Delete" }).commit).toEqual({ kind: "delete", ref: { page: 2, id: 1 } })
		expect(selectKey(state, { key: "Escape" }).commit).toEqual({ kind: "select", ref: null })

		const onMarkup = selectPointer(SELECT_IDLE, pointer("down", [250, 130]), context).state

		expect(selectKey(onMarkup, { key: "ArrowLeft" }).commit).toBeUndefined()

		const locked = selectPointer(SELECT_IDLE, pointer("down", [110, 110]), {
			annotations: [info(3, [100, 100, 200, 150], { locked: true })],
			tolerance: 3
		}).state

		expect(locked.drag).toBeNull()
		expect(selectKey(locked, { key: "Backspace" }).commit).toBeUndefined()
	})

	it("refreshes the selection after a change and drops it when gone", () => {
		const state = selected()

		expect(selectRefresh(state, 2, [{ ...square, rect: [0, 0, 5, 5] }]).selected?.rect).toEqual([0, 0, 5, 5])
		expect(selectRefresh(state, 2, [])).toBe(SELECT_IDLE)
		expect(selectRefresh(state, 1, [])).toBe(state)
	})
})
