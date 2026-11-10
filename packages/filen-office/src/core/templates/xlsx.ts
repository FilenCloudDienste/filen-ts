import { escapeAttribute } from "../xml/entities"
import { fontMarkup } from "../xlsx/write/records"
import { IMPLIED_FONT } from "../xlsx/write/styles"
import { textSheetName } from "../xlsx/convert/text"
import { templateLocale, type TemplatePaper } from "./locale"
import { FILEN_THEME } from "./themes/model"
import { CONTENT_TYPE, themeXml } from "./themes/pptx"
import { zipParts } from "./zip"

// A blank SpreadsheetML workbook: one empty, selected sheet under the caller's (localized) name, Calibri
// 11 pt, Excel's default row height and margins, and the paper of the user's region. ECMA-376 Part 1
// §18.2.27 (workbook), §18.3.1.99 (worksheet), §18.8.39 (styleSheet), §18.3.1.63 (pageSetup paperSize:
// 1 Letter, 9 A4). The default font is Excel's own (theme minor font, theme text colour, §18.8.35 scheme), backed by
// the template theme (§20.1.6), so a theme font change in Excel reaches the body text. No properties or author:
// nothing about the user is written.

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
const SPREADSHEETML = "application/vnd.openxmlformats-officedocument.spreadsheetml"

const CONTENT_TYPES =
	'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
	'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
	'<Default Extension="xml" ContentType="application/xml"/>' +
	`<Override PartName="/xl/workbook.xml" ContentType="${SPREADSHEETML}.sheet.main+xml"/>` +
	`<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${SPREADSHEETML}.worksheet+xml"/>` +
	`<Override PartName="/xl/styles.xml" ContentType="${SPREADSHEETML}.styles+xml"/>` +
	`<Override PartName="/xl/theme/theme1.xml" ContentType="${CONTENT_TYPE.theme}"/>` +
	"</Types>"

const ROOT_RELS =
	`<Relationships xmlns="${PACKAGE_RELS}">` +
	`<Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/>` +
	"</Relationships>"

const WORKBOOK_RELS =
	`<Relationships xmlns="${PACKAGE_RELS}">` +
	`<Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/>` +
	`<Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/>` +
	`<Relationship Id="rId3" Type="${R}/theme" Target="theme/theme1.xml"/>` +
	"</Relationships>"

const STYLES =
	`<styleSheet xmlns="${MAIN}">` +
	`<fonts count="1">${fontMarkup(IMPLIED_FONT, "")}</fonts>` +
	'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
	'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
	'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
	"</styleSheet>"

function workbook(sheetName: string): string {
	return (
		`<workbook xmlns="${MAIN}" xmlns:r="${R}"><bookViews><workbookView/></bookViews>` +
		`<sheets><sheet name="${escapeAttribute(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
	)
}

function worksheet(paperSize: number): string {
	return (
		`<worksheet xmlns="${MAIN}" xmlns:r="${R}"><dimension ref="A1"/>` +
		'<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>' +
		'<sheetFormatPr defaultRowHeight="15"/><sheetData/>' +
		'<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
		`<pageSetup paperSize="${String(paperSize)}" orientation="portrait"/>` +
		"</worksheet>"
	)
}

export interface BlankXlsxOptions {
	// The user's locale (BCP 47): the paper.
	readonly locale: string
	// The first sheet's name in the user's language ("Sheet1" in English). A name Excel would refuse is cut
	// down the way a text file's name is (no \ / ? * [ ] :, at most 31 characters), "Sheet1" when nothing is left.
	readonly sheetName: string
	// The user's paper, in place of the one the locale's region uses.
	readonly paper?: TemplatePaper | undefined
}

export function blankXlsx(options: BlankXlsxOptions): Promise<Uint8Array> {
	const { paper } = templateLocale(options.locale, options.paper)

	return zipParts([
		["[Content_Types].xml", CONTENT_TYPES],
		["_rels/.rels", ROOT_RELS],
		["xl/workbook.xml", workbook(textSheetName(options.sheetName))],
		["xl/_rels/workbook.xml.rels", WORKBOOK_RELS],
		["xl/worksheets/sheet1.xml", worksheet(paper === "letter" ? 1 : 9)],
		["xl/styles.xml", STYLES],
		["xl/theme/theme1.xml", themeXml(FILEN_THEME, 0)]
	])
}
