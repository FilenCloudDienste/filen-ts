// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import type { Transition } from "../core/anim/model"
import { TRANSITION_PRESETS } from "../core/anim/presets/transitions/catalog"
import {
	clipHalfPlane,
	draws3d,
	frontFacing,
	newFrame,
	transformPoint,
	transitionGeometry,
	viewMatrix,
	type Frame3d,
	type Geometry3d,
	type SlideSize
} from "../react/presentation/show/transitions3d"

// The geometry of the 3D transitions: which kinds it draws, that a transition starts on the outgoing slide and ends
// on the incoming one as they stand (every screen point shows the same slide point), that the middle moves, that no
// piece ever reaches the viewer, that options mirror the motion, and that a frame depends on progress only. The
// screen is sampled through the pieces' homographies (the plane z = 0 of a piece seen through the view), the same
// projection CSS matrix3d draws.

const SLIDE: SlideSize = { w: 1280, h: 720 }

function transition(kind: string, namespace: Transition["namespace"], options: Transition["options"] = {}): Transition {
	return { kind, namespace, options, advance: { onClick: true } }
}

// Every 3D kind with every value of each of its options.
function variants(): Transition[] {
	const out: Transition[] = []

	for (const preset of TRANSITION_PRESETS) {
		if (!draws3d(preset.kind, preset.namespace)) continue

		out.push(transition(preset.kind, preset.namespace))

		for (const option of preset.options) {
			const values = option.kind === "choice" ? option.values : [true]

			for (const value of values) out.push(transition(preset.kind, preset.namespace, { [option.name]: value }))
		}
	}

	return out
}

function label(t: Transition): string {
	return `${t.namespace}:${t.kind} ${JSON.stringify(t.options)}`
}

// The 3×3 homography of a full 4×4 projection on the plane z = 0, inverted: screen (x, y) to piece-local (x, y).
function inverseHomography(m: Float64Array): ((x: number, y: number) => [number, number] | undefined) | undefined {
	const a = m[0] ?? 0
	const b = m[4] ?? 0
	const c = m[12] ?? 0
	const d = m[1] ?? 0
	const e = m[5] ?? 0
	const f = m[13] ?? 0
	const g = m[3] ?? 0
	const h = m[7] ?? 0
	const i = m[15] ?? 0
	const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)

	if (Math.abs(det) < 1e-12) return undefined

	const inv = [
		e * i - f * h,
		c * h - b * i,
		b * f - c * e,
		f * g - d * i,
		a * i - c * g,
		c * d - a * f,
		d * h - e * g,
		b * g - a * h,
		a * e - b * d
	]

	return (x, y) => {
		const w = (inv[6] ?? 0) * x + (inv[7] ?? 0) * y + (inv[8] ?? 0)

		if (Math.abs(w) < 1e-12) return undefined

		return [((inv[0] ?? 0) * x + (inv[1] ?? 0) * y + (inv[2] ?? 0)) / w, ((inv[3] ?? 0) * x + (inv[4] ?? 0) * y + (inv[5] ?? 0)) / w]
	}
}

function inside(polygon: Float64Array, x: number, y: number): boolean {
	let hit = false
	const n = polygon.length / 2

	for (let k = 0, j = n - 1; k < n; j = k++) {
		const xk = polygon[k * 2] ?? 0
		const yk = polygon[k * 2 + 1] ?? 0
		const xj = polygon[j * 2] ?? 0
		const yj = polygon[j * 2 + 1] ?? 0

		if (yk > y !== yj > y && x < ((xj - xk) * (y - yk)) / (yj - yk) + xk) hit = !hit
	}

	return hit
}

interface Sample {
	readonly slide: 0 | 1
	readonly x: number
	readonly y: number
}

// What the screen point (x, y) (slide px) shows: the topmost visible piece containing it, and the slide point.
function sample(geometry: Geometry3d, frame: Frame3d, x: number, y: number): Sample | undefined {
	const view = viewMatrix(SLIDE)

	for (let rank = frame.order.length - 1; rank >= 0; rank--) {
		const k = frame.order[rank] ?? 0
		const piece = geometry.pieces[k]

		if (piece === undefined || (frame.opacity[k] ?? 0) <= 0) continue

		const model = frame.models.subarray(k * 16, k * 16 + 16)
		const full = new Float64Array(16)

		// view · model
		for (let col = 0; col < 4; col++)
			for (let row = 0; row < 4; row++) {
				let sum = 0

				for (let n = 0; n < 4; n++) sum += (view[n * 4 + row] ?? 0) * (model[col * 4 + n] ?? 0)

				full[col * 4 + row] = sum
			}

		const facing = frontFacing(full, piece.bounds)

		if (!facing.inView || (!facing.front && !piece.twoSided)) continue

		const local = inverseHomography(full)?.(x, y)

		if (local === undefined) continue

		const clip = frame.clips[k]

		if (!inside(piece.polygon, local[0], local[1])) continue
		if (clip !== undefined && !inside(clip, local[0], local[1])) continue

		return { slide: piece.slide, x: local[0], y: local[1] }
	}

	return undefined
}

// Grid points kept off the slide's edges and off the pieces' own edges (cuts at sixths, quarters, halves, eighths).
const GRID: (readonly [number, number])[] = []

for (let gy = 0; gy < 9; gy++) for (let gx = 0; gx < 13; gx++) GRID.push([((gx + 0.37) / 13) * SLIDE.w, ((gy + 0.41) / 9) * SLIDE.h])

describe("3D transitions: geometry", () => {
	it("draws exactly the p14 3D set and the p15 prstTrans presets, nothing ECMA, particle or morph", () => {
		const drawn = TRANSITION_PRESETS.filter(preset => draws3d(preset.kind, preset.namespace)).map(
			preset => `${preset.namespace}:${preset.kind}`
		)

		expect(drawn.sort()).toEqual(
			[
				"p14:conveyor",
				"p14:doors",
				"p14:ferris",
				"p14:flythrough",
				"p14:pan",
				"p14:flip",
				"p14:gallery",
				"p14:prism",
				"p14:reveal",
				"p14:switch",
				"p14:warp",
				"p14:wheelReverse",
				"p14:window",
				"p15:airplane",
				"p15:crush",
				"p15:curtains",
				"p15:drape",
				"p15:fallOver",
				"p15:fracture",
				"p15:origami",
				"p15:pageCurlDouble",
				"p15:pageCurlSingle",
				"p15:peelOff",
				"p15:prestige",
				"p15:wind"
			].sort()
		)
		expect(draws3d("doors", "p")).toBe(false)
		expect(draws3d("vortex", "p14")).toBe(false)
		expect(draws3d("morph", "morph")).toBe(false)
		expect(transitionGeometry(transition("fade", "p"), SLIDE)).toBeUndefined()
		expect(transitionGeometry(transition("flip", "p14"), { w: 0, h: 720 })).toBeUndefined()
	})

	it("starts on the outgoing slide and ends on the incoming one, each point where it stands", () => {
		for (const t of variants()) {
			const geometry = transitionGeometry(t, SLIDE)

			expect(geometry, label(t)).toBeDefined()

			if (geometry === undefined) continue

			const frame = newFrame(geometry)

			for (const [p, slide] of [
				[0, 0],
				[1, 1]
			] as const) {
				geometry.frame(p, frame)

				for (const [x, y] of GRID) {
					const seen = sample(geometry, frame, x, y)

					expect(seen?.slide, `${label(t)} p=${String(p)} at ${String(x)},${String(y)}`).toBe(slide)
					expect(Math.abs((seen?.x ?? -1) - x) + Math.abs((seen?.y ?? -1) - y), `${label(t)} p=${String(p)}`).toBeLessThan(0.01)
				}
			}
		}
	})

	it("moves in the middle: a frame part-way is neither slide as it stands", () => {
		for (const t of variants()) {
			const geometry = transitionGeometry(t, SLIDE)

			if (geometry === undefined) continue

			const frame = newFrame(geometry)

			geometry.frame(0.4, frame)

			const moved = GRID.filter(([x, y]) => {
				const seen = sample(geometry, frame, x, y)

				return seen === undefined || Math.abs(seen.x - x) + Math.abs(seen.y - y) > 1
			}).length
			const both = new Set(GRID.map(([x, y]) => sample(geometry, frame, x, y)?.slide)).size

			expect(moved > GRID.length / 10 || both > 1, label(t)).toBe(true)
		}
	})

	it("keeps every piece well in front of the viewer at every frame", () => {
		for (const t of variants()) {
			const geometry = transitionGeometry(t, SLIDE)

			if (geometry === undefined) continue

			const frame = newFrame(geometry)

			for (let step = 0; step <= 40; step++) {
				geometry.frame(step / 40, frame)
				geometry.pieces.forEach((piece, k) => {
					if ((frame.opacity[k] ?? 0) <= 0) return

					const model = frame.models.subarray(k * 16, k * 16 + 16)
					const b = piece.bounds

					for (const [x, y] of [
						[b.x, b.y],
						[b.x + b.w, b.y],
						[b.x, b.y + b.h],
						[b.x + b.w, b.y + b.h]
					] as const) {
						const z = transformPoint(model, x, y)[2]

						expect(z, `${label(t)} p=${String(step / 40)} piece ${String(k)}`).toBeLessThan(0.75 * geometry.distance)
					}
				})
			}
		}
	})

	it("mirrors a p15 preset's motion with invX and a p14 one's with its direction", () => {
		const pairs: [Transition, Transition][] = [
			[transition("wind", "p15"), transition("wind", "p15", { invX: true })],
			[transition("ferris", "p14", { dir: "l" }), transition("ferris", "p14", { dir: "r" })],
			[transition("peelOff", "p15"), transition("peelOff", "p15", { invX: true })]
		]

		for (const [a, b] of pairs) {
			const ga = transitionGeometry(a, SLIDE)
			const gb = transitionGeometry(b, SLIDE)

			if (ga === undefined || gb === undefined) throw new Error("no geometry")

			const fa = newFrame(ga)
			const fb = newFrame(gb)

			ga.frame(0.4, fa)
			gb.frame(0.4, fb)

			for (const [x, y] of GRID) {
				const left = sample(ga, fa, x, y)
				const right = sample(gb, fb, SLIDE.w - x, y)

				expect(right?.slide, label(b)).toBe(left?.slide)

				if (left !== undefined && right !== undefined) {
					expect(right.x, label(b)).toBeCloseTo(SLIDE.w - left.x, 3)
					expect(right.y, label(b)).toBeCloseTo(left.y, 3)
				}
			}
		}
	})

	it("draws a frame from progress alone (the same frame twice, shards and tiles included)", () => {
		for (const kind of ["fracture", "crush", "origami"]) {
			const t = transition(kind, "p15")
			const first = transitionGeometry(t, SLIDE)
			const second = transitionGeometry(t, SLIDE)

			if (first === undefined || second === undefined) throw new Error("no geometry")

			const a = newFrame(first)
			const b = newFrame(second)

			first.frame(0.63, a)
			first.frame(0.2, a)
			first.frame(0.63, a)
			second.frame(0.63, b)

			expect(Array.from(a.models)).toEqual(Array.from(b.models))
			expect(a.order).toEqual(b.order)
		}
	})

	it("cuts the outgoing slide into pieces that tile it (fracture, crush, drape, curtains, the book's halves)", () => {
		for (const kind of ["fracture", "crush", "drape", "curtains", "pageCurlDouble", "origami"]) {
			const geometry = transitionGeometry(transition(kind, "p15"), SLIDE)

			if (geometry === undefined) throw new Error("no geometry")

			const outgoing = geometry.pieces.filter(piece => piece.slide === 0)

			for (const [x, y] of GRID)
				expect(outgoing.filter(piece => inside(piece.polygon, x, y)).length, `${kind} ${String(x)},${String(y)}`).toBe(1)
		}
	})

	it("splits doors and window at a horizontal line by default and at a vertical one with dir vert", () => {
		for (const kind of ["doors", "window"]) {
			const halves = (options: Transition["options"]) =>
				transitionGeometry(transition(kind, "p14", options), SLIDE)
					?.pieces.filter(piece => piece.slide === 0 && piece.backdrop !== true)
					.map(piece => [piece.bounds.w, piece.bounds.h])

			expect(halves({}), kind).toEqual([
				[SLIDE.w, SLIDE.h / 2],
				[SLIDE.w, SLIDE.h / 2]
			])
			expect(halves({ dir: "vert" }), kind).toEqual([
				[SLIDE.w / 2, SLIDE.h],
				[SLIDE.w / 2, SLIDE.h]
			])
		}
	})

	it("keeps the backdrops still where MS-PPTX shows only the content moving (window, conveyor, ferris, flythrough, pan), and nowhere else", () => {
		const still = (t: Transition) =>
			transitionGeometry(t, SLIDE)
				?.pieces.filter(piece => piece.backdrop === true)
				.map(piece => piece.slide)

		for (const kind of ["window", "conveyor", "ferris", "flythrough", "pan"])
			expect(still(transition(kind, "p14")), kind).toEqual([0, 1])
		for (const kind of ["doors", "flip", "gallery", "switch", "warp", "reveal", "wheelReverse"])
			expect(still(transition(kind, "p14")), kind).toEqual([])
		expect(still(transition("prism", "p14")), "prism").toEqual([])
		for (const kind of [
			"fallOver",
			"drape",
			"curtains",
			"wind",
			"prestige",
			"fracture",
			"crush",
			"peelOff",
			"pageCurlDouble",
			"pageCurlSingle",
			"airplane",
			"origami"
		])
			expect(still(transition(kind, "p15")), kind).toEqual([])
	})

	it("flies the content through: inward the outgoing grows past the viewer over the incoming, which grows into place", () => {
		const sizes = (options: Transition["options"], p: number) => {
			const geometry = transitionGeometry(transition("flythrough", "p14", options), SLIDE)

			if (geometry === undefined) throw new Error("no geometry")

			const frame = newFrame(geometry)

			geometry.frame(p, frame)

			// The content pieces' projected widths, outgoing then incoming, and which is on top.
			const width = (slide: 0 | 1) => {
				const k = geometry.pieces.findIndex(piece => piece.slide === slide && piece.backdrop !== true)
				const m = frame.models.subarray(k * 16, k * 16 + 16)

				return {
					width: transformPoint(m, SLIDE.w, 0)[0] - transformPoint(m, 0, 0)[0],
					rank: frame.order.indexOf(k),
					opacity: frame.opacity[k] ?? 0
				}
			}

			return [width(0), width(1)] as const
		}
		const [outIn, inIn] = sizes({}, 0.3)

		expect(outIn.width).toBeGreaterThan(SLIDE.w)
		expect(inIn.width).toBeLessThan(SLIDE.w)
		expect(outIn.rank).toBeGreaterThan(inIn.rank)

		const [outOut, inOut] = sizes({ dir: "out" }, 0.5)

		expect(outOut.width).toBeLessThan(SLIDE.w)
		expect(inOut.width).toBeGreaterThan(SLIDE.w)
		expect(inOut.rank).toBeGreaterThan(outOut.rank)

		// With a bounce the incoming content overshoots its place before it settles.
		const overshoot = [0.7, 0.75, 0.8, 0.85, 0.9].some(p => (sizes({ hasBounce: true }, p)[1].width ?? 0) > SLIDE.w * 1.01)

		expect(overshoot).toBe(true)
		expect([0.7, 0.75, 0.8, 0.85, 0.9].some(p => sizes({}, p)[1].width > SLIDE.w * 1.001)).toBe(false)
	})

	it("pans the content the way of its dir, the incoming content following from the opposite side (default l)", () => {
		const offset = (options: Transition["options"]) => {
			const geometry = transitionGeometry(transition("pan", "p14", options), SLIDE)

			if (geometry === undefined) throw new Error("no geometry")

			const frame = newFrame(geometry)

			geometry.frame(0.5, frame)

			return ([0, 1] as const).map(slide => {
				const k = geometry.pieces.findIndex(piece => piece.slide === slide && piece.backdrop !== true)
				const [x, y] = transformPoint(frame.models.subarray(k * 16, k * 16 + 16), 0, 0)

				return [Math.sign(Math.round(x)), Math.sign(Math.round(y))]
			})
		}

		expect(offset({})).toEqual([
			[-1, 0],
			[1, 0]
		])
		expect(offset({ dir: "u" })).toEqual([
			[0, -1],
			[0, 1]
		])
		expect(offset({ dir: "r" })).toEqual([
			[1, 0],
			[-1, 0]
		])
		expect(offset({ dir: "d" })).toEqual([
			[0, 1],
			[0, -1]
		])
	})

	it("keeps a content-only prism's backdrops still, the incoming one fading in", () => {
		const geometry = transitionGeometry(transition("prism", "p14", { isContent: true }), SLIDE)

		if (geometry === undefined) throw new Error("no geometry")

		const backdrops = geometry.pieces.flatMap((piece, k) => (piece.backdrop === true ? [k] : []))
		const frame = newFrame(geometry)

		expect(backdrops.map(k => geometry.pieces[k]?.slide)).toEqual([0, 1])
		geometry.frame(0.5, frame)
		expect(frame.order.slice(0, 2)).toEqual(backdrops)
		expect(Array.from(frame.models.subarray((backdrops[1] ?? 0) * 16, (backdrops[1] ?? 0) * 16 + 16))).toEqual([
			1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1
		])
		expect(frame.opacity[backdrops[1] ?? 0]).toBeCloseTo(0.5, 5)
	})

	it("clips a convex polygon to a half plane", () => {
		const square = Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10)

		expect(Array.from(clipHalfPlane(square, 1, 0, 4))).toEqual([0, 0, 4, 0, 4, 10, 0, 10])
		expect(clipHalfPlane(square, 1, 1, -1).length).toBe(0)
		expect(clipHalfPlane(square, 1, 1, 100).length).toBe(8)
	})
})
