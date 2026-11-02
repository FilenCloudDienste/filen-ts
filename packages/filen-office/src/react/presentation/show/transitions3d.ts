import type { Transition } from "../../../core/anim/model"
import { transitionOption } from "../../../core/anim/presets/transitions/catalog"

// The 3D slide transitions of MS-PPTX: the p14 set (§2.3.1: doors, ferris, flip, gallery, conveyor, switch, window,
// prism, reveal, warp, wheelReverse, flythrough, pan) and the p15:prstTrans presets (§2.4.3.8: fallOver … origami),
// drawn with CSS 3D transforms. Each transition is geometry: the two slides cut into pieces (a half, a strip, a shard), each piece a
// plane placed in a 3D scene by a matrix per frame and seen through one perspective about the slide's centre. The
// player's two slide boxes are the first piece of each slide (moved and clipped in place, so their media and paint
// stay live); further pieces are canvases cut from the slide box (its layer bitmaps drawn into each piece's bounds)
// in slices of the first frames. Every
// element carries its whole projection as one matrix3d with no preserve-3d, and the paint order is the geometry's,
// so the three engines composite the same picture without sorting planes themselves. A frame writes transform,
// opacity, visibility and z-index only. Without CSS 3D, or when a canvas cannot copy the slide (a DOM-painted
// layer, a video, the bitmap budget), `start` refuses and the player plays the file's mc:Fallback.

// --- 4×4 matrices (column-major, as CSS matrix3d) ---

type Matrix = Float64Array

function identity(): Matrix {
	return Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
}

// a·b: b applies first.
function multiply(a: Matrix, b: Matrix): Matrix {
	const out = new Float64Array(16)

	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let sum = 0

			for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0)

			out[col * 4 + row] = sum
		}
	}

	return out
}

// m[0]·m[1]·…: the last applies first.
function chain(...matrices: Matrix[]): Matrix {
	let out = matrices[0] ?? identity()

	for (let k = 1; k < matrices.length; k++) out = multiply(out, matrices[k] ?? identity())

	return out
}

function translate(x: number, y: number, z = 0): Matrix {
	return Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1)
}

function scale(x: number, y = x, z = 1): Matrix {
	return Float64Array.of(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1)
}

// CSS rotate3d(x, y, z, degrees) (CSS Transforms 2 §13): right-handed about the axis in a y-down space, so rotateZ
// turns clockwise on screen, rotateY turns the right edge away and rotateX turns the bottom edge away.
function rotate(x: number, y: number, z: number, degrees: number): Matrix {
	const length = Math.hypot(x, y, z)

	if (length === 0 || degrees === 0) return identity()

	const [ux, uy, uz] = [x / length, y / length, z / length]
	const half = (degrees * Math.PI) / 360
	const sc = Math.sin(half) * Math.cos(half)
	const sq = Math.sin(half) * Math.sin(half)

	return Float64Array.of(
		1 - 2 * (uy * uy + uz * uz) * sq,
		2 * (ux * uy * sq + uz * sc),
		2 * (ux * uz * sq - uy * sc),
		0,
		2 * (ux * uy * sq - uz * sc),
		1 - 2 * (ux * ux + uz * uz) * sq,
		2 * (uy * uz * sq + ux * sc),
		0,
		2 * (ux * uz * sq + uy * sc),
		2 * (uy * uz * sq - ux * sc),
		1 - 2 * (ux * ux + uy * uy) * sq,
		0,
		0,
		0,
		0,
		1
	)
}

const rotateX = (degrees: number): Matrix => rotate(1, 0, 0, degrees)
const rotateY = (degrees: number): Matrix => rotate(0, 1, 0, degrees)
const rotateZ = (degrees: number): Matrix => rotate(0, 0, 1, degrees)

// `m` about the point (x, y, z).
function about(x: number, y: number, z: number, m: Matrix): Matrix {
	return chain(translate(x, y, z), m, translate(-x, -y, -z))
}

// CSS perspective(d) about the point (x, y).
function perspectiveAbout(x: number, y: number, distance: number): Matrix {
	const p = identity()

	p[11] = -1 / distance

	return chain(translate(x, y), p, translate(-x, -y))
}

// The point (x, y, 0) through `m`: x, y, z, w.
export function transformPoint(m: Matrix, x: number, y: number): [number, number, number, number] {
	return [
		(m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[12] ?? 0),
		(m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[13] ?? 0),
		(m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[14] ?? 0),
		(m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[15] ?? 0)
	]
}

// --- geometry ---

export interface SlideSize {
	readonly w: number
	readonly h: number
}

export interface Piece3d {
	// 0 the outgoing slide, 1 the incoming one.
	readonly slide: 0 | 1
	// Slide px: the piece as a closed polygon (x, y pairs) and its bounds.
	readonly polygon: Float64Array
	readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
	// Whether its back shows when it turns away (a page, a shard); else it is hidden then.
	readonly twoSided: boolean
	// The slide's backdrop (background, master and layout art) only, kept still while its content moves; the slide's
	// other pieces are then its content alone. Without a backdrop drawn apart the content carries it.
	readonly backdrop?: true
}

export interface Frame3d {
	// 16 per piece: slide px to the scene (px, z towards the viewer), before the perspective.
	readonly models: Float64Array
	readonly opacity: Float64Array
	// Black over the piece, 0..1 (a turning page darkens).
	readonly shade: Float64Array
	// Per piece, the polygon it is clipped to this frame (slide px) when that changes with progress; else undefined.
	readonly clips: (Float64Array | undefined)[]
	// Piece indices, back to front.
	order: number[]
}

export interface Geometry3d {
	readonly pieces: readonly Piece3d[]
	// The viewer's distance from the slide plane (px), looking at the slide's centre.
	readonly distance: number
	frame(progress: number, out: Frame3d): void
}

const P14_KINDS = new Set([
	"doors",
	"ferris",
	"flip",
	"gallery",
	"conveyor",
	"switch",
	"window",
	"prism",
	"reveal",
	"warp",
	"wheelReverse",
	"flythrough",
	"pan"
])
const P15_KINDS = new Set([
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

export function draws3d(kind: string, namespace: Transition["namespace"]): boolean {
	return (namespace === "p14" && P14_KINDS.has(kind)) || (namespace === "p15" && P15_KINDS.has(kind))
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value))
// Progress within [from, to] of p.
const span = (p: number, from: number, to: number): number => clamp((p - from) / (to - from))
const smooth = (t: number): number => t * t * (3 - 2 * t)
const easeIn = (t: number): number => t * t
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t)

function rectPolygon(x: number, y: number, w: number, h: number): Float64Array {
	return Float64Array.of(x, y, x + w, y, x + w, y + h, x, y + h)
}

function boundsOf(polygon: Float64Array): Piece3d["bounds"] {
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity

	for (let k = 0; k + 1 < polygon.length; k += 2) {
		const x = polygon[k] ?? 0
		const y = polygon[k + 1] ?? 0

		x0 = Math.min(x0, x)
		y0 = Math.min(y0, y)
		x1 = Math.max(x1, x)
		y1 = Math.max(y1, y)
	}

	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// The part of a convex polygon where a·x + b·y ≤ c (Sutherland–Hodgman against one edge).
export function clipHalfPlane(polygon: Float64Array, a: number, b: number, c: number): Float64Array {
	const out: number[] = []
	const n = polygon.length / 2

	for (let k = 0; k < n; k++) {
		const x0 = polygon[k * 2] ?? 0
		const y0 = polygon[k * 2 + 1] ?? 0
		const x1 = polygon[((k + 1) % n) * 2] ?? 0
		const y1 = polygon[((k + 1) % n) * 2 + 1] ?? 0
		const d0 = a * x0 + b * y0 - c
		const d1 = a * x1 + b * y1 - c

		if (d0 <= 0) out.push(x0, y0)
		if (d0 <= 0 !== d1 <= 0) {
			const t = d0 / (d0 - d1)

			out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
		}
	}

	return Float64Array.from(out)
}

// A deterministic random sequence (a linear congruential generator), so a frame depends on progress only.
function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0

		return state / 0x100000000
	}
}

class Scene {
	readonly pieces: Piece3d[] = []

	add(slide: 0 | 1, polygon: Float64Array, twoSided = false): number {
		this.pieces.push({ slide, polygon, bounds: boundsOf(polygon), twoSided })

		return this.pieces.length - 1
	}

	rect(slide: 0 | 1, x: number, y: number, w: number, h: number, twoSided = false): number {
		return this.add(slide, rectPolygon(x, y, w, h), twoSided)
	}
}

type FrameFn = (p: number, put: (piece: number, model: Matrix, opacity?: number, shade?: number) => void, out: Frame3d) => void

function geometry(scene: Scene, slide: SlideSize, frame: FrameFn): Geometry3d {
	return {
		pieces: scene.pieces,
		distance: distanceOf(slide),
		frame(progress, out) {
			const p = clamp(progress)

			out.order = scene.pieces.map((_, k) => k)
			out.clips.fill(undefined)
			frame(
				p,
				(piece, model, opacity = 1, shade = 0) => {
					out.models.set(model, piece * 16)
					out.opacity[piece] = clamp(opacity)
					out.shade[piece] = clamp(shade)
				},
				out
			)
		}
	}
}

export function distanceOf(slide: SlideSize): number {
	return 2 * Math.max(slide.w, slide.h)
}

export function newFrame(geometry: Geometry3d): Frame3d {
	const n = geometry.pieces.length

	return {
		models: new Float64Array(n * 16),
		opacity: new Float64Array(n),
		shade: new Float64Array(n),
		clips: Array.from({ length: n }, () => undefined),
		order: []
	}
}

// The perspective every piece is seen through: the viewer `distance` in front of the slide's centre.
export function viewMatrix(slide: SlideSize): Matrix {
	return perspectiveAbout(slide.w / 2, slide.h / 2, distanceOf(slide))
}

// The scene's centre depth of a piece this frame (for depth ordering).
function depth(out: Frame3d, piece: Piece3d, k: number): number {
	const m = out.models.subarray(k * 16, k * 16 + 16)

	return transformPoint(m, piece.bounds.x + piece.bounds.w / 2, piece.bounds.y + piece.bounds.h / 2)[2]
}

function byDepth(out: Frame3d, pieces: readonly Piece3d[]): void {
	const depths = pieces.map((piece, k) => depth(out, piece, k))

	out.order.sort((a, b) => (depths[a] ?? 0) - (depths[b] ?? 0))
}

// The geometry built for the canonical direction, mirrored about the slide's centre (x and/or y).
function mirrored(inner: Geometry3d, slide: SlideSize, x: boolean, y: boolean): Geometry3d {
	if (!x && !y) return inner

	const f = about(slide.w / 2, slide.h / 2, 0, scale(x ? -1 : 1, y ? -1 : 1))
	const flip = (polygon: Float64Array): Float64Array => {
		const out = new Float64Array(polygon.length)

		for (let k = 0; k + 1 < polygon.length; k += 2) {
			out[k] = x ? slide.w - (polygon[k] ?? 0) : (polygon[k] ?? 0)
			out[k + 1] = y ? slide.h - (polygon[k + 1] ?? 0) : (polygon[k + 1] ?? 0)
		}

		return out
	}
	const pieces = inner.pieces.map(piece => {
		const polygon = flip(piece.polygon)

		return { ...piece, polygon, bounds: boundsOf(polygon) }
	})

	return {
		pieces,
		distance: inner.distance,
		frame(progress, out) {
			inner.frame(progress, out)

			for (let k = 0; k < pieces.length; k++) {
				out.models.set(chain(f, out.models.subarray(k * 16, k * 16 + 16), f), k * 16)

				const clip = out.clips[k]

				if (clip !== undefined) out.clips[k] = flip(clip)
			}
		}
	}
}

// `inner` moving the slides' content only: both backdrops (the whole slide, z = 0) stay under it, the incoming one
// fading in over the outgoing one with progress.
function contentOnly(inner: Geometry3d, slide: SlideSize): Geometry3d {
	const whole = rectPolygon(0, 0, slide.w, slide.h)
	const backdrop = (index: 0 | 1): Piece3d => ({ slide: index, polygon: whole, bounds: boundsOf(whole), twoSided: false, backdrop: true })
	const pieces = [backdrop(0), backdrop(1), ...inner.pieces]
	const held = newFrame(inner)
	const still = identity()

	return {
		pieces,
		distance: inner.distance,
		frame(progress, out) {
			inner.frame(progress, held)
			out.models.set(still, 0)
			out.models.set(still, 16)
			out.models.set(held.models, 32)
			out.opacity[0] = 1
			out.opacity[1] = smooth(clamp(progress))
			out.opacity.set(held.opacity, 2)
			out.shade[0] = 0
			out.shade[1] = 0
			out.shade.set(held.shade, 2)
			out.clips[0] = undefined
			out.clips[1] = undefined
			held.clips.forEach((clip, k) => {
				out.clips[k + 2] = clip
			})
			out.order = [0, 1, ...held.order.map(k => k + 2)]
		}
	}
}

function choice(transition: Transition, name: string): string {
	const value = transitionOption(transition, name)

	return typeof value === "string" ? value : ""
}

function flag(transition: Transition, name: string): boolean {
	return transitionOption(transition, name) === true
}

// --- the p14 set ---

// The slide splits into halves that swing about their outer edges (`out`: towards the viewer, doors; else away,
// window) while the incoming slide comes forward from behind. p14:doors and p14:window are p:CT_OrientationTransition
// (MS-PPTX §2.3.1.7, §2.3.1.33): dir "vert" splits the slide at a vertical line, its halves parting left and right
// (the specification's Figures 2 and 21); "horz", the schema's default, at a horizontal one, top and bottom.
function hinged(slide: SlideSize, vertical: boolean, forward: boolean): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const first = vertical ? scene.rect(0, 0, 0, w / 2, h) : scene.rect(0, 0, 0, w, h / 2)
	const second = vertical ? scene.rect(0, w / 2, 0, w / 2, h) : scene.rect(0, 0, h / 2, w, h / 2)
	const back = forward ? 0.6 * w : 1.6 * w

	return geometry(scene, slide, (p, put) => {
		const e = smooth(p)
		const angle = (forward ? 100 : 90) * e * (forward ? 1 : -1)
		const fade = forward ? 1 - span(p, 0.75, 1) : 1 - span(p, 0.55, 0.85)

		put(incoming, translate(0, 0, -back * (1 - e)))

		if (vertical) {
			put(first, about(0, h / 2, 0, rotateY(-angle)), fade)
			put(second, about(w, h / 2, 0, rotateY(angle)), fade)
		} else {
			put(first, about(w / 2, 0, 0, rotateX(angle)), fade)
			put(second, about(w / 2, h, 0, rotateX(-angle)), fade)
		}
	})
}

// Canonical direction: moving left (dir "l").
function ferris(slide: SlideSize): Geometry3d {
	const { w } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, slide.h)
	const outgoing = scene.rect(0, 0, 0, w, slide.h)
	// The wheel's radius and the angle between two gondolas (their chord clears a slide width).
	const radius = 1.4 * w
	const step = 45
	const at = (degrees: number): Matrix => {
		const a = (degrees * Math.PI) / 180

		// Gondolas stay upright, tilting a little with the swing.
		return chain(translate(radius * Math.sin(a), radius * (1 - Math.cos(a))), about(w / 2, 0, 0, rotateZ(-degrees / 6)))
	}

	return geometry(scene, slide, (p, put) => {
		const e = smooth(p)

		put(outgoing, at(-step * e))
		put(incoming, at(step * (1 - e)))
	})
}

function flip(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const outgoing = scene.rect(0, 0, 0, w, h)

	return geometry(scene, slide, (p, put, out) => {
		const e = smooth(p)
		const lift = translate(0, 0, -0.35 * w * Math.sin(Math.PI * e))

		put(outgoing, chain(lift, about(w / 2, h / 2, 0, rotateY(-180 * e))))
		put(incoming, chain(lift, about(w / 2, h / 2, 0, rotateY(180 - 180 * e))))
		byDepth(out, scene.pieces)
	})
}

function gallery(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const outgoing = scene.rect(0, 0, 0, w, h)
	const gap = 1.15 * w

	return geometry(scene, slide, (p, put, out) => {
		const e = smooth(p)
		const swing = Math.sin(Math.PI * e)
		const turn = about(w / 2, h / 2, 0, rotateY(40 * swing))
		const back = -0.5 * w * swing

		put(outgoing, chain(translate(-gap * e, 0, back), turn))
		put(incoming, chain(translate(gap * (1 - e), 0, back), turn))
		byDepth(out, scene.pieces)
	})
}

function conveyor(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const outgoing = scene.rect(0, 0, 0, w, h)
	const gap = 1.15 * w

	return geometry(scene, slide, (p, put, out) => {
		const tilt = smooth(span(p, 0, 0.25)) - smooth(span(p, 0.75, 1))
		const travel = gap * smooth(span(p, 0.15, 0.85))
		// The belt: turned and pushed back, the slides riding along it.
		const belt = chain(translate(0, 0, -0.45 * w * tilt), about(w / 2, h / 2, 0, rotateY(35 * tilt)))

		put(outgoing, chain(belt, translate(-travel, 0)))
		put(incoming, chain(belt, translate(gap - travel, 0)))
		byDepth(out, scene.pieces)
	})
}

function switchCards(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const outgoing = scene.rect(0, 0, 0, w, h)

	return geometry(scene, slide, (p, put, out) => {
		const e = smooth(p)
		const swing = Math.sin(Math.PI * e)

		put(outgoing, chain(translate(-0.55 * w * swing, 0, -0.7 * w * e), about(w / 2, h / 2, 0, rotateY(35 * swing))))
		put(incoming, chain(translate(0.55 * w * swing, 0, -0.7 * w * (1 - e)), about(w / 2, h / 2, 0, rotateY(-35 * swing))))
		byDepth(out, scene.pieces)
	})
}

// A cube turning a quarter: the outgoing slide on its front face, the incoming one on the face it turns to (moving
// left: the right face; up: the bottom face). Inverted, the cube is seen from inside. With isContent (MS-PPTX
// §2.3.3.20, Figure 13) only the content turns.
function prism(slide: SlideSize, vertical: boolean, inverted: boolean): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const outgoing = scene.rect(0, 0, 0, w, h)
	const side = vertical ? h : w
	const centre = inverted ? side / 2 : -side / 2
	const sign = inverted ? -1 : 1
	const turn = (degrees: number): Matrix => about(w / 2, h / 2, centre, vertical ? rotateX(degrees) : rotateY(-degrees))

	return geometry(scene, slide, (p, put, out) => {
		const e = smooth(p)
		const back = translate(0, 0, -0.4 * side * Math.sin(Math.PI * e))
		const angle = 90 * e * sign

		put(outgoing, chain(back, turn(angle)))
		put(incoming, chain(back, turn(angle - 90 * sign)))
		byDepth(out, scene.pieces)
	})
}

function reveal(slide: SlideSize, throughBlack: boolean): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const outgoing = scene.rect(0, 0, 0, w, h)
	const [outEnd, inStart] = throughBlack ? [0.5, 0.5] : [0.6, 0.4]

	return geometry(scene, slide, (p, put) => {
		const e = smooth(p)

		put(outgoing, translate(-0.15 * w * e, 0, -0.3 * w * e), 1 - smooth(span(p, 0, outEnd)))
		put(incoming, translate(0.15 * w * (1 - e), 0, -0.3 * w * (1 - e)), smooth(span(p, inStart, 1)))
	})
}

function warp(slide: SlideSize, inward: boolean): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const near = 0.7 * w
	const far = 2 * w

	if (inward) {
		const incoming = scene.rect(1, 0, 0, w, h)
		const outgoing = scene.rect(0, 0, 0, w, h)

		return geometry(scene, slide, (p, put) => {
			const e = smooth(p)

			put(incoming, translate(0, 0, -far * (1 - e)))
			put(outgoing, translate(0, 0, near * easeIn(p)), 1 - span(p, 0.2, 0.7))
		})
	}

	const outgoing = scene.rect(0, 0, 0, w, h)
	const incoming = scene.rect(1, 0, 0, w, h)

	return geometry(scene, slide, (p, put) => {
		const e = smooth(p)

		put(outgoing, translate(0, 0, -far * e), 1 - span(p, 0.3, 0.8))
		put(incoming, translate(0, 0, near * (1 - easeOut(p))), span(p, 0.2, 0.7))
	})
}

// The incoming slide revealed by `spokes` sectors sweeping counter-clockwise from the top.
function wheelReverse(slide: SlideSize, spokes: number): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const outgoing = scene.rect(0, 0, 0, w, h)
	const incoming = scene.rect(1, 0, 0, w, h)
	const radius = Math.hypot(w, h)
	const steps = 48

	return geometry(scene, slide, (p, put, out) => {
		put(outgoing, identity())
		put(incoming, identity())

		const points: number[] = []
		const sweep = ((2 * Math.PI) / spokes) * p

		// One fan per spoke, its arc stepped finely enough to stay round: a single polygon through the centre.
		for (let spoke = 0; spoke < spokes; spoke++) {
			const start = (-2 * Math.PI * spoke) / spokes

			points.push(w / 2, h / 2)

			for (let k = 0; k <= steps; k++) {
				const a = start - (sweep * k) / steps

				points.push(w / 2 + Math.sin(a) * radius, h / 2 - Math.cos(a) * radius)
			}
		}

		out.clips[incoming] = p >= 1 ? undefined : Float64Array.from(points)
	})
}

// The content flies through (MS-PPTX §2.3.1.12, Figure 6, dir "in"): inward the outgoing content grows past the viewer
// and fades over the incoming content, which grows into place; outward the outgoing content shrinks away under the
// incoming content coming down from in front. hasBounce: the incoming content overshoots its place and settles (an
// ease-out-back).
function flythrough(slide: SlideSize, inward: boolean, bounce: boolean): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const outgoing = scene.rect(0, 0, 0, w, h)
	const sized = (s: number): Matrix => about(w / 2, h / 2, 0, scale(s, s, 1))

	return geometry(scene, slide, (p, put, out) => {
		const leave = smooth(span(p, 0, 0.6))
		const x = span(p, 0.3, 1)
		const arrive = bounce ? 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2 : easeOut(x)
		const from = inward ? 1 + 2 * leave : 1 - 0.8 * leave
		const to = inward ? 0.2 + 0.8 * arrive : 3 - 2 * arrive

		put(outgoing, sized(from), 1 - leave)
		put(incoming, sized(to), smooth(span(x, 0, 0.5)))
		out.order = inward ? [incoming, outgoing] : [outgoing, incoming]
	})
}

// The content pans (MS-PPTX §2.3.1.21, Figure 10, dir "u"): the outgoing content slides out the way of dir and the
// incoming content follows from the opposite side. Canonical: dir "l" or, `vertical`, "u".
function pan(slide: SlideSize, vertical: boolean): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const outgoing = scene.rect(0, 0, 0, w, h)

	return geometry(scene, slide, (p, put) => {
		const e = smooth(p)

		put(outgoing, vertical ? translate(0, -h * e) : translate(-w * e, 0))
		put(incoming, vertical ? translate(0, h * (1 - e)) : translate(w * (1 - e), 0))
	})
}

// --- the p15 presets (canonical: invX and invY unset) ---

// Falls forward about its bottom edge, leaning left.
function fallOver(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const outgoing = scene.rect(0, 0, 0, w, h)

	return geometry(scene, slide, (p, put) => {
		const fall = easeIn(p)

		put(incoming, identity())
		put(outgoing, chain(about(w / 2, h, 0, rotateX(-85 * fall)), about(0, h, 0, rotateZ(-6 * smooth(p)))), 1 - span(p, 0.8, 1))
	})
}

// An accordion of `strips` vertical strips of [x0, x0 + width], hinged at x0 (the left edge), folded by `angle`.
function accordion(x0: number, width: number, strips: number, angle: number, shift: number): Matrix[] {
	const s = width / strips
	const c = Math.cos((angle * Math.PI) / 180)
	const depthOf = s * Math.sin((angle * Math.PI) / 180)
	const out: Matrix[] = []

	for (let k = 0; k < strips; k++) {
		const left = x0 + k * s
		const x = x0 + k * s * c + shift

		out.push(
			k % 2 === 0
				? chain(translate(x, 0, 0), rotateY(angle), translate(-left, 0))
				: chain(translate(x, 0, -depthOf), rotateY(-angle), translate(-left, 0))
		)
	}

	return out
}

// Folds into vertical pleats gathered at the left edge, then is drawn off to the left.
function drape(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const strips = 8
	const incoming = scene.rect(1, 0, 0, w, h)
	const first = scene.pieces.length

	for (let k = 0; k < strips; k++) scene.rect(0, (k * w) / strips, 0, w / strips, h, true)

	return geometry(scene, slide, (p, put) => {
		const angle = 80 * smooth(span(p, 0, 0.7))
		const shift = -w * easeIn(span(p, 0.3, 1))
		const fade = 1 - span(p, 0.85, 1)

		put(incoming, identity())
		accordion(0, w, strips, angle, shift).forEach((m, k) =>
			put(first + k, m, fade, k % 2 === 1 ? 0.35 * Math.sin((angle * Math.PI) / 180) : 0)
		)
	})
}

// Two pleated halves gathered at the left and right edges, then drawn off to both sides.
function curtains(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const strips = 6
	const half = w / 2
	const incoming = scene.rect(1, 0, 0, w, h)
	const left = scene.pieces.length

	for (let k = 0; k < strips; k++) scene.rect(0, (k * half) / strips, 0, half / strips, h, true)

	const right = scene.pieces.length

	// The right half's strips from the right edge inwards (mirrors of the left's).
	for (let k = 0; k < strips; k++) scene.rect(0, w - ((k + 1) * half) / strips, 0, half / strips, h, true)

	const mirror = about(w / 2, h / 2, 0, scale(-1, 1))

	return geometry(scene, slide, (p, put) => {
		const angle = 80 * smooth(span(p, 0, 0.65))
		const shift = -half * easeIn(span(p, 0.35, 1))
		const fade = 1 - span(p, 0.85, 1)
		const pleats = accordion(0, half, strips, angle, shift)

		put(incoming, identity())
		pleats.forEach((m, k) => {
			const shade = k % 2 === 1 ? 0.35 * Math.sin((angle * Math.PI) / 180) : 0

			put(left + k, m, fade, shade)
			put(right + k, chain(mirror, m, mirror), fade, shade)
		})
	})
}

// Blown off to the left, tumbling and rising.
function wind(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const outgoing = scene.rect(0, 0, 0, w, h)

	return geometry(scene, slide, (p, put) => {
		const e = easeIn(p)

		put(incoming, identity())
		put(
			outgoing,
			chain(
				translate(-1.4 * w * e, -0.3 * h * e, 0.2 * w * Math.sin(Math.PI * e)),
				about(w / 2, h / 2, 0, chain(rotateY(50 * e), rotateZ(-20 * e)))
			),
			1 - span(p, 0.7, 1)
		)
	})
}

// Tips back and sinks away; the incoming slide rises from below, tipped forward.
function prestige(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const outgoing = scene.rect(0, 0, 0, w, h)
	const incoming = scene.rect(1, 0, 0, w, h)

	return geometry(scene, slide, (p, put) => {
		const e = smooth(span(p, 0, 0.7))
		const rise = 1 - smooth(span(p, 0.35, 1))

		put(outgoing, chain(translate(0, 0.3 * h * e), about(w / 2, h, 0, rotateX(70 * e))), 1 - span(p, 0.3, 0.7))
		put(incoming, chain(translate(0, 0.25 * h * rise, -0.4 * w * rise), about(w / 2, 0, 0, rotateX(-60 * rise))), span(p, 0.35, 0.6))
	})
}

// Shatters into triangles flying out from the centre, the centre's first.
function fracture(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const cols = 6
	const rows = 4
	const incoming = scene.rect(1, 0, 0, w, h)
	const next = random(0x51ed27)
	const shards: {
		piece: number
		cx: number
		cy: number
		dx: number
		dy: number
		axis: [number, number, number]
		spin: number
		delay: number
	}[] = []
	const reach = Math.hypot(w / 2, h / 2)

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const x0 = (col * w) / cols
			const y0 = (row * h) / rows
			const x1 = ((col + 1) * w) / cols
			const y1 = ((row + 1) * h) / rows
			// Alternating diagonals, so the cracks zig-zag.
			const triangles =
				(row + col) % 2 === 0
					? [Float64Array.of(x0, y0, x1, y0, x1, y1), Float64Array.of(x0, y0, x1, y1, x0, y1)]
					: [Float64Array.of(x0, y0, x1, y0, x0, y1), Float64Array.of(x1, y0, x1, y1, x0, y1)]

			for (const triangle of triangles) {
				const cx = ((triangle[0] ?? 0) + (triangle[2] ?? 0) + (triangle[4] ?? 0)) / 3
				const cy = ((triangle[1] ?? 0) + (triangle[3] ?? 0) + (triangle[5] ?? 0)) / 3
				const away = Math.atan2(cy - h / 2, cx - w / 2) + (next() - 0.5) * 0.8

				shards.push({
					piece: scene.add(0, triangle, true),
					cx,
					cy,
					dx: Math.cos(away) * (0.8 + next() * 0.6) * w,
					dy: Math.sin(away) * (0.8 + next() * 0.6) * h,
					axis: [next() - 0.5, next() - 0.5, next() - 0.5],
					spin: 90 + next() * 180,
					delay: 0.4 * (Math.hypot(cx - w / 2, cy - h / 2) / reach)
				})
			}
		}
	}

	return geometry(scene, slide, (p, put) => {
		put(incoming, identity())

		for (const shard of shards) {
			const q = span(p, shard.delay, shard.delay + 0.6)
			const e = easeIn(q)

			put(
				shard.piece,
				chain(
					translate(shard.dx * e, shard.dy * e + 0.4 * h * e, 0.3 * w * e),
					about(shard.cx, shard.cy, 0, rotate(shard.axis[0], shard.axis[1], shard.axis[2], shard.spin * q))
				),
				1 - span(q, 0.6, 1),
				0.2 * Math.sin(Math.PI * q)
			)
		}
	})
}

// Crumples into a ball at the centre that then rolls off to the left.
function crush(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const cols = 5
	const rows = 4
	const incoming = scene.rect(1, 0, 0, w, h)
	const next = random(0xc0ffee)
	const tiles: {
		piece: number
		cx: number
		cy: number
		jx: number
		jy: number
		jz: number
		axis: [number, number, number]
		spin: number
	}[] = []

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const tw = w / cols
			const th = h / rows

			tiles.push({
				piece: scene.rect(0, col * tw, row * th, tw, th, true),
				cx: (col + 0.5) * tw,
				cy: (row + 0.5) * th,
				jx: (next() - 0.5) * 0.12 * w,
				jy: (next() - 0.5) * 0.12 * h,
				jz: (next() - 0.5) * 0.12 * w,
				axis: [next() - 0.5, next() - 0.5, next() - 0.5],
				spin: 90 + next() * 110
			})
		}
	}

	return geometry(scene, slide, (p, put, out) => {
		const q = smooth(span(p, 0, 0.55))
		const roll = easeIn(span(p, 0.5, 1))
		const size = 1 - 0.75 * q
		const ball = chain(translate(-1.3 * w * roll, 0.2 * h * roll), about(w / 2, h / 2, 0, rotateZ(-200 * roll)))
		const fade = 1 - span(p, 0.85, 1)

		put(incoming, identity())

		for (const tile of tiles) {
			const x = tile.cx + (w / 2 + tile.jx - tile.cx) * q
			const y = tile.cy + (h / 2 + tile.jy - tile.cy) * q

			put(
				tile.piece,
				chain(
					ball,
					translate(x, y, tile.jz * q),
					rotate(tile.axis[0], tile.axis[1], tile.axis[2], tile.spin * q),
					scale(size, size, size),
					translate(-tile.cx, -tile.cy)
				),
				fade,
				0.3 * q
			)
		}

		byDepth(out, scene.pieces)
		// The incoming slide stays behind the ball.
		out.order = [incoming, ...out.order.filter(k => k !== incoming)]
	})
}

// Peeled off from the bottom-right corner: the part past a fold line moving to the top-left corner turns over it.
function peelOff(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const whole = rectPolygon(0, 0, w, h)
	const incoming = scene.rect(1, 0, 0, w, h)
	const rest = scene.rect(0, 0, 0, w, h)
	const flap = scene.rect(0, 0, 0, w, h, true)

	return geometry(scene, slide, (p, put, out) => {
		const e = smooth(p)
		// The fold line x + y = c, from the corner (w + h) to the opposite one (0).
		const c = (w + h) * (1 - e)
		// The flap rises off the slide while it turns and lies flat past the corner at the end.
		const angle = 180 - 35 * Math.sin(Math.PI * e)

		put(incoming, identity())
		put(rest, identity())
		put(flap, about(c / 2, c / 2, 0, rotate(1, -1, 0, angle)), 1 - span(p, 0.9, 1), 0.25)
		out.clips[rest] = clipHalfPlane(whole, 1, 1, c)
		out.clips[flap] = clipHalfPlane(whole, -1, -1, -c)
	})
}

// A page turning over its left edge.
function pageCurlSingle(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const page = scene.rect(0, 0, 0, w, h)

	return geometry(scene, slide, (p, put) => {
		const angle = 180 * smooth(p)

		put(incoming, identity())
		put(page, about(0, h / 2, 0, rotateY(-angle)), 1, 0.35 * Math.sin((angle * Math.PI) / 180))
	})
}

// A book open at the slide: the right page (the outgoing slide's right half, the incoming slide's left half on its
// back) turns over the spine.
function pageCurlDouble(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const half = w / 2
	const scene = new Scene()
	const inRight = scene.rect(1, half, 0, half, h)
	const outLeft = scene.rect(0, 0, 0, half, h)
	const outRight = scene.rect(0, half, 0, half, h)
	const inLeft = scene.rect(1, 0, 0, half, h)

	return geometry(scene, slide, (p, put) => {
		const angle = 180 * smooth(p)
		const shade = 0.3 * Math.sin((angle * Math.PI) / 180)

		put(inRight, identity())
		put(outLeft, identity())
		put(outRight, about(half, h / 2, 0, rotateY(-angle)), 1, shade)
		put(inLeft, about(half, h / 2, 0, rotateY(180 - angle)), 1, shade)
	})
}

// Folds its halves up into wings and flies off to the top right.
function airplane(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const left = scene.rect(0, 0, 0, w / 2, h, true)
	const right = scene.rect(0, w / 2, 0, w / 2, h, true)

	return geometry(scene, slide, (p, put) => {
		const fold = smooth(span(p, 0, 0.45))
		const fly = easeIn(span(p, 0.4, 1))
		const body = chain(
			translate(0.9 * w * fly, -1.0 * h * fly, -1.2 * w * fly),
			about(w / 2, h / 2, 0, chain(rotateZ(-25 * fly), scale(1 - 0.5 * fold, 1 - 0.5 * fold, 1 - 0.5 * fold)))
		)
		const fade = 1 - span(p, 0.85, 1)

		put(incoming, identity())
		put(left, chain(body, about(w / 2, h / 2, 0, rotateY(70 * fold))), fade, 0.25 * fold)
		put(right, chain(body, about(w / 2, h / 2, 0, rotateY(-70 * fold))), fade, 0.25 * fold)
	})
}

// Folded in half twice (right over left, then top over bottom) and sent off spinning.
function origami(slide: SlideSize): Geometry3d {
	const { w, h } = slide
	const scene = new Scene()
	const incoming = scene.rect(1, 0, 0, w, h)
	const lb = scene.rect(0, 0, h / 2, w / 2, h / 2, true)
	const lt = scene.rect(0, 0, 0, w / 2, h / 2, true)
	const rb = scene.rect(0, w / 2, h / 2, w / 2, h / 2, true)
	const rt = scene.rect(0, w / 2, 0, w / 2, h / 2, true)

	return geometry(scene, slide, (p, put, out) => {
		const first = 180 * smooth(span(p, 0, 0.4))
		const second = 180 * smooth(span(p, 0.35, 0.7))
		const away = easeIn(span(p, 0.65, 1))
		const f1 = about(w / 2, 0, 0, rotateY(-first))
		const f2 = about(0, h / 2, 0, rotateX(-second))
		const send = chain(
			translate(-0.2 * w * away, 0.9 * h * away),
			about(w / 4, (3 * h) / 4, 0, chain(rotateZ(-160 * away), scale(1 - 0.6 * away)))
		)
		const fade = 1 - span(p, 0.85, 1)
		const shade1 = 0.25 * Math.sin((first * Math.PI) / 180)
		const shade2 = 0.25 * Math.sin((second * Math.PI) / 180)

		put(incoming, identity())
		put(lb, send, fade)
		put(lt, chain(send, f2), fade, shade2)
		put(rb, chain(send, f1), fade, shade1)
		put(rt, chain(send, f2, f1), fade, Math.max(shade1, shade2))
		// The pieces turning lie over the ones they fold onto.
		out.order = second === 0 ? [incoming, lb, lt, rb, rt] : second < 90 ? [incoming, lb, rb, lt, rt] : [incoming, lb, rb, rt, lt]
	})
}

// The geometry of a 3D transition, or undefined for a kind this file does not draw.
export function transitionGeometry(transition: Transition, slide: SlideSize): Geometry3d | undefined {
	if (!draws3d(transition.kind, transition.namespace)) return undefined
	if (!(slide.w > 0 && slide.h > 0)) return undefined

	const dir = choice(transition, "dir")

	switch (transition.kind) {
		case "doors":
			return hinged(slide, dir === "vert", true)
		// MS-PPTX shows window, ferris, conveyor, flythrough and pan moving the slides' content over a backdrop that
		// stays (Figures 21, 3, 1, 6, 10); doors, flip, gallery, switch, warp, reveal and the p15 presets move whole
		// slides (Figures 2, 5, 7, 17, 19, 14, 22–33).
		case "window":
			return contentOnly(hinged(slide, dir === "vert", false), slide)
		case "ferris":
			return mirrored(contentOnly(ferris(slide), slide), slide, dir === "r", false)
		case "flip":
			return mirrored(flip(slide), slide, dir === "l", false)
		case "gallery":
			return mirrored(gallery(slide), slide, dir === "r", false)
		case "conveyor":
			return mirrored(contentOnly(conveyor(slide), slide), slide, dir === "r", false)
		case "switch":
			return mirrored(switchCards(slide), slide, dir === "l", false)
		case "prism":
			return mirrored(
				flag(transition, "isContent")
					? contentOnly(prism(slide, dir === "u" || dir === "d", flag(transition, "isInverted")), slide)
					: prism(slide, dir === "u" || dir === "d", flag(transition, "isInverted")),
				slide,
				dir === "r",
				dir === "d"
			)
		case "reveal":
			return mirrored(reveal(slide, flag(transition, "thruBlk")), slide, dir === "r", false)
		case "warp":
			return warp(slide, dir !== "out")
		case "flythrough":
			return contentOnly(flythrough(slide, dir !== "out", flag(transition, "hasBounce")), slide)
		case "pan":
			return mirrored(contentOnly(pan(slide, dir === "u" || dir === "d"), slide), slide, dir === "r", dir === "d")
		case "wheelReverse":
			return wheelReverse(slide, Math.max(1, Number(choice(transition, "spokes")) || 4))
		default:
			break
	}

	const build: ((slide: SlideSize) => Geometry3d) | undefined = (
		{
			fallOver,
			drape,
			curtains,
			wind,
			prestige,
			fracture,
			crush,
			peelOff,
			pageCurlSingle,
			pageCurlDouble,
			airplane,
			origami
		} as Readonly<Record<string, (slide: SlideSize) => Geometry3d>>
	)[transition.kind]

	return build === undefined ? undefined : mirrored(build(slide), slide, flag(transition, "invX"), flag(transition, "invY"))
}

// Whether the piece faces the viewer under its full projection `m` (local px), and every corner is in front of the
// viewer.
export function frontFacing(m: Matrix, bounds: Piece3d["bounds"]): { readonly front: boolean; readonly inView: boolean } {
	const corners = [
		transformPoint(m, bounds.x, bounds.y),
		transformPoint(m, bounds.x + bounds.w, bounds.y),
		transformPoint(m, bounds.x, bounds.y + bounds.h)
	]
	const inView = corners.every(corner => corner[3] > 0) && transformPoint(m, bounds.x + bounds.w, bounds.y + bounds.h)[3] > 0

	if (!inView) return { front: false, inView }

	const [a, b, c] = corners.map(([x, y, , q]) => [x / q, y / q] as const)
	const cross =
		((b?.[0] ?? 0) - (a?.[0] ?? 0)) * ((c?.[1] ?? 0) - (a?.[1] ?? 0)) -
		((b?.[1] ?? 0) - (a?.[1] ?? 0)) * ((c?.[0] ?? 0) - (a?.[0] ?? 0))

	return { front: cross > 0, inView }
}

// --- the renderer ---

export interface Transition3dContext {
	readonly document: Document
	readonly host: HTMLElement
	readonly outgoing: HTMLElement | undefined
	readonly incoming: HTMLElement
	readonly transition: Transition
	readonly slide: SlideSize
	// Device px per slide px.
	readonly pixelRatio: number
	// Bitmap bytes the run may hold.
	readonly budgetBytes: number
}

export interface Transition3dRun {
	// False when a canvas for a piece could not be had (the player plays the fallback from there).
	frame(progress: number): boolean
	finish(): void
}

// Canvas work per frame while a run cuts its pieces (ms), well inside a 16 ms frame.
const STEP_MS = 6
// Pieces cut below this fraction of the screen's resolution are too blurry to show: the fallback plays instead.
const MIN_SCALE_RATIO = 0.5
// Cut pieces reach this far (px) past their edges, so no seam shows between neighbours.
const OVERLAP_PX = 0.75
// Elements of a slide box a cut leaves out: transparent click targets.
const TRANSPARENT = new Set(["fo-slide-hotspot", "fo-show-links"])
const SAVED = ["transform", "transformOrigin", "opacity", "clipPath", "zIndex", "visibility", "background"] as const
// The stage's canvas of a slide's backdrop layer (the worker's shape -2).
const BACKDROP_CANVAS = ':scope > canvas[data-fo-show-shape="-2"]'

function supports3d(document: Document): boolean {
	const css: unknown = Reflect.get(document.defaultView ?? {}, "CSS")
	const supports: unknown = css === undefined ? undefined : Reflect.get(css as object, "supports")

	return (
		typeof supports === "function" && Reflect.apply(supports, css, ["transform", "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)"]) === true
	)
}

function px(value: string): number {
	const number = Number.parseFloat(value)

	return Number.isFinite(number) ? number : 0
}

// The region (slide px) of the slide box as it shows (its layer bitmaps through their layers' transform, opacity,
// visibility and clip) on a canvas at `ratio` device px per slide px; undefined when it holds what a canvas cannot
// copy (a layer painted as DOM, media controls) or a canvas cannot be had.
export function cutSlide(
	element: HTMLElement,
	region: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
	ratio: number,
	canvas: HTMLCanvasElement = element.ownerDocument.createElement("canvas")
): HTMLCanvasElement | undefined {
	canvas.width = Math.max(1, Math.round(region.w * ratio))
	canvas.height = Math.max(1, Math.round(region.h * ratio))

	const context = canvas.getContext("2d")

	if (context === null) return release(canvas)

	context.setTransform(ratio, 0, 0, ratio, 0 - region.x * ratio, 0 - region.y * ratio)
	context.fillStyle = element.style.background === "" ? "#fff" : element.style.background
	context.fillRect(region.x, region.y, region.w, region.h)

	return walkSlide(element, context) ? canvas : release(canvas)
}

// Whether a canvas can copy the slide box (nothing shows that a canvas cannot draw), without drawing it.
function copyable(element: HTMLElement): boolean {
	return walkSlide(element, undefined)
}

// Draws the slide box's visible bitmaps on `context` (when given); false at the first thing a canvas cannot copy.
function walkSlide(element: HTMLElement, context: CanvasRenderingContext2D | undefined): boolean {
	const view = element.ownerDocument.defaultView

	if (view === null) return false

	const draw = (node: HTMLElement, alpha: number, visible: boolean): boolean => {
		for (const child of node.children) {
			if (!(child instanceof view.HTMLElement)) continue

			const style = child.style

			if (style.display === "none") continue

			const shown = style.visibility === "hidden" ? false : style.visibility === "visible" ? true : visible
			const opacity = alpha * (style.opacity === "" ? 1 : Number(style.opacity))

			if (child instanceof view.HTMLCanvasElement) {
				if (!shown || opacity <= 0 || child.width === 0 || child.height === 0 || context === undefined) continue

				context.globalAlpha = opacity
				context.drawImage(child, px(style.left), px(style.top), px(style.width), px(style.height))

				continue
			}

			if (child instanceof view.HTMLVideoElement) {
				// The frame showing, fitted as object-fit: contain in its media box; nothing yet: the poster is the
				// layer's bitmap below it.
				const bw = px(node.style.width)
				const bh = px(node.style.height)

				if (
					context !== undefined &&
					shown &&
					opacity > 0 &&
					child.readyState >= 2 &&
					child.videoWidth > 0 &&
					child.videoHeight > 0 &&
					bw > 0 &&
					bh > 0
				) {
					const fit = Math.min(bw / child.videoWidth, bh / child.videoHeight)
					const vw = child.videoWidth * fit
					const vh = child.videoHeight * fit

					context.globalAlpha = opacity
					context.drawImage(child, (bw - vw) / 2, (bh - vh) / 2, vw, vh)
				}

				continue
			}

			// An audio element shows only its controls.
			if (child instanceof view.HTMLAudioElement) {
				if (shown && child.controls) return false

				continue
			}

			if (TRANSPARENT.has(child.className)) continue
			if (!child.classList.contains("fo-show-layer") && !child.classList.contains("fo-show-media")) {
				// Anything else that shows (a DOM paint, a video) cannot be copied.
				if (shown && opacity > 0) return false

				continue
			}

			const clip = style.clipPath

			if (clip.startsWith("inset(50%")) continue

			const path = /^path\(evenodd, "(.*)"\)$/u.exec(clip)?.[1]

			if (path === undefined && clip !== "") return false

			const m = style.transform === "" ? undefined : new view.DOMMatrix(style.transform)

			if (m?.is2D === false) return false

			context?.save()

			if (m !== undefined) context?.transform(m.a, m.b, m.c, m.d, m.e, m.f)
			if (path !== undefined) context?.clip(new view.Path2D(path), "evenodd")

			const done = draw(child, opacity, shown)

			context?.restore()

			if (!done) return false
		}

		return true
	}

	return draw(element, 1, true)
}

function release(canvas: HTMLCanvasElement): undefined {
	canvas.width = 0
	canvas.height = 0

	return undefined
}

function grown(polygon: Float64Array, by: number): Float64Array {
	let cx = 0
	let cy = 0
	const n = polygon.length / 2

	for (let k = 0; k < n; k++) {
		cx += (polygon[k * 2] ?? 0) / n
		cy += (polygon[k * 2 + 1] ?? 0) / n
	}

	const out = new Float64Array(polygon.length)

	for (let k = 0; k < n; k++) {
		const dx = (polygon[k * 2] ?? 0) - cx
		const dy = (polygon[k * 2 + 1] ?? 0) - cy
		const length = Math.hypot(dx, dy)
		const f = length === 0 ? 1 : (length + by) / length

		out[k * 2] = cx + dx * f
		out[k * 2 + 1] = cy + dy * f
	}

	return out
}

function number(value: number): string {
	return String(Number(value.toPrecision(7)))
}

function polygonCss(polygon: Float64Array, dx: number, dy: number): string {
	let d = ""

	for (let k = 0; k + 1 < polygon.length; k += 2)
		d += `${k === 0 ? "M" : "L"}${number((polygon[k] ?? 0) - dx)} ${number((polygon[k + 1] ?? 0) - dy)}`

	return `path("${d}Z")`
}

// A clip that is the whole slide is no clip.
function isWhole(polygon: Float64Array, slide: SlideSize): boolean {
	const b = boundsOf(polygon)

	return polygon.length === 8 && b.x <= 0 && b.y <= 0 && b.x + b.w >= slide.w && b.y + b.h >= slide.h
}

interface Drawn {
	readonly element: HTMLElement
	readonly shade: HTMLElement
	// The element's box origin in slide px.
	readonly x: number
	readonly y: number
	// What was written last.
	readonly last: { transform: string; opacity: string; visibility: string; zIndex: string; clip: string; shade: string }
	// The live slide box (else a cut canvas or a backdrop).
	readonly live: boolean
	readonly backdrop?: true
	readonly canvas?: HTMLCanvasElement
}

function shadeElement(document: Document): HTMLElement {
	const shade = document.createElement("div")

	shade.className = "fo-show-shade"
	shade.style.cssText = "position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2147483647"

	return shade
}

function start(context: Transition3dContext): Transition3dRun | undefined {
	const { document, slide } = context

	if (!supports3d(document)) return undefined

	const geometry = transitionGeometry(context.transition, slide)

	if (geometry === undefined) return undefined

	const boxes = [context.outgoing, context.incoming] as const
	// The first piece of each slide is its live box; the rest are cut from it (a backdrop is the box's own backdrop
	// canvas, moved out of it for the run).
	const firsts = new Map<0 | 1, number>()

	geometry.pieces.forEach((piece, k) => {
		if (piece.backdrop !== true && !firsts.has(piece.slide)) firsts.set(piece.slide, k)
	})

	const cut = geometry.pieces.flatMap((piece, k) =>
		firsts.get(piece.slide) === k || piece.backdrop === true || boxes[piece.slide] === undefined ? [] : [k]
	)
	const cutSlides = new Set(cut.map(k => geometry.pieces[k]?.slide ?? 0))
	// Bytes of the pieces' canvases at one device px per slide px.
	const unit = cut.reduce((sum, k) => {
		const b = geometry.pieces[k]?.bounds

		return sum + (b === undefined ? 0 : (b.w + 2 * OVERLAP_PX) * (b.h + 2 * OVERLAP_PX) * 4)
	}, 0)
	const ratio = cut.length === 0 ? context.pixelRatio : Math.min(context.pixelRatio, Math.sqrt(Math.max(0, context.budgetBytes) / unit))

	if (cut.length > 0 && ratio < Math.min(1, context.pixelRatio) * MIN_SCALE_RATIO) return undefined

	for (const index of cutSlides) {
		const box = boxes[index]

		if (box === undefined || !copyable(box)) return undefined
	}

	// The canvas work (each piece cut from its slide box) runs in slices of the first frames, so no task is long; until
	// it is done the frames show the outgoing slide as it stands.
	const steps: (() => boolean)[] = []
	const clock = document.defaultView?.performance ?? Date

	const drawn: (Drawn | undefined)[] = []
	const saved = new Map<HTMLElement, Record<(typeof SAVED)[number], string>>()
	const added: HTMLElement[] = []
	// Backdrop canvases moved out of their boxes, put back at the end.
	const moved: { readonly canvas: Element; readonly parent: Element; readonly next: Node | null }[] = []
	const backdropOf = (piece: Piece3d): Element | null =>
		piece.backdrop === true ? (boxes[piece.slide]?.querySelector(BACKDROP_CANVAS) ?? null) : null

	// The slides whose backdrop is drawn apart (found before any is moved).
	const bare = new Set(geometry.pieces.filter(piece => backdropOf(piece) !== null).map(piece => piece.slide))

	geometry.pieces.forEach((piece, k) => {
		const box = boxes[piece.slide]

		if (box === undefined) {
			drawn.push(undefined)

			return
		}

		const last = { transform: "", opacity: "", visibility: "", zIndex: "", clip: "", shade: "" }

		if (piece.backdrop === true) {
			const canvas = backdropOf(piece)

			// Not drawn apart: the content carries it.
			if (canvas === null || canvas.parentElement === null) {
				drawn.push(undefined)

				return
			}

			const element = document.createElement("div")
			const shade = shadeElement(document)

			element.className = "fo-show-piece fo-show-backdrop"
			element.style.cssText = `position:absolute;left:0;top:0;width:${number(slide.w)}px;height:${number(slide.h)}px;transform-origin:0 0;overflow:hidden;pointer-events:none;visibility:hidden;background:${box.style.background}`
			moved.push({ canvas, parent: canvas.parentElement, next: canvas.nextSibling })
			element.append(canvas, shade)
			context.host.appendChild(element)
			added.push(element)
			drawn.push({ element, shade, x: 0, y: 0, last, live: false, backdrop: true })

			return
		}

		if (firsts.get(piece.slide) === k) {
			const style = box.style

			saved.set(box, {
				transform: style.transform,
				transformOrigin: style.transformOrigin,
				opacity: style.opacity,
				clipPath: style.clipPath,
				zIndex: style.zIndex,
				visibility: style.visibility,
				background: style.background
			})
			style.transformOrigin = "0 0"
			style.clipPath = ""

			// Its backdrop is drawn apart: the box shows its content only.
			if (bare.has(piece.slide)) style.background = "transparent"

			const shade = shadeElement(document)

			box.appendChild(shade)
			added.push(shade)
			last.clip = "\u0000"
			drawn.push({ element: box, shade, x: 0, y: 0, last, live: true })

			return
		}

		const b = piece.bounds
		const x = b.x - OVERLAP_PX
		const y = b.y - OVERLAP_PX
		const w = b.w + 2 * OVERLAP_PX
		const h = b.h + 2 * OVERLAP_PX
		const element = document.createElement("div")
		const canvas = document.createElement("canvas")
		const shade = shadeElement(document)

		element.className = "fo-show-piece"
		element.style.cssText = `position:absolute;left:0;top:0;width:${number(w)}px;height:${number(h)}px;transform-origin:0 0;overflow:hidden;pointer-events:none;visibility:hidden`
		canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%"
		steps.push(() => cutSlide(box, { x, y, w, h }, ratio, canvas) !== undefined)

		if (!isWhole(piece.polygon, slide)) element.style.clipPath = polygonCss(grown(piece.polygon, OVERLAP_PX), x, y)

		element.append(canvas, shade)
		context.host.appendChild(element)
		added.push(element)
		drawn.push({ element, shade, x, y, last, live: false, canvas })
	})

	let next = 0
	let failed = false
	// Runs canvas steps for at most STEP_MS; whether all are done.
	const build = (): boolean => {
		const until = clock.now() + STEP_MS

		while (next < steps.length && !failed) {
			failed = !(steps[next]?.() ?? true)
			next++

			if (clock.now() >= until) break
		}

		return next >= steps.length
	}

	const view = viewMatrix(slide)
	const frame = newFrame(geometry)
	const write = (item: Drawn, key: keyof Drawn["last"], value: string, apply: (value: string) => void): void => {
		if (item.last[key] === value) return

		item.last[key] = value
		apply(value)
	}
	const show = (
		item: Drawn,
		k: number,
		visible: boolean,
		rank: number,
		transform: string,
		opacity: string,
		shade: string,
		clip: string
	): void => {
		const style = item.element.style

		write(item, "visibility", visible ? "visible" : "hidden", value => {
			style.visibility = value
		})
		write(item, "zIndex", String(10 + rank), value => {
			style.zIndex = value
		})
		write(item, "transform", transform, value => {
			style.transform = value
		})
		write(item, "opacity", opacity, value => {
			style.opacity = value
		})
		write(item, "shade", shade, value => {
			item.shade.style.opacity = value
		})

		if (item.live || frame.clips[k] !== undefined || item.last.clip !== "")
			write(item, "clip", clip, value => {
				style.clipPath = value
			})
	}

	return {
		frame(progress) {
			const built = progress >= 1 || build()

			// A canvas could not be had: the player plays the fallback from here.
			if (failed) return false

			// The first and last frames (and the frames before the pieces are cut) are the slides as they stand.
			if (progress <= 0 || progress >= 1 || !built) {
				const top = progress >= 1 ? 1 : 0

				drawn.forEach((item, k) => {
					if (item === undefined) return

					const piece = geometry.pieces[k]
					const whole = (item.live || item.backdrop === true) && piece?.slide === top

					show(item, k, whole, whole && item.live ? 1 : 0, "", "", "0", "")
				})

				return true
			}

			geometry.frame(progress, frame)
			frame.order.forEach((k, rank) => {
				const item = drawn[k]
				const piece = geometry.pieces[k]

				if (item === undefined || piece === undefined) return

				const m = chain(view, frame.models.subarray(k * 16, k * 16 + 16), translate(item.x, item.y))
				const local = {
					x: 0,
					y: 0,
					w: item.live ? slide.w : piece.bounds.w + 2 * OVERLAP_PX,
					h: item.live ? slide.h : piece.bounds.h + 2 * OVERLAP_PX
				}
				const facing = frontFacing(m, local)
				const opacity = frame.opacity[k] ?? 0
				const visible = facing.inView && opacity > 0 && (facing.front || piece.twoSided)
				const clipPolygon = frame.clips[k] ?? (item.live ? piece.polygon : undefined)
				const clip =
					clipPolygon === undefined || isWhole(clipPolygon, slide)
						? ""
						: clipPolygon.length < 6
							? "inset(50% 50% 50% 50%)"
							: polygonCss(item.live ? clipPolygon : grown(clipPolygon, OVERLAP_PX), item.x, item.y)

				show(
					item,
					k,
					visible,
					rank,
					`matrix3d(${Array.from(m, number).join(",")})`,
					opacity >= 1 ? "" : number(opacity),
					number(frame.shade[k] ?? 0),
					clip
				)
			})

			return true
		},
		finish() {
			for (const item of drawn) if (item?.canvas !== undefined) release(item.canvas)
			for (const { canvas, parent, next } of moved) parent.insertBefore(canvas, next)
			for (const element of added) element.remove()

			for (const [element, values] of saved) for (const name of SAVED) element.style[name] = values[name]
		}
	}
}

// The 3D transitions as the player's transition renderer.
export const transitions3d = {
	draws: draws3d,
	start
}
