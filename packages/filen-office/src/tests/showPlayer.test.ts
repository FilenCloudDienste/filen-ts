import { describe, expect, it } from "vitest"
import type { LayerState, TimegraphSource, Transition } from "../core/anim/model"
import { inRegion, transitionFrame } from "../core/anim/transitions"
import { slideRef, type CustomShow } from "../core/presentation/model"
import type { ShowLayer } from "../dom/presentation/protocol"
import { clipPathCss, filterFrame } from "../react/presentation/show/filters"
import { layerBoxes, layerCss, layerIndices, layerPlanOf, layerTree, type LayerNode } from "../react/presentation/show/layers"
import { linkBoxes } from "../react/presentation/show/links"
import { advanceAt, DEFAULT_SHOW_OPTIONS, ShowNavigator, showOptionsOf, showSequence } from "../react/presentation/show/timeline"
import { transitionDurationMs, transitionStyles } from "../react/presentation/show/transitions"
import { fixtureTextPage } from "./fixtures/presentation/textPage"

// The player's pure parts: the clip regions of the 21 ECMA transitions and of the animEffect filters drawn as CSS
// clip paths, measured against the ECMA progress functions at t = 0, 0.5 and 1 (ink mismatch on a sample grid); the
// CSS of a sampled layer state; how drawn layers nest; link boxes; and which slide comes next (hidden slides,
// ranges, custom shows and their return, loops, timed advance).

// --- Rasterising a CSS clip path (the even-odd fill of its polygons) ---

function polygonsOfCss(css: string): number[][] {
	if (css.startsWith("inset(50%")) return []

	const d = /path\(evenodd, "([^"]*)"\)/u.exec(css)?.[1] ?? ""

	return d
		.split("Z")
		.filter(part => part.trim() !== "")
		.map(part => [...part.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/gu)].flatMap(match => [Number(match[1]), Number(match[2])]))
}

function insideEvenOdd(polygons: readonly number[][], x: number, y: number): boolean {
	let inside = false

	for (const points of polygons) {
		const n = points.length / 2

		for (let i = 0, j = n - 1; i < n; j = i++) {
			const xi = points[i * 2] ?? 0
			const yi = points[i * 2 + 1] ?? 0
			const xj = points[j * 2] ?? 0
			const yj = points[j * 2 + 1] ?? 0

			if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
		}
	}

	return inside
}

const GRID_W = 160
const GRID_H = 120

// The share of grid points where the clip and the reference disagree (box 0..W x 0..H).
function mismatch(css: string, reference: (u: number, v: number) => boolean, w = 960, h = 720): number {
	const polygons = css === "" ? undefined : polygonsOfCss(css)
	let wrong = 0

	for (let j = 0; j < GRID_H; j++) {
		for (let i = 0; i < GRID_W; i++) {
			const u = (i + 0.5) / GRID_W
			const v = (j + 0.5) / GRID_H
			const shown = polygons === undefined ? true : insideEvenOdd(polygons, u * w, v * h)

			if (shown !== reference(u, v)) wrong++
		}
	}

	return wrong / (GRID_W * GRID_H)
}

const ECMA_TRANSITIONS: readonly [string, Record<string, string | number | boolean>][] = [
	["blinds", { dir: "vert" }],
	["checker", {}],
	["circle", {}],
	["comb", { dir: "vert" }],
	["cover", { dir: "u" }],
	["cut", {}],
	["diamond", {}],
	["dissolve", {}],
	["fade", {}],
	["newsflash", {}],
	["plus", {}],
	["pull", { dir: "r" }],
	["push", { dir: "d" }],
	["random", {}],
	["randomBar", { dir: "vert" }],
	["split", { orient: "vert", dir: "in" }],
	["strips", { dir: "ru" }],
	["wedge", {}],
	["wheel", { spokes: 8 }],
	["wipe", { dir: "u" }],
	["zoom", { dir: "in" }]
]

function transition(kind: string, options: Transition["options"]): Transition {
	return { kind, namespace: "p", options, advance: { onClick: true } }
}

describe("transitions as CSS", () => {
	it("covers the 21 ECMA transitions: the revealed region within 1% of the progress function at 0, 0.5 and 1", () => {
		expect(ECMA_TRANSITIONS).toHaveLength(21)

		for (const [kind, options] of ECMA_TRANSITIONS) {
			for (const p of [0, 0.5, 1]) {
				const frame = transitionFrame(kind, options, p)
				const styles = transitionStyles(transition(kind, options), p, { w: 960, h: 720 })

				expect(
					mismatch(styles.incoming.clipPath, (u, v) => inRegion(frame.reveal, u, v)),
					`${kind} at ${String(p)}`
				).toBeLessThanOrEqual(0.01)
				expect(styles.incoming.opacity).toBe(frame.incoming.opacity)
				expect(styles.outgoing.opacity).toBe(frame.outgoing.opacity)
				expect(styles.black).toBe(frame.black)
				expect(styles.outgoingOnTop).toBe(frame.outgoingOnTop)
			}
		}
	})

	it("moves the slides by the progress function's offsets, turns and scales", () => {
		expect(transitionStyles(transition("push", { dir: "d" }), 0.25, { w: 960, h: 720 })).toMatchObject({
			incoming: { transform: "translate(0px,-540px)" },
			outgoing: { transform: "translate(0px,180px)" }
		})
		expect(transitionStyles(transition("newsflash", {}), 0.5, { w: 960, h: 720 }).incoming.transform).toBe("rotate(360deg) scale(0.5)")
		expect(transitionStyles(transition("cover", { dir: "u" }), 1, { w: 960, h: 720 }).incoming.transform).toBe("")
	})

	it("lasts p14:dur, else the speed's PowerPoint duration (fast by default)", () => {
		expect(transitionDurationMs({ ...transition("fade", {}), durationMs: 1250 })).toBe(1250)
		expect(transitionDurationMs({ ...transition("fade", {}), speed: "slow" })).toBe(1000)
		expect(transitionDurationMs({ ...transition("fade", {}), speed: "med" })).toBe(750)
		expect(transitionDurationMs(transition("fade", {}))).toBe(500)
	})
})

// The animEffect filters PowerPoint's presets write (entrance families; exits play them out), each with its formula.
const FILTERS: readonly [string, (u: number, v: number, p: number) => boolean][] = [
	["wipe(down)", (_u, v, p) => v < p],
	["wipe(up)", (_u, v, p) => v >= 1 - p],
	["wipe(left)", (u, _v, p) => u >= 1 - p],
	["wipe(right)", (u, _v, p) => u < p],
	["barn(inVertical)", (u, _v, p) => u < p / 2 || u >= 1 - p / 2],
	["barn(outHorizontal)", (_u, v, p) => v >= 0.5 - p / 2 && v < 0.5 + p / 2],
	["box(out)", (u, v, p) => Math.abs(u - 0.5) <= p / 2 && Math.abs(v - 0.5) <= p / 2],
	["box(in)", (u, v, p) => !(Math.abs(u - 0.5) < (1 - p) / 2 && Math.abs(v - 0.5) < (1 - p) / 2)],
	["circle(out)", (u, v, p) => (u - 0.5) ** 2 + (v - 0.5) ** 2 <= (p * Math.SQRT1_2) ** 2],
	["circle(in)", (u, v, p) => (u - 0.5) ** 2 + (v - 0.5) ** 2 > ((1 - p) * Math.SQRT1_2) ** 2],
	["diamond(out)", (u, v, p) => Math.abs(u - 0.5) + Math.abs(v - 0.5) <= p],
	[
		"plus(out)",
		(u, v, p) => (Math.abs(u - 0.5) <= p / 2 && Math.abs(v - 0.5) <= p) || (Math.abs(u - 0.5) <= p && Math.abs(v - 0.5) <= p / 2)
	],
	["blinds(horizontal)", (_u, v, p) => (v * 6) % 1 < p],
	["checkerboard(across)", (u, v, p) => inRegion(transitionFrame("checker", { dir: "horz" }, p).reveal, u, v)],
	["randombar(horizontal)", (u, v, p) => inRegion(transitionFrame("randomBar", { dir: "horz" }, p).reveal, u, v)],
	["dissolve", (u, v, p) => inRegion(transitionFrame("dissolve", {}, p).reveal, u, v)],
	["strips(downRight)", (u, v, p) => u + v < 2 * p],
	["wedge", (u, v, p) => inRegion(transitionFrame("wedge", {}, p).reveal, u, v)],
	["wheel(4)", (u, v, p) => inRegion(transitionFrame("wheel", { spokes: 4 }, p).reveal, u, v)]
]

describe("animEffect filters as CSS", () => {
	const box = { x: 0, y: 0, w: 960, h: 720 }

	it("reveals each filter's region within 1% of its formula at 0, 0.5 and 1, in and out", () => {
		for (const [filter, formula] of FILTERS) {
			for (const p of [0, 0.5, 1]) {
				for (const reverse of [false, true]) {
					const frame = filterFrame(filter, p, reverse)
					const q = reverse ? 1 - p : p
					const css = frame.clip === undefined ? "" : clipPathCss(frame.clip, box)

					expect(
						mismatch(css, (u, v) => formula(u, v, q)),
						`${filter} at ${String(p)}${reverse ? " out" : ""}`
					).toBeLessThanOrEqual(0.01)
				}
			}
		}
	})

	it("fades by opacity, slides the content within a fixed clip, multiplies several filters", () => {
		expect(filterFrame("fade", 0.25, false)).toEqual({ opacity: 0.25, dx: 0, dy: 0 })
		expect(filterFrame("fade", 0.25, true).opacity).toBe(0.75)

		const slide = filterFrame("slide(fromTop)", 0.25, false)

		expect(slide.dy).toBe(-0.75)
		expect(clipPathCss(slide.clip ?? { kind: "none" }, { x: 10, y: 20, w: 100, h: 50 }, 0, -37.5)).toBe(
			'path(evenodd, "M10 57.5L110 57.5L110 107.5L10 107.5Z")'
		)

		const both = filterFrame("fade;wipe(right)", 0.5, false)

		expect(both.opacity).toBe(0.5)
		expect(mismatch(clipPathCss(both.clip ?? { kind: "none" }, box), u => u < 0.5)).toBe(0)
		expect(filterFrame("image", 0.5, false)).toEqual({ opacity: 1, dx: 0, dy: 0 })
	})

	it("reaches past the box on its edges, so effects outside the shape box show with the edge they touch", () => {
		const css = clipPathCss(filterFrame("wipe(right)", 0.5, false).clip ?? { kind: "none" }, { x: 100, y: 100, w: 200, h: 100 })

		expect(polygonsOfCss(css)).toEqual([[-700, -300, 200, -300, 200, 600, -700, 600]])
	})
})

describe("layer CSS", () => {
	const state = (fields: Partial<LayerState>): LayerState => ({
		layer: 0,
		visible: true,
		opacity: 1,
		matrix: [1, 0, 0, 1, 0, 0],
		...fields
	})
	const box = { x: 100, y: 50, w: 200, h: 100 }

	it("writes the sampled matrix about the slide origin, opacity and visibility, nothing when as drawn", () => {
		expect(layerCss(undefined, box)).toEqual({ transform: "", opacity: "", visibility: "visible", clipPath: "" })
		expect(layerCss(state({}), box)).toEqual({ transform: "", opacity: "", visibility: "visible", clipPath: "" })
		expect(layerCss(state({ matrix: [0, 1, -1, 0, 350, -100], opacity: 0.4, visible: false }), box)).toEqual({
			transform: "matrix(0,1,-1,0,350,-100)",
			opacity: "0.4",
			visibility: "hidden",
			clipPath: ""
		})
	})

	it("adds a filter's opacity, clip over the shape box and slide offset", () => {
		const css = layerCss(state({ filter: { name: "slide(fromLeft)", progress: 0.5, reverse: false }, opacity: 0.5 }), box)

		expect(css.transform).toBe("matrix(1,0,0,1,0,0) translate(-100px,0px)")
		expect(css.opacity).toBe("0.5")
		expect(polygonsOfCss(css.clipPath)).toEqual([[200, 50, 400, 50, 400, 150, 200, 150]])
	})
})

describe("layer plans and nesting", () => {
	const source: TimegraphSource = {
		timing: undefined,
		layers: {
			shapes: Int32Array.of(2, 3, 3, 3, 9),
			ranges: [undefined, undefined, { unit: "para", start: 0, end: 0 }, { unit: "para", start: 1, end: 2 }, undefined]
		},
		parents: Int32Array.of(-1, -1, 1, 1, 0),
		slideSize: { cx: 9144000, cy: 6858000 },
		geometry: new Float64Array(0),
		colors: []
	}

	it("asks for each shape once with its paragraph ranges", () => {
		expect(layerPlanOf(source, 2)).toEqual({
			shapes: [2, 3, 9],
			ranges: [
				undefined,
				[
					{ target: "para", range: [0, 0] },
					{ target: "para", range: [1, 2] }
				],
				undefined
			],
			dpr: 2
		})
	})

	it("matches drawn layers to timegraph layers and nests them in their parents in z-order", () => {
		const drawn = (shape: number, range?: [number, number]): ShowLayer => ({
			shape,
			...(range === undefined ? {} : { range: { target: "para", range } }),
			bitmap: { width: 1, height: 1, close: () => undefined },
			x: 0,
			y: 0,
			width: 1,
			height: 1
		})
		const layers = [drawn(-1), drawn(2), drawn(9), drawn(2), drawn(-1), drawn(3), drawn(3, [0, 0]), drawn(3, [1, 2]), drawn(-1)]
		const indices = layerIndices(source, layers)

		expect([...indices]).toEqual([-1, 0, 4, 0, -1, 1, 2, 3, -1])

		const tree = layerTree(indices, source.parents)
		const shape = (node: LayerNode | number): unknown => (typeof node === "number" ? node : { [node.layer]: node.children.map(shape) })

		expect(tree.children.map(shape)).toEqual([0, { 0: [1, { 4: [2] }, 3] }, 4, { 1: [5, { 2: [6] }, { 3: [7] }] }, 8])
	})

	it("keeps a paragraph range and a by-letter run with the same numbers apart, and reveals a run over its own box", () => {
		const runs: TimegraphSource = {
			timing: undefined,
			layers: {
				shapes: Int32Array.of(3, 3, 3),
				ranges: [undefined, { unit: "para", start: 1, end: 1 }, { unit: "char", start: 1, end: 1 }],
				boxes: Float64Array.of(
					Number.NaN,
					Number.NaN,
					Number.NaN,
					Number.NaN,
					Number.NaN,
					Number.NaN,
					Number.NaN,
					Number.NaN,
					9525,
					19050,
					95250,
					190500
				)
			},
			parents: Int32Array.of(-1, 0, 1),
			slideSize: { cx: 9144000, cy: 6858000 },
			geometry: Float64Array.of(3, 952500, 952500, 1905000, 952500),
			colors: []
		}
		const drawn = (target?: "para" | "char"): ShowLayer => ({
			shape: 3,
			...(target === undefined ? {} : { range: { target, range: [1, 1] } }),
			bitmap: { width: 1, height: 1, close: () => undefined },
			x: 0,
			y: 0,
			width: 1,
			height: 1
		})

		expect([...layerIndices(runs, [drawn(), drawn("para"), drawn("char")])]).toEqual([0, 1, 2])
		expect([...layerBoxes(runs)]).toEqual([100, 100, 200, 100, 100, 100, 200, 100, 1, 2, 10, 20])
	})
})

describe("link boxes", () => {
	it("boxes each linked range line by line, a cut fragment by its share of characters", () => {
		const fixture = fixtureTextPage(["Visit filen.io now", "plain"], { link: "https://filen.io" })
		// "filen.io" (characters 6 to 14) of the first line, one fragment of 18 characters at 9 px each.
		const text = { ...fixture, page: { ...fixture.page, linkInts: Int32Array.of(0, 6, 14, 0) } }
		const boxes = linkBoxes({
			shape: { slide: slideRef(256), id: 4 },
			drawing: fixture.page as never,
			matrix: [1, 0, 0, 1, 0, 0],
			role: "shape",
			text
		})

		expect(boxes).toEqual([{ link: 0, x: 54, y: 0, width: 72, height: 24 }])
	})
})

describe("show navigation", () => {
	const slides = [0, 1, 2, 3, 4].map(n => ({ ref: slideRef(256 + n), hidden: n === 2 }))
	const custom: CustomShow = { name: "Short", id: 7, slides: [slideRef(260), slideRef(257)] }

	it("runs the visible slides, a range, or a custom show in its order", () => {
		expect(showSequence(slides, undefined)).toEqual([0, 1, 3, 4])
		expect(showSequence(slides, undefined, { start: 2, end: 4 })).toEqual([1, 3])
		expect(showSequence(slides, custom)).toEqual([4, 1])
	})

	it("skips hidden slides, ends after the last, loops when asked, and continues in the deck after a jump", () => {
		const nav = new ShowNavigator(slides, [], DEFAULT_SHOW_OPTIONS)

		nav.go(nav.at(1))
		expect(nav.following(1)).toEqual({ kind: "slide", position: { step: 2, index: 3 } })

		nav.go(nav.last())
		expect(nav.following(1)).toEqual({ kind: "end" })

		// A hidden slide shown by a jump: next is the run's first slide after it.
		nav.go(nav.at(2))
		expect(nav.position).toEqual({ step: -1, index: 2 })
		expect(nav.following(1)).toEqual({ kind: "slide", position: { step: 2, index: 3 } })
		expect(nav.following(-1)).toEqual({ kind: "slide", position: { step: 1, index: 1 } })
		expect(nav.lastViewed).toBe(4)

		const loop = new ShowNavigator(slides, [], { ...DEFAULT_SHOW_OPTIONS, loop: true })

		loop.go(loop.last())
		expect(loop.following(1)).toEqual({ kind: "slide", position: { step: 0, index: 0 } })
		expect(new ShowNavigator(slides, [], { ...DEFAULT_SHOW_OPTIONS, kiosk: true, loop: false }).peek()).toBe(1)
	})

	it("returns from a custom show an action entered, or ends with one the show was started as", () => {
		const nav = new ShowNavigator(slides, [custom], DEFAULT_SHOW_OPTIONS)

		nav.go(nav.at(1))
		expect(nav.enterCustom(7, true)).toBe(true)
		expect(nav.position).toEqual({ step: 0, index: 4 })

		const last = nav.following(1)

		expect(last).toEqual({ kind: "slide", position: { step: 1, index: 1 } })

		if (last.kind === "slide") nav.go(last.position)

		const back = nav.following(1)

		expect(back).toEqual({ kind: "slide", position: { step: 1, index: 1 } })

		if (back.kind === "slide") nav.go(back.position)

		// Back in the whole show, where it was left.
		expect(nav.indices).toEqual([0, 1, 3, 4])
		expect(nav.following(1)).toEqual({ kind: "slide", position: { step: 2, index: 3 } })

		const only = new ShowNavigator(slides, [custom], { ...DEFAULT_SHOW_OPTIONS, customShow: 7 })

		expect(only.indices).toEqual([4, 1])
		only.go(only.last())
		expect(only.following(1)).toEqual({ kind: "end" })
		expect(nav.enterCustom(99, false)).toBe(false)
	})

	it("reads the deck's settings: kiosk loops and uses timings, a range and a custom show", () => {
		expect(
			showOptionsOf({
				kind: "kiosk",
				loop: false,
				showNarration: true,
				showAnimation: true,
				useTimings: false,
				range: { kind: "range", start: 2, end: 3 },
				restartMs: 300000
			})
		).toEqual({ loop: true, kiosk: true, useTimings: true, range: { start: 2, end: 3 }, restartMs: 300000 })
		expect(
			showOptionsOf({
				kind: "present",
				loop: false,
				showNarration: true,
				showAnimation: true,
				useTimings: true,
				range: { kind: "customShow", id: 4 }
			})
		).toEqual({ loop: false, kiosk: false, useTimings: true, customShow: 4 })
	})

	it("advances by timing once the slide is idle and its advance-after has passed, never without timings", () => {
		const after: Transition = { kind: "fade", namespace: "p", options: {}, advance: { onClick: true, afterMs: 3000 } }

		expect(advanceAt(after, DEFAULT_SHOW_OPTIONS, 1000, 1500)).toBe(4000)
		expect(advanceAt(after, DEFAULT_SHOW_OPTIONS, 1000, 9000)).toBe(9000)
		expect(advanceAt(after, { ...DEFAULT_SHOW_OPTIONS, useTimings: false }, 1000, 1500)).toBeUndefined()
		expect(advanceAt({ ...after, advance: { onClick: true } }, DEFAULT_SHOW_OPTIONS, 1000, 1500)).toBeUndefined()
		expect(advanceAt(after, DEFAULT_SHOW_OPTIONS, 1000, undefined)).toBeUndefined()
	})
})
