import { motion } from "./build"
import type { EffectPreset, PresetGroup } from "./types"

// Motion path presets (presetClass "path"): lines, arcs, turns, shapes and loops as ECMA-376 §19.5.4 paths, our own
// geometry. Coordinates are fractions of the slide, relative to the shape's place (the path starts at 0 0), so a
// closed shape brings the shape back where it began; heights are scaled by the slide's aspect so circles stay round.

const SIZE = 0.25

function n(value: number): string {
	const rounded = Math.round(value * 10000) / 10000

	return Object.is(rounded, -0) ? "0" : String(rounded)
}

function pt(x: number, y: number): string {
	return `${n(x)} ${n(y)}`
}

function line(dx: number, dy: number) {
	return (aspect: number): string => `M 0 0 L ${pt(dx, dy * aspect)} E`
}

// A curve from 0 0 to (dx, dy) bowing by (bx, by) at both control points.
function arc(dx: number, dy: number, bx: number, by: number) {
	return (aspect: number): string => `M 0 0 C ${pt(bx, by * aspect)} ${pt(dx + bx, (dy + by) * aspect)} ${pt(dx, dy * aspect)} E`
}

// Straight on, a quarter turn, straight on again.
function turn(first: readonly [number, number], second: readonly [number, number]) {
	return (aspect: number): string => {
		const half = SIZE / 2
		const [ax, ay] = first
		const [bx, by] = second
		const corner: [number, number] = [ax * half, ay * half]
		const end: [number, number] = [corner[0] + bx * half, corner[1] + by * half]
		const k = 0.55 * (half / 2)
		const c1: [number, number] = [corner[0] - (ax * half) / 2 + ax * k, corner[1] - (ay * half) / 2 + ay * k]
		const c2: [number, number] = [corner[0] + (bx * half) / 2 - bx * k, corner[1] + (by * half) / 2 - by * k]
		const into: [number, number] = [corner[0] - (ax * half) / 2, corner[1] - (ay * half) / 2]
		const outOf: [number, number] = [corner[0] + (bx * half) / 2, corner[1] + (by * half) / 2]
		const y = (value: number): number => value * aspect

		return `M 0 0 L ${pt(into[0], y(into[1]))} C ${pt(c1[0], y(c1[1]))} ${pt(c2[0], y(c2[1]))} ${pt(outOf[0], y(outOf[1]))} L ${pt(end[0], y(end[1]))} E`
	}
}

// A closed polygon of `points` (unit coordinates, the first at the start), scaled to the preset size.
function polygon(points: readonly (readonly [number, number])[]) {
	return (aspect: number): string => {
		const [x0, y0] = points[0] ?? [0, 0]
		const at = ([x, y]: readonly [number, number]): string => pt((x - x0) * SIZE, (y - y0) * SIZE * aspect)

		return `M 0 0 ${points
			.slice(1)
			.map(p => `L ${at(p)}`)
			.join(" ")} Z E`
	}
}

// Points on a circle from the top, clockwise; `inner` alternates a second radius (stars).
function ring(count: number, inner?: number): [number, number][] {
	const out: [number, number][] = []
	const steps = inner === undefined ? count : count * 2

	for (let i = 0; i < steps; i++) {
		const r = inner !== undefined && i % 2 === 1 ? inner : 0.5
		const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps

		out.push([r * Math.cos(a), r * Math.sin(a)])
	}

	return out
}

// An ellipse through the start (its top), clockwise, as four cubic Béziers.
function ellipse(rx: number, ry: number) {
	return (aspect: number): string => {
		const k = 0.5523
		const h = ry * aspect
		const y = (value: number): number => value * h

		return (
			`M 0 0 C ${pt(rx * k, 0)} ${pt(rx, y(1 - k))} ${pt(rx, y(1))} ` +
			`C ${pt(rx, y(1 + k))} ${pt(rx * k, y(2))} ${pt(0, y(2))} ` +
			`C ${pt(-rx * k, y(2))} ${pt(-rx, y(1 + k))} ${pt(-rx, y(1))} ` +
			`C ${pt(-rx, y(1 - k))} ${pt(-rx * k, 0)} 0 0 Z E`
		)
	}
}

function heart(aspect: number): string {
	const y = (value: number): number => value * SIZE * aspect
	const x = (value: number): number => value * SIZE

	return (
		`M 0 0 C ${pt(x(0.1), y(-0.35))} ${pt(x(0.55), y(-0.25))} ${pt(x(0.5), y(0.1))} ` +
		`C ${pt(x(0.45), y(0.4))} ${pt(x(0.1), y(0.55))} ${pt(0, y(0.75))} ` +
		`C ${pt(x(-0.1), y(0.55))} ${pt(x(-0.45), y(0.4))} ${pt(x(-0.5), y(0.1))} ` +
		`C ${pt(x(-0.55), y(-0.25))} ${pt(x(-0.1), y(-0.35))} 0 0 Z E`
	)
}

function loop(aspect: number): string {
	const y = (value: number): number => value * aspect

	return `M 0 0 C ${pt(0.15, 0)} ${pt(0.2, y(-0.12))} ${pt(0.12, y(-0.12))} C ${pt(0.04, y(-0.12))} ${pt(0.06, 0)} ${pt(0.25, 0)} E`
}

// Down through two loops and back up through them on the other side.
function figureEight(aspect: number): string {
	const y = (value: number): number => value * aspect
	const r = 0.06

	return (
		`M 0 0 C ${pt(r, 0)} ${pt(r, y(0.1))} ${pt(0, y(0.1))} C ${pt(-r, y(0.1))} ${pt(-r, y(0.2))} ${pt(0, y(0.2))} ` +
		`C ${pt(r, y(0.2))} ${pt(r, y(0.1))} ${pt(0, y(0.1))} C ${pt(-r, y(0.1))} ${pt(-r, 0)} 0 0 Z E`
	)
}

interface PathSpec {
	readonly id: number
	readonly name: string
	readonly group: PresetGroup
	readonly path: (aspect: number) => string
	readonly durationMs?: number
}

const PATHS: readonly PathSpec[] = [
	{ id: 63, name: "Right", group: "lines", path: line(SIZE, 0) },
	{ id: 35, name: "Left", group: "lines", path: line(-SIZE, 0) },
	{ id: 42, name: "Down", group: "lines", path: line(0, SIZE) },
	{ id: 64, name: "Up", group: "lines", path: line(0, -SIZE) },
	{ id: 49, name: "DiagonalDownRight", group: "lines", path: line(SIZE * 0.8, SIZE * 0.8) },
	{ id: 56, name: "DiagonalUpRight", group: "lines", path: line(SIZE * 0.8, -SIZE * 0.8) },
	{ id: 37, name: "ArcDown", group: "arcs", path: arc(SIZE, 0, 0, SIZE / 2) },
	{ id: 44, name: "ArcUp", group: "arcs", path: arc(SIZE, 0, 0, -SIZE / 2) },
	{ id: 51, name: "ArcLeft", group: "arcs", path: arc(0, SIZE, -SIZE / 2, 0) },
	{ id: 58, name: "ArcRight", group: "arcs", path: arc(0, SIZE, SIZE / 2, 0) },
	{ id: 36, name: "TurnDownRight", group: "turns", path: turn([0, 1], [1, 0]) },
	{ id: 43, name: "TurnUp", group: "turns", path: turn([1, 0], [0, -1]) },
	{ id: 50, name: "TurnDown", group: "turns", path: turn([1, 0], [0, 1]) },
	{ id: 57, name: "TurnUpRight", group: "turns", path: turn([0, -1], [1, 0]) },
	{ id: 1, name: "Circle", group: "shapes", path: ellipse(SIZE / 2, SIZE / 2) },
	{ id: 12, name: "Oval", group: "shapes", path: ellipse(SIZE * 0.7, SIZE * 0.35) },
	{ id: 3, name: "Diamond", group: "shapes", path: polygon(ring(4)) },
	{ id: 4, name: "Hexagon", group: "shapes", path: polygon(ring(6)) },
	{ id: 5, name: "FivePointStar", group: "shapes", path: polygon(ring(5, 0.2)) },
	{
		id: 7,
		name: "Square",
		group: "shapes",
		path: polygon([
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1]
		])
	},
	{ id: 9, name: "Heart", group: "shapes", path: heart },
	{ id: 13, name: "Triangle", group: "shapes", path: polygon(ring(3)) },
	{ id: 24, name: "LoopDeLoop", group: "loops", path: loop },
	{ id: 22, name: "VerticalFigureEight", group: "loops", path: figureEight }
]

export const PATH_PRESETS: readonly EffectPreset[] = PATHS.map((spec): EffectPreset => ({
	presetClass: "path",
	id: spec.id,
	name: spec.name,
	group: spec.group,
	subtypes: [],
	durationMs: spec.durationMs ?? 2000,
	build: ({ target, durationMs, aspect }) => [motion(target, spec.path(aspect), durationMs)]
}))
