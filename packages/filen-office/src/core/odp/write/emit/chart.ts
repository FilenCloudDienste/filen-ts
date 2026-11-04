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
import type { ByteChunks } from "../../../opc/index"
import { formerName, isIssuedName, noteFormerName } from "../../../presentation/issuedNames"
import type { OdpParts } from "../../read/document"
import { refused, type FrameRef, type Refused, type ShapeNode } from "../../../presentation/model"
import { decodeUtf8, escapeAttribute } from "../../../xml/index"
import type { OdpEmitContext, OdpEmitFamily, OdpStylesApi } from "../emit"
import { OdpStyles, declared } from "../styles"
import { IDENTITY, OdpShapeWriter, emitOdpShape, familyFragment } from "./shape"
import { altMarkup, frameBox } from "./table"
import { isRefused } from "../../../presentation/refusal"

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

// Whether "Object N" is taken: the package has it, or a package of the session had it (never handed to another chart).
function objectTaken(styles: OdpStylesApi, context: OdpEmitContext, path: string): boolean {
	return [`${path}/content.xml`, `${path}/`].some(name => hasEntry(styles, name) || isIssuedName(context.deck, name))
}

// A new "Object N": the first name the package has not and no package of the session had; undefined past MAX_OBJECTS.
function freeObjectPath(styles: OdpStylesApi, context: OdpEmitContext): string | undefined {
	for (let n = 1; n <= MAX_OBJECTS; n++) if (!objectTaken(styles, context, `Object ${String(n)}`)) return `Object ${String(n)}`

	return undefined
}

// Whether the package's object `path` is a chart (its directory's manifest entry, ODF 1.3 Part 2 §4.3): the objects a
// session edits, so the ones a duplicated page must not share.
export function isChartObject(parts: OdpParts, path: string): boolean {
	return parts.context.mediaType(path) === CHART_OBJECT_TYPE && parts.opc.has(`${path}/content.xml`)
}

// The package's chart object `from` copied whole under an object name of its own, its manifest entries with it: the
// object of a duplicated page's frame, so an edit of either chart leaves the other. The copy's name is the one a save
// of the session gave it before (`key`: the copy's page and the object it copies): taken again while the package has
// no object by it, or kept as it is when the package's object by it holds the same entries (a state saved again
// writes the same bytes). Its entries are read when the zip is written.
export function copyObject(context: OdpEmitContext, parts: OdpParts, from: string, key: string): string | Refused {
	const styles = context.styles
	const archive = parts.odf.archive
	const inner = archive.entries.filter(entry => entry.name.startsWith(`${from}/`) && !entry.name.endsWith("/"))
	const own = formerName(context.deck, `object ${key}`)

	if (own !== undefined && hasEntry(styles, `${own}/content.xml`)) {
		const held = new Map(archive.entries.map(entry => [entry.name, entry]))
		const same = inner.every(entry => {
			const copy = held.get(`${own}/${entry.name.slice(from.length + 1)}`)

			return copy !== undefined && copy.crc32 === entry.crc32 && copy.uncompressedSize === entry.uncompressedSize
		})

		if (same) return own
	}

	const path =
		own !== undefined && !hasEntry(styles, `${own}/content.xml`) && !hasEntry(styles, `${own}/`) ? own : freeObjectPath(styles, context)

	if (path === undefined) return refused("tooLarge", "no free object name")

	noteFormerName(context.deck, `object ${key}`, path)
	styles.addEntry(`${path}/`, new Uint8Array(0), CHART_OBJECT_TYPE)

	for (const entry of inner) {
		const content: ByteChunks = {
			length: entry.uncompressedSize,
			chunks: async function* () {
				yield await archive.read(entry)
			}
		}

		styles.addEntry(`${path}/${entry.name.slice(from.length + 1)}`, content, parts.context.mediaType(entry.name) ?? "text/xml", {
			crc32: entry.crc32
		})
	}

	return path
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

	const path = freeObjectPath(styles, context)

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
	const fragment = familyFragment(styles, context, shape)
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
