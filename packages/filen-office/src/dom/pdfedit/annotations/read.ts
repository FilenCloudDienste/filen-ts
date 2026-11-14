import type { PDFAnnotation, PDFDocument, PDFObject } from "mupdf"
import {
	isReviewState,
	richTextToPlain,
	type PdfAnnotationInfo,
	type PdfComment,
	type PdfCommentThread,
	type PdfReviewState
} from "../../../core/pdfedit/annotations"
import { annotationId, colorOf, dateOf, isLocked, loadPage, NOT_COMMENTABLE, POINT_TYPES, RECT_TYPES, rectOf, textOf } from "./shared"

// Reading annotations for the select tool, the popover and the Comments panel. Nothing here changes the document.

// The deepest reply chain followed to its thread's root.
const MAX_REPLY_DEPTH = 64

function referenced(object: PDFObject, key: string): number | null {
	const value = object.get(key)

	return value.isIndirect() ? value.asIndirect() : null
}

// The annotation's note as plain text: /Contents, or its rich text reduced to text when /Contents is empty.
export function plainTextOf(annotation: PDFAnnotation): string {
	const contents = annotation.getContents()

	if (contents !== "" || !annotation.hasRichContents()) return contents

	return richTextToPlain(annotation.getRichContents())
}

function opacityOf(object: PDFObject): number {
	const value = object.get("CA")

	return value.isNumber() ? Math.min(1, Math.max(0, value.asNumber())) : 1
}

function infoOf(annotation: PDFAnnotation, page: number): PdfAnnotationInfo {
	const type = annotation.getType()
	const object = annotation.getObject()
	const markup = annotation.hasAuthor()
	const freeText = type === "FreeText"

	return {
		page,
		id: annotationId(annotation),
		type,
		rect: rectOf(annotation.hasRect() ? annotation.getRect() : annotation.getBounds()),
		// A text box's colour is its text's (its default appearance); /C would be its background.
		color: freeText ? colorOf(annotation.getDefaultAppearance().color) : colorOf(annotation.getColor()),
		interiorColor: annotation.hasInteriorColor() ? colorOf(annotation.getInteriorColor()) : null,
		opacity: opacityOf(object),
		width: annotation.hasBorder() ? annotation.getBorderWidth() : 0,
		author: markup ? annotation.getAuthor() : "",
		created: markup ? dateOf(() => annotation.getCreationDate()) : null,
		modified: markup ? dateOf(() => annotation.getModificationDate()) : null,
		text: plainTextOf(annotation),
		replyTo: referenced(object, "IRT"),
		geometry: RECT_TYPES.has(type) ? "rect" : POINT_TYPES.has(type) ? "points" : null,
		locked: isLocked(annotation)
	}
}

// The annotations drawn on page `index`, in drawing order (the last is on top): every annotation except popups, links
// (listLinks) and replies or review states (readCommentThreads). Widgets are not annotations here (forms own them).
export function listAnnotations(document: PDFDocument, index: number): PdfAnnotationInfo[] {
	const page = loadPage(document, index)
	const out: PdfAnnotationInfo[] = []

	for (const annotation of page.getAnnotations()) {
		const type = annotation.getType()

		if (type === "Popup" || type === "Link" || annotation.getObject().get("IRT").isIndirect()) continue

		out.push(infoOf(annotation, index))
	}

	return out
}

// One annotation's info, or null when it is gone.
export function readAnnotation(document: PDFDocument, page: number, id: number): PdfAnnotationInfo | null {
	for (const annotation of loadPage(document, page).getAnnotations()) if (annotationId(annotation) === id) return infoOf(annotation, page)

	return null
}

interface Entry {
	readonly annotation: PDFAnnotation
	readonly id: number
	readonly parent: number | null
	readonly state: PdfReviewState | null
}

function commentOf(entry: Entry): PdfComment {
	const annotation = entry.annotation
	const markup = annotation.hasAuthor()

	return {
		id: entry.id,
		author: markup ? annotation.getAuthor() : "",
		text: plainTextOf(annotation),
		created: markup ? dateOf(() => annotation.getCreationDate()) : null,
		modified: markup ? dateOf(() => annotation.getModificationDate()) : null
	}
}

function stateOf(object: PDFObject): PdfReviewState | null {
	if (textOf(object.get("StateModel")) !== "Review") return null

	const name = textOf(object.get("State"))

	return name !== null && isReviewState(name) ? name : null
}

// The comment threads of the given pages (every page when omitted), page by page in drawing order. A thread's root is
// a sticky note, or any other markup annotation with a note or with replies; replies to replies join their root's
// thread; review states (Review state model) set the thread's state, the latest by modification date winning. Replies
// whose root is on another page or gone are dropped (no viewer can show them).
export function readCommentThreads(document: PDFDocument, pages?: Iterable<number>): PdfCommentThread[] {
	const out: PdfCommentThread[] = []

	for (const index of pages ?? Array.from({ length: document.countPages() }, (_, page) => page)) {
		const entries = new Map<number, Entry>()

		for (const annotation of loadPage(document, index).getAnnotations()) {
			const type = annotation.getType()

			if (NOT_COMMENTABLE.has(type) || !annotation.hasAuthor()) continue

			const object = annotation.getObject()
			const id = annotationId(annotation)

			// A group member (RT /Group) is part of its parent's appearance, not a reply.
			if (textOf(object.get("RT")) === "Group") continue

			entries.set(id, { annotation, id, parent: referenced(object, "IRT"), state: stateOf(object) })
		}

		const rootOf = (entry: Entry): number | null => {
			let current = entry

			for (let depth = 0; depth < MAX_REPLY_DEPTH; depth++) {
				if (current.parent === null) return current.id

				const next = entries.get(current.parent)

				if (next === undefined) return null

				current = next
			}

			return null
		}
		const replies = new Map<number, Entry[]>()
		const states = new Map<number, { state: PdfReviewState; at: number }>()

		for (const entry of entries.values()) {
			if (entry.parent === null) continue

			const root = rootOf(entry)

			if (root === null) continue

			if (entry.state !== null) {
				const at = dateOf(() => entry.annotation.getModificationDate()) ?? 0
				const known = states.get(root)

				if (known === undefined || at >= known.at) states.set(root, { state: entry.state, at })
			} else {
				const list = replies.get(root) ?? []

				list.push(entry)
				replies.set(root, list)
			}
		}

		for (const entry of entries.values()) {
			if (entry.parent !== null) continue

			const type = entry.annotation.getType()
			const thread = replies.get(entry.id) ?? []
			const root = commentOf(entry)

			if (type !== "Text" && root.text === "" && thread.length === 0) continue

			out.push({
				page: index,
				root: {
					...root,
					type,
					rect: rectOf(entry.annotation.hasRect() ? entry.annotation.getRect() : entry.annotation.getBounds())
				},
				replies: thread.map(commentOf).sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.id - b.id),
				state: states.get(entry.id)?.state ?? "None"
			})
		}
	}

	return out
}
