import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { PdfAnnotationRef, PdfCommentThread, PdfReviewState } from "@filen/office/core/pdfedit/annotations"
import { CommentThreads, type CommentThreadActions, type CommentThreadLabels } from "@/features/office/components/commentThreads"
import { pdfThreads, threadOfRef, type PdfThreadComment } from "@/features/pdf/comments/pdfCommentsPanel.logic"

// The PDF Comments panel: the document's annotation threads (notes on any annotation, sticky notes, their replies and
// review states) on the generic thread list. Values in, callbacks out: the host applies each change to the document
// and hands the new threads back. Selecting an annotation on the page opens its thread; opening a thread here selects
// its annotation. New comments start on the page (onNew), never here.

export interface PdfCommentsPanelProps {
	readonly threads: readonly PdfCommentThread[]
	readonly editable: boolean
	readonly phone: boolean
	readonly open: boolean
	readonly onClose: () => void
	// The annotation selected on the page.
	readonly selected?: PdfAnnotationRef
	// Shows and selects the annotation on its page.
	readonly onSelect: (ref: PdfAnnotationRef) => void
	// Each resolves to whether it applied (a refusal is told by the host and changes nothing).
	readonly onReply: (root: PdfAnnotationRef, text: string, author: string) => Promise<boolean>
	readonly onEdit: (ref: PdfAnnotationRef, text: string) => Promise<boolean>
	// `isRoot`: the thread's own annotation, with its replies.
	readonly onDelete: (ref: PdfAnnotationRef, isRoot: boolean) => Promise<boolean>
	// Resolve and reopen: Completed and None.
	readonly onSetState: (root: PdfAnnotationRef, state: PdfReviewState, author: string) => Promise<boolean>
	// Starts placing a sticky note on the page (none: no New button).
	readonly onNew?: () => void
}

// The list's focus scope: one document.
const SCOPE = "document"

export function PdfCommentsPanel({
	threads,
	editable,
	phone,
	open,
	onClose,
	selected,
	onSelect,
	onReply,
	onEdit,
	onDelete,
	onSetState,
	onNew
}: PdfCommentsPanelProps) {
	const { t } = useTranslation("preview")
	const [thread, setThread] = useState<string | undefined>(undefined)
	// The thread of the selected annotation, opened once per selection (and again once a new note's thread arrives).
	const target = selected === undefined ? undefined : threadOfRef(threads, selected)
	const targetKey = selected === undefined ? "" : `${String(selected.page)}:${String(selected.id)}:${target ?? ""}`
	const [seen, setSeen] = useState(targetKey)

	if (seen !== targetKey) {
		setSeen(targetKey)

		if (target !== undefined) setThread(target)
	}

	const shown = pdfThreads(
		threads,
		index => t("previewPdfCommentPage", { page: index + 1 }),
		state =>
			state === "Accepted"
				? t("previewPdfCommentAccepted")
				: state === "Rejected"
					? t("previewPdfCommentRejected")
					: t("previewPdfCommentCancelled")
	)
	const labels: CommentThreadLabels = {
		title: t("previewPdfCommentsTitle"),
		close: t("previewPdfCommentsClose"),
		list: t("previewPdfCommentsList"),
		empty: t("previewPdfCommentsEmpty"),
		new: t("previewPdfCommentNew"),
		placeholder: t("previewPdfCommentPlaceholder"),
		replyPlaceholder: t("previewPdfCommentReplyPlaceholder"),
		reply: t("previewPdfCommentReply"),
		save: t("previewPdfCommentSave"),
		actions: t("previewPdfCommentActions"),
		edit: t("previewPdfCommentEdit"),
		delete: t("previewPdfCommentDelete"),
		deleteThread: t("previewPdfCommentDeleteThread"),
		resolve: t("previewPdfCommentResolve"),
		reopen: t("previewPdfCommentReopen"),
		resolved: t("previewPdfCommentResolved"),
		back: t("previewPdfCommentBack"),
		unknownAuthor: t("previewPdfCommentUnknownAuthor"),
		replies: count => t("previewPdfCommentReplies", { count }),
		thread: (author, date, excerpt) =>
			date === "" ? t("previewPdfCommentThreadUndated", { author, excerpt }) : t("previewPdfCommentThread", { author, date, excerpt })
	}
	const actions: CommentThreadActions<PdfThreadComment> = {
		reply: (current, text, author) => onReply(current.root.ref, text, author),
		edit: (_current, comment, text) => onEdit(comment.ref, text),
		remove: (_current, comment, index) => onDelete(comment.ref, index === 0),
		resolve: (current, resolved, author) => onSetState(current.root.ref, resolved ? "Completed" : "None", author)
	}

	return (
		<CommentThreads
			open={open}
			scope={SCOPE}
			threads={shown}
			loaded
			failed={false}
			labels={labels}
			editable={editable}
			phone={phone}
			thread={thread}
			composing={false}
			onOpenThread={id => {
				setThread(id)

				const opened = id === undefined ? undefined : shown.find(candidate => candidate.root.id === id)

				if (opened !== undefined) onSelect(opened.root.ref)
			}}
			onClose={onClose}
			{...(onNew === undefined ? {} : { onNew })}
			actions={actions}
		/>
	)
}
