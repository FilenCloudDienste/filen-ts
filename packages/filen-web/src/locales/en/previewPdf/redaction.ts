// "preview" namespace, PDF editor — true redaction: the Redact mode controls, Find & redact, the list of marks, the
// Apply redactions dialog and the reasons a redacted file failed its check. Redaction deletes content for good; no
// string may promise more than is removed. Spread directly into preview.ts; same catalog rules.
export const previewPdfRedaction = {
	/** Label of the Redact mode controls (Protect tab of the PDF editor) */
	previewPdfRedactMode: "Redact",
	/** Redact mode button: drag a rectangle on the page to mark everything inside it */
	previewPdfRedactArea: "Area",
	/** Tooltip of the Area button */
	previewPdfRedactAreaHint: "Mark an area of the page for redaction",
	/** Redact mode button: select text on the page to mark it */
	previewPdfRedactText: "Text",
	/** Tooltip of the Text button */
	previewPdfRedactTextHint: "Select text to mark it for redaction",
	/** Redact mode button opening the Find & redact panel */
	previewPdfRedactFind: "Find & redact",
	/** Tooltip of the Find & redact button */
	previewPdfRedactFindHint: "Find words or phrases and mark every match",

	/** Title of the Find & redact panel */
	previewPdfFindRedactTitle: "Find & redact",
	/** Label of the input adding a word or phrase to search for (matched literally, never as a pattern) */
	previewPdfFindRedactTermLabel: "Words or phrases",
	/** Placeholder of that input */
	previewPdfFindRedactTermPlaceholder: "Add a word or phrase",
	/** Button adding the typed word or phrase to the search */
	previewPdfFindRedactAddTerm: "Add",
	/** Accessible label of the button removing a word or phrase from the search. {{term}} is the word or phrase */
	previewPdfFindRedactRemoveTerm: "Remove “{{term}}”",
	/** Find & redact option: upper and lower case must match */
	previewPdfFindRedactMatchCase: "Match case",
	/** Find & redact option: only whole words match, not parts of longer words */
	previewPdfFindRedactWholeWords: "Whole words only",
	/** Heading of the ready-made searches in Find & redact */
	previewPdfFindRedactPresets: "Also find",
	/** Ready-made search: email addresses */
	previewPdfFindRedactEmails: "Email addresses",
	/** Ready-made search: phone numbers */
	previewPdfFindRedactPhones: "Phone numbers",
	/** Button running the search */
	previewPdfFindRedactSearch: "Search",
	/** Shown while the document is searched */
	previewPdfFindRedactSearching: "Searching…",
	/** Search result count */
	previewPdfFindRedactResults_one: "{{count}} match",
	/** Search result count */
	previewPdfFindRedactResults_other: "{{count}} matches",
	/** Shown when the search found nothing */
	previewPdfFindRedactNoResults: "No matches.",
	/** Location of a match in the results list. {{page}} is the 1-based page number */
	previewPdfFindRedactResultPage: "Page {{page}}",
	/** Checkbox selecting or clearing every match in the results */
	previewPdfFindRedactSelectAll: "Select all",
	/** Button marking the selected matches for redaction */
	previewPdfFindRedactMark_one: "Mark {{count}} match for redaction",
	/** Button marking the selected matches for redaction */
	previewPdfFindRedactMark_other: "Mark {{count}} matches for redaction",
	/** Accessible label of the button closing the Find & redact panel */
	previewPdfFindRedactClose: "Close Find & redact",

	/** Heading of the list of pending redaction marks, with their number */
	previewPdfRedactMarked: "Marked for redaction ({{count}})",
	/** Shown in that list while nothing is marked */
	previewPdfRedactMarkedEmpty: "Nothing is marked yet. Mark text or areas, or use Find & redact.",
	/** A text mark in the list. {{text}} is the marked text */
	previewPdfRedactMarkText: "“{{text}}”",
	/** A text mark in the list whose text could not be read */
	previewPdfRedactMarkTextUnknown: "Marked text",
	/** An area mark in the list */
	previewPdfRedactMarkArea: "Area",
	/** A whole-page mark in the list */
	previewPdfRedactMarkPage: "Whole page",
	/** Page of a mark in the list. {{page}} is the 1-based page number */
	previewPdfRedactMarkPageNumber: "Page {{page}}",
	/** Accessible label of the ✕ button removing one mark (nothing is redacted yet) */
	previewPdfRedactRemoveMark: "Remove this mark",
	/** Button opening the Apply redactions dialog */
	previewPdfRedactApply: "Apply redactions…",

	/** Title of the dialog applying the redactions */
	previewPdfRedactApplyTitle: "Apply redactions",
	/** Apply redactions dialog: what applying does (exact wording; it must not claim more than is removed) */
	previewPdfRedactApplyWarning:
		"Applying redactions permanently deletes the marked text, image areas and drawings. Drawings that touch an area mark are deleted completely, including parts outside the mark. Text that is part of an image or a drawing is only removed where it is marked.",
	/** Apply redactions dialog: switch removing hidden information from the whole document (on by default) */
	previewPdfRedactSanitize: "Sanitize document",
	/** Description of the Sanitize switch */
	previewPdfRedactSanitizeHint:
		"Also removes the document's metadata, attachments, scripts and actions, hidden layers and private data of other apps.",
	/** Apply redactions dialog: switch removing comments and other annotations over marked areas (on by default; links and form fields over a mark are always removed) */
	previewPdfRedactRemoveAnnotations: "Remove comments over marked areas",
	/** Apply redactions dialog: label of the choice where the redacted file goes */
	previewPdfRedactSaveTo: "Save",
	/** Apply redactions dialog: save the redacted file as a new file beside the original (the default). {{name}} is the new file's name */
	previewPdfRedactSaveCopy: "As a copy: {{name}}",
	/** Apply redactions dialog: save the redacted file as a new version of this file */
	previewPdfRedactSaveInPlace: "As a new version of this file",
	/** Apply redactions dialog: the confirming button */
	previewPdfRedactApplyConfirm: "Apply and save",
	/** Apply redactions dialog: the confirming button while the redactions are applied and checked */
	previewPdfRedactApplying: "Applying…",
	/** Suffix of the redacted copy's name, as in "report (redacted).pdf" */
	previewPdfRedactCopySuffix: "redacted",
	/** Suffix of the redacted copy's name when that name is taken, as in "report (redacted 2).pdf" */
	previewPdfRedactCopySuffixNumbered: "redacted {{number}}",

	/** Shown when the saved redacted file failed the check (exact wording). {{reason}} is one of the previewPdfRedactReason… phrases */
	previewPdfRedactVerifyFailed: "The redacted file didn't pass the check, so it wasn't saved: {{reason}}.",
	/** Reason: the file kept an earlier revision of its content */
	previewPdfRedactReasonRevisions: "the file still contains an earlier version of its content",
	/** Reason: a character remained inside a marked area. {{page}} is the 1-based page number */
	previewPdfRedactReasonText: "text remains inside a marked area on page {{page}}",
	/** Reason: image pixels remained inside a marked area */
	previewPdfRedactReasonImage: "part of an image remains inside a marked area on page {{page}}",
	/** Reason: a drawing touching an area mark remained */
	previewPdfRedactReasonDrawing: "a drawing touching a marked area remains on page {{page}}",
	/** Reason: a searched word remained in a page's text. {{term}} is the word or phrase */
	previewPdfRedactReasonTermPage: "“{{term}}” still appears on page {{page}}",
	/** Reason: a searched word remained in a comment or other annotation */
	previewPdfRedactReasonTermAnnotation: "“{{term}}” still appears in a comment",
	/** Reason: a searched word remained in a form field */
	previewPdfRedactReasonTermField: "“{{term}}” still appears in a form field",
	/** Reason: a searched word remained in a bookmark */
	previewPdfRedactReasonTermBookmark: "“{{term}}” still appears in a bookmark",
	/** Reason: a searched word remained in the document's metadata */
	previewPdfRedactReasonTermMetadata: "“{{term}}” still appears in the document's metadata (turn on Sanitize document)",
	/** Reason: a searched word remained in an attachment */
	previewPdfRedactReasonTermAttachment: "“{{term}}” still appears in an attachment (turn on Sanitize document)",
	/** Reason: a searched word remained in the accessibility tags */
	previewPdfRedactReasonTermTags: "“{{term}}” still appears in the accessibility tags",
	/** Reason: a searched word remained somewhere else in the file's data */
	previewPdfRedactReasonTermFile: "“{{term}}” still appears in the file's data",
	/** Reason: sanitizing left the document information (title, author and the like) */
	previewPdfRedactReasonInfo: "the document information wasn't removed",
	/** Reason: sanitizing left XMP metadata */
	previewPdfRedactReasonXmp: "the document's metadata wasn't removed",
	/** Reason: sanitizing left attachments */
	previewPdfRedactReasonAttachments: "attachments weren't removed",
	/** Reason: sanitizing left scripts or actions */
	previewPdfRedactReasonScripts: "scripts or actions weren't removed",
	/** Reason: sanitizing left private data of the apps that edited the file */
	previewPdfRedactReasonPieceInfo: "private data of other apps wasn't removed",
	/** Reason: thumbnails or alternate images remained on a redacted page */
	previewPdfRedactReasonHiddenData: "a thumbnail or alternate image remains on a redacted page",
	/** Reason: a page could not be checked */
	previewPdfRedactReasonUnreadable: "page {{page}} couldn't be checked"
}
