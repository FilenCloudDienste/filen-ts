import { turn, type MorphBox, type MorphPath, type MorphVector } from "../../../../core/anim/morph"
import { DrawingList, PATH_COMMAND_COORDS, PathCommand, type Rgba } from "../../../../core/drawingml/displayList"
import { emitPaths, evaluateGuides } from "../../../../core/drawingml/geometry/evaluate"
import { parseProgram, PathFill, type GeometryProgram } from "../../../../core/drawingml/geometry/program"
import type { Affine } from "./device"

// A matched pair of plain shapes whose outlines morph: the same preset with its adjust values, size and paint
// interpolated and the outline evaluated again for every frame (a rounded rectangle's corners, an arrow's head), or
// custom geometry of the same command structure with its points interpolated. Drawn into a canvas at the frame's
// size, so the edge stays sharp; everything else mixes the two objects' bitmaps.

const EMU_PER_PX = 9525

export type VectorPlan =
	| {
			readonly kind: "preset"
			readonly program: GeometryProgram
			readonly from: ReadonlyMap<string, number>
			readonly to: ReadonlyMap<string, number>
	  }
	| { readonly kind: "custom"; readonly from: readonly MorphPath[]; readonly to: readonly MorphPath[] }

// One path of a frame, in the shape's local px (0..w, 0..h).
export interface VectorPath {
	readonly commands: Uint8Array
	readonly coords: Float32Array
	readonly fill: boolean
	readonly stroke: boolean
}

const programs = new Map<string, GeometryProgram>()

function programOf(encoded: string): GeometryProgram | undefined {
	let program = programs.get(encoded)

	if (program === undefined) {
		try {
			program = parseProgram(encoded)
		} catch {
			return undefined
		}

		programs.set(encoded, program)
	}

	return program
}

function samePaths(a: readonly MorphPath[], b: readonly MorphPath[]): boolean {
	if (a.length !== b.length || a.length === 0) return false

	return a.every((path, k) => {
		const other = b[k]

		if (other === undefined || other.fill !== path.fill || other.stroke !== path.stroke) return false
		if (other.commands.length !== path.commands.length || other.coords.length !== path.coords.length) return false

		return path.commands.every((command, n) => other.commands[n] === command)
	})
}

// Whether two shapes' outlines can morph point by point, and how; undefined: their bitmaps mix.
export function vectorPlan(from: MorphVector, to: MorphVector): VectorPlan | undefined {
	const a = from.geometry
	const b = to.geometry

	if (a.kind === "preset" && b.kind === "preset") {
		const program = a.program === b.program ? programOf(a.program) : undefined

		if (program === undefined) return undefined

		const plan: VectorPlan = { kind: "preset", program, from: new Map(a.adjust), to: new Map(b.adjust) }

		// Paths shaded lighter or darker (a cube's sides, a can's top) keep their bitmaps.
		return framePaths(plan, { w: 100, h: 100 }, 0).every(path => path !== undefined) ? plan : undefined
	}

	if (a.kind === "custom" && b.kind === "custom" && samePaths(a.paths, b.paths)) return { kind: "custom", from: a.paths, to: b.paths }

	return undefined
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t
}

// The paths at eased progress `t` for a box of `size` px; an entry is undefined where the preset shades a path.
export function framePaths(plan: VectorPlan, size: { readonly w: number; readonly h: number }, t: number): (VectorPath | undefined)[] {
	if (plan.kind === "custom") {
		return plan.from.map((path, k) => {
			const other = plan.to[k] ?? path
			const coords = new Float32Array(path.coords.length)

			for (let n = 0; n < coords.length; n += 2) {
				coords[n] = lerp(path.coords[n] ?? 0, other.coords[n] ?? 0, t) * size.w
				coords[n + 1] = lerp(path.coords[n + 1] ?? 0, other.coords[n + 1] ?? 0, t) * size.h
			}

			return { commands: path.commands, coords, fill: path.fill, stroke: path.stroke }
		})
	}

	const program = plan.program
	const w = size.w * EMU_PER_PX
	const h = size.h * EMU_PER_PX
	const slots = evaluateGuides(program, w, h, name => {
		const k = program.adjustNames.indexOf(name)
		const fallback = k < 0 ? 0 : (program.adjustDefaults[k] ?? 0)

		return lerp(plan.from.get(name) ?? fallback, plan.to.get(name) ?? fallback, t)
	})
	const list = new DrawingList()

	return emitPaths(list, program, slots, w, h).map(path => {
		if (path.fill !== PathFill.NORM && path.fill !== PathFill.NONE) return undefined

		return {
			commands: list.commands.slice(path.firstCommand, path.firstCommand + path.commandCount),
			coords: list.coords.slice(path.firstCoord, list.coordCount),
			fill: path.fill === PathFill.NORM,
			stroke: path.stroke
		}
	})
}

function mixColor(a: Rgba | undefined, b: Rgba | undefined, t: number): string | undefined {
	if (a === undefined && b === undefined) return undefined

	// A side without the paint has it fully transparent.
	const from = a ?? ((b ?? 0) & 0xffffff00) >>> 0
	const to = b ?? ((a ?? 0) & 0xffffff00) >>> 0
	const channel = (shift: number): number => Math.round(lerp((from >>> shift) & 255, (to >>> shift) & 255, t))

	return `rgba(${String(channel(24))},${String(channel(16))},${String(channel(8))},${String(channel(0) / 255)})`
}

function trace(ctx: CanvasRenderingContext2D, path: VectorPath): void {
	let at = 0

	ctx.beginPath()

	for (const command of path.commands) {
		const c = path.coords

		switch (command) {
			case PathCommand.MOVE:
				ctx.moveTo(c[at] ?? 0, c[at + 1] ?? 0)
				break
			case PathCommand.LINE:
				ctx.lineTo(c[at] ?? 0, c[at + 1] ?? 0)
				break
			case PathCommand.CUBIC:
				ctx.bezierCurveTo(c[at] ?? 0, c[at + 1] ?? 0, c[at + 2] ?? 0, c[at + 3] ?? 0, c[at + 4] ?? 0, c[at + 5] ?? 0)
				break
			case PathCommand.QUAD:
				ctx.quadraticCurveTo(c[at] ?? 0, c[at + 1] ?? 0, c[at + 2] ?? 0, c[at + 3] ?? 0)
				break
			case PathCommand.CLOSE:
				ctx.closePath()
				break
			default:
				break
		}

		at += PATH_COMMAND_COORDS[command] ?? 0
	}
}

// The interpolated box (slide px): centre, size, rotation, flips (a flip that changes turns through zero width).
export function vectorBox(from: MorphBox, to: MorphBox, t: number): { readonly w: number; readonly h: number; readonly place: Affine } {
	const w = lerp(from.w, to.w, t)
	const h = lerp(from.h, to.h, t)
	const cx = lerp(from.x + from.w / 2, to.x + to.w / 2, t)
	const cy = lerp(from.y + from.h / 2, to.y + to.h / 2, t)
	const rot = ((from.rot + turn(from.rot, to.rot) * t) * Math.PI) / 180
	const fx = lerp(from.flipH ? -1 : 1, to.flipH ? -1 : 1, t)
	const fy = lerp(from.flipV ? -1 : 1, to.flipV ? -1 : 1, t)
	const cos = Math.cos(rot)
	const sin = Math.sin(rot)
	// T(c) R S(f) T(-w/2, -h/2)
	const a = cos * fx
	const b = sin * fx
	const c = -sin * fy
	const d = cos * fy

	return { w, h, place: [a, b, c, d, cx - (a * w) / 2 - (c * h) / 2, cy - (b * w) / 2 - (d * h) / 2] }
}

// Draws the outline at `t` into `slot` of a 2D context (device px; `scale` device px per slide px), with a margin for
// the line, clipped to the slot; the local rectangle (slide px) it covers and its size in px are returned, undefined
// when it does not fit the slot or a path is shaded (the bitmaps mix instead).
export function drawVectorAt(
	ctx: CanvasRenderingContext2D,
	slot: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
	plan: VectorPlan,
	from: MorphVector,
	to: MorphVector,
	size: { readonly w: number; readonly h: number },
	t: number,
	scale: number
):
	| {
			readonly covers: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
			readonly w: number
			readonly h: number
	  }
	| undefined {
	const covers = vectorCovers(from, to, size, t)
	const width = lineWidth(from, to, t)
	const margin = -covers.x
	const pixelsW = Math.max(1, Math.ceil((size.w + 2 * margin) * scale))
	const pixelsH = Math.max(1, Math.ceil((size.h + 2 * margin) * scale))

	if (pixelsW > slot.w || pixelsH > slot.h) return undefined

	const paths = framePaths(plan, size, t)

	if (paths.some(path => path === undefined)) return undefined

	ctx.save()
	ctx.setTransform(1, 0, 0, 1, 0, 0)
	ctx.clearRect(slot.x, slot.y, slot.w, slot.h)
	ctx.beginPath()
	ctx.rect(slot.x, slot.y, slot.w, slot.h)
	ctx.clip()
	ctx.setTransform(scale, 0, 0, scale, slot.x + margin * scale, slot.y + margin * scale)

	const fill = mixColor(from.fill, to.fill, t)
	const line = mixColor(from.line?.color, to.line?.color, t)

	for (const path of paths) {
		if (path === undefined) continue

		trace(ctx, path)

		if (path.fill && fill !== undefined) {
			ctx.fillStyle = fill
			ctx.fill()
		}

		if (path.stroke && line !== undefined && width > 0) {
			ctx.strokeStyle = line
			ctx.lineWidth = width
			ctx.lineJoin = "round"
			ctx.stroke()
		}
	}

	ctx.restore()

	return { covers, w: pixelsW, h: pixelsH }
}

function lineWidth(from: MorphVector, to: MorphVector, t: number): number {
	return lerp(from.line?.width ?? to.line?.width ?? 0, to.line?.width ?? from.line?.width ?? 0, t)
}

// The local rectangle (slide px) drawVectorAt covers at `t`: the shape's box with a margin for its line.
function vectorCovers(
	from: MorphVector,
	to: MorphVector,
	size: { readonly w: number; readonly h: number },
	t: number
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
	const margin = lineWidth(from, to, t) / 2 + 2

	return { x: -margin, y: -margin, w: size.w + 2 * margin, h: size.h + 2 * margin }
}
