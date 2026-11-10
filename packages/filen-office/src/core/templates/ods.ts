import { escapeAttribute } from "../xml/entities"
import { textSheetName } from "../xlsx/convert/text"
import { FONT_FACES, FO, odfPackage, OFFICE, pageLayout, STYLE, SVG, TABLE, textProperties } from "./odf"
import { templateLocale, type TemplatePaper } from "./locale"
import { zipParts } from "./zip"

// A blank OpenDocument spreadsheet (ODF 1.3): one empty sheet under the caller's (localized) name, Calibri 11 pt in
// the user's language, printed on the paper of the user's region. Part 3 §9.1.2 (table:table), §16.2 default style,
// §17.15 table properties (style:master-page-name), §16.9 master page. No meta.xml: nothing about the user is written.

const MEDIA_TYPE = "application/vnd.oasis.opendocument.spreadsheet"

function content(sheetName: string): string {
	return (
		`<office:document-content xmlns:office="${OFFICE}" xmlns:style="${STYLE}" xmlns:table="${TABLE}" office:version="1.3">` +
		'<office:automatic-styles><style:style style:name="ta1" style:family="table" style:master-page-name="Default">' +
		'<style:table-properties table:display="true" style:writing-mode="lr-tb"/></style:style></office:automatic-styles>' +
		`<office:body><office:spreadsheet><table:table table:name="${escapeAttribute(sheetName)}" table:style-name="ta1">` +
		"<table:table-column/><table:table-row><table:table-cell/></table:table-row></table:table>" +
		"</office:spreadsheet></office:body></office:document-content>"
	)
}

function styles(locale: ReturnType<typeof templateLocale>): string {
	return (
		`<office:document-styles xmlns:office="${OFFICE}" xmlns:style="${STYLE}" xmlns:fo="${FO}" xmlns:svg="${SVG}" office:version="1.3">` +
		FONT_FACES +
		`<office:styles><style:default-style style:family="table-cell">${textProperties(locale)}</style:default-style>` +
		'<style:style style:name="Default" style:family="table-cell"/></office:styles>' +
		`<office:automatic-styles>${pageLayout(locale.paper)}</office:automatic-styles>` +
		'<office:master-styles><style:master-page style:name="Default" style:page-layout-name="pm1"/></office:master-styles>' +
		"</office:document-styles>"
	)
}

export interface BlankOdsOptions {
	// The user's locale (BCP 47): the paper and the default language.
	readonly locale: string
	// The first sheet's name in the user's language ("Sheet1" in English), cut down to one Excel also takes (no
	// \ / ? * [ ] :, at most 31 characters; "Sheet1" when nothing is left), so the sheet converts to .xlsx as named.
	readonly sheetName: string
	// The user's paper, in place of the one the locale's region uses.
	readonly paper?: TemplatePaper | undefined
}

export function blankOds(options: BlankOdsOptions): Promise<Uint8Array> {
	return zipParts(
		odfPackage(MEDIA_TYPE, content(textSheetName(options.sheetName)), styles(templateLocale(options.locale, options.paper)))
	)
}
