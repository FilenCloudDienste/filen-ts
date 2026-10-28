import type { EmitPiece, EmitResult } from "../../../pptx/write/types"
import {
	chartHeldBy,
	chartOwner,
	heldChart,
	isHeldChart,
	noteChartWrite,
	ownsHome,
	type HeldChart
} from "../../../presentation/edit/apply/chart"
import { refused, type FrameRef, type Refused, type ShapeNode } from "../../../presentation/model"
import { decodeUtf8, escapeAttribute } from "../../../xml/index"
import type { OdpEmitContext, OdpEmitFamily, OdpStylesApi } from "../emit"
import { OdpStyles, declared, isRefused } from "../styles"
import { IDENTITY, OdpShapeWriter, emitOdpShape } from "./shape"
import { altMarkup, frameBox } from "./table"

// A chart's draw:frame holding draw:object (ODF 1.3 Part 3 §10.4.6), the object a chart document of its own
// (Part 3 §11; its manifest entry "Object N/" of type application/vnd.oasis.opendocument.chart, Part 2 §4.3). A frame
// naming the package's object is the shape family's. A frame naming a version the session holds (apply/chart.ts)
// names the object that holds it: its home, its content.xml written again when the home holds another version (an
// edit, or an undo or redo past a save), else, for an inserted chart, a new object (its manifest entry, its
// content.xml). The frame's replacement picture (draw:image, Part 3 §10.4.6.3) is kept as the file has it: a consumer
// draws the object, the picture only stands in where the object cannot be drawn.

type ChartFrame = Extract<FrameRef, { kind: "chart" }>

const CHART_OBJECT_TYPE = "application/vnd.oasis.opendocument.chart"
const OBJECT_HREF = ' xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"'
const MAX_OBJECTS = 100_000

// Objects this save already wrote, by frame and version.
const written = new WeakMap<OdpStylesApi, Map<string, string>>()

function hasEntry(styles: OdpStylesApi, path: string): boolean {
	return styles.hasEntry?.(path) ?? false
}

// The object path a version is written to in this save: its home (its content.xml written again when the home holds
// another version), else a new "Object N" (an inserted chart, or a home the package no longer has).
function objectOf(styles: OdpStylesApi, context: OdpEmitContext, version: HeldChart, owner: string): string | Refused {
	const home = version.lineage.home

	if (home !== undefined && ownsHome(version.lineage, owner) && hasEntry(styles, `${home}/content.xml`)) {
		if (chartHeldBy(context.deck, home) === version.name) return home
		if (version.object === undefined) return refused("failed", `the chart version ${version.name} has no object`)

		const object = version.object.subarray(0)

		if (styles.replaceEntry?.(`${home}/content.xml`, object) === true) {
			noteChartWrite(context.deck, object, version.name, "object", owner)

			return home
		}
	}

	let held = written.get(styles)

	if (held === undefined) {
		held = new Map()
		written.set(styles, held)
	}

	const known = held.get(`${owner}\u0000${version.name}`)

	if (known !== undefined) return known
	if (version.object === undefined) return refused("failed", `the chart version ${version.name} has no object`)

	let path: string | undefined

	for (let n = 1; n <= MAX_OBJECTS && path === undefined; n++)
		if (!hasEntry(styles, `Object ${String(n)}/content.xml`) && !hasEntry(styles, `Object ${String(n)}/`)) path = `Object ${String(n)}`

	if (path === undefined) return refused("tooLarge", "no free object name")

	// The directory's own manifest entry says the object is a chart.
	styles.addEntry(`${path}/`, new Uint8Array(0), CHART_OBJECT_TYPE)
	const object = version.object.subarray(0)

	styles.addEntry(`${path}/content.xml`, object, "text/xml")
	noteChartWrite(context.deck, object, version.name, "object", owner)

	for (const [stream, bytes] of version.lineage.streams) styles.addEntry(`${path}/${stream}`, bytes, "text/xml")

	held.set(`${owner}\u0000${version.name}`, path)

	return path
}

function objectXml(path: string): string {
	return `<draw:object xlink:href="./${escapeAttribute(path)}"${OBJECT_HREF}/>`
}

function emitFrame(context: OdpEmitContext, shape: ShapeNode, request: Parameters<OdpEmitFamily["emit"]>[0]): EmitResult {
	const frame = shape.frame as ChartFrame

	if (!isHeldChart(frame.part)) return emitOdpShape.emit(request, context)
	if (!(context.styles instanceof OdpStyles)) return refused("failed", "the save's styles")

	const version = heldChart(context.deck, frame.part)

	if (version === undefined) return refused("stale", `the chart version ${frame.part} is not held`)

	const path = objectOf(context.styles, context, version, chartOwner(request.slide.ref, shape.id))

	if (typeof path !== "string") return path

	const styles = context.styles
	const fragment = context.document === undefined ? undefined : styles.env.fragmentOf(context.document)
	const writer = new OdpShapeWriter(context, fragment, request.slide, () => undefined)
	const node = writer.sourceNode(shape)

	if (node === undefined || fragment === undefined) {
		if (shape.xfrm === undefined) return refused("unsupported", "a new chart without a box")

		const name = shape.name === "" ? "" : ` draw:name="${escapeAttribute(shape.name)}"`

		return { kind: "markup", pieces: [`<draw:frame${name}${frameBox(shape.xfrm)}>${objectXml(path)}${altMarkup(shape)}</draw:frame>`] }
	}

	const document = fragment.document
	let object = -1

	for (let child = document.firstChildElement(node); child >= 0 && object < 0; child = document.nextSiblingElement(child))
		if (fragment.name(child) === "draw:object") object = child

	if (object < 0) return refused("malformed", "a chart frame without its draw:object")

	const pieces = writer.element(shape, IDENTITY, { xfrm: true, alt: true, name: true, hidden: true }, true)

	if (isRefused(pieces)) return pieces

	const href = fragment.attributes(object).get("xlink:href") ?? ""
	const same = href.replace(/^\.\//u, "").replace(/\/$/u, "") === path
	const out: EmitPiece[] = []
	let replaced = false

	// The frame is handed to the shape writer as markup: its kept children are their source bytes.
	const text = (piece: EmitPiece): string =>
		typeof piece === "string"
			? piece
			: piece instanceof Uint8Array
				? decodeUtf8(piece, 0, piece.length)
				: decodeUtf8(document.raw(piece.hole), 0, document.raw(piece.hole).length)

	for (const piece of pieces) {
		const hole = typeof piece === "object" && !(piece instanceof Uint8Array) ? piece.hole : -1

		if (hole === object) {
			out.push(same ? text(piece) : declared(objectXml(path), fragment.namespaces.inScope(object)))
			replaced = true
		} else {
			out.push(text(piece))
		}
	}

	if (!replaced) return refused("malformed", "a chart frame whose draw:object was not written as its source")

	return { kind: "markup", pieces: out }
}

export const emitOdpChart: OdpEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		if (shape?.frame?.kind !== "chart") return refused("failed", "a chart emit without a chart frame")

		return emitFrame(context, shape, request)
	}
}
