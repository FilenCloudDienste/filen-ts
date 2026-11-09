// The 21 ECMA-376 Part 1 §19.7 slide transitions (p:blinds … p:zoom) as progress functions: the state of the outgoing
// and incoming slides at progress p (0..1, after the speed or p14:dur maps time to progress), in slide fractions. The
// player draws the incoming slide clipped to `reveal` (undefined: the whole slide) over the outgoing one, both moved
// by their offsets. Direction values follow ST_TransitionSideDirectionType (l, u, r, d: the way the transition moves,
// so "l" enters from the right), ST_TransitionCornerDirectionType (lu, ru, ld, rd) and ST_TransitionInOutDirectionType;
// their defaults are the schema's. The ODF mapping (SMIL type and subtype, ODF 1.3 Part 3 smil:type) is the
// inverse of core/odp/read/transitions.ts.

export type Region =
	// x, y, w, h quadruples.
	| { readonly kind: "rects"; readonly rects: Float64Array }
	// x, y pairs of one closed polygon.
	| { readonly kind: "polygon"; readonly points: Float64Array }
	| { readonly kind: "ellipse"; readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number }
	// A grid of cols × rows cells, the first `count` of `order` shown.
	| { readonly kind: "cells"; readonly cols: number; readonly rows: number; readonly order: Uint16Array; readonly count: number }
	| { readonly kind: "none" }

export interface SlideMotion {
	readonly dx: number
	readonly dy: number
	readonly scale: number
	// Degrees.
	readonly rotation: number
	readonly opacity: number
}

export interface TransitionFrame {
	readonly incoming: SlideMotion
	readonly outgoing: SlideMotion
	readonly reveal?: Region
	// The opacity of the overlay drawn between the slides (thruBlk, flash).
	readonly black: number
	// The overlay's CSS colour: black, white for flash, an ODF fade's smil:fadeColor.
	readonly overlay: string
	// Whether the outgoing slide is drawn over the incoming one (pull, zoom out).
	readonly outgoingOnTop: boolean
}

const BLACK = "#000000"
const HEX_COLOR = /^#[\da-f]{6}$/iu

const STILL: SlideMotion = { dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1 }

export type TransitionOptions = { readonly [name: string]: string | number | boolean }

function option(options: TransitionOptions, name: string, fallback: string): string {
	const value = options[name]

	return typeof value === "string" ? value : fallback
}

function side(dir: string): { readonly x: number; readonly y: number } {
	// The unit vector the transition moves along.
	switch (dir) {
		case "r":
			return { x: 1, y: 0 }
		case "u":
			return { x: 0, y: -1 }
		case "d":
			return { x: 0, y: 1 }
		case "lu":
			return { x: -1, y: -1 }
		case "ru":
			return { x: 1, y: -1 }
		case "ld":
			return { x: -1, y: 1 }
		case "rd":
			return { x: 1, y: 1 }
		default:
			return { x: -1, y: 0 }
	}
}

function rects(values: readonly number[]): Region {
	return { kind: "rects", rects: Float64Array.from(values) }
}

function frame(
	incoming: Partial<SlideMotion>,
	reveal?: Region,
	extra: Partial<Pick<TransitionFrame, "black" | "overlay" | "outgoingOnTop">> = {},
	outgoing: Partial<SlideMotion> = {}
): TransitionFrame {
	return {
		incoming: { ...STILL, ...incoming },
		outgoing: { ...STILL, ...outgoing },
		...(reveal === undefined ? {} : { reveal }),
		black: extra.black ?? 0,
		overlay: extra.overlay ?? BLACK,
		outgoingOnTop: extra.outgoingOnTop ?? false
	}
}

// Out to `overlay` over the first half, in from it over the second.
function fadeThrough(p: number, overlay: string): TransitionFrame {
	return p < 0.5
		? frame({ opacity: 0 }, undefined, { black: 2 * p, overlay })
		: frame({ opacity: 2 * p - 1 }, undefined, { black: 1, overlay })
}

// The kinds p:random picks from: the ECMA ones drawn here, less cut (no visible transition) and random itself.
export const RANDOM_TRANSITION_KINDS: readonly string[] = [
	"blinds",
	"checker",
	"circle",
	"comb",
	"cover",
	"diamond",
	"dissolve",
	"fade",
	"newsflash",
	"plus",
	"pull",
	"push",
	"randomBar",
	"split",
	"strips",
	"wedge",
	"wheel",
	"wipe",
	"zoom"
]

// The kind p:random plays for a draw r in [0, 1). Picked once per run by the player, so frames depend on p only.
export function randomTransitionKind(r: number): string {
	const index = Math.min(RANDOM_TRANSITION_KINDS.length - 1, Math.max(0, Math.floor(r * RANDOM_TRANSITION_KINDS.length)))

	return RANDOM_TRANSITION_KINDS[index] ?? "fade"
}

// A deterministic permutation (a linear congruential walk), so a dissolve or random-bar frame depends on p only.
const ORDERS = new Map<number, Uint16Array>()

function order(count: number): Uint16Array {
	let cached = ORDERS.get(count)

	if (cached !== undefined) return cached

	cached = new Uint16Array(count)

	for (let k = 0; k < count; k++) cached[k] = k

	let seed = 0x2545f491

	for (let k = count - 1; k > 0; k--) {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0

		const j = seed % (k + 1)
		const swap = cached[k] ?? 0

		cached[k] = cached[j] ?? 0
		cached[j] = swap
	}

	ORDERS.set(count, cached)

	return cached
}

function sector(cx: number, cy: number, from: number, to: number, out: number[]): void {
	// A pie slice from angle `from` to `to` (radians, clockwise from up), radius big enough to cover the slide.
	const radius = 1
	const steps = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 32)))

	out.push(cx, cy)

	for (let k = 0; k <= steps; k++) {
		const a = from + ((to - from) * k) / steps

		out.push(cx + Math.sin(a) * radius, cy - Math.cos(a) * radius)
	}
}

// The frame of transition `kind` at progress `p`. Unknown kinds (p14/p15 ones without their own renderer) play as fade.
export function transitionFrame(kind: string, options: TransitionOptions, progress: number): TransitionFrame {
	const p = Math.min(1, Math.max(0, progress))

	switch (kind) {
		case "blinds": {
			const vertical = option(options, "dir", "horz") === "vert"
			const out: number[] = []
			const bands = 6

			for (let k = 0; k < bands; k++) out.push(...(vertical ? [k / bands, 0, p / bands, 1] : [0, k / bands, 1, p / bands]))

			return frame({}, rects(out))
		}
		case "checker": {
			const vertical = option(options, "dir", "horz") === "vert"
			const cells = 8
			const out: number[] = []
			const size = 1 / cells

			// Rows of cells two wide, alternate rows offset by one cell, each cell pair wiping across in turn.
			for (let row = 0; row < cells; row++) {
				for (let k = -1; k < cells / 2; k++) {
					const start = (k * 2 + (row % 2)) * size
					const extent = 2 * size * p
					const a = Math.max(0, start)
					const b = Math.min(1, start + extent)

					if (b > a) out.push(...(vertical ? [row * size, a, size, b - a] : [a, row * size, b - a, size]))
				}
			}

			return frame({}, rects(out))
		}
		case "circle": {
			const r = p * Math.SQRT1_2

			return frame({}, { kind: "ellipse", cx: 0.5, cy: 0.5, rx: r, ry: r })
		}
		case "comb": {
			const vertical = option(options, "dir", "horz") === "vert"
			const teeth = 8
			const out: number[] = []

			for (let k = 0; k < teeth; k++) {
				const from = k % 2 === 0 ? 0 : 1 - p

				out.push(...(vertical ? [k / teeth, from, 1 / teeth, p] : [from, k / teeth, p, 1 / teeth]))
			}

			return frame({}, rects(out))
		}
		case "cover": {
			const v = side(option(options, "dir", "l"))

			return frame({ dx: -v.x * (1 - p), dy: -v.y * (1 - p) })
		}
		case "pull": {
			const v = side(option(options, "dir", "l"))

			return frame({}, undefined, { outgoingOnTop: true }, { dx: v.x * p, dy: v.y * p })
		}
		case "push": {
			const v = side(option(options, "dir", "l"))

			return frame({ dx: -v.x * (1 - p), dy: -v.y * (1 - p) }, undefined, {}, { dx: v.x * p, dy: v.y * p })
		}
		case "cut":
			// Instant; through black, the black stands for the transition's whole span.
			return options["thruBlk"] === true
				? frame({ opacity: p >= 1 ? 1 : 0 }, undefined, { black: p > 0 && p < 1 ? 1 : 0 })
				: frame({ opacity: p > 0 ? 1 : 0 })
		case "diamond":
			return frame({}, { kind: "polygon", points: Float64Array.of(0.5, 0.5 - p, 0.5 + p, 0.5, 0.5, 0.5 + p, 0.5 - p, 0.5) })
		case "dissolve": {
			const cols = 32
			const rows = 24

			return frame({}, { kind: "cells", cols, rows, order: order(cols * rows), count: Math.round(p * cols * rows) })
		}
		case "fade":
			if (options["thruBlk"] === true) {
				// ODF fadeOverColor keeps its smil:fadeColor.
				const color = options["smilFadeColor"]

				return fadeThrough(p, typeof color === "string" && HEX_COLOR.test(color) ? color : BLACK)
			}

			return frame({ opacity: p })
		case "flash":
			// p14:flash: through white.
			return fadeThrough(p, "#ffffff")
		case "newsflash":
			return frame({ scale: p, rotation: 720 * (1 - p) })
		case "plus":
			return frame({}, rects([0.5 - p / 2, 0.5 - p, p, 2 * p, 0.5 - p, 0.5 - p / 2, 2 * p, p]))
		case "randomBar": {
			const vertical = option(options, "dir", "horz") === "vert"
			const bars = 120

			return frame(
				{},
				{ kind: "cells", cols: vertical ? bars : 1, rows: vertical ? 1 : bars, order: order(bars), count: Math.round(p * bars) }
			)
		}
		case "split": {
			const vertical = option(options, "orient", "horz") === "vert"
			const outward = option(options, "dir", "out") === "out"

			if (outward) return frame({}, rects(vertical ? [0.5 - p / 2, 0, p, 1] : [0, 0.5 - p / 2, 1, p]))

			return frame({}, rects(vertical ? [0, 0, p / 2, 1, 1 - p / 2, 0, p / 2, 1] : [0, 0, 1, p / 2, 0, 1 - p / 2, 1, p / 2]))
		}
		case "strips": {
			const v = side(option(options, "dir", "lu"))
			// The diagonal front moves the way of `dir`, from the opposite corner.
			const x0 = v.x > 0 ? 0 : 1
			const y0 = v.y > 0 ? 0 : 1
			const reach = 2 * p
			const sx = v.x > 0 ? 1 : -1
			const sy = v.y > 0 ? 1 : -1

			return frame({}, { kind: "polygon", points: Float64Array.of(x0, y0, x0 + sx * reach, y0, x0, y0 + sy * reach) })
		}
		case "wedge": {
			const out: number[] = []

			sector(0.5, 0.5, -Math.PI * p, Math.PI * p, out)

			return frame({}, { kind: "polygon", points: Float64Array.from(out) })
		}
		case "wheel": {
			const spokes = Math.max(1, Math.trunc(Number(options["spokes"] ?? 4)) || 4)
			const out: number[] = []
			const span = (2 * Math.PI) / spokes

			for (let k = 0; k < spokes; k++) sector(0.5, 0.5, k * span, k * span + span * p, out)

			return frame({}, { kind: "polygon", points: Float64Array.from(out) })
		}
		case "wipe": {
			const v = side(option(options, "dir", "l"))

			return frame({}, rects(v.x < 0 ? [1 - p, 0, p, 1] : v.x > 0 ? [0, 0, p, 1] : v.y < 0 ? [0, 1 - p, 1, p] : [0, 0, 1, p]))
		}
		case "zoom":
			return option(options, "dir", "out") === "in"
				? frame({}, undefined, { outgoingOnTop: true }, { scale: 1 + p, opacity: 1 - p })
				: frame({ scale: p })
		// p:random is resolved to a kind by the player before it runs; unresolved it fades.
		case "random":
		default:
			return frame({ opacity: p })
	}
}

// Whether the slide point (x, y) (fractions) is inside `region`; regions with several pieces are their union and a
// polygon list (sectors) is filled by the even-odd rule over each fan from its first point.
export function inRegion(region: Region | undefined, x: number, y: number): boolean {
	if (region === undefined) return true

	switch (region.kind) {
		case "none":
			return false
		case "rects": {
			const r = region.rects

			for (let k = 0; k + 3 < r.length; k += 4) {
				const rx = r[k] ?? 0
				const ry = r[k + 1] ?? 0

				if (x >= rx && x < rx + (r[k + 2] ?? 0) && y >= ry && y < ry + (r[k + 3] ?? 0)) return true
			}

			return false
		}
		case "ellipse": {
			if (region.rx <= 0 || region.ry <= 0) return false

			const dx = (x - region.cx) / region.rx
			const dy = (y - region.cy) / region.ry

			return dx * dx + dy * dy <= 1
		}
		case "cells": {
			const col = Math.min(region.cols - 1, Math.floor(x * region.cols))
			const row = Math.min(region.rows - 1, Math.floor(y * region.rows))
			const cell = row * region.cols + col

			for (let k = 0; k < region.count; k++) if (region.order[k] === cell) return true

			return false
		}
		case "polygon": {
			const points = region.points
			let inside = false
			const n = points.length / 2

			for (let i = 0, j = n - 1; i < n; j = i++) {
				const xi = points[i * 2] ?? 0
				const yi = points[i * 2 + 1] ?? 0
				const xj = points[j * 2] ?? 0
				const yj = points[j * 2 + 1] ?? 0

				if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
			}

			return inside
		}
	}
}

// --- ECMA ↔ ODF (smil:type, smil:subtype, smil:direction "reverse") ---

export interface OdfTransition {
	readonly type: string
	readonly subtype: string
	readonly reverse: boolean
}

const FROM: Readonly<Record<string, string>> = {
	l: "fromRight",
	r: "fromLeft",
	u: "fromBottom",
	d: "fromTop",
	lu: "fromBottomRight",
	ru: "fromBottomLeft",
	ld: "fromTopRight",
	rd: "fromTopLeft"
}

// The SMIL transition LibreOffice draws for an ECMA one (the inverse of core/odp/read/transitions.ts kindOf), or
// undefined when ODF has none (p14/p15 kinds without a SMIL equivalent keep their mc:Fallback).
export function transitionToOdf(kind: string, options: TransitionOptions): OdfTransition | undefined {
	// Read from ODF: the SMIL names as written.
	const smilType = options["smilType"]

	if (typeof smilType === "string") {
		const subtype = options["smilSubtype"]

		return { type: smilType, subtype: typeof subtype === "string" ? subtype : "", reverse: options["smilDirection"] === "reverse" }
	}

	const dir = (fallback: string): string => option(options, "dir", fallback)
	// The edge (or corner) the incoming slide comes from: the opposite of the way it moves.
	const from = (d: string): string => FROM[d] ?? "fromRight"

	switch (kind) {
		case "fade":
			return { type: "fade", subtype: options["thruBlk"] === true ? "fadeOverColor" : "crossfade", reverse: false }
		case "cut":
			return { type: "barWipe", subtype: "fadeOverColor", reverse: false }
		case "wipe": {
			const d = dir("l")

			return { type: "barWipe", subtype: d === "u" || d === "d" ? "topToBottom" : "leftToRight", reverse: d === "u" || d === "l" }
		}
		case "push":
			return { type: "pushWipe", subtype: from(dir("l")), reverse: false }
		case "comb":
			return { type: "pushWipe", subtype: dir("horz") === "vert" ? "combVertical" : "combHorizontal", reverse: false }
		case "cover":
			return { type: "slideWipe", subtype: from(dir("l")), reverse: false }
		case "pull":
			return { type: "slideWipe", subtype: from(dir("l")), reverse: true }
		case "circle":
			return { type: "ellipseWipe", subtype: "circle", reverse: false }
		case "zoom":
			return { type: "irisWipe", subtype: "rectangle", reverse: dir("out") === "in" }
		case "diamond":
			return { type: "irisWipe", subtype: "diamond", reverse: false }
		case "plus":
			return { type: "fourBoxWipe", subtype: "cornersOut", reverse: false }
		case "wedge":
			return { type: "fanWipe", subtype: "centerTop", reverse: false }
		case "wheel": {
			const spokes = String(options["spokes"] ?? "4")
			const subtype =
				spokes === "1"
					? "oneBlade"
					: spokes === "2"
						? "twoBladeVertical"
						: spokes === "3"
							? "threeBlade"
							: spokes === "8"
								? "eightBlade"
								: "fourBlade"

			return { type: "pinWheelWipe", subtype, reverse: false }
		}
		case "blinds":
			return { type: "blindsWipe", subtype: dir("horz") === "vert" ? "vertical" : "horizontal", reverse: false }
		case "checker":
			return { type: "checkerBoardWipe", subtype: dir("horz") === "vert" ? "down" : "across", reverse: false }
		case "dissolve":
			return { type: "dissolve", subtype: "default", reverse: false }
		case "randomBar":
			return { type: "randomBarWipe", subtype: dir("horz") === "vert" ? "vertical" : "horizontal", reverse: false }
		case "split": {
			const vertical = option(options, "orient", "horz") === "vert"

			return { type: "barnDoorWipe", subtype: vertical ? "vertical" : "horizontal", reverse: option(options, "dir", "out") === "in" }
		}
		case "strips": {
			const d = dir("lu")

			return {
				type: "waterfallWipe",
				subtype: d === "ld" || d === "lu" ? "horizontalLeft" : "horizontalRight",
				reverse: d === "lu" || d === "ru"
			}
		}
		case "newsflash":
			return { type: "zoom", subtype: "rotateIn", reverse: false }
		case "random":
			return { type: "random", subtype: "random", reverse: false }
		default:
			return undefined
	}
}
