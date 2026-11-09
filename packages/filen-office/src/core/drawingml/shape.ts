import type { XmlDocument } from "../xml/index"
import { readColor, colorChild } from "./color"
import { DrawingList, IDENTITY, ItemFlag, ItemKind, PathCommand, boxMatrix, multiply, type Rgba, type TextBodyProps } from "./displayList"
import {
	GROUP_PAINT,
	NO_PAINT,
	fillChild,
	readFillElement,
	shapeEffects,
	shapeFill,
	shapeLine,
	shapeShadow,
	styleRef,
	type LineEnd,
	type LineStyle,
	type PaintContext,
	type StyleRef
} from "./fill"
import { compileCustomGeometry } from "./geometry/custom"
import { emitPaths, evaluateGuides, formulaAdjust, presetProgram, textRect, type GeometryPath } from "./geometry/evaluate"
import type { GeometryProgram } from "./geometry/program"
import { readBlip } from "./picture"
import { D, EMU_PER_PX, drawingReader, type DrawingReader } from "./reader"
import { DEFAULT_TEXT, readBodyProps, readTextBody, resolveTypeface, type TextDefaults } from "./text"

// DrawingML shape trees (§20.1.2.2, §20.5 wps/wpg, §20.4 pictures, the dsp: SmartArt drawing) to the display
// list. Shapes, pictures, connectors and groups (nested, with child coordinate systems) are converted; graphic
// frames (at the top of a shape tree, or inside groups) are drawn by the host's frame hook, else counted as
// unsupported.

export interface ShapeContext extends PaintContext {
	// Maps a w:txbxContent node to the host's story reference (WordprocessingML text boxes).
	readonly story?: (txbxContent: number) => number
	// Maps an a:txBody node to the host's story reference when the host lays the text out itself (presentation
	// text): the body then becomes a story item over the same text rectangle, never laid out here. Undefined
	// keeps the body as DrawingML text.
	readonly body?: (txBody: number) => number | undefined
	// Run properties DrawingML text falls back to before the shape's font reference applies.
	readonly text?: TextDefaults
	// Draws a graphic frame inside a group (a chart) into `list`, placed by `matrix` (the frame's px to the list's), at
	// `width` x `height` EMU; false when it drew nothing (the frame then counts as unsupported).
	readonly frame?: (
		reader: DrawingReader,
		node: number,
		list: DrawingList,
		matrix: readonly number[],
		width: number,
		height: number
	) => boolean
}

export interface ShapeConversion {
	readonly list: DrawingList
	// w:txbxContent nodes of text boxes, in drawing order.
	readonly textboxes: number[]
	// Elements that were skipped because they are not supported (graphic frames inside groups, ink).
	readonly unsupported: number
	// Effects of nested elements (group children) that are not drawn: all but each one's first outer shadow.
	readonly childEffects: number
}

// Nesting of groups (and alternate content) drawn; Office itself nests far less.
export const MAX_DEPTH = 128

const SHAPES: ReadonlySet<string> = new Set(["wsp", "sp", "cxnSp"])
const GROUPS: ReadonlySet<string> = new Set(["wgp", "grpSp", "lockedCanvas", "wpc"])
// xdr: a sheet's drawing part (§20.5), whose pictures, shapes and groups are its own elements.
// p: a slide's shape tree (§19.3.1), the same elements in PresentationML.
const SHAPE_GROUPS: ReadonlySet<D> = new Set([D.Wps, D.Wpg, D.Wpc, D.Pic, D.Dsp, D.A, D.Lc, D.Xdr, D.P])

// Placement of child coordinates: a child at EMU (x, y) lands at (offsetX + x * scaleX, ...) EMU in the
// parent's local frame; `matrix` maps that frame (in px) into the drawing.
interface Frame {
	readonly matrix: readonly number[]
	readonly scaleX: number
	readonly scaleY: number
	readonly offsetX: number
	readonly offsetY: number
	// The parent's local extent (EMU), which an element without an xfrm fills.
	readonly width: number
	readonly height: number
	readonly groupFill: number
}

interface Xfrm {
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
	readonly rotation: number
	readonly flipH: boolean
	readonly flipV: boolean
	readonly childX: number
	readonly childY: number
	readonly childW: number
	readonly childH: number
}

function readXfrm(reader: DrawingReader, xfrm: number): Xfrm | undefined {
	if (xfrm < 0) return undefined

	const off = reader.child(xfrm, D.A, "off")
	const ext = reader.child(xfrm, D.A, "ext")
	const childOff = reader.child(xfrm, D.A, "chOff")
	const childExt = reader.child(xfrm, D.A, "chExt")
	const w = reader.emu(ext, "cx", 0)
	const h = reader.emu(ext, "cy", 0)

	return {
		x: reader.emu(off, "x", 0),
		y: reader.emu(off, "y", 0),
		w,
		h,
		rotation: reader.angle(xfrm, "rot", 0),
		flipH: reader.bool(xfrm, "flipH", false),
		flipV: reader.bool(xfrm, "flipV", false),
		childX: reader.emu(childOff, "x", 0),
		childY: reader.emu(childOff, "y", 0),
		childW: childExt < 0 ? w : reader.emu(childExt, "cx", w),
		childH: childExt < 0 ? h : reader.emu(childExt, "cy", h)
	}
}

// The properties child (spPr, grpSpPr) of a shape in whichever namespace the shape uses.
function propertiesOf(reader: DrawingReader, node: number, local: string): number {
	const document = reader.document

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === local && SHAPE_GROUPS.has(reader.group(child))) return child
	}

	return -1
}

// Non-visual properties (cNvPr) under nvSpPr/nvPicPr/nvGrpSpPr, or directly (wps:cNvPr).
function hidden(reader: DrawingReader, node: number): boolean {
	const document = reader.document

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "cNvPr") return reader.bool(child, "hidden", false)
		if (local.startsWith("nv") && local.endsWith("Pr")) {
			const cNvPr = propertiesOf(reader, child, "cNvPr")

			if (cNvPr >= 0) return reader.bool(cNvPr, "hidden", false)
		}
	}

	return false
}

// The shape's a:avLst overrides as an adjust function.
function adjustOverride(
	reader: DrawingReader,
	avLst: number,
	program: GeometryProgram
): ((name: string, slots: Float64Array) => number | undefined) | undefined {
	const overrides = reader.children(avLst, D.A, "gd")

	if (overrides.length === 0) return undefined

	const formulas = new Map<string, string>()

	for (const gd of overrides) formulas.set(reader.attr(gd, "name") ?? "", reader.attr(gd, "fmla") ?? "")

	return formulaAdjust(formulas, program)
}

// The geometry of a shape's properties: a:prstGeom (unknown presets draw as rectangles) or a:custGeom.
export function shapeGeometry(
	reader: DrawingReader,
	spPr: number
): { readonly program: GeometryProgram; readonly adjust: ((name: string, slots: Float64Array) => number | undefined) | undefined } {
	const custom = reader.child(spPr, D.A, "custGeom")

	if (custom >= 0) return { program: compileCustomGeometry(reader, custom), adjust: undefined }

	const preset = reader.child(spPr, D.A, "prstGeom")
	const program = presetProgram(reader.attr(preset, "prst") ?? "rect") ?? presetProgram("rect")

	if (program === undefined) throw new Error("The rect preset is missing")

	return { program, adjust: adjustOverride(reader, reader.child(preset, D.A, "avLst"), program) }
}

const FILL_FLAGS: readonly number[] = [0, 0, ItemFlag.LIGHTEN, ItemFlag.LIGHTEN_LESS, ItemFlag.DARKEN, ItemFlag.DARKEN_LESS]

// The tangent at either end of a path: [x, y, dx, dy] at the start (direction pointing away from the
// path) and at the end, or undefined for paths without two distinct points.
export function pathEnds(
	list: DrawingList,
	path: GeometryPath
): [number, number, number, number, number, number, number, number] | undefined {
	const { commands, coords } = list
	const points: number[] = []
	let at = path.firstCoord

	for (let k = path.firstCommand; k < path.firstCommand + path.commandCount; k++) {
		const command = commands[k]
		const count = command === PathCommand.CUBIC ? 6 : command === PathCommand.QUAD ? 4 : command === PathCommand.CLOSE ? 0 : 2

		for (let c = 0; c < count; c++) points.push(coords[at + c] ?? 0)

		at += count
	}

	if (points.length < 4) return undefined

	const sx = points[0] ?? 0
	const sy = points[1] ?? 0
	let nx = sx
	let ny = sy

	for (let k = 2; k < points.length && nx === sx && ny === sy; k += 2) {
		nx = points[k] ?? 0
		ny = points[k + 1] ?? 0
	}

	const ex = points[points.length - 2] ?? 0
	const ey = points[points.length - 1] ?? 0
	let px = ex
	let py = ey

	for (let k = points.length - 4; k >= 0 && px === ex && py === ey; k -= 2) {
		px = points[k] ?? 0
		py = points[k + 1] ?? 0
	}

	if (nx === sx && ny === sy) return undefined

	return [sx, sy, sx - nx, sy - ny, ex, ey, ex - px, ey - py]
}

// Appends an arrowhead at (x, y) pointing along (dx, dy) as decoration items in the line's colour.
export function addArrowhead(
	list: DrawingList,
	matrix: ArrayLike<number>,
	end: LineEnd,
	x: number,
	y: number,
	dx: number,
	dy: number,
	strokeIndex: number,
	source: number
): void {
	const stroke = list.strokes[strokeIndex]

	if (stroke === undefined) return

	const length = Math.hypot(dx, dy)

	if (length === 0) return

	const ux = dx / length
	const uy = dy / length
	const base = Math.max(stroke.width, 1)
	const halfWidth = (end.width * base) / 2
	const depth = end.length * base
	// Back corners and the point `depth` behind the tip.
	const bx = x - ux * depth
	const by = y - uy * depth
	const lx = bx - uy * halfWidth
	const ly = by + ux * halfWidth
	const rx = bx + uy * halfWidth
	const ry = by - ux * halfWidth
	const firstCommand = list.commandCount
	const firstCoord = list.coordCount
	let fill = stroke.paint
	let outline = -1

	switch (end.type) {
		case "triangle":
			list.moveTo(x, y)
			list.lineTo(lx, ly)
			list.lineTo(rx, ry)
			list.close()
			break
		case "stealth":
			list.moveTo(x, y)
			list.lineTo(lx, ly)
			list.lineTo(x - ux * depth * 0.6, y - uy * depth * 0.6)
			list.lineTo(rx, ry)
			list.close()
			break
		case "diamond": {
			// Centred on the end point, like the oval.
			const ax = (ux * depth) / 2
			const ay = (uy * depth) / 2

			list.moveTo(x + ax, y + ay)
			list.lineTo(x - uy * halfWidth, y + ux * halfWidth)
			list.lineTo(x - ax, y - ay)
			list.lineTo(x + uy * halfWidth, y - ux * halfWidth)
			list.close()

			break
		}
		case "oval": {
			// An ellipse centred on the end point, drawn as four quarter arcs.
			const k = 0.5522847498
			const ax = ux * (depth / 2)
			const ay = uy * (depth / 2)
			const wx = -uy * halfWidth
			const wy = ux * halfWidth

			list.moveTo(x + ax, y + ay)
			list.cubicTo(x + ax + wx * k, y + ay + wy * k, x + wx + ax * k, y + wy + ay * k, x + wx, y + wy)
			list.cubicTo(x + wx - ax * k, y + wy - ay * k, x - ax + wx * k, y - ay + wy * k, x - ax, y - ay)
			list.cubicTo(x - ax - wx * k, y - ay - wy * k, x - wx - ax * k, y - wy - ay * k, x - wx, y - wy)
			list.cubicTo(x - wx + ax * k, y - wy + ay * k, x + ax - wx * k, y + ay - wy * k, x + ax, y + ay)
			list.close()

			break
		}
		case "arrow":
			list.moveTo(lx, ly)
			list.lineTo(x, y)
			list.lineTo(rx, ry)
			fill = -1
			outline = list.stroke({ ...stroke, dash: "solid", customDash: null, compound: "sng" })
			break
	}

	list.addItem(ItemKind.PATH, matrix, 0, 0, 0, 0, firstCommand, firstCoord, fill, outline, -1, -1, ItemFlag.DECORATION, source)
}

// How far the stroke ends before the tip of a head: at the base of a triangle, at the notch of a stealth. Open, oval
// and diamond heads sit over the full line.
function headTrim(end: LineEnd, width: number): number {
	const depth = end.length * Math.max(width, 1)

	return end.type === "triangle" ? depth : end.type === "stealth" ? depth * 0.6 : 0
}

// Moves the point at `at` (and the cubic control point at `control`, unless -1) by (-x, -y).
function shiftBack(coords: Float32Array, at: number, control: number, x: number, y: number): void {
	coords[at] = (coords[at] ?? 0) - x
	coords[at + 1] = (coords[at + 1] ?? 0) - y

	if (control < 0) return

	coords[control] = (coords[control] ?? 0) - x
	coords[control + 1] = (coords[control + 1] ?? 0) - y
}

// Arrowheads at the ends of an open stroked path (the item just added for it). With `trim` (an unfilled path,
// whose shape the trim cannot change) the stroke is pulled back under triangle and stealth heads, as Office does,
// so a thick line's flat end does not stick out of the head's tip.
export function addLineEnds(
	list: DrawingList,
	matrix: ArrayLike<number>,
	head: LineEnd | undefined,
	tail: LineEnd | undefined,
	path: GeometryPath,
	strokeIndex: number,
	source: number,
	trim: boolean
): void {
	const ends = pathEnds(list, path)

	if (ends === undefined) return

	const [sx, sy, sdx, sdy, ex, ey, edx, edy] = ends

	if (head !== undefined) addArrowhead(list, matrix, head, sx, sy, sdx, sdy, strokeIndex, source)
	if (tail !== undefined) addArrowhead(list, matrix, tail, ex, ey, edx, edy, strokeIndex, source)

	if (!trim) return

	const width = list.strokes[strokeIndex]?.width ?? 0
	const startLength = Math.hypot(sdx, sdy)
	const endLength = Math.hypot(edx, edy)
	// Never past the neighbouring point the end's direction comes from.
	let startCut = head === undefined ? 0 : Math.min(headTrim(head, width), startLength)
	let endCut = tail === undefined ? 0 : Math.min(headTrim(tail, width), endLength)

	if (startCut === 0 && endCut === 0) return

	// The coordinate slots of either end point and of the cubic control point beside it.
	const commands = list.commands
	const last = path.firstCommand + path.commandCount
	let at = path.firstCoord
	let pairs = 0
	let startControl = -1
	let endPoint = -1
	let endControl = -1

	for (let k = path.firstCommand; k < last; k++) {
		const command = commands[k]
		const count = command === PathCommand.CUBIC ? 6 : command === PathCommand.QUAD ? 4 : command === PathCommand.CLOSE ? 0 : 2

		if (count === 0) continue
		if (k === path.firstCommand + 1 && command === PathCommand.CUBIC) startControl = at

		endPoint = at + count - 2
		endControl = command === PathCommand.CUBIC ? at + 2 : -1
		pairs += count / 2
		at += count
	}

	// One straight segment gives both ends no more than its length: the line collapses instead of crossing over.
	if (pairs === 2 && startCut + endCut > startLength) {
		const scale = startLength / (startCut + endCut)

		startCut *= scale
		endCut *= scale
	}

	const coords = list.coords

	if (startCut > 0) shiftBack(coords, path.firstCoord, startControl, (sdx / startLength) * startCut, (sdy / startLength) * startCut)
	if (endCut > 0) shiftBack(coords, endPoint, endControl, (edx / endLength) * endCut, (edy / endLength) * endCut)
}

class ShapeWalker {
	readonly context: ShapeContext
	readonly list: DrawingList
	readonly textboxes: number[] = []
	unsupported = 0
	childEffects = 0

	constructor(context: ShapeContext) {
		this.context = context
		this.list = context.list
	}

	// Counts the effects of a nested element that are not drawn: all but the first outer shadow its items carry
	// (`shadowDrawn`), an effect DAG as one. Only with effects on, as nothing is drawn or counted otherwise.
	private countChildEffects(reader: DrawingReader, properties: number, effectRef: StyleRef | undefined, shadowDrawn: boolean): void {
		if (!this.context.effects) return

		const read = shapeEffects(this.context, reader, properties, effectRef)
		let lost = read.effects.length

		if (shadowDrawn && read.sources.includes("outerShdw")) lost--
		if (read.approximated.includes("effectDag")) lost++

		this.childEffects += lost
	}

	// `depth` counts nesting of groups and alternate content; a group or alternate content past MAX_DEPTH
	// is skipped and counted unsupported, so crafted nesting cannot overflow the stack.
	element(reader: DrawingReader, node: number, frame: Frame, depth: number = 0): void {
		const group = reader.group(node)
		const local = reader.local(node)

		if (!SHAPE_GROUPS.has(group)) {
			// mc:AlternateContent around a shape: take the first branch holding drawable children.
			if (group === D.MC && local === "AlternateContent") {
				if (depth > MAX_DEPTH) this.unsupported++
				else this.alternate(reader, node, frame, depth)
			}

			return
		}

		if (hidden(reader, node)) return

		if (local === "pic") {
			this.picture(reader, node, frame, depth)
		} else if (SHAPES.has(local)) {
			this.shape(reader, node, frame, depth)
		} else if (GROUPS.has(local)) {
			if (depth > MAX_DEPTH) this.unsupported++
			else this.group(reader, node, frame, depth)
		} else if (local === "graphicFrame" || local === "contentPart") {
			if (local !== "graphicFrame" || !this.graphicFrame(reader, node, frame)) this.unsupported++
		}
	}

	// A graphic frame in a group, drawn by the host (ShapeContext.frame) in the box its own xfrm gives it.
	private graphicFrame(reader: DrawingReader, node: number, frame: Frame): boolean {
		const hook = this.context.frame

		if (hook === undefined) return false

		const document = reader.document
		let xfrmNode = -1

		for (let child = document.firstChildElement(node); child >= 0 && xfrmNode < 0; child = document.nextSiblingElement(child))
			if (reader.local(child) === "xfrm") xfrmNode = child

		const xfrm = readXfrm(reader, xfrmNode)
		const box = this.box(xfrm, frame)

		if (!(box.w > 0 && box.h > 0)) return false

		const matrix = multiply(
			frame.matrix,
			boxMatrix(
				box.x / EMU_PER_PX,
				box.y / EMU_PER_PX,
				box.w / EMU_PER_PX,
				box.h / EMU_PER_PX,
				xfrm?.rotation ?? 0,
				xfrm?.flipH ?? false,
				xfrm?.flipV ?? false
			)
		)

		return hook(reader, node, this.list, matrix, box.w, box.h)
	}

	private alternate(reader: DrawingReader, node: number, frame: Frame, depth: number): void {
		const document = reader.document

		for (let branch = document.firstChildElement(node); branch >= 0; branch = document.nextSiblingElement(branch)) {
			let drew = false

			for (let child = document.firstChildElement(branch); child >= 0; child = document.nextSiblingElement(child)) {
				if (SHAPE_GROUPS.has(reader.group(child))) {
					this.element(reader, child, frame, depth + 1)
					drew = true
				}
			}

			if (drew) return
		}
	}

	// The box of an element in its parent's local frame (EMU), from its xfrm (the whole parent frame when
	// it has none).
	private box(xfrm: Xfrm | undefined, frame: Frame): { x: number; y: number; w: number; h: number } {
		if (xfrm === undefined) return { x: 0, y: 0, w: frame.width, h: frame.height }

		return {
			x: frame.offsetX + xfrm.x * frame.scaleX,
			y: frame.offsetY + xfrm.y * frame.scaleY,
			w: xfrm.w * frame.scaleX,
			h: xfrm.h * frame.scaleY
		}
	}

	group(reader: DrawingReader, node: number, frame: Frame, depth: number): void {
		const grpSpPr = propertiesOf(reader, node, "grpSpPr")
		const xfrm = readXfrm(reader, reader.child(grpSpPr, D.A, "xfrm"))
		let matrix = frame.matrix
		let child: Frame

		if (xfrm === undefined || xfrm.childW === 0 || xfrm.childH === 0) {
			// No coordinate system of its own: children use the parent's.
			child = { ...frame }
		} else {
			const box = this.box(xfrm, frame)

			matrix = multiply(
				frame.matrix,
				boxMatrix(
					box.x / EMU_PER_PX,
					box.y / EMU_PER_PX,
					box.w / EMU_PER_PX,
					box.h / EMU_PER_PX,
					xfrm.rotation,
					xfrm.flipH,
					xfrm.flipV
				)
			)

			const scaleX = box.w / xfrm.childW
			const scaleY = box.h / xfrm.childH

			child = {
				matrix,
				scaleX,
				scaleY,
				offsetX: -xfrm.childX * scaleX,
				offsetY: -xfrm.childY * scaleY,
				width: box.w,
				height: box.h,
				groupFill: frame.groupFill
			}
		}

		const fill = readFillElement(this.context, reader, fillChild(reader, grpSpPr))

		if (fill !== undefined && fill !== GROUP_PAINT) child = { ...child, groupFill: fill }

		// A nested group draws none of its effects (the host draws the outermost element's).
		if (depth > 0) this.countChildEffects(reader, grpSpPr, undefined, false)

		const document = reader.document

		for (let element = document.firstChildElement(node); element >= 0; element = document.nextSiblingElement(element)) {
			this.element(reader, element, child, depth + 1)
		}
	}

	private shape(reader: DrawingReader, node: number, frame: Frame, depth: number): void {
		const spPr = propertiesOf(reader, node, "spPr")
		const xfrm = readXfrm(reader, reader.child(spPr, D.A, "xfrm"))
		const box = this.box(xfrm, frame)
		const matrix = multiply(
			frame.matrix,
			boxMatrix(
				box.x / EMU_PER_PX,
				box.y / EMU_PER_PX,
				box.w / EMU_PER_PX,
				box.h / EMU_PER_PX,
				xfrm?.rotation ?? 0,
				xfrm?.flipH ?? false,
				xfrm?.flipV ?? false
			)
		)
		const style = propertiesOf(reader, node, "style")
		const context = this.context
		const fillRef = styleRef(context, reader, reader.child(style, D.A, "fillRef"), "fill")
		const lnRef = styleRef(context, reader, reader.child(style, D.A, "lnRef"), "line")
		const effectRef = styleRef(context, reader, reader.child(style, D.A, "effectRef"), "effect")
		let fill = shapeFill(context, reader, spPr, fillRef)

		if (fill === GROUP_PAINT) fill = frame.groupFill

		const line = shapeLine(context, reader, reader.child(spPr, D.A, "ln"), lnRef)
		const shadow = shapeShadow(context, reader, spPr, effectRef)
		const { program, adjust } = shapeGeometry(reader, spPr)

		if (depth > 0) this.countChildEffects(reader, spPr, effectRef, shadow >= 0)

		this.paths(program, adjust, box.w, box.h, matrix, fill ?? NO_PAINT, line, shadow, node)
		this.text(reader, node, frame, program, adjust, box, style)
	}

	private paths(
		program: GeometryProgram,
		adjust: ((name: string, slots: Float64Array) => number | undefined) | undefined,
		w: number,
		h: number,
		matrix: readonly number[],
		fill: number,
		line: LineStyle | undefined,
		shadow: number,
		source: number
	): void {
		const list = this.list
		const slots = evaluateGuides(program, w, h, adjust)
		const paths = emitPaths(list, program, slots, w, h)
		let shadowLeft = shadow

		for (const path of paths) {
			const pathFill = path.fill === 1 || fill < 0 ? -1 : fill
			const stroke = path.stroke && line !== undefined ? line.stroke : -1

			if (pathFill < 0 && stroke < 0) continue

			const flags = ItemFlag.EVEN_ODD | (pathFill < 0 ? 0 : (FILL_FLAGS[path.fill] ?? 0))

			list.addItem(
				ItemKind.PATH,
				matrix,
				0,
				0,
				w / EMU_PER_PX,
				h / EMU_PER_PX,
				path.firstCommand,
				path.firstCoord,
				pathFill,
				stroke,
				-1,
				shadowLeft,
				flags,
				source
			)
			shadowLeft = -1

			if (stroke >= 0 && path.open && line !== undefined && (line.head !== undefined || line.tail !== undefined))
				addLineEnds(list, matrix, line.head, line.tail, path, stroke, source, pathFill < 0)
		}
	}

	private text(
		reader: DrawingReader,
		node: number,
		frame: Frame,
		program: GeometryProgram,
		adjust: ((name: string, slots: Float64Array) => number | undefined) | undefined,
		box: { x: number; y: number; w: number; h: number },
		style: number
	): void {
		const context = this.context
		const list = this.list
		const document = reader.document
		let txbx = -1
		let txBody = -1
		let bodyPr = -1
		let txXfrm = -1

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "txbx") txbx = child
			else if (local === "txBody") txBody = child
			else if (local === "bodyPr") bodyPr = child
			else if (local === "txXfrm") txXfrm = child
			else if (local === "txSp") txBody = reader.child(child, D.A, "txBody")
		}

		const content = txbx < 0 ? -1 : reader.child(txbx, D.W, "txbxContent")

		if (content < 0 && txBody < 0) return

		const hosted = content < 0 && context.body !== undefined ? context.body(txBody) : undefined
		let body: TextBodyProps
		let parsed: ReturnType<typeof readTextBody> | undefined

		if (content >= 0 || hosted !== undefined) {
			body = readBodyProps(reader, bodyPr >= 0 ? bodyPr : reader.child(txBody, D.A, "bodyPr"))
		} else {
			// DrawingML text: the style's font reference supplies the default typeface and colour.
			const fontRef = reader.child(style, D.A, "fontRef")
			const base = context.text ?? DEFAULT_TEXT
			const refColor: Rgba | undefined = fontRef < 0 ? undefined : readColor(reader, colorChild(reader, fontRef), context.theme)
			const refFont =
				fontRef < 0 ? undefined : resolveTypeface(context.theme, reader.attr(fontRef, "idx") === "major" ? "+mj-lt" : "+mn-lt")
			const defaults: TextDefaults = { ...base, color: refColor ?? base.color, font: refFont ?? base.font }

			parsed = readTextBody(reader, context.theme, txBody, defaults, bodyPr >= 0 ? readBodyProps(reader, bodyPr) : {})

			if (parsed.paragraphs.every(paragraph => paragraph.runs.every(run => run.text === ""))) return

			body = parsed.body
		}

		// The text rectangle: dsp:txXfrm (its own placement), else the geometry's text rectangle.
		let textMatrix: readonly number[]
		let rect: [number, number, number, number]
		const textXfrm = readXfrm(reader, txXfrm)
		const xfrm = readXfrm(reader, reader.child(propertiesOf(reader, node, "spPr"), D.A, "xfrm"))
		const turn = xfrm?.rotation ?? 0

		if (textXfrm !== undefined) {
			const textBox = this.box(textXfrm, frame)

			textMatrix = multiply(
				frame.matrix,
				boxMatrix(
					textBox.x / EMU_PER_PX,
					textBox.y / EMU_PER_PX,
					textBox.w / EMU_PER_PX,
					textBox.h / EMU_PER_PX,
					// dsp:txXfrm turns relative to the shape (upright text on a turned shape turns back by its turn).
					turn + textXfrm.rotation,
					false,
					false
				)
			)
			rect = [0, 0, textBox.w / EMU_PER_PX, textBox.h / EMU_PER_PX]
		} else {
			// The text rectangle follows the flipped geometry, but the text never mirrors: it turns with the shape, and
			// a vertical flip turns it half round, which maps y itself, so x is mirrored for exactly one of the flips.
			const flipH = xfrm?.flipH ?? false
			const flipV = xfrm?.flipV ?? false
			const textTurn = flipV ? turn + 180 : turn
			const w = box.w / EMU_PER_PX

			textMatrix = multiply(
				frame.matrix,
				boxMatrix(box.x / EMU_PER_PX, box.y / EMU_PER_PX, w, box.h / EMU_PER_PX, textTurn, false, false)
			)
			rect = textRect(program, evaluateGuides(program, box.w, box.h, adjust), box.w, box.h)

			if (flipH !== flipV) rect = [w - rect[2], rect[1], w - rect[0], rect[3]]

			// bodyPr rot turns the text about the rectangle's centre; upright text first turns back to the page.
			const extra = body.rotation - (body.upright ? textTurn : 0)
			const half = ((extra % 180) + 180) % 180

			if (extra % 360 !== 0) {
				const cx = (rect[0] + rect[2]) / 2
				const cy = (rect[1] + rect[3]) / 2
				// Upright text a quarter turn off its shape lays out across the box the page shows.
				const swap = body.upright && half > 45 && half < 135
				const rw = Math.max(0, swap ? rect[3] - rect[1] : rect[2] - rect[0])
				const rh = Math.max(0, swap ? rect[2] - rect[0] : rect[3] - rect[1])

				textMatrix = multiply(textMatrix, boxMatrix(cx - rw / 2, cy - rh / 2, rw, rh, extra, false, false))
				rect = [0, 0, rw, rh]
			}
		}

		const text =
			parsed === undefined
				? list.text({ kind: "story", body, story: hosted ?? context.story?.(content) ?? content })
				: list.text({ kind: "body", body, paragraphs: parsed.paragraphs })

		if (content >= 0) this.textboxes.push(content)
		list.addItem(
			ItemKind.TEXT,
			textMatrix,
			rect[0],
			rect[1],
			Math.max(0, rect[2] - rect[0]),
			Math.max(0, rect[3] - rect[1]),
			list.commandCount,
			list.coordCount,
			-1,
			-1,
			text,
			-1,
			0,
			node
		)
	}

	private picture(reader: DrawingReader, node: number, frame: Frame, depth: number): void {
		const context = this.context
		const list = this.list
		const spPr = propertiesOf(reader, node, "spPr")
		const xfrm = readXfrm(reader, reader.child(spPr, D.A, "xfrm"))
		const box = this.box(xfrm, frame)
		const matrix = multiply(
			frame.matrix,
			boxMatrix(
				box.x / EMU_PER_PX,
				box.y / EMU_PER_PX,
				box.w / EMU_PER_PX,
				box.h / EMU_PER_PX,
				xfrm?.rotation ?? 0,
				xfrm?.flipH ?? false,
				xfrm?.flipV ?? false
			)
		)
		const blipFill = propertiesOf(reader, node, "blipFill")
		const image = readBlip(context, reader, blipFill)
		const w = box.w / EMU_PER_PX
		const h = box.h / EMU_PER_PX
		const { program, adjust } = shapeGeometry(reader, spPr)
		const preset = reader.attr(reader.child(spPr, D.A, "prstGeom"), "prst")
		const clipped = reader.child(spPr, D.A, "custGeom") >= 0 || (preset !== undefined && preset !== "rect")
		const background = readFillElement(context, reader, fillChild(reader, spPr))
		const shadow = shapeShadow(context, reader, spPr, undefined)

		if (depth > 0) this.countChildEffects(reader, spPr, undefined, shadow >= 0 && image >= 0)

		if (background !== undefined && background >= 0) this.paths(program, adjust, box.w, box.h, matrix, background, undefined, -1, node)

		if (image >= 0) {
			const stretch = reader.child(reader.child(blipFill, D.A, "stretch"), D.A, "fillRect")
			const left = reader.fraction(stretch, "l", 0) * w
			const top = reader.fraction(stretch, "t", 0) * h
			const right = reader.fraction(stretch, "r", 0) * w
			const bottom = reader.fraction(stretch, "b", 0) * h
			const firstCommand = list.commandCount
			const firstCoord = list.coordCount

			if (clipped) {
				const slots = evaluateGuides(program, box.w, box.h, adjust)

				emitPaths(list, program, slots, box.w, box.h)
			}

			list.addItem(
				ItemKind.IMAGE,
				matrix,
				left,
				top,
				w - left - right,
				h - top - bottom,
				firstCommand,
				firstCoord,
				-1,
				-1,
				image,
				shadow,
				0,
				node
			)
		}

		const line = shapeLine(context, reader, reader.child(spPr, D.A, "ln"), undefined)

		if (line !== undefined) this.paths(program, adjust, box.w, box.h, matrix, NO_PAINT, line, -1, node)
	}
}

function rootFrame(width: number, height: number): Frame {
	return { matrix: IDENTITY, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, width, height, groupFill: NO_PAINT }
}

// Converts the content of an a:graphicData holding a picture, shape, group, locked canvas or canvas, drawn
// into a frame of width x height EMU (wp:extent): the top-level element's xfrm is mapped onto the frame.
export function convertGraphic(
	context: ShapeContext,
	document: XmlDocument,
	graphicData: number,
	width: number,
	height: number
): ShapeConversion {
	const reader = drawingReader(document)
	const walker = new ShapeWalker(context)
	const list = context.list

	list.width = width / EMU_PER_PX
	list.height = height / EMU_PER_PX

	for (let element = document.firstChildElement(graphicData); element >= 0; element = document.nextSiblingElement(element)) {
		const properties = propertiesOf(reader, element, GROUPS.has(reader.local(element)) ? "grpSpPr" : "spPr")
		const xfrm = readXfrm(reader, reader.child(properties, D.A, "xfrm"))
		let frame = rootFrame(width, height)

		if (xfrm !== undefined && xfrm.w > 0 && xfrm.h > 0) {
			const scaleX = width / xfrm.w
			const scaleY = height / xfrm.h

			frame = { ...frame, scaleX, scaleY, offsetX: -xfrm.x * scaleX, offsetY: -xfrm.y * scaleY }
		}

		walker.element(reader, element, frame)
	}

	return { list, textboxes: walker.textboxes, unsupported: walker.unsupported, childEffects: walker.childEffects }
}

// Converts a shape tree whose coordinates are already in the frame's EMU (dsp:spTree of a SmartArt drawing,
// later p:spTree).
export function convertShapeTree(
	context: ShapeContext,
	document: XmlDocument,
	tree: number,
	width: number,
	height: number
): ShapeConversion {
	const reader = drawingReader(document)
	const walker = new ShapeWalker(context)
	const list = context.list
	const frame = rootFrame(width, height)

	list.width = width / EMU_PER_PX
	list.height = height / EMU_PER_PX

	for (let element = document.firstChildElement(tree); element >= 0; element = document.nextSiblingElement(element)) {
		walker.element(reader, element, frame)
	}

	return { list, textboxes: walker.textboxes, unsupported: walker.unsupported, childEffects: walker.childEffects }
}
