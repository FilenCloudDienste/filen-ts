import { insertedMediaContent, insertedMediaId, insertedMediaWritten } from "../../../presentation/edit/apply/media"
import { pictureFillOf } from "../../../presentation/edit/apply/picture"
import { refused, type Refused, type ShapeNode } from "../../../presentation/model"
import { RELATIONSHIP_TYPES } from "../parts"
import type { EmitPiece, EmitResult, PptxEmitFamily } from "../types"
import { blipFillXml, pictureElement } from "./picture"
import { Pieces, attr, lineMarkup, readerOf, sourceNode, xfrmXml, type EmitContext } from "./shape"

// The media family's PresentationML: a p:pic playing a medium (ECMA-376 Part 1 §19.3.1.37 with §20.1.3.6 a:videoFile
// or §20.1.3.1 a:audioFile in p:nvPr, and PowerPoint 2010's p14:media naming the embedded copy it plays). A medium
// the file has is the picture family's element (its poster fill, box and properties edited; p:nvPr and its media
// references kept as source). A medium an op inserted is written whole: its stored part streamed from where the
// worker registered it (read once, checked against the CRC-32 taken at insert), related twice as PowerPoint does
// (the a:videoFile/a:audioFile link and the p14:media embed), and its poster as the picture fill. Once a save wrote it,
// the part it was written to is related instead (nothing is read or added again).

const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
const P14_MEDIA_EXT = "{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"

// The medium's part and its embed relationship: the part a save wrote it to, else its bytes added as a new part.
function mediaPart(context: EmitContext, id: number): { readonly part: string; readonly rId: string } | Refused {
	const written = context.deck.format === "pptx" ? insertedMediaWritten(context.deck, id) : undefined

	if (written !== undefined) return { part: written, rId: context.parts.relate(written, RELATIONSHIP_TYPES.media) }

	const content = insertedMediaContent(context.deck, id)

	if (content === undefined) return refused("stale", `The inserted medium ${String(id)} is not held`)

	return context.parts.addPart("media", content.bytes, content.contentType, { crc32: content.crc32 })
}

function newMedia(context: EmitContext, shape: ShapeNode, id: number): EmitResult {
	const media = shape.media
	const fill = pictureFillOf(shape)

	if (media === undefined || shape.xfrm === undefined) return refused("malformed", "A new medium without its medium or box")
	if (insertedMediaWritten(context.deck, id) === undefined && insertedMediaContent(context.deck, id) === undefined)
		return refused("stale", `The inserted medium ${String(id)} is not held`)
	if (fill === undefined) return refused("malformed", "A new medium without a poster")

	const blipFill = blipFillXml(context, fill, -1)

	if (!Array.isArray(blipFill)) return blipFill as Refused

	const ln = shape.props?.ln === undefined ? "" : lineMarkup(context, shape.props.ln)

	if (typeof ln !== "string") return ln

	const added = mediaPart(context, id)

	if ("kind" in added) return added

	const { part, rId: embed } = added
	const link = context.parts.relate(part, `${RELATIONSHIPS}${media.kind}`)
	const alt = shape.alt

	return new Pieces()
		.text(
			`<p:pic><p:nvPicPr><p:cNvPr${attr("id", shape.id)}${attr("name", shape.name)}${attr("descr", alt?.descr)}` +
				`${shape.hidden ? ' hidden="1"' : ""}${attr("title", alt?.title)}>` +
				`${shape.actions?.click?.kind === "media" ? '<a:hlinkClick r:id="" action="ppaction://media"/>' : ""}</p:cNvPr>` +
				'<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>' +
				`<p:nvPr><a:${media.kind}File r:link="${link}"/><p:extLst><p:ext uri="${P14_MEDIA_EXT}">` +
				`<p14:media xmlns:p14="${P14}" r:embed="${embed}"/></p:ext></p:extLst></p:nvPr></p:nvPicPr>`
		)
		.append(blipFill as readonly EmitPiece[])
		.text(`<p:spPr>${xfrmXml("a:xfrm", shape.xfrm, false)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${ln}</p:spPr></p:pic>`)
		.markup()
}

export const emitPptxMedia: PptxEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		if (shape === undefined) return refused("failed", "A media emit without a shape")

		const emitContext: EmitContext = context
		const id = insertedMediaId(shape.media?.part)

		if (id !== undefined && (readerOf(emitContext) === undefined || sourceNode(emitContext, shape.src) < 0))
			return newMedia(emitContext, shape, id)

		// A medium in a graphic frame is the shape family's to move; nothing of its content is written from the model.
		if (shape.kind !== "pic") return refused("notImplemented", "pptx emit media in a frame")

		return pictureElement(emitContext, shape)
	}
}
