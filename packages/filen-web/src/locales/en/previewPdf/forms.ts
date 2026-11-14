// "preview" namespace, PDF editor — forms: filling a PDF's own form fields, and the honest limits of doing so (scripts
// never run, XFA). Spread into preview.ts; same catalog rules.
export const previewPdfForms = {
	/** PDF editor — one-line banner under the ribbon when the document has form fields */
	previewPdfFormBanner: "This document has form fields.",
	/** PDF editor — button on the form-fields banner moving focus to the first field */
	previewPdfFormBannerFocus: "Fill in",
	/** PDF editor — accessible name of a form field whose document gives it none */
	previewPdfFormFieldFallbackLabel: "Form field",
	/** PDF editor — accessible description of a form field the document marks read-only */
	previewPdfFormFieldReadOnly: "This field is read-only.",
	/** PDF editor — accessible description of a form field the document marks required */
	previewPdfFormFieldRequired: "Required",
	/** PDF editor — message when a typed value is not one of a list field's options */
	previewPdfFormNotAnOption: "Choose one of the listed options.",
	/** PDF editor — Fill & Sign command clearing every field of the form back to its default */
	previewPdfFormClear: "Clear form",
	/** PDF editor — confirm dialog title before clearing the form */
	previewPdfFormClearTitle: "Clear this form?",
	/** PDF editor — confirm dialog body before clearing the form */
	previewPdfFormClearBody: "Every field goes back to its default value. You can undo this.",
	/** PDF editor — confirm button of the clear-form dialog */
	previewPdfFormClearConfirm: "Clear form",
	/** PDF editor — warning on save when required fields are still empty (saving goes ahead) */
	previewPdfFormRequiredEmpty_one: "{{count}} required field is still empty.",
	/** PDF editor — warning on save when required fields are still empty (saving goes ahead) */
	previewPdfFormRequiredEmpty_other: "{{count}} required fields are still empty.",
	/** PDF editor — notice when the form has calculate, format or validate scripts (exact wording) */
	previewPdfFormScripts: "This form uses scripts for calculations or formatting. They don't run here, so calculated fields won't update.",
	/** PDF editor — notice for an XFA-only form (exact wording) */
	previewPdfFormXfaOnly: "This form uses XFA, which can't be filled here. You can still view and print it.",
	/** PDF editor — title of the confirm dialog before the first save of a form that also holds XFA data */
	previewPdfFormXfaSaveTitle: "Save without XFA data?",
	/** PDF editor — body of that confirm dialog (exact wording) */
	previewPdfFormXfaSaveBody: "This form also contains XFA data. Saving removes it; the regular form fields keep your entries.",
	/** PDF editor — XFA save confirm: save as a new version in place */
	previewPdfFormXfaSave: "Save",
	/** PDF editor — XFA save confirm: save as a copy, the original keeps its XFA data */
	previewPdfFormXfaSaveCopy: "Save as copy",
	/** PDF editor — XFA save confirm: cancel */
	previewPdfFormXfaSaveCancel: "Cancel"
} as const
