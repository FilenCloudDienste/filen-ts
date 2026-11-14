import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import type { CommentView, DeckOp, SlideReview } from "@filen/office/core/presentation"
import { CommentThreads, type CommentThreadActions, type CommentThreadLabels } from "@/features/office/components/commentThreads"
import type { CommentThread } from "@/features/office/components/commentThreads.logic"
import { useOfficeSettings } from "@/features/office/lib/officeSettings"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { newCommentGuid, slideReview, useSlideReview, useSlideReviewState } from "@/features/presentation/components/commentsPane.logic"

// The Comments pane beside the slide (Review ▸ Show Comments): the slide's threads (modern, legacy or ODF comments,
// core/presentation/comments.ts) on the generic thread list (office/components/commentThreads.tsx), every change one
// comment op. The slide's review and the pane's state come from commentsPane.logic.ts. Only modern threads resolve.

// A new comment or reply carries the user's own initials (Settings, Office) when given; the deck derives them
// from the name otherwise.
function withInitials(op: DeckOp, initials: string | null): DeckOp {
	return initials !== null && op.family === "comment" && (op.kind === "add" || op.kind === "reply")
		? { ...op, authorInitials: initials }
		: op
}

function threadsOf(review: SlideReview | undefined): CommentThread<CommentView>[] {
	const out: { root: CommentView; replies: CommentView[]; resolved: boolean; resolvable: boolean }[] = []

	for (const comment of review?.comments ?? []) {
		const last = out[out.length - 1]

		if (comment.parent !== undefined && last?.root.id === comment.parent) last.replies.push(comment)
		else out.push({ root: comment, replies: [], resolved: comment.resolved, resolvable: comment.format === "modern" })
	}

	return out
}

// A comment's text as the deck takes it: U+000B, the soft line break PowerPoint and Word put on the clipboard, is a
// line break (every comment form writes a line as its own paragraph and reads a DrawingML <a:br/> back as one).
function commentText(text: string): string {
	return text.replaceAll("\u000b", "\n")
}

export function PresentationCommentsPane({
	editor,
	editable,
	phone
}: {
	editor: PresentationRibbonEditor | undefined
	editable: boolean
	phone: boolean
}) {
	const { t } = useTranslation("preview")
	const state = useSlideReviewState()
	const review = useSlideReview(editor, state.open)
	const settings = useOfficeSettings()
	const threads = threadsOf(review)
	const slide = editor?.render?.ref

	// Another slide in view (the pane open or not) closes the thread and the field the last one had.
	const seen = useRef(slide)

	useEffect(() => {
		if (seen.current !== undefined && seen.current !== slide) slideReview.leaveSlide()

		seen.current = slide
	}, [slide])

	const labels: CommentThreadLabels = {
		title: t("previewPptxCommentsTitle"),
		close: t("previewPptxCommentsClose"),
		list: t("previewPptxCommentsList"),
		empty: t("previewPptxCommentsEmpty"),
		loading: t("previewPptxCommentsLoading"),
		failed: t("previewPptxCommentsFailed"),
		new: t("previewPptxCommentNew"),
		placeholder: t("previewPptxCommentPlaceholder"),
		replyPlaceholder: t("previewPptxCommentReplyPlaceholder"),
		post: t("previewPptxCommentPost"),
		reply: t("previewPptxCommentReply"),
		save: t("previewPptxCommentSave"),
		actions: t("previewPptxCommentActions"),
		edit: t("previewPptxCommentEdit"),
		delete: t("previewPptxCommentDelete"),
		deleteThread: t("previewPptxCommentDeleteThread"),
		resolve: t("previewPptxCommentResolve"),
		reopen: t("previewPptxCommentReopen"),
		resolved: t("previewPptxCommentResolved"),
		back: t("previewPptxCommentBack"),
		unknownAuthor: t("previewPptxCommentUnknownAuthor"),
		noResolve: t("previewPptxCommentNoResolve"),
		replies: count => t("previewPptxCommentReplies", { count }),
		thread: (author, date, excerpt) =>
			date === ""
				? t("previewPptxCommentThreadUndated", { author, excerpt })
				: t("previewPptxCommentThread", { author, date, excerpt })
	}

	if (editor === undefined || slide === undefined) return null

	// A refusal is told by the editor (one toast) and changes nothing.
	const command = async (op: DeckOp): Promise<boolean> => (await editor.command(withInitials(op, settings.authorInitials))).ok
	const actions: CommentThreadActions<CommentView> = {
		reply: (thread, text, author) =>
			command({
				family: "comment",
				kind: "reply",
				slide,
				parent: thread.root.id,
				comment: { id: newCommentGuid(), author: newCommentGuid(), text: commentText(text), created: new Date().toISOString() },
				authorName: author
			}),
		edit: (_thread, comment, text) => command({ family: "comment", kind: "edit", slide, id: comment.id, text: commentText(text) }),
		remove: (_thread, comment) => command({ family: "comment", kind: "delete", slide, id: comment.id }),
		resolve: (thread, resolved) => command({ family: "comment", kind: "resolve", slide, id: thread.root.id, resolved }),
		post: async (text, author) => {
			const id = newCommentGuid()
			const ok = await command({
				family: "comment",
				kind: "add",
				slide,
				comment: { id, author: newCommentGuid(), text: commentText(text), created: new Date().toISOString() },
				authorName: author
			})

			return ok ? id : null
		}
	}

	return (
		<CommentThreads
			open={state.open}
			scope={slide}
			threads={threads}
			loaded={review !== undefined}
			failed={state.failed}
			labels={labels}
			editable={editable}
			phone={phone}
			thread={state.thread}
			composing={state.composing}
			onOpenThread={slideReview.openThread}
			onClose={() => {
				slideReview.setOpen(false)
			}}
			onNew={() => {
				slideReview.openThread(undefined)
				slideReview.compose(true)
			}}
			onComposeEnd={() => {
				slideReview.compose(false)
			}}
			askAuthorOnEveryChange
			actions={actions}
		/>
	)
}
