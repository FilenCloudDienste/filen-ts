import { DrawingList, PATH_COMMAND_COORDS, PathCommand } from "../../drawingml/displayList"
import { emitPaths, evaluateGuides } from "../../drawingml/geometry/evaluate"
import { parseProgram, type GeometryProgram } from "../../drawingml/geometry/program"
import { D, EMU_PER_PX, type DrawingReader } from "../../drawingml/reader"
import { FRAGMENT_INTS, FragmentInt, LINE_FLOATS, LINE_INTS, LineFloat, LineInt } from "../../text/displayList"
import type { DocxPageData, DocxTextStyle } from "../../docx/layout/index"
import { PRESET_TEXT_WARP } from "./warps.generated"

// WordArt text warps (a:prstTxWarp, §20.1.9.19; the presets of §20.1.10.76 ST_TextShapeType in their ECMA-376 annex L
// definitions). A warp's paths are evaluated in the text box. With two or more paths the text's extent (its lines'
// boxes) is mapped onto the first path (its top) and the last (its bottom); with one path the text sits on the path
// (its bottom edge on the point its horizontal centre reaches, turned to the path's direction there).
//
// The text painters place glyphs by one matrix per text page, so a warp is drawn as the affine map that fits it: exact
// for the straight-path presets (textPlain, textSlantUp/Down), through the paths' end points for curved ones, and
// for one path the tangent at the text's centre. Curved warps are reported as approximated.

export interface TextWarp {
	readonly preset: string
	// Adjust values written in a:avLst (a:gd fmla "val n").
	readonly adjust: ReadonlyMap<string, number>
}

export interface WarpFit {
	// Page px → page px, inside the text box.
	readonly matrix: readonly number[]
	// The warp bends the text; the matrix only fits it.
	readonly approximate: boolean
}

// Points per flattened curve segment: enough for a tangent and end points, bounded for hostile adjust values.
const CURVE_STEPS = 16
const MAX_POINTS = 4096

const compiled = new Map<string, GeometryProgram | null>()

function warpProgram(preset: string): GeometryProgram | undefined {
	let program = compiled.get(preset)

	if (program === undefined) {
		const encoded = Object.hasOwn(PRESET_TEXT_WARP, preset) ? PRESET_TEXT_WARP[preset] : undefined

		program = encoded === undefined ? null : parseProgram(encoded)
		compiled.set(preset, program)
	}

	return program ?? undefined
}

// The warp a body's a:bodyPr writes (`txBody` is p:txBody, dsp:txBody or a:txBody); undefined for none or textNoShape.
export function readTextWarp(reader: DrawingReader, txBody: number): TextWarp | undefined {
	const warp = reader.child(reader.child(txBody, D.A, "bodyPr"), D.A, "prstTxWarp")
	const preset = warp < 0 ? undefined : reader.attr(warp, "prst")

	if (preset === undefined || preset === "textNoShape") return undefined

	const adjust = new Map<string, number>()

	for (const gd of reader.children(reader.child(warp, D.A, "avLst"), D.A, "gd")) {
		const [op, value] = (reader.attr(gd, "fmla") ?? "").trim().split(/\s+/)
		const number = Number(value)

		if (op === "val" && value !== undefined && value !== "" && Number.isFinite(number))
			adjust.set(reader.attr(gd, "name") ?? "", number)
	}

	return { preset, adjust }
}

// The warp's paths in a w × h px box, each flattened to points (x, y pairs).
export function warpPaths(warp: TextWarp, width: number, height: number): Float64Array[] | undefined {
	const program = warpProgram(warp.preset)

	if (program === undefined || !(width > 0) || !(height > 0)) return undefined

	const w = width * EMU_PER_PX
	const h = height * EMU_PER_PX
	const slots = evaluateGuides(program, w, h, name => warp.adjust.get(name))
	const list = new DrawingList()
	const paths = emitPaths(list, program, slots, w, h)
	const out: Float64Array[] = []
	let budget = MAX_POINTS

	for (const path of paths) {
		const points: number[] = []
		let coord = path.firstCoord
		let x = 0
		let y = 0

		for (let k = 0; k < path.commandCount && points.length < budget * 2; k++) {
			const command = list.commands[path.firstCommand + k] ?? PathCommand.CLOSE
			const at = (offset: number): number => list.coords[coord + offset] ?? 0

			if (command === PathCommand.MOVE || command === PathCommand.LINE) {
				x = at(0)
				y = at(1)
				points.push(x, y)
			} else if (command === PathCommand.CUBIC || command === PathCommand.QUAD) {
				const cubic = command === PathCommand.CUBIC
				const [x1, y1, x2, y2, x3, y3] = cubic
					? [at(0), at(1), at(2), at(3), at(4), at(5)]
					: [at(0), at(1), at(0), at(1), at(2), at(3)]

				for (let step = 1; step <= CURVE_STEPS; step++) {
					const t = step / CURVE_STEPS
					const u = 1 - t

					if (cubic) {
						points.push(
							u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
							u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
						)
					} else {
						points.push(u * u * x + 2 * u * t * x1 + t * t * x3, u * u * y + 2 * u * t * y1 + t * t * y3)
					}
				}

				x = x3
				y = y3
			}

			coord += PATH_COMMAND_COORDS[command] ?? 0
		}

		budget -= points.length / 2

		if (points.length >= 4) out.push(Float64Array.from(points))
	}

	return out.length === 0 ? undefined : out
}

// The text's extent in page px: its lines' horizontal extent, from the tallest ascent above the first line's baseline
// to the deepest descent below the last's (the fonts' own metrics, not the line spacing; lines with content, all lines
// when none has).
export function textExtent(page: DocxPageData, styles: readonly DocxTextStyle[]): [number, number, number, number] | undefined {
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity

	for (const filled of [true, false]) {
		for (let line = 0; line < page.lineCount; line++) {
			const first = page.lineInts[line * LINE_INTS + LineInt.FIRST_FRAGMENT] ?? 0
			const count = page.lineInts[line * LINE_INTS + LineInt.FRAGMENT_COUNT] ?? 0

			if (filled && count === 0) continue

			const top = page.lineFloats[line * LINE_FLOATS + LineFloat.TOP] ?? 0
			const height = page.lineFloats[line * LINE_FLOATS + LineFloat.HEIGHT] ?? 0
			const baseline = page.lineFloats[line * LINE_FLOATS + LineFloat.BASELINE] ?? 0
			const x = page.lineFloats[line * LINE_FLOATS + LineFloat.X] ?? 0
			const width = page.lineFloats[line * LINE_FLOATS + LineFloat.WIDTH] ?? 0
			let ascent = 0
			let descent = 0

			for (let fragment = first; fragment < first + count; fragment++) {
				const style = styles[page.fragmentInts[fragment * FRAGMENT_INTS + FragmentInt.STYLE] ?? -1]

				if (style === undefined) continue

				ascent = Math.max(ascent, style.ascent + style.shift)
				descent = Math.max(descent, style.descent - style.shift)
			}

			x0 = Math.min(x0, x)
			x1 = Math.max(x1, x + width)
			y0 = Math.min(y0, ascent > 0 ? baseline - ascent : top)
			y1 = Math.max(y1, descent > 0 ? baseline + descent : top + height)
		}

		if (x1 > x0 && y1 > y0) return [x0, y0, x1, y1]
	}

	return undefined
}

function straight(points: Float64Array): boolean {
	const n = points.length / 2

	if (n <= 2) return true

	const x0 = points[0] ?? 0
	const y0 = points[1] ?? 0
	const dx = (points[points.length - 2] ?? 0) - x0
	const dy = (points[points.length - 1] ?? 0) - y0
	const length = Math.hypot(dx, dy)

	if (length === 0) return false

	for (let k = 1; k < n - 1; k++) {
		const distance = Math.abs(((points[k * 2] ?? 0) - x0) * dy - ((points[k * 2 + 1] ?? 0) - y0) * dx) / length

		if (distance > length * 1e-3) return false
	}

	return true
}

// The point `fraction` of the way along a polyline.
function along(points: Float64Array, fraction: number): [number, number] {
	const n = points.length / 2
	let total = 0

	for (let k = 1; k < n; k++)
		total += Math.hypot((points[k * 2] ?? 0) - (points[k * 2 - 2] ?? 0), (points[k * 2 + 1] ?? 0) - (points[k * 2 - 1] ?? 0))

	let remaining = Math.min(1, Math.max(0, fraction)) * total

	for (let k = 1; k < n; k++) {
		const ax = points[k * 2 - 2] ?? 0
		const ay = points[k * 2 - 1] ?? 0
		const dx = (points[k * 2] ?? 0) - ax
		const dy = (points[k * 2 + 1] ?? 0) - ay
		const length = Math.hypot(dx, dy)

		if (length > 0 && (remaining <= length || k === n - 1)) {
			const t = Math.min(1, remaining / length)

			return [ax + dx * t, ay + dy * t]
		}

		remaining -= length
	}

	return [points[0] ?? 0, points[1] ?? 0]
}

// The affine map drawing `page`'s text (its fragments styled by `styles`) warped in its width × height px text box; undefined when the warp is unknown
// or there is no text to place.
export function fitTextWarp(
	warp: TextWarp,
	page: DocxPageData,
	styles: readonly DocxTextStyle[],
	width: number,
	height: number
): WarpFit | undefined {
	const paths = warpPaths(warp, width, height)
	const extent = textExtent(page, styles)

	if (paths === undefined || extent === undefined) return undefined

	const [x0, y0, x1, y1] = extent
	const tw = x1 - x0
	const th = y1 - y0

	if (paths.length === 1) {
		const path = paths[0] ?? new Float64Array(0)
		const fraction = (x0 + x1) / 2 / width
		const [px, py] = along(path, fraction)
		// The direction across a short stretch around the point, not one flattened segment's.
		const [ax, ay] = along(path, fraction - 0.01)
		const [bx, by] = along(path, fraction + 0.01)
		const angle = Math.atan2(by - ay, bx - ax)
		const cos = Math.cos(angle)
		const sin = Math.sin(angle)
		// The text's bottom centre onto the point, turned to the path's direction there.
		const cx = (x0 + x1) / 2

		return {
			matrix: [cos, sin, -sin, cos, px - (cos * cx - sin * y1), py - (sin * cx + cos * y1)],
			approximate: !straight(path)
		}
	}

	const top = paths[0] ?? new Float64Array(0)
	const bottom = paths[paths.length - 1] ?? new Float64Array(0)
	const t0x = top[0] ?? 0
	const t0y = top[1] ?? 0
	const t1x = top[top.length - 2] ?? 0
	const t1y = top[top.length - 1] ?? 0
	const b0x = bottom[0] ?? 0
	const b0y = bottom[1] ?? 0
	const b1x = bottom[bottom.length - 2] ?? 0
	const b1y = bottom[bottom.length - 1] ?? 0
	// The left edge's direction, averaged with the right's so a trapezoid maps to its mean parallelogram.
	const ex = (b0x - t0x + (b1x - t1x)) / 2
	const ey = (b0y - t0y + (b1y - t1y)) / 2
	const ux = (t1x - t0x + (b1x - b0x)) / 2
	const uy = (t1y - t0y + (b1y - b0y)) / 2
	const ox = (t0x + b0x) / 2 - ex / 2
	const oy = (t0y + b0y) / 2 - ey / 2
	const a = ux / tw
	const b = uy / tw
	const c = ex / th
	const d = ey / th
	const parallel =
		Math.abs(t1x - t0x - (b1x - b0x)) + Math.abs(t1y - t0y - (b1y - b0y)) <= (Math.hypot(ux, uy) + Math.hypot(ex, ey)) * 1e-3

	return {
		matrix: [a, b, c, d, ox - a * x0 - c * y0, oy - b * x0 - d * y0],
		approximate: !(parallel && straight(top) && straight(bottom))
	}
}
