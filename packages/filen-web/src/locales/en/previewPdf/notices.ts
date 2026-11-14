// "preview" namespace, PDF editor: the notices about what it cannot do or keep (limits, scripts, XFA, signatures,
// earlier versions). Spread into preview.ts; same catalog rules as preview.ts.
export const previewPdfNotices = {
	/** PDF editor — notice when the editor's engine could not be downloaded or started; a Try again button follows */
	previewPdfEditorUnavailable:
		"Editing isn't available right now. The editor couldn't load: you may be offline, or WebAssembly may be turned off in this browser.",
	/** PDF editor — button in the notice above: load the editor again */
	previewPdfEditorRetry: "Try again",
	/** PDF editor — notice when the editor crashed; the viewer shows the file as last saved */
	previewPdfPoisoned: "The editor stopped (out of memory or an internal error). Unsaved changes are lost. The file is unchanged.",
	/** PDF editor — notice when the file was saved but the editor could not open the saved file again; a Try again button follows */
	previewPdfReopenFailed: "Your changes were saved, but the editor couldn't open the saved file again.",
	/** PDF editor — notice when the file is too large to edit in this browser; {{size}} is the largest size it can edit, e.g. "175 MB" */
	previewPdfTooLarge: "This PDF is too large to edit in this browser (limit {{size}}). You can still view, print and check signatures.",
	/** PDF editor — error when one change (e.g. inserting many pages) would need more memory than the browser gives the editor */
	previewPdfOverBudget: "This change needs more memory than this browser allows for a file this size.",
	/** PDF editor — notice on a form whose fields are computed or formatted by scripts embedded in the PDF, which the app never runs */
	previewPdfScripts: "This form uses scripts for calculations or formatting. They don't run here, so calculated fields won't update.",
	/** PDF editor — notice on a form made only with XFA (an older form technology), whose fields cannot be filled in the app */
	previewPdfXfaOnly: "This form uses XFA, which can't be filled here. You can still view and print it.",
	/** PDF editor — notice before a change to a PDF that carries accessibility tags (structure for screen readers) */
	previewPdfTagged: "This PDF has accessibility tags. They may be incomplete after this change.",
	/** PDF editor — tooltip on a tool, or notice, when the PDF's author turned off this kind of change; the owner password lifts it */
	previewPdfOwnerRestricted: "The document's author restricted this. Unlock with the owner password.",
	/** PDF editor — notice after saving a file with content removed for good (redaction): its earlier versions on Filen still hold that content */
	previewPdfEarlierVersions: "Earlier versions of this file still contain the removed content. Delete them to remove it from Filen.",
	/** PDF editor — button in the notice above: delete every earlier version of the file */
	previewPdfDeleteEarlierVersions: "Delete earlier versions",
	/** PDF editor — title of the confirmation before deleting every earlier version of the file */
	previewPdfDeleteEarlierVersionsTitle: "Delete earlier versions?",
	/** PDF editor — body of the confirmation before deleting every earlier version of the file */
	previewPdfDeleteEarlierVersionsBody: "Every earlier version of this file is deleted for good. This can't be undone.",
	/** PDF editor — title of the dialog on save when someone else saved the file since it was opened here */
	previewPdfRemoteChanged: "This file changed since you opened it."
} as const
