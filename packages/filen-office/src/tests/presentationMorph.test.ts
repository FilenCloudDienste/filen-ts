import { describe, expect, it } from "vitest"
import {
	matchMorph,
	matchPlanned,
	matchTokens,
	MORPH_MAX_PAIRS,
	MORPH_MAX_SHAPES,
	packAtlas,
	MORPH_MAX_TOKENS,
	morphEase,
	morphOption,
	morphPlacement,
	morphRank,
	morphTokens,
	planMorph,
	turn,
	type MorphBox,
	type MorphCandidate,
	type MorphShape
} from "../core/anim/morph"
import { deckWebglTransitions, morphShapes, morphVector, TransitionKindScanner } from "../core/anim/morphShapes"
import type { PptxParts } from "../core/pptx/package"
import { PRESET_GEOMETRY } from "../core/drawingml/geometry/presets.generated"
import { DrawingList, ItemKind } from "../core/drawingml/displayList"
import { drawingData } from "../core/presentation/render/slide"
import type { SlideLayer, SlideRender } from "../core/presentation/output"
import { slideRef, type ShapeNode } from "../core/presentation/model"
import { budget, cpuMs } from "./timing"

// Morph (MS-PPTX §2.6.1.1, option §2.6.4.1): which objects, words and characters of two slides match, and where a
// matched object is at a point of the transition.

function shape(name: string, type: string, x = 0, y = 0, outline = "rect", w = 100, h = 50): MorphCandidate {
	return { name, type, outline, x, y, w, h }
}

describe("morph matching", () => {
	it("forces a match between two objects of the same type named with the same !! name, whatever their outline", () => {
		const from = [shape("!!Blob", "sp", 0, 0, "ellipse"), shape("Title 1", "sp")]
		const to = [shape("Title 1", "sp"), shape("!!Blob", "sp", 300, 200, "rect")]

		expect(matchMorph(from, to).pairs).toEqual([
			[1, 0],
			[0, 1]
		])
	})

	it("never matches a !! object with one whose name lacks the !!", () => {
		const match = matchMorph([shape("!!Box", "sp")], [shape("Box", "sp")])

		expect(match.pairs).toEqual([])
		expect(match.exits).toEqual([0])
		expect(match.entries).toEqual([0])
	})

	it("never matches objects of different types, even by a !! name", () => {
		expect(matchMorph([shape("!!A", "sp")], [shape("!!A", "pic")]).pairs).toEqual([])
		expect(matchMorph([shape("Picture 3", "pic")], [shape("Picture 3", "sp")]).pairs).toEqual([])
	})

	it("matches objects in common by type and name, repeated names in z-order", () => {
		const from = [shape("Rectangle 4", "sp", 0), shape("Rectangle 4", "sp", 50), shape("Oval 5", "sp", 0, 0, "ellipse")]
		const to = [shape("Oval 5", "sp", 400, 0, "ellipse"), shape("Rectangle 4", "sp", 700), shape("Rectangle 4", "sp", 10)]

		expect(matchMorph(from, to).pairs).toEqual([
			[2, 0],
			[0, 1],
			[1, 2]
		])
	})

	it("matches what is left by outline, nearest first, and only within a type", () => {
		const from = [shape("Rectangle 1", "sp", 0, 0), shape("Rectangle 2", "sp", 500, 0), shape("Star 3", "sp", 0, 0, "star")]
		const to = [shape("Rectangle 9", "sp", 480, 0), shape("Rectangle 8", "sp", 20, 0), shape("Picture 7", "pic", 0, 0, "rect")]
		const match = matchMorph(from, to)

		expect(match.pairs).toEqual([
			[1, 0],
			[0, 1]
		])
		expect(match.exits).toEqual([2])
		expect(match.entries).toEqual([2])
	})

	it("leaves !! objects out of the outline rule", () => {
		expect(matchMorph([shape("!!Left", "sp")], [shape("Rectangle 2", "sp")]).pairs).toEqual([])
	})

	it("cross-fades charts instead of morphing them", () => {
		const match = matchMorph([shape("Chart 2", "chart")], [shape("Chart 2", "chart")])

		expect(match.pairs).toEqual([])
		expect(match.exits).toEqual([0])
		expect(match.entries).toEqual([0])
	})

	it("matches each object at most once", () => {
		const match = matchMorph([shape("A", "sp")], [shape("A", "sp"), shape("A", "sp"), shape("B", "sp")])

		expect(match.pairs).toEqual([[0, 0]])
		expect(match.entries).toEqual([1, 2])
	})

	it("reads the option, byObject by default", () => {
		expect(morphOption({ options: {} })).toBe("byObject")
		expect(morphOption({ options: { option: "byWord" } })).toBe("byWord")
		expect(morphOption({ options: { option: "byChar" } })).toBe("byChar")
		expect(morphOption({ options: { option: "bogus" } })).toBe("byObject")
	})
})

function described(name: string, text: string | undefined, type = "sp"): MorphShape {
	return {
		id: 2,
		name,
		type,
		x: 0,
		y: 0,
		w: 100,
		h: 50,
		rot: 0,
		flipH: false,
		flipV: false,
		outline: "rect",
		...(text === undefined ? {} : { text })
	}
}

describe("morph words and characters", () => {
	it("splits text into words in charRg offsets, paragraph ends counted, spaces left out", () => {
		const tokens = morphTokens([described("T", "Hello big world\nNext\n")], "byWord") ?? []

		expect(tokens.map(token => [token.text, token.start, token.end])).toEqual([
			["Hello", 0, 5],
			["big", 6, 9],
			["world", 10, 14],
			["Next", 16, 19]
		])
	})

	it("splits text into characters without spaces", () => {
		const tokens = morphTokens([described("T", "ab c\n")], "byChar") ?? []

		expect(tokens.map(token => [token.text, token.start, token.end])).toEqual([
			["a", 0, 0],
			["b", 1, 1],
			["c", 3, 3]
		])
	})

	it("moves each word of a reordered phrase to its new place within the matched object", () => {
		const from = [described("Title 1", "quick brown fox\n")]
		const to = [described("Title 1", "fox quick brown\n")]
		const objects = matchMorph(from, to)
		const a = morphTokens(from, "byWord") ?? []
		const b = morphTokens(to, "byWord") ?? []
		const words = matchTokens(a, b, objects)

		expect(words.pairs.map(([f, t]) => [a[f]?.text, b[t]?.text])).toEqual([
			["fox", "fox"],
			["quick", "quick"],
			["brown", "brown"]
		])
	})

	it("rearranges characters into an anagram, extra ones fading", () => {
		const from = [described("Title 1", "listen\n")]
		const to = [described("Title 1", "silent!\n")]
		const a = morphTokens(from, "byChar") ?? []
		const b = morphTokens(to, "byChar") ?? []
		const letters = matchTokens(a, b, matchMorph(from, to))

		expect(letters.pairs).toHaveLength(6)
		expect(letters.pairs.every(([f, t]) => a[f]?.text === b[t]?.text)).toBe(true)
		expect(letters.entries.map(t => b[t]?.text)).toEqual(["!"])
	})

	it("matches words across objects once the matched pairs are done", () => {
		const from = [described("Box A", "alpha beta\n"), { ...described("Box B", "gamma\n"), outline: "star" }]
		const to = [described("Box A", "beta\n"), { ...described("Other", "alpha gamma\n"), outline: "ellipse" }]
		const objects = matchMorph(from, to)
		const a = morphTokens(from, "byWord") ?? []
		const b = morphTokens(to, "byWord") ?? []
		const words = matchTokens(a, b, objects)

		expect(objects.pairs).toEqual([[0, 0]])
		expect(words.pairs.map(([f, t]) => [a[f]?.text, a[f]?.shape, b[t]?.shape])).toEqual([
			["beta", 0, 0],
			["alpha", 0, 1],
			["gamma", 1, 1]
		])
	})

	it("refuses to split a slide past the token budget", () => {
		const text = `${"x ".repeat(MORPH_MAX_TOKENS + 1)}\n`

		expect(morphTokens([described("T", text)], "byWord")).toBeUndefined()
	})
})

describe("morph interpolation", () => {
	const a: MorphBox = { x: 0, y: 0, w: 100, h: 50, rot: 0, flipH: false, flipV: false }
	const b: MorphBox = { x: 300, y: 100, w: 200, h: 100, rot: 90, flipH: false, flipV: false }
	const apply = (m: readonly number[], x: number, y: number): [number, number] => [
		(m[0] ?? 0) * x + (m[2] ?? 0) * y + (m[4] ?? 0),
		(m[1] ?? 0) * x + (m[3] ?? 0) * y + (m[5] ?? 0)
	]

	it("is the outgoing object at 0 and the incoming one at 1", () => {
		const start = morphPlacement(a, b, 0, "from")
		const end = morphPlacement(a, b, 1, "to")

		for (const [m] of [[start], [end]] as const) {
			expect(m[0]).toBeCloseTo(1, 9)
			expect(m[1]).toBeCloseTo(0, 9)
			expect(m[2]).toBeCloseTo(0, 9)
			expect(m[3]).toBeCloseTo(1, 9)
			expect(m[4]).toBeCloseTo(0, 9)
			expect(m[5]).toBeCloseTo(0, 9)
		}
	})

	it("maps the outgoing box onto the incoming one at 1: centre, size and rotation", () => {
		const m = morphPlacement(a, b, 1, "from")
		const centre = apply(m, 50, 25)

		expect(centre[0]).toBeCloseTo(400, 6)
		expect(centre[1]).toBeCloseTo(150, 6)

		// The outgoing box's right edge midpoint lands where the turned incoming box's is: 90° clockwise, half its width below.
		const edge = apply(m, 100, 25)

		expect(edge[0]).toBeCloseTo(400, 6)
		expect(edge[1]).toBeCloseTo(250, 6)
	})

	it("moves the centre linearly in eased time and turns the short way round", () => {
		const m = morphPlacement(a, b, 0.5, "to")
		const centre = apply(m, 400, 150)

		expect(centre[0]).toBeCloseTo(225, 6)
		expect(centre[1]).toBeCloseTo(87.5, 6)
		expect(turn(350, 10)).toBe(20)
		expect(turn(10, 350)).toBe(-20)
		expect(turn(0, 180)).toBe(180)
	})

	it("turns an object over through zero width when its flip changes", () => {
		const flipped = { ...a, flipH: true }

		expect(morphPlacement(a, flipped, 0.5, "from")[0]).toBeCloseTo(0, 9)
		expect(morphPlacement(a, flipped, 1, "from")[0]).toBeCloseTo(-1, 9)
		expect(morphPlacement(a, flipped, 1, "to")[0]).toBeCloseTo(1, 9)
	})

	it("eases in and out and stacks as the outgoing slide at 0 and the incoming one at 1", () => {
		expect(morphEase(0)).toBe(0)
		expect(morphEase(1)).toBe(1)
		expect(morphEase(0.5)).toBe(0.5)
		expect(morphEase(0.1)).toBeLessThan(0.1)

		// Object 0 is under object 1 on the outgoing slide and over it on the incoming one.
		expect(morphRank(0, 2, 1, 2, 0)).toBeLessThan(morphRank(1, 2, 0, 2, 0))
		expect(morphRank(0, 2, 1, 2, 1)).toBeGreaterThan(morphRank(1, 2, 0, 2, 1))
	})
})

describe("morph descriptors", () => {
	const ref = slideRef(300)

	function rectDrawing(w: number, h: number): SlideLayer["drawing"] {
		const list = new DrawingList()
		const command = list.commandCount
		const coord = list.coordCount

		list.width = w
		list.height = h
		list.moveTo(0, 0)
		list.lineTo(w, 0)
		list.lineTo(w, h)
		list.lineTo(0, h)
		list.close()
		list.addItem(ItemKind.PATH, [1, 0, 0, 1, 0, 0], 0, 0, w, h, command, coord, -1, -1, -1, -1, 0, 0)

		return drawingData(list)
	}

	function layer(id: number, w: number, h: number): SlideLayer {
		return {
			shape: { slide: ref, id },
			drawing: rectDrawing(w, h),
			matrix: [1, 0, 0, 1, 0, 0],
			role: "shape",
			box: { id, xfrm: { x: 9525 * 10, y: 9525 * 20, cx: 9525 * w, cy: 9525 * h, rot: 60000 * 30, flipH: true, flipV: false } }
		}
	}

	function node(id: number, name: string, extra: Partial<ShapeNode> = {}): ShapeNode {
		return { id, name, hidden: false, kind: "sp", ...extra }
	}

	function render(layers: SlideLayer[]): SlideRender {
		return { ref, index: 0, revision: 1, hidden: false, background: rectDrawing(1, 1), layers, notesText: "", animated: false }
	}

	it("describes each visible top-level object as rendered, with an outline equal at any size", () => {
		const shapes = [
			node(2, "Rectangle 1", {
				text: { paragraphs: [{ runs: [{ kind: "r", text: "Hi", rPr: {} }] }] } as unknown as NonNullable<ShapeNode["text"]>
			}),
			node(3, "Rectangle 2"),
			node(4, "Hidden", { hidden: true })
		]
		const out = morphShapes(shapes, render([layer(2, 100, 50), layer(3, 300, 10), layer(4, 5, 5)])) ?? []

		expect(out.map(entry => [entry.id, entry.name, entry.type])).toEqual([
			[2, "Rectangle 1", "sp"],
			[3, "Rectangle 2", "sp"]
		])
		expect(out[0]).toMatchObject({ x: 10, y: 20, w: 100, h: 50, rot: 30, flipH: true, text: "Hi\n" })
		expect(out[0]?.outline).not.toBe("")
		expect(out[0]?.outline).toBe(out[1]?.outline)
	})

	it("matches the objects on stage as if the hidden ones were not on the slides", () => {
		const from = Array.from({ length: 40 }, (_, k) => shape(k % 3 === 0 ? `Box ${String(k)}` : `From ${String(k)}`, "sp", k * 7, k * 3))
		const to = Array.from({ length: 40 }, (_, k) =>
			shape(k % 4 === 0 ? `Box ${String(k)}` : `To ${String(k)}`, "sp", 300 - k * 5, k * 2)
		)
		const shownFrom = from.map((_, k) => k % 5 !== 1)
		// Hides some objects matched by name, so their partners fall to geometry.
		const shownTo = to.map((_, k) => k % 6 !== 0)
		const keep = (shown: boolean[]): number[] => shown.flatMap((on, k) => (on ? [k] : []))
		const fk = keep(shownFrom)
		const tk = keep(shownTo)
		const alone = matchMorph(
			fk.map(k => from[k] as MorphCandidate),
			tk.map(k => to[k] as MorphCandidate)
		)
		const planned = matchPlanned(planMorph(from, to), shownFrom, shownTo)

		expect(planned.pairs).toEqual(alone.pairs.map(([f, t]) => [fk[f], tk[t]]))
		expect(planned.exits).toEqual(alone.exits.map(f => fk[f]))
		expect(planned.entries).toEqual(alone.entries.map(t => tk[t]))
	})

	it("past the pair bound still matches each object to the nearest one of its kind", () => {
		const count = Math.ceil(Math.sqrt(MORPH_MAX_PAIRS)) + 50
		const at = (k: number): [number, number] => [(k * 37) % 1280, (k * 91) % 720]
		const from = Array.from({ length: count }, (_, k) => shape(`From ${String(k)}`, "sp", ...at(k), "rect", 10, 10))
		const to = Array.from({ length: count }, (_, k) => shape(`To ${String(k)}`, "sp", at(k)[0] + 2, at(k)[1] - 1, "rect", 10, 10))
		const start = cpuMs()
		const match = matchMorph(from, to)

		expect(cpuMs() - start).toBeLessThan(50)
		expect(match.pairs).toEqual(to.map((_, k) => [k, k]))
	})

	it("matches every object of its own kind only when the slides are billions of px apart", () => {
		const count = Math.sqrt(MORPH_MAX_PAIRS)
		const from = [
			shape("Lone A", "sp", 0, 0, "ellipse"),
			...Array.from({ length: count }, (_, k) => shape(`From ${String(k)}`, "sp", k * 3, k * 7, "rect", 10, 10))
		]
		const to = [
			shape("Lone B", "sp", 0, 0, "triangle"),
			...Array.from({ length: count }, (_, k) => shape(`To ${String(k)}`, "sp", 2.8e9 + k * 5, k * 2, "rect", 10, 10))
		]
		const match = matchMorph(from, to)

		expect(match.pairs).toHaveLength(count)
		expect(match.pairs.every(([f, t]) => from[f]?.outline === to[t]?.outline)).toBe(true)
	})

	describe("on hostile geometry, matching at the start of the run stays under 10 ms", () => {
		const sq = "M0 0L1 0L1 1Z"
		const box = (k: number, x: number, y: number, w = 10, h = 10): MorphCandidate => ({
			name: `n${String(k)}`,
			type: "sp",
			outline: sq,
			x,
			y,
			w,
			h
		})
		const N = MORPH_MAX_SHAPES
		const odd = [2.8e9, Number.POSITIVE_INFINITY, Number.NaN, -2.8e9, 0]
		const at = (k: number): number => odd[k % odd.length] ?? 0
		const layouts: Record<string, readonly [MorphCandidate[], MorphCandidate[]]> = {
			"NaN, Infinity and far boxes": [
				Array.from({ length: N }, (_, k) => box(k, at(k), at(k * 3), k % 7 === 0 ? -10 : 10)),
				Array.from({ length: N }, (_, k) => box(k + N, at(k + 1), at(k * 2)))
			],
			"finite boxes billions of px away": [
				Array.from({ length: N }, (_, k) => box(k, k % 2 === 1 ? 2.8e9 : -2.8e9, (k * 7) % 720)),
				Array.from({ length: N }, (_, k) => box(k + N, (k * 37) % 1280, (k * 91) % 720))
			],
			"every object on one point but one": [
				Array.from({ length: N }, (_, k) => box(k, k === 0 ? 1e9 : 5, 5)),
				Array.from({ length: N }, (_, k) => box(k + N, k === N - 1 ? -1e9 : 6, 6))
			]
		}

		for (const [label, [from, to]] of Object.entries(layouts)) {
			it(label, () => {
				const plan = planMorph(from, to, { w: 1280, h: 720 })
				let best = Number.POSITIVE_INFINITY
				let match = matchPlanned(plan)

				for (let run = 0; run < 3; run++) {
					const start = cpuMs()

					match = matchPlanned(plan)
					best = Math.min(best, cpuMs() - start)
				}

				expect(best).toBeLessThan(10)

				const finite = (shape: MorphCandidate | undefined): boolean =>
					shape !== undefined && [shape.x, shape.y, shape.w, shape.h].every(Number.isFinite)

				// Each object at most once, and an object without a finite box in no pair.
				expect(new Set(match.pairs.map(([f]) => f)).size).toBe(match.pairs.length)
				expect(new Set(match.pairs.map(([, t]) => t)).size).toBe(match.pairs.length)
				expect(match.pairs.every(([f, t]) => finite(from[f]) && finite(to[t]))).toBe(true)
			})
		}

		it("pairs every object of a stack on one point", () => {
			const from = Array.from({ length: N }, (_, k) => box(k, 5, 5))
			const to = Array.from({ length: N }, (_, k) => box(k + N, 6, 6))

			expect(matchMorph(from, to).pairs).toHaveLength(N)
		})
	})

	it("matches 500 objects in under 20 ms of CPU", () => {
		const from = Array.from({ length: 500 }, (_, k) => shape(`Shape ${String(k)}`, "sp", k * 3, k, k % 2 === 0 ? "rect" : "ellipse"))
		const to = Array.from({ length: 500 }, (_, k) => shape(`Other ${String(k)}`, "sp", k * 3 + 1, k, k % 2 === 0 ? "rect" : "ellipse"))
		let best = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const start = cpuMs()

			matchMorph(from, to)
			best = Math.min(best, cpuMs() - start)
		}

		expect(best).toBeLessThan(20)
	})
})

describe("morph outlines", () => {
	const ref = slideRef(300)

	function plain(
		paints: SlideLayer["drawing"]["paints"],
		fill: number,
		stroke: number,
		strokes: SlideLayer["drawing"]["strokes"] = []
	): SlideLayer {
		const list = new DrawingList()
		const command = list.commandCount
		const coord = list.coordCount

		list.width = 100
		list.height = 50
		list.moveTo(0, 0)
		list.lineTo(100, 0)
		list.lineTo(100, 50)
		list.close()
		list.addItem(ItemKind.PATH, [1, 0, 0, 1, 0, 0], 0, 0, 100, 50, command, coord, fill, stroke, -1, -1, 0, 0)

		return {
			shape: { slide: ref, id: 2 },
			drawing: { ...drawingData(list), paints, strokes },
			matrix: [1, 0, 0, 1, 0, 0],
			role: "shape",
			box: { id: 2, xfrm: { x: 0, y: 0, cx: 952500, cy: 476250, rot: 0, flipH: false, flipV: false } }
		}
	}

	const line = {
		width: 2,
		paint: 1,
		dash: "solid",
		customDash: null,
		cap: "flat",
		join: "miter",
		miterLimit: 8,
		compound: "sng",
		inset: false
	} as const
	const node = { id: 2, name: "Rounded Rectangle 1", hidden: false, kind: "sp" } as const

	it("redraws a plain shape from its preset and adjust values, its solid fill and line", () => {
		const layer = plain(
			[
				{ kind: "solid", color: 0xff0000ff },
				{ kind: "solid", color: 0x000000ff }
			],
			0,
			0,
			[line]
		)
		const vector = morphVector({ ...node }, layer, {
			kind: "preset",
			preset: "roundRect",
			guides: [{ name: "adj", formula: "val 30000" }]
		})

		expect(vector).toEqual({
			geometry: { kind: "preset", program: PRESET_GEOMETRY["roundRect"], adjust: [["adj", 30000]] },
			fill: 0xff0000ff,
			line: { color: 0x000000ff, width: 2 }
		})
	})

	it("keeps the drawn paths, in fractions of the box, when the model has no geometry of its own", () => {
		const vector = morphVector({ ...node }, plain([{ kind: "solid", color: 0xff0000ff }], 0, -1), undefined)

		expect(vector?.geometry.kind).toBe("custom")

		if (vector?.geometry.kind !== "custom") return

		expect([...(vector.geometry.paths[0]?.coords ?? [])]).toEqual([0, 0, 1, 0, 1, 1])
		expect(vector.geometry.paths[0]).toMatchObject({ fill: true, stroke: false })
	})

	it("leaves a shape with a gradient, a dashed line or an adjust formula to its bitmap", () => {
		const gradient = plain([{ kind: "linear", stops: [], angle: 0, scaled: false } as never], 0, -1)
		const dashed = plain(
			[
				{ kind: "solid", color: 1 },
				{ kind: "solid", color: 2 }
			],
			0,
			0,
			[{ ...line, dash: "dash" }]
		)
		const solid = plain([{ kind: "solid", color: 1 }], 0, -1)

		expect(morphVector({ ...node }, gradient, undefined)).toBeUndefined()
		expect(morphVector({ ...node }, dashed, undefined)).toBeUndefined()
		expect(
			morphVector({ ...node }, solid, { kind: "preset", preset: "roundRect", guides: [{ name: "adj", formula: "*/ w 1 2" }] })
				?.geometry.kind
		).toBe("custom")
		expect(morphVector({ ...node, kind: "pic" }, solid, undefined)).toBeUndefined()
	})
})

describe("the WebGL transitions a deck uses", () => {
	const encode = (text: string): Uint8Array => Uint8Array.from(text, c => c.charCodeAt(0))

	it("finds p14 particle transitions and p159 morph in slide bytes, whatever their prefix", () => {
		const scanner = new TransitionKindScanner()

		scanner.push(encode('<p:sld><mc:AlternateContent><mc:Choice><p:transition><p14:vortex dir="r"/></p:transition>'))
		scanner.end()
		scanner.push(encode('<x:transition><p159:morph option="byWord"/><p:fade/></x:transition><q:glitterBox/>'))
		scanner.end()

		expect([...scanner.found].sort()).toEqual(["morph", "vortex"])
	})

	it("finds a tag a chunk boundary cuts", () => {
		const scanner = new TransitionKindScanner()

		scanner.push(encode("<p:transition><p1"))
		scanner.push(encode("4:hon"))
		scanner.push(encode("eycomb/></p:transition>"))
		scanner.end()

		expect([...scanner.found]).toEqual(["honeycomb"])
	})

	it("finds none in a deck of ECMA transitions", () => {
		const scanner = new TransitionKindScanner()

		scanner.push(encode('<p:transition spd="slow"><p:wipe dir="r"/></p:transition><p:timing/>'))

		expect(scanner.found.size).toBe(0)
	})

	it("takes a parsed slide's transition from its model and reads each other slide's part once per session", async () => {
		const reads: string[] = []
		const bytes: Record<string, string> = {
			"/ppt/slides/slide1.xml": "<p:transition><p:fade/></p:transition>",
			"/ppt/slides/slide2.xml": "<mc:Choice><p:transition><p14:ripple/></p:transition></mc:Choice>"
		}
		const parts = {
			partOf: (ref: number) => `/ppt/slides/slide${String(ref - 255)}.xml`,
			opc: {
				has: (part: string) => part in bytes,
				read: (part: string) => {
					reads.push(part)

					return Promise.resolve(encode(bytes[part] ?? ""))
				}
			}
		} as unknown as PptxParts
		const slides = [slideRef(256), slideRef(257)]
		const slicing = { sliceMs: 1000, now: () => 0, pause: () => Promise.resolve() }
		const scanned = new Map<ReturnType<typeof slideRef>, readonly string[]>()
		// The first slide was given morph in this session: its saved bytes still say fade.
		const nodes = new Map([
			[slideRef(256), { transition: { kind: "morph", namespace: "morph" as const, options: {}, advance: { onClick: true } } }]
		])

		expect((await deckWebglTransitions(parts, slides, slicing, nodes, scanned)).sort()).toEqual(["morph", "ripple"])
		expect(await deckWebglTransitions(parts, slides, slicing, new Map(), scanned)).toEqual(["ripple"])
		expect(reads).toEqual(["/ppt/slides/slide2.xml", "/ppt/slides/slide1.xml"])
		expect(await deckWebglTransitions(parts, slides, slicing, new Map(), scanned)).toEqual(["ripple"])
		expect(reads).toHaveLength(2)
	})

	it("scans 20 MB of slide XML in under 120 ms of CPU", () => {
		const chunk = encode(`${'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/></p:nvSpPr><a:t>text</a:t></p:sp>'.repeat(12_000)}`)
		let best = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const scanner = new TransitionKindScanner()
			const start = cpuMs()
			let bytes = 0

			while (bytes < 20_000_000) {
				scanner.push(chunk)
				bytes += chunk.length
			}

			best = Math.min(best, cpuMs() - start)
		}

		expect(best).toBeLessThan(120)
	})

	it("scans 20 MB of shape properties and runs in under 70 ms of CPU, every element name compared in place", () => {
		const shape =
			'<p:sp><p:spPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
			'<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-GB"/>' +
			"<a:t>Some words</a:t></a:r></a:p></p:txBody></p:sp>"
		const chunk = encode(shape.repeat(Math.ceil(1_000_000 / shape.length)))
		let best = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const scanner = new TransitionKindScanner()
			const start = cpuMs()

			for (let bytes = 0; bytes < 20_000_000; bytes += chunk.length) scanner.push(chunk)

			best = Math.min(best, cpuMs() - start)
			expect(scanner.found.size).toBe(0)
		}

		expect(best).toBeLessThan(budget(70))
	})
})

describe("morph's atlas pages", () => {
	it("packs small bitmaps into shared pages, tallest first, each with a gap, and a larger one into its own", () => {
		const packed = packAtlas(
			[
				{ w: 100, h: 50 },
				{ w: 0, h: 0 },
				{ w: 30, h: 80 },
				{ w: 5000, h: 10 },
				{ w: 1000, h: 50 }
			],
			1024
		)

		expect(packed.slots[1]).toBeUndefined()
		expect(packed.slots[2]).toEqual({ page: 0, x: 1, y: 1 })
		expect(packed.slots[0]).toEqual({ page: 0, x: 33, y: 1 })
		// No room left on the first shelf: the next one starts under the tallest of it.
		expect(packed.slots[4]).toEqual({ page: 0, x: 1, y: 83 })
		expect(packed.slots[3]).toEqual({ page: 1, x: 0, y: 0 })
		expect(packed.pages).toEqual([
			{ w: 1002, h: 134 },
			{ w: 5000, h: 10 }
		])
	})

	it("starts a page when one is full", () => {
		const packed = packAtlas(
			Array.from({ length: 5 }, () => ({ w: 500, h: 500 })),
			1024
		)

		expect(packed.slots.map(slot => slot?.page)).toEqual([0, 0, 0, 0, 1])
	})
})
