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
	previewPdfFormXfaSaveCancel: "Cancel"
} as const
