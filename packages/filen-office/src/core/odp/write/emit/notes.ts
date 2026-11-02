import { notesBody } from "../../../presentation/notes"
import { refused, type Refused, type SlideNode } from "../../../presentation/model"
import { escapeAttribute, type XmlEditor } from "../../../xml/index"
import { isAnnotation } from "../../read/annotations"
import type { Fragment } from "../../read/context"
import type { OdpEmitContext, OdpEmitFamily } from "../emit"
import { OdpStyles, styleChanges } from "../styles"
import { boxAttributes, markupOf } from "./shape"

// A page's presentation:notes (ODF 1.3 Part 3 §10.3.4 page thumbnail, §16.9 presentation:notes) when the session made
// the notes (apply/notes.ts): a page thumbnail and a notes frame (presentation:class "notes", §19.432), placed as the
// model holds them, written where the page has none, before its comments (where LibreOffice writes them). An undo after
// a save takes it out again. Notes read from the file are spliced shape by shape (the page splice's container).

export const emitOdpNotes: OdpEmitFamily = {
	emit: request => (request.shape === undefined ? { kind: "unchanged" } : refused("unsupported", "odp emit notes: a shape"))
}

// The shape's name (the reader takes draw:name as it) and its box.
function boxMarkup(shape: { readonly name: string; readonly xfrm?: Parameters<typeof boxAttributes>[0] }): string {
	let out = shape.name === "" ? "" : ` draw:name="${escapeAttribute(shape.name)}"`

	if (shape.xfrm === undefined) return out

	for (const { name, value } of boxAttributes(shape.xfrm)) if (value !== null) out += ` ${name}="${escapeAttribute(value)}"`

	return out
}

// The presentation style a notes frame takes: its master's "<master>-notes" (§16.16 presentation styles name their
// master), else one of its own. LibreOffice imports a frame as a presentation object (its notes) only with one.
function notesStyle(slide: SlideNode, context: OdpEmitContext): string | Refused {
	const styles = context.styles

	if (!(styles instanceof OdpStyles)) return refused("failed", "the save's styles")

	const deck = context.deck
	const layout = slide.parent === undefined ? undefined : deck.nodes.get(slide.parent)
	const master = layout?.parent === undefined ? undefined : deck.nodes.get(layout.parent)
	const base = master?.name === undefined ? undefined : `${master.name}-notes`

	if (base !== undefined && styles.sheet.style("presentation", base, "styles") !== undefined) return base

	return styles.derived("presentation", undefined, styleChanges())
}

// A notes node the session made as presentation:notes markup; `pageNumber`: the slide's (1-based) the thumbnail shows.
export function odpNotesMarkup(slide: SlideNode, notes: SlideNode, pageNumber: number, context: OdpEmitContext): string | Refused {
	const body = notesBody(notes)
	const image = notes.shapes.find(shape => shape.ph?.type === "sldImg")
	let text = ""

	// Notes without any text are a placeholder (presentation:placeholder), as LibreOffice writes an empty one.
	const holdsText = body?.text?.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind !== "r" || run.text !== "")) === true

	if (body?.text !== undefined && body.text.paragraphs.length > 0) {
		if (!(context.styles instanceof OdpStyles)) return refused("failed", "the save's styles")

		const written = markupOf(
			context.styles.env.dispatch(
				"text",
				{ slide: notes, shape: body, touch: { kind: "shape", slide: notes.ref, shape: body.id, dirt: { kind: "text" } } },
				{ ...context, document: undefined, editor: undefined }
			)
		)

		if (typeof written !== "string") return written

		text = written
	}

	const style = body === undefined ? "" : notesStyle(slide, context)

	if (typeof style !== "string") return style

	const thumbnail =
		image === undefined
			? ""
			: `<draw:page-thumbnail${boxMarkup(image)} draw:page-number="${String(pageNumber)}" presentation:class="page"/>`
	const frame =
		body === undefined
			? ""
			: `<draw:frame presentation:style-name="${escapeAttribute(style)}"${boxMarkup(body)} presentation:class="notes"${holdsText ? "" : ' presentation:placeholder="true"'}>${text === "" ? "<draw:text-box/>" : `<draw:text-box>${text}</draw:text-box>`}</draw:frame>`

	return `<presentation:notes>${thumbnail}${frame}</presentation:notes>`
}

function notesElement(fragment: Fragment, page: number): number {
	const document = fragment.document

	for (let child = document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
		if (fragment.name(child) === "presentation:notes") return child
	}

	return -1
}

// The page's notes made as the model has them when the session made or removed them; undefined when they are the
// file's (the page splice writes their shapes).
export function spliceOdpNotes(
	slide: SlideNode,
	notes: SlideNode | undefined,
	pristine: SlideNode | undefined,
	pageNumber: number,
	fragment: Fragment,
	page: number,
	editor: XmlEditor,
	context: OdpEmitContext
): Refused | undefined {
	const element = notesElement(fragment, page)

	if (notes === undefined) {
		// The notes an undo took back after the save that wrote them.
		if (element >= 0) editor.remove(element)

		return undefined
	}

	if (notes.src?.format === "odp" && pristine !== undefined) return undefined

	const markup = odpNotesMarkup(slide, notes, pageNumber, context)

	if (typeof markup !== "string") return markup

	if (element >= 0) {
		editor.replace(element, markup)

		return undefined
	}

	const document = fragment.document

	for (let child = document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
		if (isAnnotation(fragment, child)) {
			editor.insertBefore(child, markup)

			return undefined
		}
	}

	editor.append(page, markup)

	return slide.kind === "slide" ? undefined : refused("unsupported", "notes of a node that is not a slide")
}
