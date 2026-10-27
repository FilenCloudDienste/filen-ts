// "preview" namespace, presentation editor: inserting objects (Insert tab: table, pictures, shapes, text box) and the
// contextual Shape Format, Picture and Table tabs. Spread into preview.ts; same catalog rules.
export const previewPptxObjects = {
	/** Presentation editor — Insert tab group and button: insert a table */
	previewPptxInsertTable: "Table",
	/** Presentation editor — Insert ▸ Table grid: the size of the table under the pointer, e.g. "3 × 2 table" (columns × rows) */
	previewPptxInsertTableGrid: "{{cols}} × {{rows}} table",
	/** Presentation editor — Insert ▸ Table menu item opening a dialog for any size */
	previewPptxInsertTableCustom: "Insert table…",
	/** Presentation editor — Insert table dialog title */
	previewPptxInsertTableTitle: "Insert table",
	/** Presentation editor — Insert table dialog description */
	previewPptxInsertTableDescription: "Choose how many rows and columns the table has.",
	/** Presentation editor — Insert table dialog field */
	previewPptxInsertTableRows: "Rows",
	/** Presentation editor — Insert table dialog field */
	previewPptxInsertTableColumns: "Columns",
	/** Presentation editor — Insert table dialog error: a count outside the allowed range */
	previewPptxInsertTableRange: "Enter a number from 1 to {{max}}.",
	/** Presentation editor — dialog submit button that inserts the object */
	previewPptxInsertApply: "Insert",
	/** Presentation editor — dialog cancel button */
	previewPptxInsertCancel: "Cancel",
	/** Presentation editor — Insert tab group and menu: insert pictures */
	previewPptxInsertPictures: "Pictures",
	/** Presentation editor — Insert ▸ Pictures: from a file on this device */
	previewPptxInsertPictureDevice: "This device…",
	/** Presentation editor — Insert ▸ Pictures: from the user's Filen drive */
	previewPptxInsertPictureDrive: "From Filen…",
	/** Presentation editor — title of the drive picker for a picture */
	previewPptxInsertPictureDriveTitle: "Insert a picture",
	/** Presentation editor — description of the drive picker for a picture */
	previewPptxInsertPictureDriveDescription: "Choose a picture from your drive.",
	/** Presentation editor — Insert tab group and menu: insert a shape */
	previewPptxInsertShapes: "Shapes",
	/** Presentation editor — Insert tab button: insert a text box */
	previewPptxInsertTextBox: "Text box",
	/** Presentation editor — Shapes gallery section */
	previewPptxShapesLines: "Lines",
	/** Presentation editor — Shapes gallery section */
	previewPptxShapesRectangles: "Rectangles",
	/** Presentation editor — Shapes gallery section */
	previewPptxShapesBasic: "Basic shapes",
	/** Presentation editor — Shapes gallery section */
	previewPptxShapesArrows: "Block arrows",
	/** Presentation editor — Shapes gallery section */
	previewPptxShapesStars: "Stars",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeLine: "Line",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeRect: "Rectangle",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeRoundRect: "Rounded rectangle",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeEllipse: "Oval",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeTriangle: "Triangle",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeRtTriangle: "Right triangle",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeParallelogram: "Parallelogram",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeTrapezoid: "Trapezoid",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeDiamond: "Diamond",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapePentagon: "Pentagon",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeHexagon: "Hexagon",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeOctagon: "Octagon",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapePlus: "Cross",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeDonut: "Ring",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeFrame: "Frame",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeHeart: "Heart",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeSmileyFace: "Smiley face",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeCloud: "Cloud",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeRightArrow: "Right arrow",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeLeftArrow: "Left arrow",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeUpArrow: "Up arrow",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeDownArrow: "Down arrow",
	/** Presentation editor — shape name in the Shapes gallery */
	previewPptxShapeStar5: "5-point star",
	/** Presentation editor — Shape Format tab group */
	previewPptxShapeStyles: "Shape styles",
	/** Presentation editor — Shape Format button: the fill colour of the selected shapes */
	previewPptxShapeFill: "Shape fill",
	/** Presentation editor — Shape Format: remove the fill */
	previewPptxShapeNoFill: "No fill",
	/** Presentation editor — Shape Format button: the outline of the selected shapes */
	previewPptxShapeOutline: "Shape outline",
	/** Presentation editor — Shape Format: remove the outline */
	previewPptxShapeNoOutline: "No outline",
	/** Presentation editor — Shape Format menu: the outline's thickness */
	previewPptxShapeOutlineWeight: "Weight",
	/** Presentation editor — an outline thickness in points, e.g. "1.5 pt" */
	previewPptxShapeOutlinePoints: "{{points}} pt",
	/** Presentation editor — Picture tab group */
	previewPptxPictureAdjust: "Adjust",
	/** Presentation editor — Picture tab button and dialog: change brightness, contrast, colour and transparency */
	previewPptxPictureCorrections: "Corrections",
	/** Presentation editor — picture corrections dialog description */
	previewPptxPictureCorrectionsDescription: "Change the picture's brightness, contrast and colour.",
	/** Presentation editor — picture corrections field, a percentage from -100 to 100 */
	previewPptxPictureBrightness: "Brightness (%)",
	/** Presentation editor — picture corrections field, a percentage from -100 to 100 */
	previewPptxPictureContrast: "Contrast (%)",
	/** Presentation editor — picture corrections field, a percentage from 0 to 100 */
	previewPptxPictureTransparency: "Transparency (%)",
	/** Presentation editor — picture corrections switch: show the picture in shades of grey */
	previewPptxPictureGrayscale: "Grayscale",
	/** Presentation editor — Picture tab button: take every correction off the picture */
	previewPptxPictureReset: "Reset picture",
	/** Presentation editor — Picture tab button: put another image in the picture's place */
	previewPptxPictureChange: "Change picture",
	/** Presentation editor — Picture tab group and button: cut the picture's edges */
	previewPptxPictureCrop: "Crop",
	/** Presentation editor — crop dialog description */
	previewPptxPictureCropDescription: "Enter how much to cut from each edge of the picture.",
	/** Presentation editor — crop dialog field, percent of the picture's width or height */
	previewPptxPictureCropLeft: "Left (%)",
	/** Presentation editor — crop dialog field */
	previewPptxPictureCropTop: "Top (%)",
	/** Presentation editor — crop dialog field */
	previewPptxPictureCropRight: "Right (%)",
	/** Presentation editor — crop dialog field */
	previewPptxPictureCropBottom: "Bottom (%)",
	/** Presentation editor — crop dialog error: the edges cut more than the whole picture */
	previewPptxPictureCropTooMuch: "The edges together must leave part of the picture.",
	/** Presentation editor — dialog field error: a value outside its range */
	previewPptxValueRange: "Enter a number from {{min}} to {{max}}.",
	/** Presentation editor — dialog submit button applying the change */
	previewPptxObjectsApply: "Apply",
	/** Presentation editor — Table tab group */
	previewPptxTableRowsColumns: "Rows & columns",
	/** Presentation editor — Table tab command */
	previewPptxTableInsertAbove: "Insert above",
	/** Presentation editor — Table tab command */
	previewPptxTableInsertBelow: "Insert below",
	/** Presentation editor — Table tab command */
	previewPptxTableInsertLeft: "Insert left",
	/** Presentation editor — Table tab command */
	previewPptxTableInsertRight: "Insert right",
	/** Presentation editor — Table tab menu */
	previewPptxTableDelete: "Delete",
	/** Presentation editor — Table tab command */
	previewPptxTableDeleteRows: "Delete rows",
	/** Presentation editor — Table tab command */
	previewPptxTableDeleteColumns: "Delete columns",
	/** Presentation editor — Table tab command */
	previewPptxTableDeleteTable: "Delete table",
	/** Presentation editor — Table tab group */
	previewPptxTableMerge: "Merge",
	/** Presentation editor — Table tab command */
	previewPptxTableMergeCells: "Merge cells",
	/** Presentation editor — Table tab command */
	previewPptxTableSplitCells: "Split cells",
	/** Presentation editor — announced when a range of table cells is selected (Shift+click or Shift+drag), e.g. "2 × 3 cells selected" */
	previewPptxTableRangeSelected: "{{rows}} × {{cols}} cells selected",
	/** Presentation editor — Table tab group */
	previewPptxTableCellSize: "Cell size",
	/** Presentation editor — Table tab command: make the selected rows the same height */
	previewPptxTableDistributeRows: "Distribute rows",
	/** Presentation editor — Table tab command: make the selected columns the same width */
	previewPptxTableDistributeColumns: "Distribute columns",
	/** Presentation editor — Table tab group and menu */
	previewPptxTableStyles: "Table styles",
	/** Presentation editor — a table style in the gallery; {{accent}} is 1–6 */
	previewPptxTableStyleAccent: "Medium Style 2 – Accent {{accent}}",
	/** Presentation editor — a table style in the gallery */
	previewPptxTableStyleDark: "Medium Style 2",
	/** Presentation editor — table style gallery item: a table without a style */
	previewPptxTableStyleNone: "No style",
	/** Presentation editor — Table tab group */
	previewPptxTableOptions: "Style options",
	/** Presentation editor — table style option */
	previewPptxTableHeaderRow: "Header row",
	/** Presentation editor — table style option */
	previewPptxTableTotalRow: "Total row",
	/** Presentation editor — table style option */
	previewPptxTableBandedRows: "Banded rows",
	/** Presentation editor — table style option */
	previewPptxTableFirstColumn: "First column",
	/** Presentation editor — table style option */
	previewPptxTableLastColumn: "Last column",
	/** Presentation editor — table style option */
	previewPptxTableBandedColumns: "Banded columns",
	/** Presentation editor — Table tab button: the fill of the selected cells */
	previewPptxTableShading: "Shading",
	/** Presentation editor — Table shading: no fill */
	previewPptxTableNoShading: "No shading"
} as const
