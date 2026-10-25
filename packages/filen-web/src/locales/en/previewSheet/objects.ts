// "preview" namespace, spreadsheet viewer — pictures, shapes and other drawing objects. Spread
// into preview.ts; same catalog rules.
export const previewSheetObjects = {
	/** Spreadsheet Insert menu — opens the link dialog for the selection, as Ctrl/Cmd+K does */
	previewSheetInsertLink: "Link…",
	/** Spreadsheet Insert menu — adds a note to the active cell (or opens its note), as Shift+F2 does */
	previewSheetInsertNote: "Note",
	/** Spreadsheet Insert menu and grid menu — inserts a picture from this device at the active cell */
	previewSheetObjectImageFromFile: "Image from file…",
	/** Spreadsheet Insert menu and grid menu — inserts a picture from the user's Filen drive at the active cell */
	previewSheetObjectImageFromDrive: "Image from drive…",
	/** Spreadsheet grid menu — submenu holding the two ways to insert a picture */
	previewSheetObjectInsertImage: "Insert image",
	/** Drive picker for a spreadsheet picture — title */
	previewSheetObjectDriveTitle: "Insert an image from your drive",
	/** Drive picker for a spreadsheet picture — description */
	previewSheetObjectDriveDescription: "Pick an image to place at the active cell.",
	/** Spreadsheet grid menu, with a picture or shape selected — opens the alt text dialog */
	previewSheetObjectAltText: "Edit alt text…",
	/** Alt text dialog for a picture, shape or chart — title */
	previewSheetObjectAltTextTitle: "Alt text",
	/** Alt text dialog — what the field is for */
	previewSheetObjectAltTextDescription: "Describe the object for people who can't see it.",
	/** Alt text dialog — the field's label */
	previewSheetObjectAltTextLabel: "Description",
	/** Alt text dialog — saves the text */
	previewSheetObjectAltTextApply: "Apply",
	/** Spreadsheet grid menu, with a picture or shape selected — deletes it */
	previewSheetObjectDelete: "Delete object",
	/** Accessible name of a picture with neither alt text nor a name */
	previewSheetObjectPicture: "Picture",
	/** Accessible name of a shape or text box with neither alt text nor a name */
	previewSheetObjectShape: "Shape",
	/** Accessible name of a chart with neither alt text nor a name */
	previewSheetObjectChart: "Chart",
	/** Accessible name of any other drawing object with neither alt text nor a name */
	previewSheetObjectOther: "Object",
	/** Toast — the picture is over the size a workbook takes */
	previewSheetObjectTooLarge: "This image is larger than 25 MB, the most an image in a workbook can be.",
	/** Toast — the picture has too many pixels */
	previewSheetObjectPixels: "This image has more than 20 megapixels, the most an image in a workbook can have.",
	/** Toast — the file is not a picture a workbook shows */
	previewSheetObjectFormat: "This file isn't an image a workbook can show. Use a PNG, JPEG, GIF, BMP, TIFF, SVG or WebP image.",
	/** Toast — HEIC pictures are refused by name */
	previewSheetObjectHeic: "HEIC images can't be shown in a workbook. Convert it to JPEG or PNG first.",
	/** Toast — AVIF pictures are refused by name */
	previewSheetObjectAvif: "AVIF images can't be shown in a workbook. Convert it to JPEG or PNG first.",
	/** Toast — the picture's bytes do not read */
	previewSheetObjectCorrupt: "This image couldn't be read. It may be damaged.",
	/** Toast — reading, converting or inserting the picture failed */
	previewSheetObjectFailed: "The image couldn't be inserted.",
	/** Toast — an animated picture went in as its first frame */
	previewSheetObjectAnimated: "This image is animated. Its first frame was inserted.",
	/** Toast — the file locks the object against moving or resizing */
	previewSheetObjectLocked: "This object is locked in the file and can't be moved or resized.",
	/** Toast — the sheet's drawing part is damaged, so its objects can't be shown or changed */
	previewSheetDrawingUnavailable: "The pictures and shapes on this sheet couldn't be read, so they can't be changed."
}
