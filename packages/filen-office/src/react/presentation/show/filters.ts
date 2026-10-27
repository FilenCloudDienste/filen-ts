import { transitionFrame, type Region, type TransitionOptions } from "../../../core/anim/transitions"

// The animEffect filters of ECMA-376 Part 1 §19.5.3 (p:animEffect filter, e.g. "wipe(down)", "barn(inVertical)") as
// what the stage does to a layer at progress p: the region of its shape box left visible, an opacity and an offset.
// The regions are the slide transitions' own (core/anim/transitions.ts) where a filter is one of them; "in" variants
// of the shape reveals (box, circle, diamond, plus) close from the edges, so they are the complement of the "out"
// shape at 1 - p. An effect that plays out (transition="out") shows at p what playing in shows at 1 - p.

export type ClipShape =
	// Polygons (x, y fractions of the box) filled by the even-odd rule. With `reach`, a rectangle's side on the box's
	// edge reaches far past it (the layer's effects outside the box show with the edge they touch).
	| { readonly kind: "polygons"; readonly polygons: readonly Float64Array[]; readonly reach?: true }
	// Nothing visible.
	| { readonly kind: "none" }

export interface FilterFrame {
	readonly opacity: number
	// Absent: the whole layer.
	readonly clip?: ClipShape
	// Fractions of the box the content moves by (slide), the clip staying where the box is.
	readonly dx: number
	readonly dy: number
}

const WHOLE: FilterFrame = { opacity: 1, dx: 0, dy: 0 }
const ELLIPSE_POINTS = 64

type Rect = readonly [number, number, number, number]

// `a` minus `b`, as up to four rectangles (x0, y0, x1, y1).
function subtract(a: Rect, b: Rect): Rect[] {
	const [ax0, ay0, ax1, ay1] = a
	const [bx0, by0, bx1, by1] = b

	if (bx0 >= ax1 || bx1 <= ax0 || by0 >= ay1 || by1 <= ay0) return [a]

	const out: Rect[] = []

	if (by0 > ay0) out.push([ax0, ay0, ax1, by0])
	if (by1 < ay1) out.push([ax0, by1, ax1, ay1])

	const y0 = Math.max(ay0, by0)
	const y1 = Math.min(ay1, by1)

	if (bx0 > ax0) out.push([ax0, y0, bx0, y1])
	if (bx1 < ax1) out.push([bx1, y0, ax1, y1])

	return out
}

// Rectangles (x, y, w, h quadruples, their union meant) cut into ones that do not overlap, so the even-odd fill of
// their polygons is their union (a plus is two overlapping bars).
function disjoint(rects: Float64Array): Rect[] {
	const out: Rect[] = []

	for (let k = 0; k + 3 < rects.length; k += 4) {
		const x = rects[k] ?? 0
		const y = rects[k + 1] ?? 0
		const w = rects[k + 2] ?? 0
		const h = rects[k + 3] ?? 0

		if (!(w > 0 && h > 0)) continue

		let pieces: Rect[] = [[x, y, x + w, y + h]]

		for (const held of out) pieces = pieces.flatMap(piece => subtract(piece, held))

		out.push(...pieces)
	}

	return out
}

// A transition region (core/anim/transitions.ts) as polygons.
export function polygonsOf(region: Region | undefined): ClipShape | undefined {
	if (region === undefined) return undefined

	switch (region.kind) {
		case "none":
			return { kind: "none" }
		case "polygon":
			return { kind: "polygons", polygons: [region.points] }
		case "rects": {
			const out = disjoint(region.rects).map(([x0, y0, x1, y1]) => Float64Array.of(x0, y0, x1, y0, x1, y1, x0, y1))

			return out.length === 0 ? { kind: "none" } : { kind: "polygons", polygons: out, reach: true }
		}
		case "ellipse": {
			if (region.rx <= 0 || region.ry <= 0) return { kind: "none" }

			const points = new Float64Array(ELLIPSE_POINTS * 2)

			for (let k = 0; k < ELLIPSE_POINTS; k++) {
				const a = (2 * Math.PI * k) / ELLIPSE_POINTS

				points[k * 2] = region.cx + Math.cos(a) * region.rx
				points[k * 2 + 1] = region.cy + Math.sin(a) * region.ry
			}

			return { kind: "polygons", polygons: [points] }
		}
		case "cells": {
			const out: Float64Array[] = []
			const w = 1 / region.cols
			const h = 1 / region.rows

			for (let k = 0; k < region.count; k++) {
				const cell = region.order[k] ?? 0
				const x = (cell % region.cols) * w
				const y = Math.floor(cell / region.cols) * h

				out.push(Float64Array.of(x, y, x + w, y, x + w, y + h, x, y + h))
			}

			return out.length === 0 ? { kind: "none" } : { kind: "polygons", polygons: out, reach: true }
		}
	}
}

// Everything outside `shape`: the box (far past its edges) with the shape's polygons as holes.
function complement(shape: ClipShape | undefined): ClipShape | undefined {
	const outer = Float64Array.of(-4, -4, 5, -4, 5, 5, -4, 5)

	if (shape === undefined) return { kind: "none" }
	if (shape.kind === "none") return undefined

	return { kind: "polygons", polygons: [outer, ...shape.polygons] }
}

function reveal(kind: string, options: TransitionOptions, p: number): ClipShape | undefined {
	return polygonsOf(transitionFrame(kind, options, p).reveal)
}

const SIDES: Readonly<Record<string, string>> = { down: "d", up: "u", left: "l", right: "r" }
const CORNERS: Readonly<Record<string, string>> = { downLeft: "ld", upLeft: "lu", downRight: "rd", upRight: "ru" }

// One filter (name and argument) at visible amount q.
function one(name: string, arg: string, q: number): FilterFrame {
	switch (name) {
		case "fade":
			return { ...WHOLE, opacity: q }
		case "wipe":
			return { ...WHOLE, ...clip(reveal("wipe", { dir: SIDES[arg] ?? "r" }, q)) }
		case "blinds":
			return { ...WHOLE, ...clip(reveal("blinds", { dir: arg === "vertical" ? "vert" : "horz" }, q)) }
		case "checkerboard":
			return { ...WHOLE, ...clip(reveal("checker", { dir: arg === "down" ? "vert" : "horz" }, q)) }
		case "randombar":
			return { ...WHOLE, ...clip(reveal("randomBar", { dir: arg === "vertical" ? "vert" : "horz" }, q)) }
		case "strips":
			return { ...WHOLE, ...clip(reveal("strips", { dir: CORNERS[arg] ?? "rd" }, q)) }
		case "barn":
			return {
				...WHOLE,
				...clip(
					reveal("split", { orient: arg.endsWith("Vertical") ? "vert" : "horz", dir: arg.startsWith("in") ? "in" : "out" }, q)
				)
			}
		case "dissolve":
			return { ...WHOLE, ...clip(reveal("dissolve", {}, q)) }
		case "wedge":
			return { ...WHOLE, ...clip(reveal("wedge", {}, q)) }
		case "wheel":
			return { ...WHOLE, ...clip(reveal("wheel", { spokes: Number(arg) || 1 }, q)) }
		case "circle":
		case "diamond":
		case "plus":
			return { ...WHOLE, ...clip(arg === "in" ? complement(reveal(name, {}, 1 - q)) : reveal(name, {}, q)) }
		case "box": {
			const size = arg === "in" ? 1 - q : q
			const box = polygonsOf({ kind: "rects", rects: Float64Array.of(0.5 - size / 2, 0.5 - size / 2, size, size) })

			return { ...WHOLE, ...clip(arg === "in" ? complement(box) : box) }
		}
		case "slide": {
			const rest = 1 - q
			const whole: ClipShape = { kind: "polygons", polygons: [Float64Array.of(0, 0, 1, 0, 1, 1, 0, 1)] }

			switch (arg) {
				case "fromTop":
					return { ...WHOLE, clip: whole, dy: -rest }
				case "fromBottom":
					return { ...WHOLE, clip: whole, dy: rest }
				case "fromLeft":
					return { ...WHOLE, clip: whole, dx: -rest }
				default:
					return { ...WHOLE, clip: whole, dx: rest }
			}
		}
		default:
			// "image" and filters the stage has no drawing for show the layer as it is.
			return WHOLE
	}
}

function clip(shape: ClipShape | undefined): Pick<FilterFrame, "clip"> {
	return shape === undefined ? {} : { clip: shape }
}

// The frame of filter list `filter` (";"-separated, each "name" or "name(argument)") at progress p. Several filters
// multiply their opacities; the last one with a region gives the region.
export function filterFrame(filter: string, progress: number, reverse: boolean): FilterFrame {
	const p = Math.min(1, Math.max(0, progress))
	const q = reverse ? 1 - p : p
	let out = WHOLE

	for (const part of filter.split(";")) {
		const match = /^\s*([A-Za-z]+)\s*(?:\(\s*([^)]*?)\s*\))?\s*$/u.exec(part)

		if (match === null) continue

		const frame = one(match[1] ?? "", match[2] ?? "", q)

		out = {
			opacity: out.opacity * frame.opacity,
			...(frame.clip !== undefined ? { clip: frame.clip } : out.clip !== undefined ? { clip: out.clip } : {}),
			dx: out.dx + frame.dx,
			dy: out.dy + frame.dy
		}
	}

	return out
}

// Box fractions to px; with `reaches`, a point exactly on an edge (0 or 1) reaches far beyond the box.
function edge(u: number, start: number, size: number, reaches: boolean): number {
	const reach = Math.max(size, 1) * 4

	if (!reaches) return start + u * size
	if (u === 0) return start - reach
	if (u === 1) return start + size + reach

	return start + u * size
}

function round(value: number): string {
	return String(Math.round(value * 100) / 100)
}

// A CSS clip-path for `shape` over the box (x, y, w, h, the coordinates of the clipped element), moved back by the
// content offset (dx, dy px) so the clip stays put while the content slides.
export function clipPathCss(
	shape: ClipShape,
	box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
	dx = 0,
	dy = 0
): string {
	if (shape.kind === "none") return "inset(50% 50% 50% 50%)"

	let d = ""

	for (const polygon of shape.polygons) {
		for (let k = 0; k + 1 < polygon.length; k += 2) {
			const x = edge(polygon[k] ?? 0, box.x, box.w, shape.reach === true) - dx
			const y = edge(polygon[k + 1] ?? 0, box.y, box.h, shape.reach === true) - dy

			d += `${k === 0 ? "M" : "L"}${round(x)} ${round(y)}`
		}

		d += "Z"
	}

	return `path(evenodd, "${d}")`
}
