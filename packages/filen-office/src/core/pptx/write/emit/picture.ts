import { insertedImage, insertedImageWritten, pictureFillOf, type PictureFill } from "../../../presentation/edit/apply/picture"
import { adjustXml } from "../../../presentation/render/markup"
import { refused, type EdgeFractions, type Refused, type ShapeNode } from "../../../presentation/model"
import type { Relationships } from "../../../opc/index"
import type { DeckTally } from "../../../presentation/budget"
import type { XmlDocument } from "../../../xml/index"
import { readBlipFill } from "../../read/drawing"
import { G, partReader, type PartReader } from "../../read/xml"
import type { EmitPiece, EmitResult, PptxEmitFamily } from "../types"
import {
	IMAGE_RELATIONSHIP,
	Pieces,
	attr,
	lineMarkup,
	readerOf,
	shapeElement,
	sourceNode,
	unmodeledAttributes,
	xfrmXml,
	type EmitContext
} from "./shape"

// The picture family's PresentationML: p:pic (ECMA-376 Part 1 §19.3.1.37). A picture with no typed fill is the shape
// family's (its p:blipFill kept as source). A typed fill (an edit: crop, adjustments, another image) writes
// p:blipFill from the model: a:blip naming the image's part (an inserted image added as a new part here), its
// adjustments, a:srcRect and a:stretch or a:tile; what the model does not hold of the source a:blip (its other
// effects, its extension list: a:svgBlip, a:imgProps) stays. A picture an op made is written whole.

const ADJUST_LOCALS: ReadonlySet<string> = new Set(["lum", "grayscl", "biLevel", "duotone", "alphaModFix"])

function edges(name: string, value: EdgeFractions | undefined): string {
	return value === undefined ? "" : `<a:${name}${attr("l", value.l)}${attr("t", value.t)}${attr("r", value.r)}${attr("b", value.b)}/>`
}

// The image's relationship id: an existing part related from the owner, an inserted image added as a part (once: a
// save that wrote it makes it that part).
function imageId(context: EmitContext, fill: PictureFill): string | Refused {
	if (fill.part !== undefined) return context.parts.relate(fill.part, IMAGE_RELATIONSHIP)
	if (fill.inserted === undefined) return refused("malformed", "A picture fill naming no image")

	const image = insertedImage(context.deck, fill.inserted)

	if (image !== undefined) return context.parts.addPart("image", image.bytes, image.contentType).rId

	// One a committed save wrote: the part it became, related again.
	const written = insertedImageWritten(context.deck, fill.inserted)

	if (written === undefined) return refused("stale", `The inserted image ${String(fill.inserted)} is not held`)

	return context.parts.relate(written.part, IMAGE_RELATIONSHIP)
}

// p:blipFill of a typed fill; `source` the source p:blipFill (its a:blip's other children and attributes kept).
export function blipFillXml(context: EmitContext, fill: PictureFill, source: number): readonly EmitPiece[] | Refused {
	const r = readerOf(context)
	const blip = r === undefined || source < 0 ? -1 : r.child(source, G.A, "blip")
	const id = imageId(context, fill)

	if (typeof id !== "string") return id

	const out = new Pieces().text(`<p:blipFill${unmodeledAttributes(context, source, new Set())}>`)
	const adjust = fill.adjust === undefined ? undefined : adjustXml(fill.adjust)

	out.text(
		`<a:blip r:embed="${id}"${unmodeledAttributes(context, blip, new Set(["r:embed", "r:link"])).replace(/ r:(?:embed|link)="[^"]*"/gu, "")}>`
	)

	for (let child = blip < 0 || r === undefined ? -1 : r.first(blip); child >= 0 && r !== undefined; child = r.next(child)) {
		const adjusting = r.group(child) === G.A && ADJUST_LOCALS.has(r.local(child))

		// The model's adjustments go before the source's other effects and its extension list.
		if (adjust !== undefined && adjusting) continue
		if (r.local(child) === "extLst" && adjust !== undefined) out.text(adjust).hole(child)
		else out.hole(child)
	}

	if (adjust !== undefined && (blip < 0 || r?.child(blip, G.A, "extLst") === -1)) out.text(adjust)

	out.text("</a:blip>").text(edges("srcRect", fill.crop))

	if (fill.tile !== undefined) {
		const tile = fill.tile

		out.text(
			`<a:tile${attr("tx", tile.tx)}${attr("ty", tile.ty)}${attr("sx", tile.sx)}${attr("sy", tile.sy)}${attr("flip", tile.flip)}${attr("algn", tile.algn)}/>`
		)
	} else {
		const stretch = fill.stretch
		const whole = stretch === undefined || (stretch.l === 0 && stretch.t === 0 && stretch.r === 0 && stretch.b === 0)

		out.text(`<a:stretch>${whole ? "<a:fillRect/>" : edges("fillRect", stretch)}</a:stretch>`)
	}

	return out.text("</p:blipFill>").out
}

function newPicture(context: EmitContext, shape: ShapeNode, fill: PictureFill): EmitResult {
	if (shape.xfrm === undefined) return refused("unsupported", "A new picture without a box")

	const blipFill = blipFillXml(context, fill, -1)

	if (!Array.isArray(blipFill)) return blipFill as Refused

	const alt = shape.alt
	const ln = shape.props?.ln === undefined ? "" : lineMarkup(context, shape.props.ln)

	if (typeof ln !== "string") return ln

	return new Pieces()
		.text(
			`<p:pic><p:nvPicPr><p:cNvPr${attr("id", shape.id)}${attr("name", shape.name)}${attr("descr", alt?.descr)}` +
				`${shape.hidden ? ' hidden="1"' : ""}${attr("title", alt?.title)}/>` +
				'<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
		)
		.append(blipFill as readonly EmitPiece[])
		.text(`<p:spPr>${xfrmXml("a:xfrm", shape.xfrm, false)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${ln}</p:spPr></p:pic>`)
		.markup()
}

function sourceBlipFill(r: PartReader | undefined, source: number): number {
	return r === undefined || source < 0 ? -1 : r.child(source, G.P, "blipFill")
}

export function pictureElement(context: EmitContext, shape: ShapeNode): EmitResult {
	const fill = pictureFillOf(shape)

	if (fill === undefined) return shapeElement(context, shape)

	const r = readerOf(context)
	const source = sourceNode(context, shape.src)

	if (source < 0 || r === undefined) return newPicture(context, shape, fill)

	const blipFill = sourceBlipFill(r, source)
	// The shape family writes the rest (non-visual properties, spPr without the picture fill, which is p:blipFill's).
	const { fill: _fill, ...props } = shape.props ?? {}
	const { props: _props, ...bare } = shape
	const rest = shapeElement(context, Object.keys(props).length === 0 ? bare : { ...bare, props })

	if (rest.kind !== "markup") return rest

	const markup = blipFillXml(context, fill, blipFill)

	if (!Array.isArray(markup)) return markup as Refused

	const out = new Pieces()
	let replaced = false

	for (const piece of rest.pieces) {
		if (blipFill >= 0 && typeof piece === "object" && !(piece instanceof Uint8Array) && piece.hole === blipFill) {
			out.append(markup as readonly EmitPiece[])
			replaced = true
		} else {
			out.append([piece])
		}
	}

	// CT_Picture requires p:blipFill; a source without one cannot take the edit.
	if (!replaced) return refused("malformed", "A picture without p:blipFill")

	return out.markup()
}

// A source picture's own fill (its p:blipFill read as the model's picture fill), for the first edit of it; undefined
// when it has none. `relationships` are those of the part the picture's slide is.
export function sourcePictureFill(
	document: XmlDocument,
	shape: ShapeNode,
	relationships: Relationships,
	tally: DeckTally
): PictureFill | undefined {
	const src = shape.src

	if (src?.format !== "pptx") return undefined

	const r = partReader(document)
	const node = r.child(src.node, G.P, "blipFill")
	const fill =
		node < 0
			? undefined
			: readBlipFill({ reader: r, part: src.part, epoch: src.epoch, relationships, tally, action: () => undefined }, node)

	return fill?.kind === "picture" ? fill : undefined
}

export const emitPptxPicture: PptxEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		if (shape === undefined) return refused("failed", "A picture emit without a shape")

		return pictureElement(context, shape)
	}
}
