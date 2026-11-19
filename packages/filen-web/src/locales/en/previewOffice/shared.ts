// "preview" namespace — strings both office editors use (DOCX editing and the spreadsheet viewer).
// Spread into preview.ts; same catalog rules.
export const previewOfficeShared = {
	/** Office editors — dialog title asking for the name comments, notes and tracked changes are signed with */
	previewOfficeAuthorNameTitle: "Your name in documents",
	/** Office editors — dialog body asking for the author name; it is synced and can be changed in settings */
	previewOfficeAuthorNameBody: "Comments and tracked changes show this name. You can change it later in settings.",
	/** Docx editor — body of the name prompt when an edit was not made because track changes needs the author's name */
	previewOfficeAuthorNameTrackBody:
		"Track changes is on, so every edit carries your name. Give it to keep editing, or turn track changes off.",
	/** Office editors — author name field label */
	previewOfficeAuthorNameLabel: "Name",
	/** Office editors — author name dialog submit button */
	previewOfficeAuthorNameSave: "Save",
	/** Docx editor — button in the name prompt turning track changes off instead of giving a name */
	previewOfficeTurnOffTracking: "Turn off track changes",
	/** Office editors — colour picker: automatic text colour (black on light, white on dark) */
	previewOfficeColorAutomatic: "Automatic",
	/** Office editors — colour picker: no highlight or shading */
	previewOfficeColorNone: "No color",
	/** Office editors — colour picker section heading */
	previewOfficeColorThemeColors: "Theme colors",
	/** Office editors — colour picker section heading */
	previewOfficeColorStandardColors: "Standard colors",
	/** Office editors — a theme colour variation's name; {{color}} is the colour, {{percent}} how much lighter */
	previewOfficeColorLighter: "{{color}}, lighter {{percent}}%",
	/** Office editors — a theme colour variation's name; {{color}} is the colour, {{percent}} how much darker */
	previewOfficeColorDarker: "{{color}}, darker {{percent}}%",
	/** Office editors — theme colour name */
	previewOfficeColorBackground1: "Background 1",
	/** Office editors — theme colour name */
	previewOfficeColorText1: "Text 1",
	/** Office editors — theme colour name */
	previewOfficeColorBackground2: "Background 2",
	/** Office editors — theme colour name */
	previewOfficeColorText2: "Text 2",
	/** Office editors — theme colour name */
	previewOfficeColorAccent1: "Accent 1",
	/** Office editors — theme colour name */
	previewOfficeColorAccent2: "Accent 2",
	/** Office editors — theme colour name */
	previewOfficeColorAccent3: "Accent 3",
	/** Office editors — theme colour name */
	previewOfficeColorAccent4: "Accent 4",
	/** Office editors — theme colour name */
	previewOfficeColorAccent5: "Accent 5",
	/** Office editors — theme colour name */
	previewOfficeColorAccent6: "Accent 6",
	/** Office editors — standard colour name */
	previewOfficeColorDarkRed: "Dark red",
	/** Office editors — standard colour name */
	previewOfficeColorRed: "Red",
	/** Office editors — standard colour name */
	previewOfficeColorOrange: "Orange",
	/** Office editors — standard colour name */
	previewOfficeColorYellow: "Yellow",
	/** Office editors — standard colour name */
	previewOfficeColorLightGreen: "Light green",
	/** Office editors — standard colour name */
	previewOfficeColorGreen: "Green",
	/** Office editors — standard colour name */
	previewOfficeColorLightBlue: "Light blue",
	/** Office editors — standard colour name */
	previewOfficeColorBlue: "Blue",
	/** Office editors — standard colour name */
	previewOfficeColorDarkBlue: "Dark blue",
	/** Office editors — standard colour name */
	previewOfficeColorPurple: "Purple",
	/** Office editors — Download as PDF of a password-protected file: title of the prompt asking the file's password first */
	previewOfficePdfPasswordTitle: "Protect the PDF",
	/** Office editors — that prompt's body: the PDF gets the file's own password */
	previewOfficePdfPasswordBody: "The PDF is protected with the document's password. Enter it to continue.",
	/** Office editors — that prompt's field label */
	previewOfficePdfPasswordLabel: "Document password",
	/** Office editors — that prompt's submit button */
	previewOfficePdfPasswordSubmit: "Download PDF",
	/** Office editors — that prompt, while the password is checked */
	previewOfficePdfPasswordChecking: "Checking password…",
	/** Office editors — that prompt, under the field after a wrong password */
	previewOfficePdfPasswordWrong: "That is not the document's password",
	/** Office documents — drawn in a chart as the name of a data series the file leaves unnamed; {{n}} is its position (1, 2, …), written without a space as Excel does */
	previewOfficeChartSeriesName: "Series{{n}}",
	/** Office documents — drawn as a chart's title where the file asks for an automatic one and names none */
	previewOfficeChartTitle: "Chart Title",
	/** Office documents — drawn as a chart axis's title where the file shows one without its text */
	previewOfficeChartAxisTitle: "Axis Title"
}
