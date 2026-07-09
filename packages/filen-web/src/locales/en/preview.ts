// English source catalog — "preview" namespace: the full-bleed drive file-preview overlay
// (features/preview/components/*) opened from a listing's handleOpen — header chrome (prev/next, download,
// close) and per-category viewer copy. Same typed-catalog rules as the other namespaces: flat `as
// const` object, camelCase keys, no literal '.' or ':' (real i18next namespaces, keySeparator/
// nsSeparator both ON).
export const preview = {
	// ── Header ───────────────────────────────────────────────────────────────
	/** Preview overlay header — accessible label for the button stepping to the previous previewable sibling; disabled at the first item */
	previewPreviousAction: "Previous file",
	/** Preview overlay header — accessible label for the button stepping to the next previewable sibling; disabled at the last item */
	previewNextAction: "Next file",
	/** Preview overlay header — accessible label for the button downloading the open item; hidden in trash */
	previewDownloadAction: "Download",
	/** Preview overlay header — accessible label for the button saving the editable text/code buffer; shown only while editable and dirty, also the Cmd/Ctrl+S keymap command's description */
	previewSaveAction: "Save",

	// ── Body ─────────────────────────────────────────────────────────────────
	/** Preview overlay body — shown in place of a viewer for a previewable category with no renderer built yet */
	previewUnsupportedType: "Preview isn't available for this file type yet.",
	/** Preview overlay body — a streamed image/video/audio failed mid-playback and the file is too large to safely retry buffered */
	previewStreamFailed: "This preview failed and the file is too large to retry.",
	/** Preview overlay body — a HEIC/HEIF image could not be converted for preview (corrupt or unsupported file) */
	previewTransformFailed: "This image couldn't be converted for preview.",
	/** Preview overlay body — shown by the scoped error boundary when a viewer throws while rendering (e.g. a parse failure) */
	previewRenderError: "This preview couldn't be displayed.",

	// ── Editable save ────────────────────────────────────────────────────────
	/** Unsaved-changes confirm dialog — title, shown on Escape/close/prev/next while the editable buffer is dirty */
	previewUnsavedChangesTitle: "Unsaved changes",
	/** Unsaved-changes confirm dialog — body */
	previewUnsavedChangesBody: "You have unsaved changes to this file. Discard them?",
	/** Unsaved-changes confirm dialog — the destructive confirm button, discards the buffer and proceeds */
	previewDiscardAction: "Discard",
	/** Toast shown after a save fails because the file's own parent directory no longer exists — the editor locks read-only for the rest of this session (mobile parity: retrying against the same broken parent would only fail again); every other save failure keeps the editor open for a retry instead */
	previewReadOnlyAfterSaveFailure: "This file is now read-only — saving failed and can't be retried until you reopen it.",

	// ── PDF ──────────────────────────────────────────────────────────────────
	/** PDF viewer — password dialog title, shown both on the first prompt and on a wrong-password retry */
	previewPdfPasswordTitle: "Password required",
	/** PDF viewer — password dialog body on the first prompt, before any attempt */
	previewPdfPasswordBody: "This PDF is password-protected. Enter the password to view it.",
	/** PDF viewer — password dialog body after a submitted password was rejected */
	previewPdfPasswordRetryBody: "That password was incorrect. Try again.",
	/** PDF viewer — password dialog field label */
	previewPdfPasswordLabel: "Password",
	/** PDF viewer — password dialog submit button */
	previewPdfPasswordSubmit: "Unlock",
	/** PDF viewer — button shown after the password prompt is dismissed, reopens it */
	previewPdfPasswordReopen: "Enter password",
	/** PDF viewer — shown in place of the document when it fails to load or render (corrupt file, decode error) */
	previewPdfLoadFailed: "This PDF couldn't be rendered.",
	/** PDF viewer — accessible label for the page-nav button stepping to the previous page; distinct from the overlay's own file-level previous/next */
	previewPdfPreviousPageAction: "Previous page",
	/** PDF viewer — accessible label for the page-nav button stepping to the next page */
	previewPdfNextPageAction: "Next page",
	/** PDF viewer — page-nav indicator and per-page canvas label; {{current}} = the page in view, {{total}} = page count */
	previewPdfPageIndicator: "Page {{current}} of {{total}}",

	// ── Docx ─────────────────────────────────────────────────────────────────
	/** Docx viewer — shown in place of the document when it fails to load or render */
	previewDocxLoadFailed: "This document couldn't be rendered.",

	// ── Markdown ─────────────────────────────────────────────────────────────
	/** Markdown viewer — toolbar button shown while viewing the rendered output; switches to the raw-text source view */
	previewMarkdownViewSourceAction: "View source",
	/** Markdown viewer — toolbar button shown while viewing the raw-text source; switches back to the rendered output */
	previewMarkdownViewRenderedAction: "View rendered"
} as const
