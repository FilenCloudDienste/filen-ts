import { describe, expect, it } from "vitest"
import type { Transition } from "../core/anim/model"
import { ecmaFallback, transitionOption } from "../core/anim/presets/transitions/catalog"
import { DrawingList } from "../core/drawingml/index"
import { slideRef, type ShapeNode, type SlideNode } from "../core/presentation/model"
import type { SlideLayer, SlideRender } from "../core/presentation/output"
import { drawingData } from "../core/presentation/render/slide"
import { BACKDROP_LAYER, backdropWanted, planShowLayers, STATIC_LAYER } from "../dom/presentation/engine/show"

// A prism transition that turns the content only (p14:prism isContent, MS-PPTX §2.3.3.20) needs the slides' backdrop
// (background, then the master and layout art shown under the slide's own shapes) as a layer of its own, so the page
// keeps it still while the content turns. The worker splits it out only for a slide that such a transition enters or
// leaves (a second full-size bitmap costs bytes), and the orientation transitions read their dir as the schema does.

const EMU = 9525
const SLIDE = { w: 960, h: 540 }

function drawingDataOf(width: number, height: number): ReturnType<typeof drawingData> {
	const list = new DrawingList()

	list.width = width
	list.height = height

	return drawingData(list)
}

function drawn(id: number, x: number, y: number, w: number, h: number, owner = 256): SlideLayer {
	return {
		shape: { slide: slideRef(owner), id },
		drawing: drawingDataOf(w, h),
		matrix: [1, 0, 0, 1, x, y],
		role: owner === 256 ? "shape" : "master",
		...(owner === 256
			? { box: { id, xfrm: { x: x * EMU, y: y * EMU, cx: w * EMU, cy: h * EMU, rot: 0, flipH: false, flipV: false } } }
			: {})
	}
}

function renderOf(layers: readonly SlideLayer[]): SlideRender {
	return {
		ref: slideRef(256),
		index: 0,
		revision: 0,
		hidden: false,
		background: drawingDataOf(960, 540),
		layers,
		notesText: "",
		animated: true
	}
}

function nodeOf(ids: readonly number[]): SlideNode {
	const shapes: ShapeNode[] = ids.map(id => ({ id, name: String(id), hidden: false, kind: "sp" }))

	return { ref: slideRef(256), kind: "slide", part: "", showMasterShapes: true, hidden: false, shapes, comments: [], revision: 0 }
}

function transition(kind: string, namespace: Transition["namespace"], options: Transition["options"] = {}): Transition {
	return { kind, namespace, options, advance: { onClick: true } }
}

describe("show backdrop layer", () => {
	it("draws the background with the master and layout art as a layer of its own, the slide's shapes after it", () => {
		const render = renderOf([
			drawn(2, 0, 0, 960, 40, 1),
			drawn(3, 0, 500, 960, 40, 2),
			drawn(4, 10, 10, 100, 50),
			drawn(5, 200, 10, 100, 50)
		])
		const planned = planShowLayers(render, nodeOf([4, 5]), { shapes: [5], dpr: 1 }, SLIDE, undefined, { backdrop: true })

		expect(planned.map(layer => [layer.shape, layer.background, layer.pieces.map(piece => piece.layer.shape.id)])).toEqual([
			[BACKDROP_LAYER, true, [2, 3]],
			[STATIC_LAYER, false, [4]],
			[5, false, [5]]
		])
		expect(planned[0]?.bounds).toEqual([0, 0, 960, 540])
		expect(planned[1]?.bounds).toEqual([10, 10, 110, 60])
	})

	it("keeps one static run with the background when no backdrop is asked for (no extra bitmap)", () => {
		const render = renderOf([drawn(2, 0, 0, 960, 40, 1), drawn(4, 10, 10, 100, 50)])
		const planned = planShowLayers(render, nodeOf([4]), { shapes: [], dpr: 1 }, SLIDE)

		expect(planned.map(layer => [layer.shape, layer.background, layer.pieces.length])).toEqual([[STATIC_LAYER, true, 2]])
	})

	it("splits a slide a content-only transition enters or leaves, and no other", () => {
		const content = transition("prism", "p14", { isContent: true })

		expect(backdropWanted(content, undefined)).toBe(true)
		expect(backdropWanted(undefined, content)).toBe(true)
		expect(backdropWanted(transition("prism", "p14", { isContent: "1" }), undefined)).toBe(true)
		expect(backdropWanted(transition("prism", "p14"), transition("prism", "p14", { isContent: false }))).toBe(false)
		expect(backdropWanted(transition("fade", "p"), undefined)).toBe(false)
		// The kinds MS-PPTX shows moving only the content (Figures 1, 3, 6, 10, 21).
		for (const kind of ["window", "conveyor", "ferris", "flythrough", "pan"]) {
			expect(backdropWanted(transition(kind, "p14"), undefined), kind).toBe(true)
			expect(backdropWanted(undefined, transition(kind, "p14")), kind).toBe(true)
		}

		expect(backdropWanted(transition("doors", "p14"), transition("gallery", "p14"))).toBe(false)
	})
})

describe("pan (CT_SideDirectionTransition)", () => {
	it("defaults dir to l, as the schema does, and falls back to a push the same way", () => {
		expect(transitionOption(transition("pan", "p14"), "dir")).toBe("l")
		expect(ecmaFallback(transition("pan", "p14"))).toEqual({ kind: "push", options: { dir: "l" } })
		expect(ecmaFallback(transition("pan", "p14", { dir: "u" }))).toEqual({ kind: "push", options: { dir: "u" } })
	})
})

describe("orientation transitions (CT_OrientationTransition)", () => {
	it("default dir to horz, as the schema does, for doors and window alike", () => {
		for (const kind of ["doors", "window"]) {
			expect(transitionOption(transition(kind, "p14"), "dir"), kind).toBe("horz")
			// The ECMA fallback of a dir-less one splits the same way.
			expect(ecmaFallback(transition(kind, "p14")), kind).toEqual({ kind: "split", options: { orient: "horz", dir: "out" } })
			expect(ecmaFallback(transition(kind, "p14", { dir: "vert" })), kind).toEqual({
				kind: "split",
				options: { orient: "vert", dir: "out" }
			})
		}
	})
})
