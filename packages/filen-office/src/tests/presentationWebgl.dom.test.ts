// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { Transition } from "../core/anim/model"
import { planMorph, type MorphShape } from "../core/anim/morph"
import { slideRef } from "../core/presentation/model"
import { slideDraws } from "../react/presentation/show/webgl/compose"
import { warmWebgl, webglTransitions } from "../react/presentation/show/webgl/index"
import { framePaths, vectorBox, vectorPlan } from "../react/presentation/show/webgl/vector"
import { PRESET_GEOMETRY } from "../core/drawingml/geometry/presets.generated"
import {
	capVectors,
	drawMorph,
	morphBuffers,
	morphElements,
	outlineSlots,
	morphPixelRatio,
	MORPH_LAYER_BYTES,
	shownObjects,
	VECTOR_FRAME_SHAPES,
	type MorphData
} from "../react/presentation/show/webgl/morph"
import { cpuMs } from "./timing"
import { particleScale, particleShape, PARTICLE_KINDS } from "../react/presentation/show/webgl/particles"

// The show's WebGL2 transitions on the page: when they decline (so the player plays the file's mc:Fallback), what
// each p14 particle transition's options select, how a run fits the GPU budget, and what of the stage they draw.
// The frames themselves are compared with the static slides in real browsers.

function transition(kind: string, namespace: Transition["namespace"], options: Transition["options"] = {}): Transition {
	return { kind, namespace, options, durationMs: 1000, advance: { onClick: true } }
}

const KINDS = [...PARTICLE_KINDS]

describe("declining to the file's fallback", () => {
	it("draws no particle transition and no morph without WebGL2", () => {
		expect(Reflect.get(globalThis, "WebGL2RenderingContext")).toBeUndefined()

		for (const kind of KINDS) expect(webglTransitions.draws(kind, "p14")).toBe(false)

		expect(webglTransitions.draws("morph", "morph")).toBe(false)
	})

	it("never claims ECMA, p15 or other p14 kinds", () => {
		vi.stubGlobal("WebGL2RenderingContext", function WebGL2RenderingContext() {})

		expect(webglTransitions.draws("vortex", "p14")).toBe(true)
		expect(webglTransitions.draws("morph", "morph")).toBe(true)
		expect(webglTransitions.draws("fade", "p")).toBe(false)
		expect(webglTransitions.draws("vortex", "p15")).toBe(false)
		expect(webglTransitions.draws("doors", "p14")).toBe(false)
		expect(webglTransitions.draws("curtains", "p15")).toBe(false)
	})

	it("declines when the browser makes no WebGL2 context", async () => {
		vi.stubGlobal("WebGL2RenderingContext", function WebGL2RenderingContext() {})

		const host = document.createElement("div")
		const outgoing = document.createElement("div")
		const incoming = document.createElement("div")
		const prepared = await webglTransitions.prepare?.({
			transition: transition("ripple", "p14"),
			session: undefined,
			outgoing: slideRef(256),
			outgoingSource: undefined,
			incoming: slideRef(257),
			incomingSource: undefined,
			widthPx: 960,
			dpr: 1,
			signal: { aborted: false }
		})
		const run = webglTransitions.start({
			document,
			host,
			outgoing,
			incoming,
			transition: transition("ripple", "p14"),
			slide: { w: 960, h: 540 },
			pixelRatio: 1,
			budgetBytes: 256 * 1024 * 1024,
			incomingSlide: slideRef(257)
		})

		expect(prepared).toBeUndefined()
		expect(run).toBeUndefined()
		expect(host.childElementCount).toBe(0)
	})

	it("declines morph without the slides' objects from the worker", async () => {
		vi.stubGlobal("WebGL2RenderingContext", function WebGL2RenderingContext() {})

		const run = webglTransitions.start({
			document,
			host: document.createElement("div"),
			outgoing: document.createElement("div"),
			incoming: document.createElement("div"),
			transition: transition("morph", "morph", { option: "byObject" }),
			slide: { w: 960, h: 540 },
			pixelRatio: 1,
			budgetBytes: 256 * 1024 * 1024,
			incomingSlide: slideRef(257)
		})

		expect(run).toBeUndefined()
	})
})

describe("particle transition options (MS-PPTX §2.3.3 defaults)", () => {
	it("starts vortex, glitter at the schema's dir l, moving left", () => {
		expect(particleShape(transition("vortex", "p14"), 16 / 9)?.dir).toEqual([-1, 0])
		expect(particleShape(transition("vortex", "p14", { dir: "u" }), 16 / 9)?.dir).toEqual([0, -1])
		expect(particleShape(transition("glitter", "p14"), 16 / 9)).toMatchObject({ dir: [-1, 0], mode: 0 })
		expect(particleShape(transition("glitter", "p14", { pattern: "hexagon", dir: "r" }), 16 / 9)).toMatchObject({
			dir: [1, 0],
			mode: 1
		})
	})

	it("ripples from the centre, or the corner its dir names", () => {
		expect(particleShape(transition("ripple", "p14"), 16 / 9)?.dir).toEqual([0.5, 0.5])
		expect(particleShape(transition("ripple", "p14", { dir: "rd" }), 16 / 9)?.dir).toEqual([1, 1])
	})

	it("shreds strips in by default, rectangles out on request", () => {
		expect(particleShape(transition("shred", "p14"), 16 / 9)).toMatchObject({ mode: 0, grid: [24, 1], outgoingOver: false })
		expect(particleShape(transition("shred", "p14", { pattern: "rectangle", dir: "out" }), 16 / 9)).toMatchObject({
			mode: 3,
			outgoingOver: true
		})
	})

	it("leaves flythrough to the 3D renderer (it moves the content over a still backdrop)", () => {
		expect(PARTICLE_KINDS.has("flythrough")).toBe(false)
		expect(particleShape(transition("flythrough", "p14"), 16 / 9)).toBeUndefined()
	})

	it("draws honeycomb as its own effect", () => {
		expect(particleShape(transition("honeycomb", "p14"), 4 / 3)?.program).toBe("screen:honeycomb")
		expect(particleShape(transition("prism", "p14"), 4 / 3)).toBeUndefined()
	})
})

describe("the GPU budget", () => {
	const slide = { w: 960, h: 540 }

	it("draws at the stage's resolution when the budget holds it", () => {
		expect(particleScale(slide, 2, 256 * 1024 * 1024, 16384)).toBe(2)
	})

	it("lowers the resolution to fit the bytes left, two textures and a double-buffered canvas", () => {
		const budget = 960 * 540 * 4 * 16 * 0.5
		const scale = particleScale(slide, 2, budget, 16384) ?? 0
		const bytes = Math.floor(slide.w * scale) * Math.floor(slide.h * scale) * 16

		expect(scale).toBeLessThan(2)
		expect(bytes).toBeLessThanOrEqual(budget)
	})

	it("declines below a third of the stage's resolution, and caps at the device's texture size", () => {
		expect(particleScale(slide, 2, 4096, 16384)).toBeUndefined()
		expect(particleScale(slide, 4, 256 * 1024 * 1024, 2048)).toBeCloseTo(2048 / 960, 9)
	})
})

function layer(index: number, style = ""): HTMLDivElement {
	const element = document.createElement("div")

	element.className = "fo-show-layer"
	element.dataset["foShowLayer"] = String(index)
	element.style.cssText = style

	return element
}

function bitmap(x: number, y: number, w: number, h: number): HTMLCanvasElement {
	const canvas = document.createElement("canvas")

	canvas.className = "fo-show-bitmap"
	canvas.width = w * 2
	canvas.height = h * 2
	canvas.style.cssText = `position:absolute;left:${String(x)}px;top:${String(y)}px;width:${String(w)}px;height:${String(h)}px`

	return canvas
}

describe("what of the stage a particle transition draws", () => {
	it("draws each layer bitmap at its place with its layer's opacity, hidden layers left out", () => {
		const box = document.createElement("div")
		const shown = layer(0, "opacity:0.5")
		const hidden = layer(1, "visibility:hidden")
		const hotspot = document.createElement("button")

		hotspot.className = "fo-slide-hotspot"
		box.append(bitmap(0, 0, 960, 540), shown, hidden)
		shown.append(bitmap(10, 20, 100, 50), hotspot)
		hidden.append(bitmap(0, 0, 10, 10))

		const draws = slideDraws(box) ?? []

		expect(draws).toHaveLength(2)
		expect(draws[1]?.place).toEqual([100, 0, 0, 50, 10, 20])
		expect(draws[1]?.alpha).toBe(0.5)
	})

	it("declines a slide whose visible layer is clipped, shown as DOM, or painted without layers", () => {
		const clipped = document.createElement("div")
		const clip = layer(0, "clip-path:inset(0 50% 0 0)")

		clip.append(bitmap(0, 0, 10, 10))
		clipped.append(clip)

		const dom = document.createElement("div")
		const domLayer = layer(0)
		const painted = document.createElement("div")

		painted.className = "fo-show-dom"
		domLayer.append(painted)
		dom.append(domLayer)

		const svg = document.createElement("div")

		svg.append(document.createElement("div"))

		expect(slideDraws(clipped)).toBeUndefined()
		expect(slideDraws(dom)).toBeUndefined()
		expect(slideDraws(svg)).toBeUndefined()
	})
})

function shapeOf(id: number, name: string, x: number): MorphShape {
	return { id, name, type: "sp", x, y: 0, w: 50, h: 50, rot: 0, flipH: false, flipV: false, outline: "rect" }
}

describe("what of the stage morph draws", () => {
	const source = (shapes: number[], ranges?: ({ unit: "para"; start: number; end: number } | undefined)[]) =>
		({
			timing: undefined,
			layers: { shapes: Int32Array.from(shapes), ...(ranges === undefined ? {} : { ranges }) },
			parents: new Int32Array(shapes.length).fill(-1),
			slideSize: { cx: 1, cy: 1 },
			geometry: new Float64Array(0),
			colors: []
		}) as const

	it("leaves out an object the incoming slide's first state hides (an entrance still to come)", () => {
		const box = document.createElement("div")

		box.append(layer(0, "visibility:hidden"), layer(1))

		expect(shownObjects(box, { source: source([3, 4]), shapes: [shapeOf(2, "A", 0), shapeOf(3, "B", 0), shapeOf(4, "C", 0)] })).toEqual(
			[true, false, true]
		)
	})

	it("declines a slide with an object half built (a paragraph still hidden)", () => {
		const box = document.createElement("div")

		box.append(layer(0), layer(1, "visibility:hidden"))

		expect(
			shownObjects(box, {
				source: source([3, 3], [undefined, { unit: "para", start: 1, end: 1 }]),
				shapes: [shapeOf(3, "B", 0)]
			})
		).toBeUndefined()
	})

	it("stacks matched, leaving and entering objects and draws each once", () => {
		const texture = { texture: {} as WebGLTexture, width: 1, height: 1 }
		const piece = { page: texture, u0: 0, v0: 0, u1: 1, v1: 1, x: 0, y: 0, w: 1, h: 1 }
		const side = (shapes: MorphShape[]) => ({
			ref: slideRef(256),
			source: source([]),
			shapes,
			pages: [],
			statics: [],
			objects: shapes.map(() => [piece]),
			tokens: [],
			tokenPieces: []
		})
		const fromShapes = [shapeOf(2, "Kept", 0), shapeOf(3, "Gone", 100)]
		const toShapes = [{ ...shapeOf(5, "New", 0), outline: "ellipse" }, shapeOf(6, "Kept", 300)]
		const data: MorphData = {
			from: side(fromShapes),
			to: { ...side(toShapes), ref: slideRef(257) },
			plan: planMorph(fromShapes, toShapes),
			bytes: 0
		}
		const elements = morphElements(data, [true, true], [true, true])

		expect(elements).toHaveLength(3)
		expect(elements.map(element => [element.a.length, element.b.length, element.fromRank, element.toRank])).toEqual([
			[1, 1, 0, 1],
			[1, 0, 1, -1],
			[0, 1, -1, 0]
		])
		expect(elements[0]?.toBox.x).toBe(300)
	})
})

describe("starting morph on a slide of many like objects", () => {
	const vector = {
		geometry: { kind: "preset" as const, program: PRESET_GEOMETRY["rect"] ?? "", adjust: [] },
		fill: 0x0000ffff
	}
	const grid = (count: number, dx: number, name: (k: number) => string): MorphShape[] =>
		Array.from({ length: count }, (_, k) => ({
			...shapeOf(k + 2, name(k), ((k * 37) % 1280) + dx),
			y: (k * 91) % 720,
			w: 10,
			h: 10,
			vector
		}))
	const stage = (count: number, hidden: (k: number) => boolean): HTMLElement => {
		const box = document.createElement("div")

		for (let k = 0; k < count; k++) box.append(layer(k, hidden(k) ? "visibility:hidden" : ""))

		return box
	}
	const texture = { texture: {} as WebGLTexture, width: 1, height: 1 }
	const side = (shapes: MorphShape[], ref: number) => ({
		ref: slideRef(ref),
		source: {
			timing: undefined,
			layers: { shapes: Int32Array.from(shapes, shape => shape.id) },
			parents: new Int32Array(shapes.length).fill(-1),
			slideSize: { cx: 1, cy: 1 },
			geometry: new Float64Array(0),
			colors: []
		},
		shapes,
		pages: [texture],
		statics: [],
		objects: shapes.map(shape => [{ page: texture, u0: 0, v0: 0, u1: 0.01, v1: 0.01, x: shape.x, y: shape.y, w: shape.w, h: shape.h }]),
		tokens: [],
		tokenPieces: []
	})

	for (const [label, name] of [
		["names of their own", (k: number) => `Rectangle ${String(k)}`],
		["one shared name", () => "Rectangle"]
	] as const) {
		it(`plans 2,000 identical shapes per slide with ${label} and starts with no task over 50 ms`, () => {
			const fromShapes = grid(2000, 0, name)
			// Different names on the incoming slide, so matching falls to geometry.
			const toShapes = grid(2000, 3, k => `${name(k)}'`)
			// An entrance still to come hides every tenth incoming object.
			const fromBox = stage(2000, () => false)
			const toBox = stage(2000, k => k % 10 === 0)
			let prepare = Number.POSITIVE_INFINITY
			let click = Number.POSITIVE_INFINITY
			let elements: ReturnType<typeof morphElements> = []

			for (let run = 0; run < 3; run++) {
				const begin = cpuMs()
				const plan = planMorph(fromShapes, toShapes)

				prepare = Math.min(prepare, cpuMs() - begin)

				const data = { from: side(fromShapes, 256), to: side(toShapes, 257), plan, bytes: 0 } as unknown as MorphData
				const start = cpuMs()
				const shownFrom = shownObjects(fromBox, data.from) ?? []
				const shownTo = shownObjects(toBox, data.to) ?? []

				elements = capVectors(morphElements(data, shownFrom, shownTo), 2)
				click = Math.min(click, cpuMs() - start)
			}

			expect(prepare).toBeLessThan(50)
			expect(click).toBeLessThan(50)
			// Every shown incoming object takes its nearest outgoing one, 3 px to its left.
			const pairs = elements.filter(element => element.a.length > 0 && element.b.length > 0)

			expect(pairs).toHaveLength(1800)
			// Each redrawn outline is drawn and uploaded every frame: only so many are, the others mix their bitmaps.
			expect(elements.filter(element => element.vector !== undefined)).toHaveLength(VECTOR_FRAME_SHAPES)

			// A frame: every element written into one instance buffer, drawn in calls that grow with the pages and
			// redrawn outlines, not with the objects.
			const calls = new Map<string, number>()
			const gl = new Proxy(
				{},
				{
					get: (_target, name: string) =>
						/^[A-Z_0-9]+$/u.test(name)
							? 0
							: (...args: unknown[]) => {
									calls.set(name, (calls.get(name) ?? 0) + 1)

									return name.startsWith("create")
										? {}
										: name === "getError"
											? 0
											: args.length >= 0
												? undefined
												: undefined
								}
				}
			)
			const device = {
				gl,
				canvas: { width: 1920, height: 1080 },
				program: () => ({ program: {}, uniform: () => null }),
				upload: () => texture,
				uploadInto: () => (gl as { texSubImage2D(): void }).texSubImage2D(),
				free: () => undefined
			} as unknown as Parameters<typeof drawMorph>[0]
			const data = {
				from: side(fromShapes, 256),
				to: side(toShapes, 257),
				plan: planMorph(fromShapes, toShapes),
				bytes: 0
			} as unknown as MorphData
			const buffers = morphBuffers(device, 5 * elements.length)

			if (buffers === undefined) throw new Error("no buffers")

			// The outline canvas: a 2D context recording nothing.
			const context2d = new Proxy({}, { get: () => () => undefined }) as unknown as CanvasRenderingContext2D
			const outlines = outlineSlots(elements, 2, 4096)
			const page = outlines.size ?? { w: 1, h: 1 }
			const vectors = {
				canvas: { width: page.w, height: page.h } as HTMLCanvasElement,
				context: context2d,
				texture: { texture: {} as WebGLTexture, width: page.w, height: page.h },
				scale: 2,
				slots: outlines.slots
			}
			let frame = Number.POSITIVE_INFINITY

			for (let run = 0; run < 3; run++) {
				calls.clear()

				const start = cpuMs()

				drawMorph(device, data, outlines.elements, { w: 1280, h: 720 }, 0.5, buffers, vectors)
				frame = Math.min(frame, cpuMs() - start)
			}

			expect(frame).toBeLessThan(20)
			// One upload of the instances and one of the outline canvas a frame; a call per run of instances sampling
			// the same pages (each redrawn outline, from the outline texture, breaks a run).
			expect(outlines.slots.size).toBe(VECTOR_FRAME_SHAPES)
			expect(calls.get("bufferSubData")).toBe(1)
			expect(calls.get("texSubImage2D")).toBe(1)
			expect(calls.get("drawArraysInstanced") ?? 0).toBeLessThanOrEqual(2 * VECTOR_FRAME_SHAPES + 1)
			expect(calls.get("drawArrays") ?? 0).toBe(0)
			expect(pairs.every(element => element.toBox.x - element.fromBox.x === 3 && element.toBox.y === element.fromBox.y)).toBe(true)
		})
	}
})

describe("morph's layer bytes", () => {
	const slide = { w: 960, h: 540 }

	it("draws both slides' objects at the stage's pixel ratio when they fit", () => {
		expect(morphPixelRatio([[shapeOf(2, "A", 0)], [shapeOf(3, "B", 0)]], slide, 960, 2)).toBe(2)
	})

	it("lowers the pixel ratio so many large objects fit the layer budget", () => {
		const many = Array.from({ length: 40 }, (_, k) => ({ ...shapeOf(k + 2, `S${String(k)}`, 0), w: 900, h: 500 }))
		const dpr = morphPixelRatio([many, many], slide, 1920, 2)
		const reach = Math.hypot(900, 500) + 16
		const area = 2 * (960 * 540 + 40 * reach * reach)
		const scale = (1920 * dpr) / 960

		expect(dpr).toBeLessThan(2)
		expect(area * scale * scale * 4).toBeLessThanOrEqual(MORPH_LAYER_BYTES * 1.0001)
	})
})

describe("morphing outlines", () => {
	const preset = (name: string, adj?: number) => ({
		geometry: {
			kind: "preset" as const,
			program: PRESET_GEOMETRY[name] ?? "",
			adjust: adj === undefined ? [] : [["adj", adj] as const]
		}
	})
	const custom = (coords: number[], commands = [0, 1, 1, 4]) => ({
		geometry: {
			kind: "custom" as const,
			paths: [{ commands: Uint8Array.from(commands), coords: Float32Array.from(coords), fill: true, stroke: true }]
		}
	})

	it("morphs the same preset by its adjust values: a rounded rectangle's corners grow with the transition", () => {
		const plan = vectorPlan(preset("roundRect", 0), preset("roundRect", 50000))

		expect(plan?.kind).toBe("preset")

		if (plan === undefined) return

		// roundRect starts at the left edge, one corner radius (min(w, h) × adj) down.
		const start = (t: number): number => framePaths(plan, { w: 200, h: 100 }, t)[0]?.coords[1] ?? Number.NaN

		expect(start(0)).toBeCloseTo(0, 6)
		expect(start(0.5)).toBeCloseTo(25, 6)
		expect(start(1)).toBeCloseTo(50, 6)
	})

	it("uses a preset's default where one side writes no adjust value", () => {
		const plan = vectorPlan(preset("roundRect"), preset("roundRect", 0))

		if (plan === undefined) throw new Error("no plan")

		// The default adj is 16667: halfway, half of it.
		expect(framePaths(plan, { w: 100, h: 100 }, 0.5)[0]?.coords[1]).toBeCloseTo(100 * (16667 / 2 / 100000), 4)
	})

	it("morphs custom geometry of the same command structure point by point", () => {
		const plan = vectorPlan(custom([0, 0, 1, 0, 1, 1]), custom([0, 0.5, 1, 0.5, 0, 1]))

		if (plan === undefined) throw new Error("no plan")

		expect([...(framePaths(plan, { w: 10, h: 10 }, 0.5)[0]?.coords ?? [])]).toEqual([0, 2.5, 10, 2.5, 5, 10])
	})

	it("mixes bitmaps for different presets, different structures, or a preset against custom paths", () => {
		expect(vectorPlan(preset("rect"), preset("ellipse"))).toBeUndefined()
		expect(vectorPlan(custom([0, 0, 1, 0, 1, 1]), custom([0, 0, 1, 0], [0, 1, 4]))).toBeUndefined()
		expect(vectorPlan(preset("rect"), custom([0, 0, 1, 0, 1, 1]))).toBeUndefined()
		// A shaded path (a cube's darker sides) keeps its bitmap.
		expect(vectorPlan(preset("cube"), preset("cube"))).toBeUndefined()
	})

	it("places the interpolated box: centre, size, rotation", () => {
		const box = vectorBox(
			{ x: 0, y: 0, w: 100, h: 50, rot: 0, flipH: false, flipV: false },
			{ x: 200, y: 100, w: 200, h: 100, rot: 90, flipH: false, flipV: false },
			1
		)
		const [a, b, c, d, e, f] = box.place

		expect([box.w, box.h]).toEqual([200, 100])
		// The local centre lands on the incoming box's centre.
		expect(a * 100 + c * 50 + e).toBeCloseTo(300, 6)
		expect(b * 100 + d * 50 + f).toBeCloseTo(150, 6)
	})
})

describe("warming the WebGL context at show entry", () => {
	it("makes nothing for a deck that uses no particle transition or morph", () => {
		vi.stubGlobal("WebGL2RenderingContext", function WebGL2RenderingContext() {})

		const create = vi.spyOn(document, "createElement")

		expect(warmWebgl(document, [])).toBeUndefined()
		expect(warmWebgl(document, ["doors", "fallOver"])).toBeUndefined()
		expect(create).not.toHaveBeenCalled()
	})

	it("makes nothing without WebGL2", () => {
		expect(warmWebgl(document, ["vortex", "morph"])).toBeUndefined()
	})
})
