// "preview" namespace, Word document editor — fields and tables of contents while editing. Spread into preview.ts; same catalog rules.
export const previewDocxFields = {
	// ── Commands ─────────────────────────────────────────────────────────────
	/** Docx editor — command and chip button recomputing the field at the cursor (F9) */
	previewDocxUpdateField: "Update field",
	/** Docx editor — command and Insert menu item recomputing every field in the document */
	previewDocxUpdateAllFields: "Update all fields",
	/** Docx editor — command turning the fields at the cursor or in the selection into their results as plain text (Ctrl+Shift+F9) */
	previewDocxUnlinkFields: "Unlink fields",
	/** Docx editor — command and Insert menu item: a table of contents built from the headings (opens a dialog) */
	previewDocxInsertToc: "Table of contents…",
	/** Docx editor — command and chip button rebuilding the table of contents at the cursor */
	previewDocxUpdateToc: "Update table",
	/** Docx editor — command and Insert menu item: the current page's number */
	previewDocxInsertPageNumber: "Page number",
	/** Docx editor — command and Insert menu item: the document's number of pages */
	previewDocxInsertPageCount: "Number of pages",
	/** Docx editor — command and Insert menu item: a date field (opens the date format dialog) */
	previewDocxInsertDate: "Date and time…",
	/** Docx editor — command and Insert menu item: any field by its code (opens the field dialog) */
	previewDocxInsertField: "Field…",
	/** Docx editor — command and Insert menu item: bookmarks at the cursor (opens the bookmark dialog) */
	previewDocxBookmark: "Bookmark…",
	/** Docx editor — command deleting a bookmark */
	previewDocxBookmarkDelete: "Delete bookmark",
	/** Docx editor — command renaming a bookmark */
	previewDocxBookmarkRename: "Rename bookmark",
	/** Docx editor — Insert menu submenu holding page numbers and the page count */
	previewDocxInsertPageNumbers: "Page numbers",

	// ── Field chip ───────────────────────────────────────────────────────────
	/** Docx editor — chip at a table of contents: what its Update menu offers; Word's "Update Table of Contents" */
	previewDocxTocUpdatePages: "Update page numbers only",
	/** Docx editor — chip at a table of contents: rebuild every entry */
	previewDocxTocUpdateAll: "Update entire table",
	/** Docx editor — accessible name of the chip at a field or note reference */
	previewDocxFieldChip: "Field actions",

	// ── Table of contents dialog ─────────────────────────────────────────────
	/** Docx editor — table of contents dialog title */
	previewDocxTocTitle: "Table of contents",
	/** Docx editor — table of contents dialog description */
	previewDocxTocDescription: "Builds a table from the document's headings at the cursor.",
	/** Docx editor — table of contents dialog: how many heading levels it lists */
	previewDocxTocLevels: "Show levels",
	/** Docx editor — table of contents dialog: entries link to their headings */
	previewDocxTocHyperlinks: "Link entries to their headings",

	// ── Date dialog ──────────────────────────────────────────────────────────
	/** Docx editor — date dialog title */
	previewDocxDateTitle: "Date and time",
	/** Docx editor — date dialog description */
	previewDocxDateDescription: "Inserts today's date in the format you pick.",
	/** Docx editor — date dialog switch: inserts a date field that shows the date it was last updated, instead of the date as text */
	previewDocxDateUpdateAutomatically: "Update automatically",
	/** Docx editor — accessible label of the date dialog's list of formats */
	previewDocxDateFormats: "Formats",

	// ── Field dialog ─────────────────────────────────────────────────────────
	/** Docx editor — field dialog title */
	previewDocxFieldTitle: "Field",
	/** Docx editor — field dialog description */
	previewDocxFieldDescription: "Pick a field and edit its code if you need to.",
	/** Docx editor — field dialog: the kind of field */
	previewDocxFieldType: "Field",
	/** Docx editor — field dialog: the field's code (Word's field code) */
	previewDocxFieldCode: "Field code",
	/** Docx editor — field dialog: the code is not one this field type takes */
	previewDocxFieldCodeInvalid: "This field code can't be inserted.",
	/** Docx editor — field type: the page number (PAGE) */
	previewDocxFieldPage: "Page number",
	/** Docx editor — field type: the number of pages (NUMPAGES) */
	previewDocxFieldNumPages: "Number of pages",
	/** Docx editor — field type: the pages in the section (SECTIONPAGES) */
	previewDocxFieldSectionPages: "Pages in section",
	/** Docx editor — field type: the section's number (SECTION) */
	previewDocxFieldSection: "Section number",
	/** Docx editor — field type: the date (DATE) */
	previewDocxFieldDate: "Date",
	/** Docx editor — field type: the time (TIME) */
	previewDocxFieldTime: "Time",
	/** Docx editor — field type: a bookmark's text (REF) */
	previewDocxFieldRef: "Bookmark text",
	/** Docx editor — field type: the page a bookmark is on (PAGEREF) */
	previewDocxFieldPageRef: "Bookmark page",
	/** Docx editor — field type: a numbered sequence such as figures or tables (SEQ) */
	previewDocxFieldSeq: "Sequence",

	// ── Bookmark dialog ──────────────────────────────────────────────────────
	/** Docx editor — bookmark dialog title */
	previewDocxBookmarkTitle: "Bookmarks",
	/** Docx editor — bookmark dialog description */
	previewDocxBookmarkDescription: "Name the place at the cursor to link to it, or rename, delete and go to bookmarks.",
	/** Docx editor — bookmark dialog: the name field */
	previewDocxBookmarkName: "Bookmark name",
	/** Docx editor — bookmark dialog: why the typed name can't be used */
	previewDocxBookmarkNameInvalid: "A name starts with a letter and holds letters, digits and underscores, 40 at most.",
	/** Docx editor — bookmark dialog: the typed name is taken */
	previewDocxBookmarkNameTaken: "A bookmark with this name already exists.",
	/** Docx editor — bookmark dialog: adds a bookmark with the typed name at the cursor */
	previewDocxBookmarkAdd: "Add",
	/** Docx editor — bookmark dialog: gives the selected bookmark the typed name */
	previewDocxBookmarkRenameAction: "Rename",
	/** Docx editor — bookmark dialog: deletes the selected bookmark */
	previewDocxBookmarkDeleteAction: "Delete",
	/** Docx editor — bookmark dialog: moves the cursor to the selected bookmark */
	previewDocxBookmarkGoTo: "Go to",
	/** Docx editor — bookmark dialog: accessible label of the list of the document's bookmarks */
	previewDocxBookmarkList: "Bookmarks in this document",
	/** Docx editor — bookmark dialog: the document has none */
	previewDocxBookmarkNone: "No bookmarks yet."
} as const
