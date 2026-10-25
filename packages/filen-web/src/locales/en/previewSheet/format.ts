// "preview" namespace, spreadsheet viewer — the formatting toolbar and the Format Cells
// dialog. Spread into preview.ts; same catalog rules.
export const previewSheetFormat = {
	/** Spreadsheet viewer — font picker (accessible label and tooltip) */
	previewSheetFormatFont: "Font",
	/** Spreadsheet viewer — font size picker (accessible label and tooltip) */
	previewSheetFormatFontSize: "Font size",
	/** Spreadsheet viewer — the font picker's group of the workbook theme's fonts */
	previewSheetFormatThemeFonts: "Theme fonts",
	/** Spreadsheet viewer — the font picker's theme heading font, e.g. "Calibri Light (Headings)" */
	previewSheetFormatHeadingsFont: "{{font}} (Headings)",
	/** Spreadsheet viewer — the font picker's theme body font, e.g. "Calibri (Body)" */
	previewSheetFormatBodyFont: "{{font}} (Body)",
	/** Spreadsheet viewer — the font picker's group of fonts the workbook already uses */
	previewSheetFormatWorkbookFonts: "In this workbook",
	/** Spreadsheet viewer — the font picker's group of other common fonts */
	previewSheetFormatOtherFonts: "Other fonts",
	/** Spreadsheet viewer — borders menu (accessible label and tooltip) */
	previewSheetFormatBorders: "Borders",
	/** Borders menu — label of the group of single-edge presets (bottom, top, left, right), for screen readers */
	previewSheetBorderGroupEdges: "Edges",
	/** Borders menu — label of the group of no border, all borders and outlines, for screen readers */
	previewSheetBorderGroupOutlines: "Outlines",
	/** Borders menu — label of the group of top and bottom line combinations, for screen readers */
	previewSheetBorderGroupTopBottom: "Top and bottom",
	/** Borders menu — label of the group of inside lines and diagonals, for screen readers */
	previewSheetBorderGroupInside: "Inside and diagonal",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderBottom: "Bottom border",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderTop: "Top border",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderLeft: "Left border",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderRight: "Right border",
	/** Spreadsheet viewer — borders menu item: removes the outline and inside lines of the selected cells */
	previewSheetBorderNone: "No border",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderAll: "All borders",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderOutside: "Outside borders",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderThickOutside: "Thick outside borders",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderBottomDouble: "Bottom double border",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderThickBottom: "Thick bottom border",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderTopBottom: "Top and bottom border",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderTopThickBottom: "Top and thick bottom border",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderTopDoubleBottom: "Top and double bottom border",
	/** Spreadsheet viewer — borders menu item: lines between the selected cells */
	previewSheetBorderInside: "Inside borders",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderInsideHorizontal: "Inside horizontal borders",
	/** Spreadsheet viewer — borders menu item */
	previewSheetBorderInsideVertical: "Inside vertical borders",
	/** Spreadsheet viewer — borders menu item: a line from each cell's lower left to its upper right */
	previewSheetBorderDiagonalUp: "Diagonal up border",
	/** Spreadsheet viewer — borders menu item: a line from each cell's upper left to its lower right */
	previewSheetBorderDiagonalDown: "Diagonal down border",
	/** Spreadsheet viewer — borders menu: submenu choosing the colour of the lines the items draw */
	previewSheetBorderLineColor: "Line color",
	/** Spreadsheet viewer — borders menu: submenu choosing the style of the lines the items draw */
	previewSheetBorderLineStyle: "Line style",
	/** Spreadsheet viewer — border line style */
	previewSheetLineThin: "Thin",
	/** Spreadsheet viewer — border line style */
	previewSheetLineMedium: "Medium",
	/** Spreadsheet viewer — border line style */
	previewSheetLineThick: "Thick",
	/** Spreadsheet viewer — border line style */
	previewSheetLineDashed: "Dashed",
	/** Spreadsheet viewer — border line style */
	previewSheetLineDotted: "Dotted",
	/** Spreadsheet viewer — border line style */
	previewSheetLineDouble: "Double",
	/** Spreadsheet viewer — border line style: the finest dotted line */
	previewSheetLineHair: "Hairline",
	/** Spreadsheet viewer — border line style */
	previewSheetLineMediumDashed: "Medium dashed",
	/** Spreadsheet viewer — border line style */
	previewSheetLineDashDot: "Dash dot",
	/** Spreadsheet viewer — border line style */
	previewSheetLineMediumDashDot: "Medium dash dot",
	/** Spreadsheet viewer — border line style */
	previewSheetLineDashDotDot: "Dash dot dot",
	/** Spreadsheet viewer — border line style */
	previewSheetLineMediumDashDotDot: "Medium dash dot dot",
	/** Spreadsheet viewer — border line style */
	previewSheetLineSlantDashDot: "Slanted dash dot",
	/** Spreadsheet viewer — menu of how text lines up across a cell (accessible label and tooltip) */
	previewSheetFormatHorizontalAlign: "Horizontal alignment",
	/** Spreadsheet viewer — menu of how text lines up from a cell's top to its bottom (accessible label and tooltip) */
	previewSheetFormatVerticalAlign: "Vertical alignment",
	/** Spreadsheet viewer — horizontal alignment: text left, numbers right, as the value's type says */
	previewSheetAlignGeneral: "General",
	/** Spreadsheet viewer — horizontal alignment */
	previewSheetAlignLeft: "Left",
	/** Spreadsheet viewer — horizontal alignment */
	previewSheetAlignCenter: "Center",
	/** Spreadsheet viewer — horizontal alignment */
	previewSheetAlignRight: "Right",
	/** Spreadsheet viewer — horizontal alignment: repeats the text to fill the cell */
	previewSheetAlignFill: "Fill",
	/** Spreadsheet viewer — horizontal alignment */
	previewSheetAlignJustify: "Justify",
	/** Spreadsheet viewer — horizontal alignment: centred over the selected cells without merging them */
	previewSheetAlignCenterAcross: "Center across selection",
	/** Spreadsheet viewer — horizontal or vertical alignment: spreads the text evenly */
	previewSheetAlignDistributed: "Distributed",
	/** Spreadsheet viewer — vertical alignment */
	previewSheetAlignTop: "Top",
	/** Spreadsheet viewer — vertical alignment */
	previewSheetAlignMiddle: "Middle",
	/** Spreadsheet viewer — vertical alignment */
	previewSheetAlignBottom: "Bottom",
	/** Spreadsheet viewer — toggle button: long text breaks into lines inside its cell */
	previewSheetFormatWrap: "Wrap text",
	/** Spreadsheet viewer — number format menu item */
	previewSheetNumberGeneral: "General",
	/** Spreadsheet viewer — number format menu item */
	previewSheetNumberNumber: "Number",
	/** Spreadsheet viewer — number format menu item */
	previewSheetNumberCurrency: "Currency",
	/** Spreadsheet viewer — number format menu item: currency with the symbol and decimals lined up in a column */
	previewSheetNumberAccounting: "Accounting",
	/** Spreadsheet viewer — number format menu item */
	previewSheetNumberShortDate: "Short date",
	/** Spreadsheet viewer — number format menu item */
	previewSheetNumberLongDate: "Long date",
	/** Spreadsheet viewer — number format menu item, and the dialog's category of date formats */
	previewSheetNumberDate: "Date",
	/** Spreadsheet viewer — number format menu item */
	previewSheetNumberTime: "Time",
	/** Spreadsheet viewer — number format menu item */
	previewSheetNumberPercentage: "Percentage",
	/** Spreadsheet viewer — number format menu item */
	previewSheetNumberFraction: "Fraction",
	/** Spreadsheet viewer — number format menu item */
	previewSheetNumberScientific: "Scientific",
	/** Spreadsheet viewer — number format menu item: entries are kept as typed */
	previewSheetNumberText: "Text",
	/** Spreadsheet viewer — the number format menu's label for a format none of its items names */
	previewSheetNumberCustom: "Custom",
	/** Spreadsheet viewer — number format menu item: opens the Format Cells dialog */
	previewSheetNumberMore: "More number formats…",
	/** Spreadsheet viewer — toolbar button: one decimal place fewer */
	previewSheetDecreaseDecimal: "Decrease decimal",
	/** Spreadsheet viewer — toolbar button: one decimal place more */
	previewSheetIncreaseDecimal: "Increase decimal",
	/** Spreadsheet viewer — toolbar button: shows numbers as percentages */
	previewSheetPercentStyle: "Percent style",
	/** Spreadsheet viewer — ⋯ menu item: numbers with thousands separators and two decimal places */
	previewSheetCommaStyle: "Comma style",
	/** Spreadsheet viewer — ⋯ menu item: opens the Format Cells dialog */
	previewSheetFormatCells: "Format cells…",
	/** Spreadsheet viewer — ⋯ menu item: takes the formatting off the selected cells, keeping their contents */
	previewSheetClearFormats: "Clear formats",
	/** Format Cells dialog — title */
	previewSheetFormatCellsTitle: "Format cells",
	/** Format Cells dialog — description under the title */
	previewSheetFormatCellsBody: "Choose how numbers in the selected cells are shown.",
	/** Format Cells dialog — label of the list of number format categories */
	previewSheetFormatCategory: "Category",
	/** Format Cells dialog — number field: digits after the decimal point */
	previewSheetFormatDecimals: "Decimal places",
	/** Format Cells dialog — checkbox: digits grouped in thousands (1,000) */
	previewSheetFormatThousands: "Use 1000 separator",
	/** Format Cells dialog — currency symbol picker */
	previewSheetFormatSymbol: "Symbol",
	/** Format Cells dialog — the currency symbol picker's choice of no symbol */
	previewSheetFormatSymbolNone: "None",
	/** Format Cells dialog — how negative numbers show (picker label) */
	previewSheetFormatNegative: "Negative numbers",
	/** Format Cells dialog — picker of the date, time or fraction formats of the chosen category */
	previewSheetFormatType: "Type",
	/** Format Cells dialog — text field of the number format code */
	previewSheetFormatCode: "Format code",
	/** Format Cells dialog — what the active cell would show in the chosen format */
	previewSheetFormatSample: "Sample",
	/** Format Cells dialog — note on the General category */
	previewSheetFormatGeneralNote: "General shows numbers as typed, rounded to fit their cell.",
	/** Format Cells dialog — note on the Text category */
	previewSheetFormatTextNote: "Text keeps what is typed into the cell as it is, even when it looks like a number.",
	/** Format Cells dialog — error under the format code field: empty */
	previewSheetFormatCodeEmpty: "Enter a format code.",
	/** Format Cells dialog — error under the format code field: longer than Excel takes */
	previewSheetFormatCodeTooLong: "A format code can have at most 255 characters.",
	/** Format Cells dialog — error under the format code field: more than four sections separated by ";" */
	previewSheetFormatCodeSections: "A format code can have at most four sections.",
	/** Format Cells dialog — error under the format code field: a quote, bracket or escape is not closed */
	previewSheetFormatCodeUnclosed: "Close every quote and bracket, and follow \\, _ and * with a character.",
	/** Format Cells dialog — error under the format code field: it holds a control character (pasted) a file cannot store */
	previewSheetFormatCodeCharacters: "Remove the control characters from the format code.",
	/** Format Cells dialog — button applying the format */
	previewSheetFormatApply: "Apply"
}
