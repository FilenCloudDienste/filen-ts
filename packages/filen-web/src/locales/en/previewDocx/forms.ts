// "preview" namespace, Word document editor — content controls (checkboxes, dropdowns, dates) while editing. Spread into preview.ts; same catalog rules.
export const previewDocxForms = {
	/** Docx editor — label of ticking a checkbox content control */
	previewDocxControlCheck: "Check box",
	/** Docx editor — label of choosing a dropdown entry */
	previewDocxControlChoose: "Choose an item",
	/** Docx editor — label of picking a date in a date control */
	previewDocxControlDate: "Pick a date",
	/** Docx editor — context menu/popover action: empties the control so its placeholder shows again */
	previewDocxControlClear: "Clear",
	/** Docx editor — Insert menu submenu: a new form control */
	previewDocxControlInsert: "Form control",
	/** Docx editor — Insert ▸ Form control item */
	previewDocxControlInsertCheckbox: "Checkbox",
	/** Docx editor — Insert ▸ Form control item (asks for the list's items first) */
	previewDocxControlInsertDropdown: "Dropdown list…",
	/** Docx editor — Insert ▸ Form control item */
	previewDocxControlInsertDate: "Date picker",
	/** Docx editor — Insert ▸ Form control item */
	previewDocxControlInsertText: "Text",
	/** Docx editor — context menu: adds an item after the repeating section item at the caret */
	previewDocxControlItemAdd: "Add repeating item",
	/** Docx editor — context menu: removes the repeating section item at the caret */
	previewDocxControlItemRemove: "Remove repeating item",
	/** Docx editor — label of changing a dropdown's entries (its popover's add and remove) */
	previewDocxControlItemsEdit: "Edit items",
	/** Docx editor — dropdown control popover: accessible name of its list of entries */
	previewDocxControlItems: "Items",
	/** Docx editor — date control popover: the date field's label */
	previewDocxControlDateLabel: "Date",
	/** Docx editor — date control popover: sets the chosen date */
	previewDocxControlDateSet: "Set date",
	/** Docx editor — why a control can't be changed: locked in Word */
	previewDocxControlLockedContent: "This control's content is locked.",
	/** Docx editor — why a control can't be changed: linked to data the editor can't update */
	previewDocxControlLockedBound: "This control is linked to data that can't be changed here.",
	/** Docx editor — why a control can't be changed: a legacy form field that is turned off */
	previewDocxControlLockedDisabled: "This form field is turned off.",
	/** Docx editor — why a control can't be changed: the document is view-only */
	previewDocxControlLockedReadOnly: "This document can only be viewed.",
	/** Docx editor — new dropdown list dialog title */
	previewDocxDropdownTitle: "Dropdown list",
	/** Docx editor — new dropdown list dialog description */
	previewDocxDropdownBody: "Add the items the list offers.",
	/** Docx editor — new dropdown list dialog: field for the next item's text */
	previewDocxDropdownItem: "New item",
	/** Docx editor — new dropdown list dialog: adds the typed item */
	previewDocxDropdownAdd: "Add",
	/** Docx editor — new dropdown list dialog: removes an item; {{item}} is its text */
	previewDocxDropdownRemove: "Remove {{item}}",
	/** Docx editor — new dropdown list dialog: an item already in the list */
	previewDocxDropdownDuplicate: "That item is already in the list.",
	/** Docx editor — new dropdown list dialog submit */
	previewDocxDropdownInsert: "Insert",
	/** Docx editor — text saved into the document: what a new text form control shows until something is typed in (Word's own wording) */
	previewDocxControlPlaceholderText: "Click or tap here to enter text.",
	/** Docx editor — text saved into the document: what a new date form control shows until a date is picked (Word's own wording) */
	previewDocxControlPlaceholderDate: "Click or tap to enter a date.",
	/** Docx editor — text saved into the document: a new dropdown list's first entry, shown until an item is chosen (Word's own wording) */
	previewDocxControlPlaceholderList: "Choose an item.",
	/** Docx editor — text saved into the document: a table of contents built where the document has no headings (Word's own wording) */
	previewDocxTocNoEntries: "No table of contents entries found."
} as const
