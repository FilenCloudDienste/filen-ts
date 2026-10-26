// "drive" namespace, New ▸ Office ▸ OpenDocument and Download as in the item menus (a document or spreadsheet exported to another format without
// opening it; a local download, the file in the drive is unchanged). Spread into drive.ts; same catalog rules.
export const driveDownloadAs = {
	/** New menu ▸ Office — submenu holding the blank OpenDocument files (the open standard format of LibreOffice and others) */
	driveNewOfficeOpenDocument: "OpenDocument",
	/** New menu ▸ Office ▸ OpenDocument — entry opening the name dialog for a blank OpenDocument text document */
	driveNewOfficeOdt: "Text (.odt)",
	/** New menu ▸ Office ▸ OpenDocument — entry opening the name dialog for a blank OpenDocument spreadsheet */
	driveNewOfficeOds: "Spreadsheet (.ods)",
	/** Item menu and bulk menus — submenu of the formats a document or spreadsheet can be downloaded as (a local download made from the saved file; the file in the drive is unchanged) */
	driveActionDownloadAs: "Download as",
	/** Item menu → Download as — item downloading the document or spreadsheet as a PDF file */
	driveDownloadAsPdf: "PDF document (.pdf)",
	/** Item menu → Download as — item downloading the document converted to a Word document */
	driveDownloadAsDocx: "Word document (.docx)",
	/** Item menu → Download as — item downloading the document converted to an OpenDocument text document */
	driveDownloadAsOdt: "OpenDocument text (.odt)",
	/** Item menu → Download as — item downloading the spreadsheet converted to an Excel workbook */
	driveDownloadAsXlsx: "Excel workbook (.xlsx)",
	/** Item menu → Download as — item downloading the spreadsheet converted to an OpenDocument spreadsheet */
	driveDownloadAsOds: "OpenDocument spreadsheet (.ods)",
	/** Download as progress toast — the file is being downloaded before it is converted */
	driveDownloadAsDownloading: "Downloading…",
	/** Download as progress toast description — the file being exported, when several are exported one after another: {{index}} of {{count}} */
	driveDownloadAsBulkItem: "{{name}} ({{index}} of {{count}})",
	/** Download as error — a ".dot" file that turned out to be a text file (a Graphviz graph), not a Word 97–2003 template, so there is no document to export */
	driveDownloadAsNotDocument: "This file is a text file, not a Word document",
	/** Download as of several files — report toast once the run ended: how many of the files gave no download (a PDF or converted copy; each listed below with why) */
	driveDownloadAsReportFailed_one: "{{count}} of {{total}} files could not be converted",
	driveDownloadAsReportFailed_other: "{{count}} of {{total}} files could not be converted",
	/** Download as of several files — report toast once the run ended: how many downloads (PDFs or converted copies) lack something of their file (each listed below with what) */
	driveDownloadAsReportWarned_one: "{{count}} download is not quite like its file",
	driveDownloadAsReportWarned_other: "{{count}} downloads are not quite like their files",
	/** Download as of several files — last line of the report toast: how many more files it does not list */
	driveDownloadAsReportMore: "And {{count}} more",
	/** Download as progress toast — the document or spreadsheet is being converted to the chosen format (in the background, from the saved file) */
	driveDownloadAsConverting: "Converting…",
	/** Download as error — a document or spreadsheet could not be converted to the chosen format (damaged, or something the converter cannot read) */
	driveDownloadAsConvertFailed: "This file could not be converted",
	/** Download as error — a password-protected file is not converted to an OpenDocument format: the OpenDocument copy could not keep its password protection */
	driveDownloadAsConvertProtected: "Password-protected files can't be converted to OpenDocument, because the copy would not be protected",
	/** Download as error — the file is too large for the browser to convert */
	driveDownloadAsConvertTooLarge: "This file is too large to convert here",
	/** Download as error — a Word 6.0/95 or older document, which cannot be converted */
	driveDownloadAsConvertLegacyVersion: "Documents from Word 95 and earlier can't be converted",
	/** Download as warning — the converted copy lacks something the file has (pictures, charts, macros, formatting the other format cannot hold…) */
	driveDownloadAsConvertLossy: "Some of this file's content or formatting is not in the converted copy",
	/** Download as warning — an Excel 97–2003 workbook (.xls) converted: only its cell values are in the copy, as the viewer's Save as .xlsx also says */
	driveDownloadAsConvertValuesOnly:
		"Only the values are in the converted copy: formulas become their results, and formatting, column widths, row heights and named ranges are not kept",
	/** Download as warning — formulas the other spreadsheet format cannot express, written as the values they showed */
	driveDownloadAsConvertFormulas_one: "{{count}} formula is kept only as its value",
	driveDownloadAsConvertFormulas_other: "{{count}} formulas are kept only as their values",
	/** Download as — password prompt title for a password-protected file converted to another format (the copy keeps the password) */
	driveDownloadAsPasswordCopyTitle: "Protect the converted copy",
	/** Download as — password prompt body for a password-protected file converted to another format: the copy is protected with the same password */
	driveDownloadAsPasswordCopyBody:
		"“{{name}}” is password-protected. The converted copy is protected with the same password. Enter it to continue.",
	/** Download as — password prompt submit button for a password-protected file converted to another format */
	driveDownloadAsPasswordCopySubmit: "Download",
	/** Download as — password prompt body for a password-protected file: the PDF made from it is protected with the same password */
	driveDownloadAsPasswordBody: "“{{name}}” is password-protected. The PDF is protected with the same password. Enter it to continue."
} as const
