import { NodeKind } from "../../xml/index"
import { GRAPHIC_URIS, Ns, type GraphicKind } from "./namespaces"
import { afterSubtree, parseInteger, type PartReader } from "./reader"

export type DrawingPlacement = "inline" | "anchor" | "unknown"

export type WrapType = "none" | "square" | "tight" | "through" | "topAndBottom" | "unknown"

// wp:positionH / wp:positionV: either an alignment or an offset (EMU) from `relativeFrom`.
export interface AnchorPosition {
	readonly relativeFrom: string | undefined
	readonly align: string | undefined
	readonly offset: number | undefined
	// wp14:pctPosHOffset / pctPosVOffset, in thousandths of a percent.
	readonly percentOffset: number | undefined
}

export interface AnchorInfo {
	readonly behindDoc: boolean
	readonly locked: boolean
	readonly layoutInCell: boolean
	readonly allowOverlap: boolean
	readonly relativeHeight: number
	readonly simplePos: boolean
	readonly simpleX: number
	readonly simpleY: number
	readonly horizontal: AnchorPosition | undefined
	readonly vertical: AnchorPosition | undefined
	readonly wrap: WrapType
	// wp:wrapSquare|wrapTight|wrapThrough @wrapText.
	readonly wrapText: string | undefined
	readonly wrapNode: number
}

export interface DiagramIds {
	readonly data: string | undefined
	readonly layout: string | undefined
	readonly style: string | undefined
	readonly colors: string | undefined
}

// A w:drawing. Sizes are EMU. Nodes are in the part's XmlDocument; -1 when absent. External picture
// links (`linkId`) are recorded, never fetched.
export interface DrawingInfo {
	readonly index: number
	readonly part: number
	readonly item: number
	readonly node: number
	readonly frame: number
	readonly placement: DrawingPlacement
	readonly graphic: GraphicKind
	readonly graphicUri: string | undefined
	readonly graphicData: number
	readonly width: number
	readonly height: number
	readonly effectLeft: number
	readonly effectTop: number
	readonly effectRight: number
	readonly effectBottom: number
	readonly distTop: number
	readonly distBottom: number
	readonly distLeft: number
	readonly distRight: number
	readonly docPr: number
	readonly docPrId: number
	readonly hidden: boolean
	readonly anchor: AnchorInfo | undefined
	readonly blip: number
	readonly embedId: string | undefined
	readonly linkId: string | undefined
	readonly chartId: string | undefined
	readonly diagram: DiagramIds | undefined
	// Text box stories inside (shape, group or canvas text boxes), each a child item of the drawing.
	readonly textboxes: number
}

export type VmlKind = "picture" | "object"

// A VML w:pict or OLE w:object. `shape` is the first v:* drawing element (not v:shapetype).
export interface VmlInfo {
	readonly index: number
	readonly part: number
	readonly item: number
	readonly node: number
	readonly kind: VmlKind
	readonly shape: number
	readonly shapeType: string | undefined
	readonly imageData: number
	readonly imageId: string | undefined
	// v:textpath: WordArt and header watermarks.
	readonly textPath: number
	readonly ole: number
	readonly oleId: string | undefined
	readonly progId: string | undefined
	readonly textboxes: number
}

function textInteger(reader: PartReader, node: number): number | undefined {
	if (node < 0) return undefined

	const document = reader.document
	const child = document.firstChild(node)

	if (child < 0 || document.kinds[child] !== NodeKind.Text) return undefined

	const value = parseInteger(document.bytes, document.start(child), document.end(child), Number.NaN)

	return Number.isNaN(value) ? undefined : value
}

function textValue(reader: PartReader, node: number): string | undefined {
	return node < 0 ? undefined : reader.text(node).trim()
}

function position(reader: PartReader, node: number, percentName: string): AnchorPosition | undefined {
	if (node < 0) return undefined

	const document = reader.document
	let percentNode = -1

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === percentName) percentNode = child
	}

	return {
		relativeFrom: reader.attr(node, Ns.None, "relativeFrom"),
		align: textValue(reader, reader.child(node, Ns.WP, "align")),
		offset: textInteger(reader, reader.child(node, Ns.WP, "posOffset")),
		percentOffset: textInteger(reader, percentNode)
	}
}

const WRAPS: readonly (readonly [string, WrapType])[] = [
	["wrapNone", "none"],
	["wrapSquare", "square"],
	["wrapTight", "tight"],
	["wrapThrough", "through"],
	["wrapTopAndBottom", "topAndBottom"]
]

function onOffAttribute(reader: PartReader, node: number, name: string): boolean {
	return reader.flag(node, Ns.None, name)
}

function anchor(reader: PartReader, frame: number): AnchorInfo {
	const document = reader.document
	const simple = reader.child(frame, Ns.WP, "simplePos")
	let wrap: WrapType = "unknown"
	let wrapNode = -1

	for (let child = document.firstChildElement(frame); child >= 0 && wrapNode < 0; child = document.nextSiblingElement(child)) {
		if (reader.group(child) !== Ns.WP) continue

		const local = document.localName(child)

		for (const [name, type] of WRAPS) {
			if (local === name) {
				wrap = type
				wrapNode = child
			}
		}
	}

	return {
		behindDoc: onOffAttribute(reader, frame, "behindDoc"),
		locked: onOffAttribute(reader, frame, "locked"),
		layoutInCell: onOffAttribute(reader, frame, "layoutInCell"),
		allowOverlap: onOffAttribute(reader, frame, "allowOverlap"),
		relativeHeight: reader.int(frame, Ns.None, "relativeHeight", 0),
		simplePos: onOffAttribute(reader, frame, "simplePos"),
		simpleX: simple < 0 ? 0 : reader.int(simple, Ns.None, "x", 0),
		simpleY: simple < 0 ? 0 : reader.int(simple, Ns.None, "y", 0),
		horizontal: position(reader, reader.child(frame, Ns.WP, "positionH"), "pctPosHOffset"),
		vertical: position(reader, reader.child(frame, Ns.WP, "positionV"), "pctPosVOffset"),
		wrap,
		wrapText: wrapNode < 0 ? undefined : reader.attr(wrapNode, Ns.None, "wrapText"),
		wrapNode
	}
}

// Reads a w:drawing's frame and graphic. `textboxes` is filled in by the builder once nested stories exist.
export function readDrawing(reader: PartReader, node: number, index: number, part: number, item: number, textboxes: number): DrawingInfo {
	const document = reader.document
	let frame = -1
	let placement: DrawingPlacement = "unknown"

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.group(child) !== Ns.WP) continue

		const local = document.localName(child)

		if (local === "inline" || local === "anchor") {
			frame = child
			placement = local

			break
		}
	}

	const scope = frame < 0 ? node : frame
	const extent = frame < 0 ? -1 : reader.child(frame, Ns.WP, "extent")
	const effect = frame < 0 ? -1 : reader.child(frame, Ns.WP, "effectExtent")
	const docPr = frame < 0 ? -1 : reader.child(frame, Ns.WP, "docPr")
	const graphic = reader.descendant(scope, Ns.A, "graphic")
	const graphicData = graphic < 0 ? -1 : reader.child(graphic, Ns.A, "graphicData")
	const graphicUri = graphicData < 0 ? undefined : reader.attr(graphicData, Ns.None, "uri")
	const kind: GraphicKind = graphicUri === undefined ? "unknown" : (GRAPHIC_URIS.get(graphicUri) ?? "unknown")
	let blip = -1
	let chartId: string | undefined
	let diagram: DiagramIds | undefined

	if (graphicData >= 0) {
		if (kind === "picture") {
			blip = reader.descendant(graphicData, Ns.A, "blip")
		} else if (kind === "chart") {
			const chart = reader.child(graphicData, Ns.C, "chart")

			chartId = chart < 0 ? undefined : reader.attr(chart, Ns.R, "id")
		} else if (kind === "smartArt") {
			const ids = reader.child(graphicData, Ns.Dgm, "relIds")

			if (ids >= 0) {
				diagram = {
					data: reader.attr(ids, Ns.R, "dm"),
					layout: reader.attr(ids, Ns.R, "lo"),
					style: reader.attr(ids, Ns.R, "qs"),
					colors: reader.attr(ids, Ns.R, "cs")
				}
			}
		}
	}

	return {
		index,
		part,
		item,
		node,
		frame,
		placement,
		graphic: kind,
		graphicUri,
		graphicData,
		width: extent < 0 ? 0 : reader.int(extent, Ns.None, "cx", 0),
		height: extent < 0 ? 0 : reader.int(extent, Ns.None, "cy", 0),
		effectLeft: effect < 0 ? 0 : reader.int(effect, Ns.None, "l", 0),
		effectTop: effect < 0 ? 0 : reader.int(effect, Ns.None, "t", 0),
		effectRight: effect < 0 ? 0 : reader.int(effect, Ns.None, "r", 0),
		effectBottom: effect < 0 ? 0 : reader.int(effect, Ns.None, "b", 0),
		distTop: frame < 0 ? 0 : reader.int(frame, Ns.None, "distT", 0),
		distBottom: frame < 0 ? 0 : reader.int(frame, Ns.None, "distB", 0),
		distLeft: frame < 0 ? 0 : reader.int(frame, Ns.None, "distL", 0),
		distRight: frame < 0 ? 0 : reader.int(frame, Ns.None, "distR", 0),
		docPr,
		docPrId: docPr < 0 ? -1 : reader.int(docPr, Ns.None, "id", -1),
		hidden: docPr >= 0 && onOffAttribute(reader, docPr, "hidden"),
		anchor: placement === "anchor" ? anchor(reader, frame) : undefined,
		blip,
		embedId: blip < 0 ? undefined : reader.attr(blip, Ns.R, "embed"),
		linkId: blip < 0 ? undefined : reader.attr(blip, Ns.R, "link"),
		chartId,
		diagram,
		textboxes
	}
}

// A picture's accessible name: wp:docPr@descr (alternative text), else its @title (ECMA-376 Part 1 §20.4.2.5,
// CT_NonVisualDrawingProps); "" for none.
export function drawingAltText(reader: PartReader, docPr: number): string {
	if (docPr < 0) return ""

	const descr = reader.attr(docPr, Ns.None, "descr")?.trim() ?? ""

	return descr !== "" ? descr : (reader.attr(docPr, Ns.None, "title")?.trim() ?? "")
}

// A VML shape's: v:shape@alt, else @title (ECMA-376 Part 4 §19.1.2.19, the shape's core attributes).
export function vmlAltText(reader: PartReader, shape: number): string {
	if (shape < 0) return ""

	const alt = reader.attr(shape, Ns.None, "alt")?.trim() ?? ""

	return alt !== "" ? alt : (reader.attr(shape, Ns.None, "title")?.trim() ?? "")
}

export function readVml(
	reader: PartReader,
	node: number,
	kind: VmlKind,
	index: number,
	part: number,
	item: number,
	textboxes: number
): VmlInfo {
	const document = reader.document
	const end = document.end(node)
	let shape = -1
	let imageData = -1
	let textPath = -1
	let ole = -1

	// Text boxes and DrawingML previews are stories and drawings of their own: their pictures are not this
	// shape's.
	for (let n = node + 1; n < document.count && document.start(n) < end;) {
		if (document.kinds[n] !== NodeKind.Element) {
			n++

			continue
		}

		const group = reader.group(n)
		const local = document.localName(n)

		if (group === Ns.W && (local === "txbxContent" || local === "drawing")) {
			n = afterSubtree(document, n, node)

			continue
		}

		if (group === Ns.V) {
			if (shape < 0 && local !== "shapetype") shape = n
			if (imageData < 0 && local === "imagedata") imageData = n
			if (textPath < 0 && local === "textpath") textPath = n
		} else if (
			ole < 0 &&
			((group === Ns.O && local === "OLEObject") || (group === Ns.W && (local === "objectEmbed" || local === "objectLink")))
		) {
			ole = n
		}

		n++
	}

	return {
		index,
		part,
		item,
		node,
		kind,
		shape,
		shapeType: shape < 0 ? undefined : document.localName(shape),
		imageData,
		imageId: imageData < 0 ? undefined : (reader.attr(imageData, Ns.R, "id") ?? reader.attr(imageData, Ns.O, "relid")),
		textPath,
		ole,
		oleId: ole < 0 ? undefined : reader.attr(ole, Ns.R, "id"),
		progId: ole < 0 ? undefined : (reader.attr(ole, Ns.None, "ProgID") ?? reader.attr(ole, Ns.W, "progId")),
		textboxes
	}
}
