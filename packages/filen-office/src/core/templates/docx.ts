import { languageSlots, templateLocale } from "./locale"
import { zipParts } from "./zip"

// A blank WordprocessingML document: one empty paragraph in Calibri 11 pt, the paper of the user's region
// with 1-inch margins, the user's language as the proofing default of its script's slot, and Word 2013+ layout
// (compatibilityMode 15). ECMA-376 Part 1 §11.3.10 (document), §17.7.4 (styles), §17.15.1 (settings),
// §17.6.13 / §17.6.11 (pgSz, pgMar). No theme, properties or author: nothing about the user is written.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"

const CONTENT_TYPES =
	'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
	'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
	'<Default Extension="xml" ContentType="application/xml"/>' +
	`<Override PartName="/word/document.xml" ContentType="${DOCX_CONTENT_TYPE}"/>` +
	'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
	'<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
	"</Types>"

const ROOT_RELS =
	`<Relationships xmlns="${PACKAGE_RELS}">` +
	`<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
	"</Relationships>"

const DOCUMENT_RELS =
	`<Relationships xmlns="${PACKAGE_RELS}">` +
	`<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>` +
	`<Relationship Id="rId2" Type="${R}/settings" Target="settings.xml"/>` +
	"</Relationships>"

// Twips. Letter 8.5 × 11 in; A4 210 × 297 mm as Word rounds it. Header and footer distances as Word's own
// blank documents of each paper have them.
const PAGES = {
	letter: { width: 12240, height: 15840, edge: 720 },
	a4: { width: 11906, height: 16838, edge: 708 }
} as const

const SETTINGS =
	`<w:settings xmlns:w="${W}">` +
	'<w:defaultTabStop w:val="720"/>' +
	'<w:characterSpacingControl w:val="doNotCompress"/>' +
	'<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
	"</w:settings>"

function document(paper: keyof typeof PAGES): string {
	const page = PAGES[paper]

	return (
		`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p/><w:sectPr>` +
		`<w:pgSz w:w="${String(page.width)}" w:h="${String(page.height)}"/>` +
		`<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="${String(page.edge)}" w:footer="${String(page.edge)}" w:gutter="0"/>` +
		`<w:cols w:space="${String(page.edge)}"/><w:docGrid w:linePitch="360"/>` +
		"</w:sectPr></w:body></w:document>"
	)
}

// §17.3.2.20: w:val proofs Latin text, w:eastAsia East Asian text, w:bidi complex-script text.
function lang(tag: string): string {
	const { latin, eastAsia, complex } = languageSlots(tag)

	return (
		`<w:lang w:val="${latin}"` +
		(eastAsia === undefined ? "" : ` w:eastAsia="${eastAsia}"`) +
		(complex === undefined ? "" : ` w:bidi="${complex}"`) +
		"/>"
	)
}

function styles(tag: string): string {
	return (
		`<w:styles xmlns:w="${W}"><w:docDefaults>` +
		'<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
		`<w:sz w:val="22"/><w:szCs w:val="22"/>${lang(tag)}</w:rPr></w:rPrDefault>` +
		'<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
		"</w:docDefaults>" +
		'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
		'<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/>' +
		'<w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
		'<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
		'<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>' +
		'<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/>' +
		'<w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
		'<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/>' +
		'<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
		"</w:styles>"
	)
}

export interface BlankDocxOptions {
	// The user's locale (BCP 47): the paper and the default language.
	readonly locale: string
}

export function blankDocx(options: BlankDocxOptions): Promise<Uint8Array> {
	const { tag, paper } = templateLocale(options.locale)

	return zipParts([
		["[Content_Types].xml", CONTENT_TYPES],
		["_rels/.rels", ROOT_RELS],
		["word/document.xml", document(paper)],
		["word/_rels/document.xml.rels", DOCUMENT_RELS],
		["word/styles.xml", styles(tag)],
		["word/settings.xml", SETTINGS]
	])
}
