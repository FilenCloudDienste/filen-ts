// "preview" namespace, Word document editor — the editor's insert menu, its dialogs, pictures and notes. Spread into preview.ts; same catalog rules.
export const previewDocxInsert = {
	// ── Insert menu ──────────────────────────────────────────────────────────
	/** Docx editor — Insert menu item and command: a link at the selection (opens the link dialog) */
	previewDocxInsertLink: "Link…",
	/** Docx editor — command removing the link at the selection, keeping its text */
	previewDocxRemoveLink: "Remove link",
	/** Docx editor — Insert menu submenu holding the page, line and section breaks */
	previewDocxInsertBreaks: "Breaks",
	/** Docx editor — Insert ▸ Breaks item: the text after the caret starts on a new page */
	previewDocxInsertPageBreak: "Page break",
	/** Docx editor — Insert ▸ Breaks item: a line break inside the paragraph (Shift+Enter) */
	previewDocxInsertLineBreak: "Line break",
	/** Docx editor — Insert menu item and command: Word's horizontal line (an empty paragraph with a bottom border) */
	previewDocxInsertHorizontalLine: "Horizontal line",
	/** Docx editor — Insert menu item and command: a symbol or special character (opens the symbol dialog) */
	previewDocxInsertSymbol: "Symbol…",

	// ── Pictures ─────────────────────────────────────────────────────────────
	/** Docx editor — Insert menu submenu and command inserting a picture at the caret */
	previewDocxInsertPicture: "Picture",
	/** Docx editor — Insert ▸ Picture item: opens the device's file chooser */
	previewDocxPictureFromDevice: "From this device…",
	/** Docx editor — Insert ▸ Picture item: opens a picker of the user's Filen drive */
	previewDocxPictureFromDrive: "From Filen drive…",
	/** Docx editor — title of the drive picker choosing a picture to insert */
	previewDocxPictureDriveTitle: "Insert a picture from your drive",
	/** Docx editor — description of the drive picker choosing a picture to insert */
	previewDocxPictureDriveDescription: "Pick a picture to insert at the cursor.",
	/** Docx editor — error toast: a picture over the 25 MB limit was not inserted */
	previewDocxPictureTooLarge: "This picture is larger than 25 MB, the most a picture in a document can be.",
	/** Docx editor — error toast: a picture over the 20-megapixel limit was not inserted */
	previewDocxPicturePixels: "This picture has more than 20 megapixels, the most a picture in a document can have.",
	/** Docx editor — error toast: the file is not a picture Word can show */
	previewDocxPictureFormat: "This file isn't a picture Word documents can show. Use a PNG, JPEG, GIF, BMP, TIFF, SVG or WebP picture.",
	/** Docx editor — error toast: an HEIC/HEIF picture (iPhone photos) was not inserted, Word cannot show it */
	previewDocxPictureHeic: "HEIC pictures can't be shown in Word documents. Convert it to JPEG or PNG first.",
	/** Docx editor — error toast: an AVIF picture was not inserted, Word cannot show it */
	previewDocxPictureAvif: "AVIF pictures can't be shown in Word documents. Convert it to JPEG or PNG first.",
	/** Docx editor — error toast: the picture's data is damaged */
	previewDocxPictureCorrupt: "This picture couldn't be read. It may be damaged.",
	/** Docx editor — error toast: the document holds as many new pictures as it can until it is saved */
	previewDocxPictureFull: "The document holds as many new pictures as it can. Save it to add more.",
	/** Docx editor — error toast: a picture cannot go where the cursor is (or the document cannot be changed) */
	previewDocxPicturePlace: "A picture can't be inserted here.",
	/** Docx editor — info toast: an animated WebP picture went in as its first frame (Word shows no WebP animation) */
	previewDocxPictureAnimated: "This picture is animated. Its first frame was inserted.",
	/** Docx editor — error toast: reading, converting or inserting the picture failed */
	previewDocxPictureFailed: "The picture couldn't be inserted.",

	// ── Picture group ────────────────────────────────────────────────────────
	/** Docx editor — accessible name of the toolbar group shown while a picture is selected */
	previewDocxPictureGroup: "Picture",
	/** Docx editor — command resizing the selected picture (its handles) */
	previewDocxPictureResize: "Resize picture",
	/** Docx editor — command moving the selected floating picture (dragging it) */
	previewDocxPictureMove: "Move picture",
	/** Docx editor — Picture group menu: how text wraps around the selected picture */
	previewDocxPictureWrap: "Wrap text",
	/** Docx editor — wrap choice: the picture sits in the line like a character */
	previewDocxWrapInline: "In line with text",
	/** Docx editor — wrap choice: text wraps around the picture's box */
	previewDocxWrapSquare: "Square",
	/** Docx editor — wrap choice: text wraps tightly around the picture's outline */
	previewDocxWrapTight: "Tight",
	/** Docx editor — wrap choice: text also flows into open areas of the picture */
	previewDocxWrapThrough: "Through",
	/** Docx editor — wrap choice: text stays above and below the picture */
	previewDocxWrapTopAndBottom: "Top and bottom",
	/** Docx editor — wrap choice: the picture sits behind the text */
	previewDocxWrapBehind: "Behind text",
	/** Docx editor — wrap choice: the picture sits in front of the text */
	previewDocxWrapInFront: "In front of text",
	/** Docx editor — Picture group menu: turning the selected picture */
	previewDocxPictureRotate: "Rotate",
	/** Docx editor — rotate choice: a quarter turn clockwise */
	previewDocxRotateRight: "Rotate right 90°",
	/** Docx editor — rotate choice: a quarter turn counterclockwise */
	previewDocxRotateLeft: "Rotate left 90°",
	/** Docx editor — rotate choice: a half turn */
	previewDocxRotateHalf: "Rotate 180°",
	/** Docx editor — Picture group toggle: crop handles on the selected picture (page view only) */
	previewDocxPictureCrop: "Crop",
	/** Docx editor — Picture group button and command: the selected picture's description for screen readers (opens a dialog) */
	previewDocxPictureAltText: "Alt text…",
	/** Docx editor — Picture group button and command deleting the selected picture */
	previewDocxPictureDelete: "Delete picture",
	/** Docx editor — alt text dialog title */
	previewDocxAltTextTitle: "Alt text",
	/** Docx editor — alt text dialog description */
	previewDocxAltTextDescription: "Describe the picture for people who can't see it.",
	/** Docx editor — alt text dialog's field label */
	previewDocxAltTextLabel: "Description",

	// ── Tables ───────────────────────────────────────────────────────────────
	/** Docx editor — Insert menu submenu: a table */
	previewDocxInsertTable: "Table",
	/** Docx editor — accessible label of one cell of the Insert ▸ Table grid; the table it inserts */
	previewDocxInsertTableGrid: "{{cols}} × {{rows}} table",
	/** Docx editor — Insert ▸ Table item opening the table size dialog */
	previewDocxInsertTableCustom: "Insert table…",
	/** Docx editor — table size dialog title */
	previewDocxTableSizeTitle: "Insert table",
	/** Docx editor — table size dialog description */
	previewDocxTableSizeDescription: "Choose how many columns and rows the table has.",

	// ── Notes ────────────────────────────────────────────────────────────────
	/** Docx editor — Insert menu submenu: footnotes and endnotes */
	previewDocxInsertNotes: "Footnotes and endnotes",
	/** Docx editor — command and menu item: a footnote at the caret */
	previewDocxInsertFootnote: "Footnote",
	/** Docx editor — command and menu item: an endnote at the caret */
	previewDocxInsertEndnote: "Endnote",
	/** Docx editor — command: from a note reference to its note and back */
	previewDocxNoteGoTo: "Go to note",
	/** Docx editor — command deleting the note at the caret with its reference */
	previewDocxNoteDelete: "Delete note",
	/** Docx editor — command turning the footnote at the caret into an endnote, or the other way */
	previewDocxNoteConvert: "Convert note",
	/** Docx editor — command turning every note of one kind into the other */
	previewDocxNoteConvertAll: "Convert all notes",
	/** Docx editor — Notes submenu item: every endnote becomes a footnote */
	previewDocxNoteConvertAllToFootnotes: "Convert all to footnotes",
	/** Docx editor — Notes submenu item: every footnote becomes an endnote */
	previewDocxNoteConvertAllToEndnotes: "Convert all to endnotes",
	/** Docx editor — command and Notes submenu item opening the note options dialog */
	previewDocxNoteOptions: "Note options…",
	/** Docx editor — note options dialog title */
	previewDocxNoteOptionsTitle: "Footnotes and endnotes",
	/** Docx editor — note options dialog description */
	previewDocxNoteOptionsDescription: "Choose where notes go and how they are numbered.",
	/** Docx editor — note options dialog: which kind of note the settings are for */
	previewDocxNoteKind: "Notes",
	/** Docx editor — note kind choice: footnotes */
	previewDocxNoteKindFootnote: "Footnotes",
	/** Docx editor — note kind choice: endnotes */
	previewDocxNoteKindEndnote: "Endnotes",
	/** Docx editor — note options dialog: where the notes are placed */
	previewDocxNoteLocation: "Location",
	/** Docx editor — note location: at the bottom of the page */
	previewDocxNotePageBottom: "Bottom of page",
	/** Docx editor — note location: right after the page's text */
	previewDocxNoteBeneathText: "Below text",
	/** Docx editor — note location: at the end of the section */
	previewDocxNoteSectionEnd: "End of section",
	/** Docx editor — note location: at the end of the document */
	previewDocxNoteDocumentEnd: "End of document",
	/** Docx editor — note options dialog: how notes are numbered */
	previewDocxNoteFormat: "Number format",
	/** Docx editor — note options dialog: the first note's number */
	previewDocxNoteStart: "Start at",
	/** Docx editor — note options dialog: when numbering starts again */
	previewDocxNoteRestart: "Numbering",
	/** Docx editor — numbering choice: never restarts */
	previewDocxNoteContinuous: "Continuous",

	// ── Links ────────────────────────────────────────────────────────────────
	/** Docx editor — link dialog title */
	previewDocxLinkTitle: "Link",
	/** Docx editor — link dialog description */
	previewDocxLinkDescription: "Link to a web address or to a place in this document.",
	/** Docx editor — link dialog: the text the link shows (when nothing is selected) */
	previewDocxLinkText: "Text to display",
	/** Docx editor — link dialog: what the link goes to */
	previewDocxLinkKind: "Link to",
	/** Docx editor — link target choice: a web or email address */
	previewDocxLinkWeb: "Web address",
	/** Docx editor — link target choice: a heading or bookmark in the document */
	previewDocxLinkPlace: "Place in this document",
	/** Docx editor — link dialog: the address field's label */
	previewDocxLinkAddress: "Address",
	/** Docx editor — link dialog: the place picker's label */
	previewDocxLinkPlaceLabel: "Place",
	/** Docx editor — link dialog: group of the document's headings in the place picker */
	previewDocxLinkHeadings: "Headings",
	/** Docx editor — link dialog: group of the document's bookmarks in the place picker */
	previewDocxLinkBookmarks: "Bookmarks",
	/** Docx editor — link dialog: shown instead of the place picker when there is nowhere to link to */
	previewDocxLinkNoPlaces: "This document has no headings or bookmarks to link to.",
	/** Docx editor — link dialog: the address has a scheme a new link cannot have (only web, email and phone links) */
	previewDocxLinkSchemeRefused: "Links can go to web (http, https), email (mailto) and phone (tel) addresses only.",

	// ── Symbols ──────────────────────────────────────────────────────────────
	/** Docx editor — symbol dialog title */
	previewDocxSymbolTitle: "Symbol",
	/** Docx editor — symbol dialog description */
	previewDocxSymbolDescription: "Pick a symbol, or type or paste the characters to insert.",
	/** Docx editor — symbol dialog: the field for characters to insert */
	previewDocxSymbolCharacters: "Characters",
	/** Docx editor — accessible label of the symbol dialog's grid */
	previewDocxSymbolGrid: "Symbols",
	/** Docx editor — symbol dialog: a space a line never breaks at */
	previewDocxSymbolNonBreakingSpace: "Nonbreaking space",
	/** Docx editor — symbol dialog: a hyphen a line never breaks at */
	previewDocxSymbolNonBreakingHyphen: "Nonbreaking hyphen",
	/** Docx editor — symbol dialog: a hyphen shown only where a line breaks at it */
	previewDocxSymbolOptionalHyphen: "Optional hyphen",

	// ── Shared dialog actions ────────────────────────────────────────────────
	/** Docx editor — submit button of the insert dialogs */
	previewDocxInsertAction: "Insert",
	/** Docx editor — submit button of dialogs changing something already there (alt text, an existing link, note options) */
	previewDocxApplyAction: "Apply",
	/** Docx editor — cancel button of the insert dialogs */
	previewDocxCancelAction: "Cancel"
} as const
