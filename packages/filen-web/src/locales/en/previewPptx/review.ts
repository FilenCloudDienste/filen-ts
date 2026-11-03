// "preview" namespace, presentations: the Review tab, the Comments pane and editing the speaker notes. Spread into
// preview.ts; same catalog rules.
export const previewPptxReview = {
	/** Presentation editor, Review tab — group of the comment commands */
	previewPptxReviewComments: "Comments",
	/** Presentation editor, Review tab — starts a comment on the slide in view */
	previewPptxCommentNew: "New comment",
	/** Presentation editor, Review tab — shows the Comments pane beside the slide */
	previewPptxCommentsShow: "Show comments",
	/** Comments pane — its heading */
	previewPptxCommentsTitle: "Comments",
	/** Comments pane — closes the pane */
	previewPptxCommentsClose: "Close comments",
	/** Comments pane — accessible name of the list of the slide's comment threads */
	previewPptxCommentsList: "Comment threads on this slide",
	/** Comments pane — shown while the slide's comments are read */
	previewPptxCommentsLoading: "Reading comments…",
	/** Comments pane — shown when the slide's comments could not be read */
	previewPptxCommentsFailed: "The comments of this slide could not be read.",
	/** Comments pane — shown when the slide has no comments */
	previewPptxCommentsEmpty: "This slide has no comments.",
	/** Comments pane — placeholder of the field starting a comment, and its accessible name */
	previewPptxCommentPlaceholder: "Add a comment",
	/** Comments pane — placeholder of the reply field, and the button opening it */
	previewPptxCommentReplyPlaceholder: "Reply",
	/** Comments pane — posts a new comment */
	previewPptxCommentPost: "Post",
	/** Comments pane — posts a reply */
	previewPptxCommentReply: "Reply",
	/** Comments pane — saves an edited comment */
	previewPptxCommentSave: "Save",
	/** Comments pane — closes a comment field without posting */
	previewPptxCommentCancel: "Cancel",
	/** Comments pane — the ⋯ menu of one comment */
	previewPptxCommentActions: "Comment actions",
	/** Comments pane ⋯ menu — changes the text of one's own comment */
	previewPptxCommentEdit: "Edit",
	/** Comments pane ⋯ menu — removes one reply */
	previewPptxCommentDelete: "Delete comment",
	/** Comments pane ⋯ menu — removes a thread's first comment with its replies */
	previewPptxCommentDeleteThread: "Delete thread",
	/** Comments pane — marks a thread done */
	previewPptxCommentResolve: "Resolve thread",
	/** Comments pane — marks a resolved thread open again */
	previewPptxCommentReopen: "Reopen thread",
	/** Comments pane — beside a thread marked resolved */
	previewPptxCommentResolved: "Resolved",
	/** Comments pane — a thread's number of replies */
	previewPptxCommentReplies_one: "{{count}} reply",
	/** Comments pane — a thread's number of replies */
	previewPptxCommentReplies_other: "{{count}} replies",
	/** Comments pane — accessible name of one thread in the list: its first comment's author, date and opening words */
	previewPptxCommentThread: "{{author}}, {{date}}: {{excerpt}}",
	/** Comments pane — accessible name of one thread in the list whose first comment has no date: author and opening words */
	previewPptxCommentThreadUndated: "{{author}}: {{excerpt}}",
	/** Comments pane — goes back from one thread to the slide's list */
	previewPptxCommentBack: "All comments",
	/** Comments pane — the author of a comment whose author the file does not name */
	previewPptxCommentUnknownAuthor: "Unknown author",
	/** Comments pane — note under a thread whose format has no resolved state (older PowerPoint and ODF comments) */
	previewPptxCommentNoResolve: "Comments of this kind cannot be marked resolved.",
	/** Notes pane — shown in an editable deck on a slide without notes; clicking it starts them */
	previewPptxNotesAdd: "Click to add notes",
	/** Notes pane — accessible name of the speaker notes being edited */
	previewPptxNotesEditor: "Speaker notes",
	/** Notes pane — accessible name of the notes page around the notes being edited (it scrolls in a short pane) */
	previewPptxNotesPage: "Notes page"
}
