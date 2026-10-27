import type { EmitResult } from "../../../pptx/write/types"
import {
	PATH_CLOSE,
	PATH_CUBIC,
	PATH_LINE,
	PATH_MOVE,
	refused,
	type CustomPath,
	type Refused,
	type ShapeNode,
	type Xfrm
} from "../../../presentation/model"
import { escapeAttribute, escapeText } from "../../../xml/index"
import { odpTargetId, odpTargetIds } from "../../../anim/odf"
import type { OdpEmitContext, OdpEmitFamily } from "../emit"
import { attributeMarkup, cm, effectChanges, fillChanges, isRefused, lineChanges, styleChanges, type StyleChanges } from "../styles"
import { IDENTITY, compose, emitOdpShape, groupAffine, placed, type Affine } from "./shape"

// The ink family's ODF markup (ODF 1.3 Part 3 §10.3.7 draw:path): a freeform a session made, kept ink's strokes
// among them, written whole as a draw:path whose svg:d runs through the outline's points in a view box of the
// shape's own extent (EMU), placed where its groups' mapping puts it (a draw:g has no box of its own), with an
// automatic graphic style for its fill and line (§20.137 draw:fill, §20.164 draw:stroke, svg:stroke-*).
// What the reader would read back otherwise (it reads svg:d as one filled, stroked path of moves, lines, cubics and
// closes) is refused with its reason, never written as something else. A freeform the source holds is the shape
// family's, which patches its element.

// The groups `id` sits in, outermost first; undefined when the tree does not hold it.
function ancestry(shapes: readonly ShapeNode[], id: number, into: ShapeNode[]): ShapeNode[] | undefined {
	for (const shape of shapes) {
		if (shape.id === id) return into
		if (shape.children === undefined) continue

		into.push(shape)

		const found = ancestry(shape.children, id, into)

		if (found !== undefined) return found

		into.pop()
	}

	return undefined
}

function mappingOf(shapes: readonly ShapeNode[], shape: ShapeNode): Affine | Refused {
	let m = IDENTITY

	for (const group of ancestry(shapes, shape.id, []) ?? []) {
		const inner = groupAffine(group.xfrm)

		if (isRefused(inner)) return inner

		m = compose(m, inner)
	}

	return m
}

// svg:x/y/width/height, or for a turned box draw:transform "rotate (a) translate (x y)" about its corner (§19.229;
// the reader's angle turns counter-clockwise, DrawingML's rot clockwise).
function boxMarkup(box: Xfrm): string {
	const size = ` svg:width="${cm(box.cx)}" svg:height="${cm(box.cy)}"`

	if (box.rot === 0) return ` svg:x="${cm(box.x)}" svg:y="${cm(box.y)}"${size}`

	const a = -((box.rot / 60_000) * Math.PI) / 180
	const cos = Math.cos(a)
	const sin = Math.sin(a)
	const halfW = box.cx / 2
	const halfH = box.cy / 2
	const tx = box.x + halfW - (cos * halfW + sin * halfH)
	const ty = box.y + halfH - (-sin * halfW + cos * halfH)

	return `${size} draw:transform="rotate (${a.toFixed(12)}) translate (${cm(tx)} ${cm(ty)})"`
}

const POINTS: Readonly<Record<number, readonly [string, number]>> = {
	[PATH_MOVE]: ["M", 1],
	[PATH_LINE]: ["L", 1],
	[PATH_CUBIC]: ["C", 3],
	[PATH_CLOSE]: ["Z", 0]
}

// svg:d of one path in a w × h view box (the path's own space scaled onto it): each
// command letter once per run of the same command (SVG 1.1 §8.3.2 repeats it), whole numbers.
function pathData(path: CustomPath, w: number, h: number): string | Refused {
	const sx = path.w > 0 ? w / path.w : 1
	const sy = path.h > 0 ? h / path.h : 1
	const coords = path.coords
	const commands = path.commands
	let d = ""
	let last = -1
	let at = 0

	for (let k = 0; k < commands.length; k++) {
		const command = commands[k] as number
		const spec = POINTS[command]

		if (spec === undefined) return refused("unsupported", "an arc or quadratic curve in a freeform ODF reads back as another outline")

		const [letter, points] = spec

		if (command !== last || command === PATH_MOVE || command === PATH_CLOSE) d += letter
		else d += " "

		for (let p = 0; p < points; p++, at += 2) {
			const x = Math.round((coords[at] ?? 0) * sx)
			const y = Math.round((coords[at + 1] ?? 0) * sy)

			d += `${p === 0 ? "" : " "}${String(x)} ${String(y)}`
		}

		last = command
	}

	return d
}

// The graphic style of the freeform's fill, line and shadow (only what it sets; the rest inherits the default).
function styleOf(shape: ShapeNode, context: OdpEmitContext): string | Refused {
	const changes: StyleChanges = styleChanges()
	const props = shape.props
	const failed =
		(props?.fill === undefined ? undefined : fillChanges(changes, props.fill)) ??
		(props?.ln === undefined ? undefined : lineChanges(changes, props.ln, undefined)) ??
		(props?.effects === undefined ? undefined : effectChanges(changes, props.effects))

	if (failed !== undefined) return failed

	const attributes: [string, string][] = []

	for (const [name, value] of changes.attributes.get("graphic") ?? []) if (value !== null) attributes.push([name, value])

	let children = ""

	for (const markup of changes.children.get("graphic")?.values() ?? []) if (markup !== null) children += markup

	if (attributes.length === 0 && children === "") return ""

	const own = attributeMarkup(attributes)
	const properties =
		children === "" ? `<style:graphic-properties${own}/>` : `<style:graphic-properties${own}>${children}</style:graphic-properties>`

	return ` draw:style-name="${escapeAttribute(context.styles.automatic("graphic", properties))}"`
}

function pathElement(
	shape: ShapeNode,
	slideShapes: readonly ShapeNode[],
	context: OdpEmitContext,
	timing: ReadonlySet<number>
): EmitResult {
	const geometry = shape.props?.geometry

	if (shape.lock !== undefined) return refused("locked", shape.lock)
	if (geometry?.kind !== "custom") return refused("failed", "a freeform without a custom outline")
	if (shape.xfrm === undefined) return refused("unsupported", "a new freeform without a box")
	if (shape.text?.paragraphs.some(paragraph => paragraph.runs.length > 0) === true)
		return refused("unsupported", "text in a new freeform")
	if (shape.actions !== undefined && (shape.actions.click !== undefined || shape.actions.hover !== undefined))
		return refused("unsupported", "an action on a new freeform")

	// svg:d is read back as one path (every move continues it), filled and stroked.
	const path = geometry.paths[0]

	if (path === undefined || geometry.paths.length > 1) return refused("unsupported", "a freeform of other than one path")
	if (path.fill !== "norm" || !path.stroke) return refused("unsupported", "a freeform path ODF reads back filled and stroked")

	const m = mappingOf(slideShapes, shape)

	if (isRefused(m)) return m

	const box = placed(shape.xfrm, m)

	// The reader reads a draw:path back unmirrored (the shape family refuses a mirrored new shape the same way).
	if (box.flipH || box.flipV) return refused("unsupported", "a mirrored new freeform")

	const w = Math.max(1, Math.round(shape.xfrm.cx))
	const h = Math.max(1, Math.round(shape.xfrm.cy))
	const d = pathData(path, w, h)

	if (isRefused(d)) return d

	const style = styleOf(shape, context)

	if (isRefused(style)) return style

	let common = shape.name === "" ? "" : ` draw:name="${escapeAttribute(shape.name)}"`

	// A shape the slide's timing animates is named by its target id (core/anim/odf.ts odpTargetId).
	if (timing.has(shape.id)) {
		const id = escapeAttribute(odpTargetId(shape))

		common += ` xml:id="${id}" draw:id="${id}"`
	}
	if (shape.hidden) common += ' draw:display="none"'

	const alt =
		(shape.alt?.title === undefined || shape.alt.title === "" ? "" : `<svg:title>${escapeText(shape.alt.title)}</svg:title>`) +
		(shape.alt?.descr === undefined || shape.alt.descr === "" ? "" : `<svg:desc>${escapeText(shape.alt.descr)}</svg:desc>`)
	return {
		kind: "markup",
		pieces: [`<draw:path${common}${style}${boxMarkup(box)} svg:viewBox="0 0 ${String(w)} ${String(h)}" svg:d="${d}">${alt}</draw:path>`]
	}
}

export const emitOdpInk: OdpEmitFamily = {
	emit(request, context) {
		const shape = request.shape

		if (shape === undefined) return refused("failed", "an ink emit without a shape")
		if (shape.kind === "ink") return refused("unsupported", "an ink content part in ODF")
		// A freeform the source holds, or a shape that is not one: patched or written by the shape family.
		if (shape.src !== undefined || shape.kind !== "sp" || shape.props?.geometry?.kind !== "custom")
			return emitOdpShape.emit(request, context)

		return pathElement(shape, request.slide.shapes, context, odpTargetIds(request.slide.timing))
	}
}
