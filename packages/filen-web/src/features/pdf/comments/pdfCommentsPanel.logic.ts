import type { PdfAnnotationRef, PdfComment, PdfCommentThread, PdfReviewState } from "@filen/office/core/pdfedit/annotations"
import type { CommentThread, ThreadComment } from "@/features/office/components/commentThreads.logic"

// The document's annotation threads as the generic thread list takes them. A thread's id is its annotation's object
// number (unique in the document); every comment keeps its annotation's ref for the callbacks. The author's name keys
// its colour (PDF annotations carry no author id). Text is the engine's plain text, never markup.

export interface PdfThreadComment extends ThreadComment {
	readonly ref: PdfAnnotationRef
}

// A state set in another app shown beside an unresolved thread (None and Completed have none: Completed is resolved).
export type PdfStateLabel = (state: "Accepted" | "Rejected" | "Cancelled") => string

function isoDate(ms: number | null): string {
	return ms === null || !Number.isFinite(ms) ? "" : new Date(ms).toISOString()
}

function commentOf(comment: PdfComment, page: number): PdfThreadComment {
	return {
		id: String(comment.id),
		author: comment.author,
		authorId: comment.author,
		text: comment.text,
		created: isoDate(comment.created),
		editable: true,
		ref: { page, id: comment.id }
	}
}

function statusOf(state: PdfReviewState, label: PdfStateLabel): string | undefined {
	return state === "None" || state === "Completed" ? undefined : label(state)
}

// `page`: the label of a 0-based page index ("Page 3" for index 2).
export function pdfThreads(
	threads: readonly PdfCommentThread[],
	page: (index: number) => string,
	state: PdfStateLabel
): CommentThread<PdfThreadComment>[] {
	return threads.map(thread => {
		const status = statusOf(thread.state, state)

		return {
			root: commentOf(thread.root, thread.page),
			replies: thread.replies.map(reply => commentOf(reply, thread.page)),
			resolved: thread.state === "Completed",
			resolvable: true,
			detail: page(thread.page),
			...(status === undefined ? {} : { status })
		}
	})
}

// The id of the thread `ref` starts or replies in; undefined when it carries none.
export function threadOfRef(threads: readonly PdfCommentThread[], ref: PdfAnnotationRef): string | undefined {
	for (const thread of threads) {
		if (thread.page !== ref.page) continue
		if (thread.root.id === ref.id || thread.replies.some(reply => reply.id === ref.id)) return String(thread.root.id)
	}

	return undefined
}
