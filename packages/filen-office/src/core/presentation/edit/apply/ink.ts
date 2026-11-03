import { DEFAULT_PRESENTATION_BUDGETS } from "../../budget"
import {
	PATH_LINE,
	PATH_MOVE,
	refused,
	type ColorModel,
	type CustomPath,
	type Deck,
	type LineProps,
	type Refused,
	type ShapeNode
} from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Touch } from "../apply"
import type { InkOp, ShapeOp } from "../ops"
import { xmlSafeText } from "../xmlText"
import { applyShape } from "./shape"
import { isRefused } from "../../refusal"

// Ink kept after a slideshow: one group named by the page (from the locale) holding one freeform per stroke, each a
// custom outline through the stroke's points with no fill and a round-capped, round-joined line (a highlighter's
// at half opacity). The group goes in through the shape family's insert, so its inverse is that insert's (a delete
// of the group) and the writers see a new grpSp of custom-geometry sp's.

const BUDGETS = DEFAULT_PRESENTATION_BUDGETS
const HIGHLIGHTER_ALPHA = 50_000
const RGB = /^[0-9A-Fa-f]{6}$/u

// A stroke's outline in slide EMU: its bbox and its points relative to it, rounded (the writers write whole EMU and
// gate 2 compares the model with what the file reads back). The path fills "norm" as ODF reads an svg:d path back;
// the shape's own fill is none.
interface Freeform {
	readonly x: number
	readonly y: number
	readonly cx: number
	readonly cy: number
	readonly path: CustomPath
}

// The least extent of a stroke's box on either axis, 0.1 mm: a straight stroke along an axis, or a dot (a stroke that
// never left its point), keeps its points centred in it. A box of almost no extent is drawn at the wrong scale by
// LibreOffice (it reads svg:d in raw view-box units when svg:width or svg:height rounds to 0), and a line of no
// length or of its 0.01 mm unit is not painted: a dot is a line across the box's middle, which its round caps draw
// as a disc of the stroke's width.
const LEAST = 3600

function freeform(points: Float64Array): Freeform {
	const coords = new Float64Array(points.length)
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity

	for (let k = 0; k < points.length; k += 2) {
		const x = Math.round(points[k] as number)
		const y = Math.round(points[k + 1] as number)

		coords[k] = x
		coords[k + 1] = y

		if (x < minX) minX = x
		if (x > maxX) maxX = x
		if (y < minY) minY = y
		if (y > maxY) maxY = y
	}

	const x = minX - Math.floor(Math.max(0, LEAST - (maxX - minX)) / 2)
	const y = minY - Math.floor(Math.max(0, LEAST - (maxY - minY)) / 2)
	const cx = Math.max(LEAST, maxX - minX)
	const cy = Math.max(LEAST, maxY - minY)
	const path = { w: cx, h: cy, fill: "norm", stroke: true, extrusionOk: false } as const

	if (minX === maxX && minY === maxY) {
		const middle = minY - y

		return {
			x,
			y,
			cx,
			cy,
			path: { ...path, commands: new Uint8Array([PATH_MOVE, PATH_LINE]), coords: new Float64Array([0, middle, cx, middle]) }
		}
	}

	for (let k = 0; k < coords.length; k += 2) {
		coords[k] = (coords[k] as number) - x
		coords[k + 1] = (coords[k + 1] as number) - y
	}

	const commands = new Uint8Array(coords.length / 2).fill(PATH_LINE)

	commands[0] = PATH_MOVE

	return { x, y, cx, cy, path: { ...path, commands, coords } }
}

function strokeColor(color: ColorModel, highlighter: boolean): ColorModel {
	const own = color.kind === "srgb" ? { ...color, rgb: color.rgb.toUpperCase() } : color

	if (!highlighter || own.mods?.some(mod => mod.name === "alpha") === true) return own

	return { ...own, mods: [...(own.mods ?? []), { name: "alpha", value: HIGHLIGHTER_ALPHA }] }
}

// Points the slide's custom outlines already hold (ink kept before counts against the same budget).
function heldPoints(shapes: readonly ShapeNode[]): number {
	let total = 0

	for (const shape of shapes) {
		const geometry = shape.props?.geometry

		if (geometry?.kind === "custom") for (const path of geometry.paths) total += path.coords.length / 2
		if (shape.children !== undefined) total += heldPoints(shape.children)
	}

	return total
}

function collectIds(shapes: readonly ShapeNode[], into: Set<number>): void {
	for (const shape of shapes) {
		into.add(shape.id)
		if (shape.children !== undefined) collectIds(shape.children, into)
	}
}

// Why the deck cannot carry the strokes, or undefined: points in x, y pairs of finite numbers, a positive width, a
// colour the format writes (ODF: sRGB with an alpha only), within the per-path and per-slide ink budgets.
function invalid(deck: Deck, op: InkOp, held: readonly ShapeNode[]): Refused | undefined {
	if (op.strokes.length === 0) return refused("malformed", "ink without strokes")
	if (xmlSafeText(op.name) !== op.name) return refused("malformed", "an ink name XML cannot carry")

	let points = 0

	for (const stroke of op.strokes) {
		const length = stroke.points.length

		if (length < 2 || length % 2 !== 0) return refused("malformed", "a stroke's points are not x, y pairs")
		if (length / 2 > BUDGETS.pathCommandsPerShape) return refused("tooLarge", `${String(length / 2)} points in one stroke`)

		for (let k = 0; k < length; k++) if (!Number.isFinite(stroke.points[k])) return refused("malformed", "a stroke point is not finite")

		if (!Number.isFinite(stroke.width) || stroke.width <= 0) return refused("malformed", "a stroke width")

		const color = stroke.color

		if (color.kind === "srgb" && !RGB.test(color.rgb)) return refused("malformed", `colour ${color.rgb}`)
		if (deck.format === "odp" && (color.kind !== "srgb" || color.mods?.some(mod => mod.name !== "alpha") === true))
			return refused("unsupported", "an ink colour ODF cannot write")

		points += length / 2
	}

	if (points + heldPoints(held) > BUDGETS.inkPointsPerSlide) return refused("tooLarge", "ink points on the slide")

	return undefined
}

function applyInkOp(deck: Deck, op: InkOp, context: ApplyContext): ApplyResult<InkOp> {
	const node = deck.nodes.get(op.slide)

	if (node === undefined) return refused("notFound", `slide ${String(op.slide)} is not parsed`)

	const bad = invalid(deck, op, node.shapes)

	if (bad !== undefined) return bad

	// Ids in order from the slide's next free one, so a redo (the group's id filled in) on the slide as it was gives
	// every stroke the id it had, and later ops in history still name them.
	const used = new Set<number>()

	collectIds(node.shapes, used)

	const id = op.id !== undefined && op.id > 0 && !used.has(op.id) ? op.id : context.newShapeId(node.ref)

	used.add(id)

	let next = Math.max(id, context.newShapeId(node.ref))
	const fresh = (): number => {
		while (used.has(next)) next++
		used.add(next)

		return next
	}
	const children: ShapeNode[] = []
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity

	for (const [index, stroke] of op.strokes.entries()) {
		const outline = freeform(stroke.points)
		const ln: LineProps = {
			w: Math.max(1, Math.round(stroke.width)),
			fill: { kind: "solid", color: strokeColor(stroke.color, stroke.highlighter) },
			cap: "rnd",
			join: "round"
		}

		minX = Math.min(minX, outline.x)
		minY = Math.min(minY, outline.y)
		maxX = Math.max(maxX, outline.x + outline.cx)
		maxY = Math.max(maxY, outline.y + outline.cy)
		children.push({
			id: fresh(),
			name: `${op.name} ${String(index + 1)}`,
			hidden: false,
			kind: "sp",
			ink: true,
			xfrm: { x: outline.x, y: outline.y, cx: outline.cx, cy: outline.cy, rot: 0, flipH: false, flipV: false },
			props: {
				geometry: { kind: "custom", guides: [], paths: [outline.path], textRect: { l: "l", t: "t", r: "r", b: "b" } },
				fill: "none",
				ln
			}
		})
	}

	const cx = maxX - minX
	const cy = maxY - minY
	const group: ShapeNode = {
		id,
		name: op.name,
		hidden: false,
		kind: "grpSp",
		xfrm: { x: minX, y: minY, cx, cy, rot: 0, flipH: false, flipV: false, chX: minX, chY: minY, chCx: cx, chCy: cy },
		children
	}
	const insert: ShapeOp = { family: "shape", kind: "insert", slide: op.slide, shape: group }
	const result = applyShape.apply(deck, insert, context)

	if (isRefused(result)) return result

	return { kind: "applied", inverse: result.inverse, op: { ...op, id } }
}

// The group, by the id the op holds once applied (0 before: the slide is still named, so it is parsed first).
function inkTouches(op: InkOp): readonly Touch[] {
	return [{ kind: "shape", slide: op.slide, shape: op.id ?? 0, dirt: { kind: "node" } }]
}

export const applyInk: ApplyFamily<InkOp> = {
	apply: applyInkOp,
	touches: inkTouches
}
