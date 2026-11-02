import type { DrawingList } from "../displayList"
import { EMU_PER_PX } from "../reader"
import {
	BUILTIN_COUNT,
	GEOM_COMMAND_ARITY,
	GeomCommand,
	GuideOp,
	OP_BY_FORMULA,
	PATH_FILL_MASK,
	PATH_NO_STROKE,
	PathFill,
	builtinIndex,
	fillBuiltins,
	opArity,
	parseProgram,
	type GeometryProgram
} from "./program"
import { PRESET_GEOMETRY } from "./presets.generated"

const TO_RADIANS = Math.PI / (180 * 60000)
const CIRCLE = 21600000

const compiled = new Map<string, GeometryProgram | null>()

// The compiled program of a preset (ST_ShapeType), or undefined for unknown names. Compiled once.
export function presetProgram(name: string): GeometryProgram | undefined {
	let program = compiled.get(name)

	if (program === undefined) {
		const encoded = Object.hasOwn(PRESET_GEOMETRY, name) ? PRESET_GEOMETRY[name] : undefined

		program = encoded === undefined ? null : parseProgram(encoded)
		compiled.set(name, program)
	}

	return program ?? undefined
}

export function presetNames(): string[] {
	return Object.keys(PRESET_GEOMETRY)
}

function finite(value: number): number {
	return Number.isFinite(value) ? value : 0
}

function operand(program: GeometryProgram, slots: Float64Array, arg: number): number {
	return arg >= 0 ? (slots[arg] ?? 0) : (program.literals[-1 - arg] ?? 0)
}

// Evaluates one guide formula.
export function evaluateOp(op: number, x: number, y: number, z: number): number {
	switch (op) {
		case GuideOp.VAL:
			return x
		case GuideOp.MUL_DIV:
			return z === 0 ? 0 : (x * y) / z
		case GuideOp.ADD_SUB:
			return x + y - z
		case GuideOp.ADD_DIV:
			return z === 0 ? 0 : (x + y) / z
		case GuideOp.IF_ELSE:
			return x > 0 ? y : z
		case GuideOp.ABS:
			return Math.abs(x)
		case GuideOp.AT2:
			return Math.atan2(y, x) / TO_RADIANS
		case GuideOp.CAT2:
			return x * Math.cos(Math.atan2(z, y))
		case GuideOp.COS:
			return x * Math.cos(y * TO_RADIANS)
		case GuideOp.MAX:
			return Math.max(x, y)
		case GuideOp.MIN:
			return Math.min(x, y)
		case GuideOp.MOD:
			return Math.sqrt(x * x + y * y + z * z)
		case GuideOp.PIN:
			return y < x ? x : y > z ? z : y
		case GuideOp.SAT2:
			return x * Math.sin(Math.atan2(z, y))
		case GuideOp.SIN:
			return x * Math.sin(y * TO_RADIANS)
		case GuideOp.SQRT:
			return x < 0 ? 0 : Math.sqrt(x)
		case GuideOp.TAN:
			return x * Math.tan(y * TO_RADIANS)
		default:
			return 0
	}
}

// Every slot of a program for a shape of w x h EMU. `adjust` overrides adjust values by name (a:avLst on
// the shape); it is called with the built-ins already set, so overrides may use them.
export function evaluateGuides(
	program: GeometryProgram,
	w: number,
	h: number,
	adjust?: (name: string, slots: Float64Array) => number | undefined
): Float64Array {
	const slots = new Float64Array(program.slotCount)

	fillBuiltins(slots, w, h)

	for (let k = 0; k < program.adjustNames.length; k++) {
		const override = adjust?.(program.adjustNames[k] ?? "", slots)

		slots[BUILTIN_COUNT + k] = override === undefined ? (program.adjustDefaults[k] ?? 0) : finite(override)
	}

	const first = BUILTIN_COUNT + program.adjustNames.length
	const guides = program.guides

	for (let g = 0; g < program.guideCount; g++) {
		const at = g * 4

		slots[first + g] = finite(
			evaluateOp(
				guides[at] ?? 0,
				operand(program, slots, guides[at + 1] ?? 0),
				operand(program, slots, guides[at + 2] ?? 0),
				operand(program, slots, guides[at + 3] ?? 0)
			)
		)
	}

	return slots
}

// Adjust overrides from a:avLst formulas by guide name (usually "val n"; built-ins and earlier adjust values may
// appear), for evaluateGuides.
export function formulaAdjust(
	formulas: ReadonlyMap<string, string>,
	program: GeometryProgram
): (name: string, slots: Float64Array) => number | undefined {
	return (name, slots) => {
		const formula = formulas.get(name)

		if (formula === undefined) return undefined

		const [opName, ...args] = formula.trim().split(/\s+/)
		const op = OP_BY_FORMULA.get(opName ?? "")

		if (op === undefined) return undefined

		const value = (token: string | undefined): number => {
			if (token === undefined) return 0

			const number = Number(token)

			if (token !== "" && Number.isFinite(number)) return number

			const builtin = builtinIndex(token)

			if (builtin >= 0) return slots[builtin] ?? 0

			const adjust = program.adjustNames.indexOf(token)

			return adjust >= 0 ? (slots[BUILTIN_COUNT + adjust] ?? 0) : 0
		}
		const arity = opArity(op)

		return evaluateOp(op, value(args[0]), arity > 1 ? value(args[1]) : 0, arity > 2 ? value(args[2]) : 0)
	}
}

// The text rectangle in px: [left, top, right, bottom].
export function textRect(program: GeometryProgram, slots: Float64Array, w: number, h: number): [number, number, number, number] {
	const rect = program.rect

	if (rect === null) return [0, 0, w / EMU_PER_PX, h / EMU_PER_PX]

	return [
		operand(program, slots, rect[0] ?? 0) / EMU_PER_PX,
		operand(program, slots, rect[1] ?? 0) / EMU_PER_PX,
		operand(program, slots, rect[2] ?? 0) / EMU_PER_PX,
		operand(program, slots, rect[3] ?? 0) / EMU_PER_PX
	]
}

// One emitted geometry path: the commands [firstCommand, list.commandCount at the next path) and how to
// paint it.
export interface GeometryPath {
	readonly firstCommand: number
	readonly firstCoord: number
	readonly commandCount: number
	readonly fill: number
	readonly stroke: boolean
	// The path is open (no close), so line ends get arrowheads.
	readonly open: boolean
}

// The visual angle `angle` (as DrawingML measures it: the direction of the ray from the centre) of an
// ellipse with radii rx, ry as the parametric angle.
function parametric(angle: number, rx: number, ry: number): number {
	return Math.atan2(rx * Math.sin(angle), ry * Math.cos(angle))
}

// Appends cubic segments for a:arcTo from the current point (x, y); returns the end point. The angles are measured
// on the arc as the path's own coordinates draw it (radii pathRx, pathRy), before the path is scaled to the shape.
export function appendArc(
	list: DrawingList,
	x: number,
	y: number,
	rx: number,
	ry: number,
	start: number,
	sweep: number,
	end: [number, number],
	pathRx = rx,
	pathRy = ry
): void {
	end[0] = x
	end[1] = y

	if (sweep === 0 || (rx === 0 && ry === 0)) return

	const startRadians = start * TO_RADIANS
	const sweepRadians = Math.max(-CIRCLE, Math.min(CIRCLE, sweep)) * TO_RADIANS
	const t0 = parametric(startRadians, pathRx, pathRy)
	let delta: number

	if (Math.abs(sweepRadians) >= 2 * Math.PI - 1e-9) {
		delta = Math.sign(sweepRadians) * 2 * Math.PI
	} else {
		delta = parametric(startRadians + sweepRadians, pathRx, pathRy) - t0

		if (sweepRadians > 0 && delta < 0) delta += 2 * Math.PI
		if (sweepRadians < 0 && delta > 0) delta -= 2 * Math.PI
	}

	const cx = x - rx * Math.cos(t0)
	const cy = y - ry * Math.sin(t0)
	const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9))
	const step = delta / segments
	const k = (4 / 3) * Math.tan(step / 4)
	let a = t0
	let endX = x
	let endY = y

	for (let s = 0; s < segments; s++) {
		const b = a + step
		const cosA = Math.cos(a)
		const sinA = Math.sin(a)
		const cosB = Math.cos(b)
		const sinB = Math.sin(b)

		endX = cx + rx * cosB
		endY = cy + ry * sinB
		list.cubicTo(
			cx + rx * (cosA - k * sinA),
			cy + ry * (sinA + k * cosA),
			cx + rx * (cosB + k * sinB),
			cy + ry * (sinB - k * cosB),
			endX,
			endY
		)
		a = b
	}

	end[0] = endX
	end[1] = endY
}

// Appends every path of the program for a w x h EMU shape, in local px (0..w/9525, 0..h/9525).
export function emitPaths(list: DrawingList, program: GeometryProgram, slots: Float64Array, w: number, h: number): GeometryPath[] {
	const out: GeometryPath[] = []
	const paths = program.paths
	const end: [number, number] = [0, 0]
	let scaleX = 1 / EMU_PER_PX
	let scaleY = 1 / EMU_PER_PX
	let x = 0
	let y = 0
	let startX = 0
	let startY = 0
	let firstCommand = -1
	let firstCoord = 0
	let flags = 0
	let open = true
	let hasStart = false
	const finish = (): void => {
		if (firstCommand < 0) return

		const commandCount = list.commandCount - firstCommand

		if (commandCount > 0) {
			out.push({
				firstCommand,
				firstCoord,
				commandCount,
				fill: flags & PATH_FILL_MASK,
				stroke: (flags & PATH_NO_STROKE) === 0,
				open
			})
		}

		firstCommand = -1
	}
	const value = (arg: number): number => operand(program, slots, arg)
	const ensureStart = (): void => {
		if (!hasStart) {
			list.moveTo(x, y)
			hasStart = true
		}
	}

	for (let k = 0; k < paths.length;) {
		const command = paths[k] ?? 0
		const arity = GEOM_COMMAND_ARITY[command] ?? 0
		const a1 = paths[k + 1] ?? 0
		const a2 = paths[k + 2] ?? 0

		switch (command) {
			case GeomCommand.PATH: {
				finish()

				const pathW = value(a2)
				const pathH = value(paths[k + 3] ?? 0)

				flags = value(a1)
				scaleX = pathW > 0 ? w / pathW / EMU_PER_PX : 1 / EMU_PER_PX
				scaleY = pathH > 0 ? h / pathH / EMU_PER_PX : 1 / EMU_PER_PX
				firstCommand = list.commandCount
				firstCoord = list.coordCount
				open = true
				hasStart = false
				x = y = 0

				break
			}
			case GeomCommand.MOVE:
				x = value(a1) * scaleX
				y = value(a2) * scaleY
				startX = x
				startY = y
				list.moveTo(x, y)
				hasStart = true
				break
			case GeomCommand.LINE:
				ensureStart()
				x = value(a1) * scaleX
				y = value(a2) * scaleY
				list.lineTo(x, y)
				break
			case GeomCommand.ARC:
				ensureStart()
				appendArc(
					list,
					x,
					y,
					Math.abs(value(a1) * scaleX),
					Math.abs(value(a2) * scaleY),
					value(paths[k + 3] ?? 0),
					value(paths[k + 4] ?? 0),
					end,
					Math.abs(value(a1)),
					Math.abs(value(a2))
				)
				x = end[0]
				y = end[1]
				break
			case GeomCommand.QUAD: {
				ensureStart()

				const ex = value(paths[k + 3] ?? 0) * scaleX
				const ey = value(paths[k + 4] ?? 0) * scaleY

				list.quadTo(value(a1) * scaleX, value(a2) * scaleY, ex, ey)
				x = ex
				y = ey

				break
			}
			case GeomCommand.CUBIC: {
				ensureStart()

				const ex = value(paths[k + 5] ?? 0) * scaleX
				const ey = value(paths[k + 6] ?? 0) * scaleY

				list.cubicTo(
					value(a1) * scaleX,
					value(a2) * scaleY,
					value(paths[k + 3] ?? 0) * scaleX,
					value(paths[k + 4] ?? 0) * scaleY,
					ex,
					ey
				)
				x = ex
				y = ey

				break
			}
			case GeomCommand.CLOSE:
				if (hasStart) list.close()

				open = false
				x = startX
				y = startY
				break
			default:
				break
		}

		k += 1 + arity
	}

	finish()

	return out
}

export { PathFill }
