import { describe, expect, it } from "vitest"
import type { LayerState, TimegraphInstance } from "../core/anim/model"
import { compile, instantiate } from "../core/anim/timegraph"
import { PresentationError } from "../core/presentation/model"
import { BUDGETS, TimingBuilder, animatedSlide, layersOf, shape } from "./animFixtures"

// Event-log driven tests of the timegraph: each fires a sequence of events at slide times and samples the layers.

const SHAPES = [shape(2, 0, 0), shape(3, 1905000, 0), shape(4, 3810000, 0), shape(5, 0, 1905000), shape(9, 5715000, 1905000)]
const LAYERS = layersOf([2, 3, 4, 5, 9])

function layer(states: readonly LayerState[], index: number): LayerState {
	const state = states.find(entry => entry.layer === index)

	if (state === undefined) throw new Error(`layer ${String(index)} not sampled`)

	return state
}

function rotation(state: LayerState): number {
	const [a = 1, b = 0] = state.matrix

	return (Math.atan2(b, a) * 180) / Math.PI
}

function started(build: (b: TimingBuilder) => ReturnType<TimingBuilder["root"]>): TimegraphInstance {
	const b = new TimingBuilder()
	const instance = instantiate(compile(animatedSlide(build(b), SHAPES), LAYERS, BUDGETS))

	instance.fire({ kind: "slideBegin" }, 0)

	return instance
}

describe("the timegraph", () => {
	it("hides a shape before its entrance and plays click groups with their after-effects", () => {
		const t = started(b =>
			b.root([
				b.mainSeq([
					b.click([
						[0, [b.flyIn(4, "clickEffect")]],
						[500, [b.spin(2, "afterEffect")]]
					])
				])
			])
		)

		expect(layer(t.sample(0), 2).visible).toBe(false)
		t.fire({ kind: "next" }, 1000)
		expect(t.snapshot().step).toBe(1)

		const mid = layer(t.sample(1250), 2)

		expect(mid.visible).toBe(true)
		// Half way up from below the slide: ppt_y from 1 + h/2 to y.
		expect(mid.matrix[5]).toBeGreaterThan(0)
		expect(layer(t.sample(1500), 2).matrix[5]).toBeCloseTo(0, 6)
		// The spin begins after the fly-in: 2000 ms after 1500.
		expect(rotation(layer(t.sample(1500), 0))).toBeCloseTo(0, 6)
		expect(rotation(layer(t.sample(2000), 0))).toBeCloseTo(90, 4)
		expect(t.nextActivation()).toBe(1001)
	})

	it("answers the next begin or end after a sampled time, and none once everything has ended", () => {
		const t = started(b =>
			b.root([
				b.mainSeq([
					b.click([
						[0, [b.flyIn(4, "clickEffect")]],
						[500, [b.spin(2, "afterEffect")]]
					])
				])
			])
		)

		t.fire({ kind: "next" }, 1000)

		// From the click's time: the fly-in under way. Sampled past the fly-in's end (1500): the spin's end (it runs
		// 1500–3500); past that, nothing is left to wait for.
		expect(t.nextActivation()).toBe(1001)
		expect(t.nextActivation(1600)).toBe(3500)
		expect(t.nextActivation(10_000)).toBeUndefined()
	})

	it("seeks a running step to its end on next when nextAc is seek, spending the click", () => {
		const t = started(b =>
			b.root([b.mainSeq([b.click([[0, [b.spin(2, "clickEffect", 2000)]]]), b.click([[0, [b.flyIn(4, "clickEffect")]]])])])
		)

		t.fire({ kind: "next" }, 0)
		expect(rotation(layer(t.sample(500), 0))).toBeCloseTo(90, 4)
		t.fire({ kind: "next" }, 500)
		// At its end state at once; the second step has not begun.
		expect(rotation(layer(t.sample(500), 0)) % 360).toBeCloseTo(0, 4)
		expect(t.snapshot().step).toBe(1)
		expect(layer(t.sample(600), 2).visible).toBe(false)
		t.fire({ kind: "next" }, 700)
		expect(t.snapshot().step).toBe(2)
		expect(layer(t.sample(701), 2).visible).toBe(true)
	})

	it("ends an until-next-click emphasis with the click that begins the next step", () => {
		const t = started(b =>
			b.root([
				b.mainSeq([
					b.click([
						[
							0,
							[
								b.spin(2, "clickEffect", 1000, {
									repeatCount: "indefinite",
									endCondLst: [{ evt: "onNext", delay: 0, tgtEl: { kind: "slide" } }]
								})
							]
						]
					]),
					b.click([[0, [b.flyIn(4, "clickEffect")]]])
				])
			])
		)

		t.fire({ kind: "next" }, 0)
		expect(rotation(layer(t.sample(2250), 0))).toBeCloseTo(90, 4)
		t.fire({ kind: "next" }, 2250)
		expect(t.snapshot().step).toBe(2)
		expect(layer(t.sample(2260), 2).visible).toBe(true)
	})

	it("plays a trigger fired mid-step beside the main sequence, which keeps running", () => {
		const t = started(b =>
			b.root([b.mainSeq([b.click([[0, [b.spin(2, "clickEffect", 2000)]]])]), b.interactive(9, [b.spin(5, "clickEffect", 1000)])])
		)
		const graph = compile(animatedSlide(new TimingBuilder().root([new TimingBuilder().interactive(9, [])]), SHAPES), LAYERS, BUDGETS)

		expect(graph.interactive).toEqual([{ trigger: { slide: 1, id: 9 }, seq: 0 }])
		t.fire({ kind: "next" }, 0)
		t.fire({ kind: "click", shape: 9 }, 500)
		// Both run: the main step at 750 ms of 2000, the trigger at 250 of 1000.
		expect(rotation(layer(t.sample(750), 0))).toBeCloseTo(135, 4)
		expect(rotation(layer(t.sample(750), 3))).toBeCloseTo(90, 4)
		expect(t.snapshot().step).toBe(1)
	})

	it("does not restart a whenNotActive node clicked while it plays, and restarts it once it has ended", () => {
		const t = started(b => {
			const effect = b.spin(5, "clickEffect", 1000)

			effect.ctn.restart = "whenNotActive"
			effect.ctn.stCondLst.splice(0, 1, { evt: "onClick", delay: 0, tgtEl: { kind: "shape", shape: 9 } })

			return b.root([b.mainSeq([]), effect])
		})

		t.fire({ kind: "click", shape: 9 }, 0)
		t.fire({ kind: "click", shape: 9 }, 500)
		expect(rotation(layer(t.sample(750), 3))).toBeCloseTo(-90, 4)
		t.fire({ kind: "click", shape: 9 }, 2000)
		expect(rotation(layer(t.sample(2250), 3))).toBeCloseTo(90, 4)
	})

	it("begins an effect on a media bookmark", () => {
		const t = started(b => {
			const effect = b.flyIn(4, "clickEffect")

			effect.ctn.stCondLst.splice(0, 1, { evt: "onMediaBookmark", delay: 0, tgtEl: { kind: "shape", shape: 5 }, bookmark: "chorus" })

			return b.root([b.mainSeq([]), effect])
		})

		t.fire({ kind: "mediaBookmark", shape: 5, bookmark: "verse" }, 100)
		expect(layer(t.sample(200), 2).visible).toBe(false)
		t.fire({ kind: "mediaBookmark", shape: 5, bookmark: "chorus" }, 300)
		expect(layer(t.sample(301), 2).visible).toBe(true)
	})

	it("restores the boundary state on previous, across a step whose effect has fill remove", () => {
		const t = started(b =>
			b.root([
				b.mainSeq([
					b.click([[0, [b.flyIn(4, "clickEffect")]]]),
					b.click([[0, [b.spin(2, "clickEffect", 1000, { fill: "remove" }), b.fadeOut(4, "withEffect")]]])
				])
			])
		)

		t.fire({ kind: "next" }, 0)
		const boundary = t.snapshot()
		const atBoundary = t.sample(2000)

		t.fire({ kind: "next" }, 2000)
		expect(layer(t.sample(3000), 2).visible).toBe(false)
		expect(rotation(layer(t.sample(2500), 0))).toBeCloseTo(180, 4)
		t.fire({ kind: "prev" }, 3000)
		expect(t.snapshot().step).toBe(1)
		expect(t.sample(3000)).toEqual(atBoundary)

		// The player's path: restore the boundary snapshot taken when the step began.
		t.fire({ kind: "next" }, 4000)
		t.restore(boundary)
		expect(t.sample(5000)).toEqual(atBoundary)
		expect(t.snapshot().step).toBe(1)
	})

	it("counts main-sequence steps and reports the slide done past the last one", () => {
		const b = new TimingBuilder()
		const first = b.click([[0, [b.flyIn(4, "clickEffect")]]])
		const main = b.mainSeq([first, b.click([[0, [b.spin(2, "clickEffect")]]])])

		// "With previous" as the first effect: the group begins with the main sequence.
		first.ctn.stCondLst.push({ evt: "onBegin", delay: 0, tn: main.ctn.id })

		const tree = b.root([main])
		const graph = compile(animatedSlide(tree, SHAPES), LAYERS, BUDGETS)
		const t = instantiate(graph)

		expect(graph.mainSteps).toBe(1)
		t.fire({ kind: "slideBegin" }, 0)
		// The first group begins with the main sequence.
		expect(layer(t.sample(10), 2).visible).toBe(true)
		t.fire({ kind: "next" }, 1000)
		t.fire({ kind: "next" }, 4000)
		expect(t.snapshot().step).toBe(2)
	})

	it("refuses a tree past the node budget and depth", () => {
		const b = new TimingBuilder()
		const tree = b.root([b.mainSeq([b.click([[0, [b.flyIn(4, "clickEffect")]]])])])

		expect(() => compile(animatedSlide(tree, SHAPES), LAYERS, { ...BUDGETS, nodesPerSlide: 5 })).toThrow(PresentationError)
		expect(() => compile(animatedSlide(tree, SHAPES), LAYERS, { ...BUDGETS, depth: 3 })).toThrow(/deeper/u)
	})
})
