// "preview" namespace, PDF editor — the Comments panel: annotation notes, replies and review states. Spread into
// preview.ts; same catalog rules.
export const previewPdfComments = {
	/** PDF Comments panel — its heading */
	previewPdfCommentsTitle: "Comments",
	/** PDF Comments panel — closes the panel */
	previewPdfCommentsClose: "Close comments",
	/** PDF Comments panel — accessible name of the list of the document's comment threads */
	previewPdfCommentsList: "Comment threads in this document",
	/** PDF Comments panel — shown when the document has no comments */
	previewPdfCommentsEmpty: "This document has no comments.",
	/** PDF Comments panel — starts placing a sticky note on the page */
	previewPdfCommentNew: "New comment",
	/** PDF Comments panel — placeholder of the field editing a comment */
	previewPdfCommentPlaceholder: "Add a comment",
	/** PDF Comments panel — placeholder of the reply field, and the button opening it */
	previewPdfCommentReplyPlaceholder: "Reply",
	/** PDF Comments panel — posts a new comment (a sticky note placed on the page, or the first note of an annotation) */
	previewPdfCommentPost: "Comment",
	/** PDF Comments panel — posts a reply */
	previewPdfCommentReply: "Reply",
	/** PDF Comments panel — saves an edited comment */
	previewPdfCommentSave: "Save",
	/** PDF Comments panel — the ⋯ menu of one comment */
	previewPdfCommentActions: "Comment actions",
	/** PDF Comments panel ⋯ menu — changes the text of one's own comment */
	previewPdfCommentEdit: "Edit",
	/** PDF Comments panel ⋯ menu — removes one reply */
	previewPdfCommentDelete: "Delete comment",
	/** PDF Comments panel ⋯ menu — removes a thread's first comment (its annotation) with its replies */
	previewPdfCommentDeleteThread: "Delete thread",
	/** PDF Comments panel — marks a thread done (review state Completed) */
	previewPdfCommentResolve: "Resolve thread",
	/** PDF Comments panel — marks a resolved thread open again */
	previewPdfCommentReopen: "Reopen thread",
	/** PDF Comments panel — beside a thread marked resolved */
	previewPdfCommentResolved: "Resolved",
	/** PDF Comments panel — beside a thread whose review state is Accepted (set in another app; shown only) */
	previewPdfCommentAccepted: "Accepted",
	/** PDF Comments panel — beside a thread whose review state is Rejected (set in another app; shown only) */
	previewPdfCommentRejected: "Rejected",
	/** PDF Comments panel — beside a thread whose review state is Cancelled (set in another app; shown only) */
	previewPdfCommentCancelled: "Cancelled",
	/** PDF Comments panel — a thread's number of replies */
	previewPdfCommentReplies_one: "{{count}} reply",
	/** PDF Comments panel — a thread's number of replies */
	previewPdfCommentReplies_other: "{{count}} replies",
	/** PDF Comments panel — accessible name of one thread in the list: its first comment's author, date and opening words */
	previewPdfCommentThread: "{{author}}, {{date}}: {{excerpt}}",
	/** PDF Comments panel — accessible name of one thread whose first comment has no date: author and opening words */
	previewPdfCommentThreadUndated: "{{author}}: {{excerpt}}",
	/** PDF Comments panel — goes back from one thread to the document's list */
	previewPdfCommentBack: "All comments",
	/** PDF Comments panel — the author of a comment whose author the file does not name */
	previewPdfCommentUnknownAuthor: "Unknown author"
} as const
