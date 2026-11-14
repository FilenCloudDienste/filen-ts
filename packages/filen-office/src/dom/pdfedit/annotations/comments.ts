import type { PDFAnnotation, PDFDocument, PDFPage } from "mupdf"
import type { PdfAnnotationRef, PdfReviewState } from "../../../core/pdfedit/annotations"
import type { PdfCreated } from "./create"
import {
	annotationId,
	FLAG_HIDDEN,
	FLAG_NO_ROTATE,
	FLAG_NO_VIEW,
	FLAG_NO_ZOOM,
	mutableRect,
	NOT_COMMENTABLE,
	PdfAnnotationError,
	rectOf,
	removeFromAnnots,
	requireAnnotation,
	stampCreated,
	stampModified,
	textOf
} from "./shared"

// Comments on annotations: replies (/IRT, /RT /R) and review states (/StateModel /Review), each a Text annotation
// pointing at the thread's first annotation; readers group them by /IRT. Replies are not drawn on the page (NoView: the
// Comments panel shows them), review states are hidden, as major viewers write them. Editing or deleting a comment
// is setAnnotationText / deleteAnnotation on its ref. Each function is one command and returns the pages it touched.

const REPLY_FLAGS = FLAG_NO_ZOOM | FLAG_NO_ROTATE | FLAG_NO_VIEW
const STATE_FLAGS = FLAG_HIDDEN | FLAG_NO_VIEW | FLAG_NO_ZOOM | FLAG_NO_ROTATE
// A reply's (never drawn) icon box at its root's corner.
const REPLY_SIDE = 16

function commentable(document: PDFDocument, root: PdfAnnotationRef): { page: PDFPage; annotation: PDFAnnotation } {
	const found = requireAnnotation(document, root)
	const type = found.annotation.getType()

	if (NOT_COMMENTABLE.has(type) || !found.annotation.hasAuthor())
		throw new PdfAnnotationError("unsupported", `${type} annotations take no comments`)

	return found
}

// The popup MuPDF gives every new Text annotation: a reply or state shows in the panel, never in a popup.
function dropPopup(page: PDFPage, annotation: PDFAnnotation): void {
	const popup = annotation.getObject().get("Popup")

	if (!popup.isIndirect()) return

	annotation.getObject().delete("Popup")
	removeFromAnnots(page, new Set([popup.asIndirect()]))
}

function childOf(document: PDFDocument, page: PDFPage, root: PDFAnnotation, flags: number): PDFAnnotation {
	const rect = rectOf(root.hasRect() ? root.getRect() : root.getBounds())
	const child = page.createAnnotation("Text")

	child.setRect(mutableRect([rect[0], rect[1], rect[0] + REPLY_SIDE, rect[1] + REPLY_SIDE]))
	child.getObject().put("IRT", root.getObject())
	child.getObject().put("RT", document.newName("R"))
	child.setFlags(flags)
	dropPopup(page, child)

	return child
}

// A reply to the thread of `root` (the thread's first annotation or any reply of it).
export function addReply(
	document: PDFDocument,
	root: PdfAnnotationRef,
	input: { readonly text: string; readonly author: string; readonly now: Date }
): PdfCreated {
	const { page, annotation } = commentable(document, root)
	const reply = childOf(document, page, annotation, REPLY_FLAGS)

	reply.setContents(input.text)
	stampCreated(reply, input.author, input.now)
	reply.update()

	return { ref: { page: root.page, id: annotationId(reply) }, pages: [root.page] }
}

// Sets the review state `author` gives the thread of `root`: that author's earlier state annotation is updated, or a
// new one is made. The thread's state is the latest of all authors' (readCommentThreads).
export function setReviewState(
	document: PDFDocument,
	root: PdfAnnotationRef,
	input: { readonly state: PdfReviewState; readonly author: string; readonly now: Date }
): readonly number[] {
	const { page, annotation } = commentable(document, root)
	const name = document.newString(input.state)

	for (const other of page.getAnnotations()) {
		const object = other.getObject()
		const parent = object.get("IRT")

		if (
			other.getType() === "Text" &&
			parent.isIndirect() &&
			parent.asIndirect() === root.id &&
			textOf(object.get("StateModel")) === "Review" &&
			other.getAuthor() === input.author
		) {
			object.put("State", name)
			other.setContents(input.state)
			stampModified(other, input.now)
			other.update()

			return [root.page]
		}
	}

	const state = childOf(document, page, annotation, STATE_FLAGS)

	state.getObject().put("StateModel", document.newString("Review"))
	state.getObject().put("State", name)
	state.setContents(input.state)
	stampCreated(state, input.author, input.now)
	state.update()

	return [root.page]
}
