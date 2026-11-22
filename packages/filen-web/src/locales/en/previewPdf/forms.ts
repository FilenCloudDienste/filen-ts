// "preview" namespace, PDF editor — forms: filling a PDF's own form fields, and the honest limits of doing so (scripts
// never run, XFA). Spread into preview.ts; same catalog rules.
export const previewPdfForms = {
	/** PDF editor — one-line banner under the ribbon when the document has form fields */
	previewPdfFormBanner: "This document has form fields.",
	/** PDF editor — button on the form-fields banner moving focus to the first field */
	previewPdfFormBannerFocus: "Fill in",
	/** PDF editor — note when typing into a form field the document marks as a password field: its value would be written into the file, so it can't be filled */
	previewPdfFormPassword: "This is a password field. Filen doesn't write passwords into PDFs, so it can't be filled here.",
	/** PDF editor — warning on save when required fields are still empty (saving goes ahead) */
	previewPdfFormRequiredEmpty_one: "{{count}} required field is still empty.",
	/** PDF editor — warning on save when required fields are still empty (saving goes ahead) */
	previewPdfFormRequiredEmpty_other: "{{count}} required fields are still empty.",
	/** PDF editor — title of the confirm dialog before the first save of a form that also holds XFA data */
	previewPdfFormXfaSaveTitle: "Save without XFA data?",
	/** PDF editor — body of that confirm dialog (exact wording) */
	previewPdfFormXfaSaveBody: "This form also contains XFA data. Saving removes it; the regular form fields keep your entries.",
	/** PDF editor — XFA save confirm: save as a new version in place */
	previewPdfFormXfaSave: "Save",
	/** PDF editor — XFA save confirm: cancel */
	previewPdfFormXfaSaveCancel: "Cancel",
	/** PDF editor — button on the form-fields banner opening the assistant's form fill for the page in view */
	previewPdfFormBannerFill: "Fill from my details",
	/** PDF editor — Fill & Sign ribbon tool: the assistant fills the page in view from details the user types */
	previewPdfFormFillTool: "Fill this page",
	/** Form fill panel — heading; `page` is the page in view */
	previewPdfFormFillTitle: "Fill page {{page}}",
	/** Form fill panel — label of the box the user types or pastes their details into */
	previewPdfFormFillDetails: "Your details",
	/** Form fill panel — hint under the details box */
	previewPdfFormFillDetailsHint: "Type or paste your name, address and the like. They're used for this page only and aren't saved.",
	/** Form fill panel — runs the assistant over the details */
	previewPdfFormFillRun: "Fill",
	/** Form fill panel — the page's fields and text are being read */
	previewPdfFormFillReadingPage: "Reading the page…",
	/** Form fill panel — the assistant is matching the details to the fields */
	previewPdfFormFillMatching: "Matching your details to the fields…",
	/** Form fill panel — section heading of the fields that will be filled; `count` is how many */
	previewPdfFormFillWill: "Will fill ({{count}})",
	/** Form fill panel — section heading of the fields that won't be filled; `count` is how many */
	previewPdfFormFillNot: "Not filled ({{count}})",
	/** Form fill panel — a field the assistant does not fill: `label` names it, `reason` says why */
	previewPdfFormFillNotItem: "{{label}} ({{reason}})",
	/** Form fill panel — name of a field nothing on the page names */
	previewPdfFormFillUnnamed: "Unnamed field",
	/** Form fill panel — reason: a checkbox or radio button, which the user ticks */
	previewPdfFormFillReasonTick: "tick it yourself",
	/** Form fill panel — reason: nothing on the page names the field, so the assistant can't place a value in it */
	previewPdfFormFillReasonUnlabeled: "nothing on the page names it",
	/** Form fill panel — reason: past the most fields one request takes */
	previewPdfFormFillReasonLimit: "too many fields on this page",
	/** Form fill panel — reason: the details did not answer it */
	previewPdfFormFillReasonUnanswered: "not in your details",
	/** Form fill panel — reason: the assistant's value is not something the user wrote */
	previewPdfFormFillReasonUngrounded: "value not in your details",
	/** Form fill panel — reason: the value is longer than the field takes */
	previewPdfFormFillReasonTooLong: "value too long for the field",
	/** Form fill panel — reason: the value matches none of the field's choices */
	previewPdfFormFillReasonNotAnOption: "not one of its choices",
	/** Form fill panel — fills the checked fields; `count` is how many */
	previewPdfFormFillApply_one: "Fill {{count}} field",
	/** Form fill panel — fills the checked fields; `count` is how many */
	previewPdfFormFillApply_other: "Fill {{count}} fields",
	/** Form fill panel — closes it without filling anything */
	previewPdfFormFillCancel: "Cancel",
	/** Form fill panel — the page has no field the assistant can fill */
	previewPdfFormFillNoFields: "No field on this page can be filled from your details.",
	/** Form fill panel — none of the fields matched the details */
	previewPdfFormFillNothing: "None of the fields matched your details.",
	/** Form fill panel — the details are longer than one request takes */
	previewPdfFormFillTooLong: "These details are too long. Shorten them and try again.",
	/** Form fill panel — the assistant failed */
	previewPdfFormFillFailed: "Couldn't fill this page. Try again.",
	/** Form fill panel — fields changed since the assistant read them; `fields` names them. Nothing was filled */
	previewPdfFormFillChanged: "Some fields changed meanwhile ({{fields}}), so nothing was filled. Fill again.",
	/** Form fill panel — the editor refused a value; every other value of the fill was taken back too */
	previewPdfFormFillRefused: "The form refused a value, so nothing was filled.",
	/** Toast — the fields were filled (one undo takes them all back); `count` is how many */
	previewPdfFormFillDone_one: "Filled {{count}} field",
	/** Toast — the fields were filled (one undo takes them all back); `count` is how many */
	previewPdfFormFillDone_other: "Filled {{count}} fields"
} as const
