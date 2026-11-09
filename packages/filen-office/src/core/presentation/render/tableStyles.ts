import { drawingReader, type DrawingReader } from "../../drawingml/reader"
import { parseXml } from "../../xml/index"

// PowerPoint's built-in table styles that a deck may name by id without writing them into its tableStyles part
// (a:tableStyleId, §21.1.3.12; the part holds only the styles PowerPoint chose to write). The definitions are the ones
// PowerPoint itself writes into tableStyles.xml when a deck uses the style (the corpus's PowerPoint-saved decks), with
// the accent as a parameter. Families without such a sample (Light Style 2's plain variant, Light Style 3, Themed
// Style 2, Medium Style 3, Dark Styles 1 and 2) stay unknown rather than synthesized.

export type BuiltinTableStyleFamily =
	| "No Style, No Grid"
	| "No Style, Table Grid"
	| "Themed Style 1"
	| "Light Style 1"
	| "Light Style 2"
	| "Medium Style 1"
	| "Medium Style 2"
	| "Medium Style 4"

const lightStyle1 = (a: string): string =>
	`<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef><a:schemeClr val="tx1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:ln><a:noFill/></a:ln></a:left><a:right><a:ln><a:noFill/></a:ln></a:right><a:top><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:top><a:bottom><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:bottom><a:insideH><a:ln><a:noFill/></a:ln></a:insideH><a:insideV><a:ln><a:noFill/></a:ln></a:insideV></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl>` +
	`<a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="${a}"><a:alpha val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1H>` +
	"<a:band2H><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2H>" +
	`<a:band1V><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="${a}"><a:alpha val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1V>` +
	"<a:band2V><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2V>" +
	'<a:lastCol><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr/></a:tcStyle></a:lastCol>' +
	'<a:firstCol><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr/></a:tcStyle></a:firstCol>' +
	`<a:lastRow><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr><a:top><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:top></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:lastRow>` +
	"<a:seCell><a:tcStyle><a:tcBdr/></a:tcStyle></a:seCell>" +
	"<a:swCell><a:tcStyle><a:tcBdr/></a:tcStyle></a:swCell>" +
	`<a:firstRow><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr><a:bottom><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:bottom></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:firstRow>` +
	"<a:neCell><a:tcStyle><a:tcBdr/></a:tcStyle></a:neCell>" +
	"<a:nwCell><a:tcStyle><a:tcBdr/></a:tcStyle></a:nwCell>"

const lightStyle2 = (a: string): string =>
	`<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef><a:schemeClr val="tx1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:left><a:right><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:right><a:top><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:top><a:bottom><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:bottom><a:insideH><a:ln><a:noFill/></a:ln></a:insideH><a:insideV><a:ln><a:noFill/></a:ln></a:insideV></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl>` +
	`<a:band1H><a:tcStyle><a:tcBdr><a:top><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:top><a:bottom><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:bottom></a:tcBdr></a:tcStyle></a:band1H>` +
	`<a:band1V><a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:left><a:right><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:right></a:tcBdr></a:tcStyle></a:band1V>` +
	`<a:band2V><a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:left><a:right><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:right></a:tcBdr></a:tcStyle></a:band2V>` +
	'<a:lastCol><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr/></a:tcStyle></a:lastCol>' +
	'<a:firstCol><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr/></a:tcStyle></a:firstCol>' +
	`<a:lastRow><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr><a:top><a:ln w="50800" cmpd="dbl"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:top></a:tcBdr></a:tcStyle></a:lastRow>` +
	`<a:firstRow><a:tcTxStyle b="on"><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef><a:schemeClr val="bg1"/></a:tcTxStyle><a:tcStyle><a:tcBdr/><a:fillRef idx="1"><a:schemeClr val="${a}"/></a:fillRef></a:tcStyle></a:firstRow>`

const mediumStyle1 = (a: string): string =>
	`<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:left><a:right><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:right><a:top><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:top><a:bottom><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:bottom><a:insideH><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:insideH><a:insideV><a:ln><a:noFill/></a:ln></a:insideV></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>` +
	`<a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="${a}"><a:tint val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1H>` +
	"<a:band2H><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2H>" +
	`<a:band1V><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="${a}"><a:tint val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1V>` +
	"<a:band2V><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2V>" +
	'<a:lastCol><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr/></a:tcStyle></a:lastCol>' +
	'<a:firstCol><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr/></a:tcStyle></a:firstCol>' +
	`<a:lastRow><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr><a:top><a:ln w="50800" cmpd="dbl"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:top></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:fill></a:tcStyle></a:lastRow>` +
	"<a:seCell><a:tcStyle><a:tcBdr/></a:tcStyle></a:seCell>" +
	"<a:swCell><a:tcStyle><a:tcBdr/></a:tcStyle></a:swCell>" +
	`<a:firstRow><a:tcTxStyle b="on"><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>` +
	"<a:neCell><a:tcStyle><a:tcBdr/></a:tcStyle></a:neCell>" +
	"<a:nwCell><a:tcStyle><a:tcBdr/></a:tcStyle></a:nwCell>"

const mediumStyle4 = (a: string): string =>
	`<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:left><a:right><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:right><a:top><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:top><a:bottom><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:bottom><a:insideH><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:insideH><a:insideV><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:insideV></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="${a}"><a:tint val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>` +
	`<a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="${a}"><a:tint val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1H>` +
	`<a:band1V><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="${a}"><a:tint val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1V>` +
	'<a:lastCol><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr/></a:tcStyle></a:lastCol>' +
	'<a:firstCol><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr/></a:tcStyle></a:firstCol>' +
	`<a:lastRow><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr><a:top><a:ln w="25400" cmpd="sng"><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:ln></a:top></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="${a}"><a:tint val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:lastRow>` +
	`<a:firstRow><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="${a}"><a:tint val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:firstRow>`

const themedStyle1 = (a: string): string =>
	`<a:tblBg><a:fillRef idx="2"><a:schemeClr val="${a}"/></a:fillRef><a:effectRef idx="1"><a:schemeClr val="${a}"/></a:effectRef></a:tblBg>` +
	`<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:left><a:right><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:right><a:top><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:top><a:bottom><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:bottom><a:insideH><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:insideH><a:insideV><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:insideV></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl>` +
	`<a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="${a}"><a:alpha val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1H>` +
	"<a:band2H><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2H>" +
	`<a:band1V><a:tcStyle><a:tcBdr><a:top><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:top><a:bottom><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:bottom></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="${a}"><a:alpha val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1V>` +
	"<a:band2V><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2V>" +
	`<a:lastCol><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr><a:left><a:lnRef idx="2"><a:schemeClr val="${a}"/></a:lnRef></a:left><a:right><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:right><a:top><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:top><a:bottom><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:bottom><a:insideH><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:insideH><a:insideV><a:ln><a:noFill/></a:ln></a:insideV></a:tcBdr></a:tcStyle></a:lastCol>` +
	`<a:firstCol><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:left><a:right><a:lnRef idx="2"><a:schemeClr val="${a}"/></a:lnRef></a:right><a:top><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:top><a:bottom><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:bottom><a:insideH><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:insideH><a:insideV><a:ln><a:noFill/></a:ln></a:insideV></a:tcBdr></a:tcStyle></a:firstCol>` +
	`<a:lastRow><a:tcTxStyle b="on"/><a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:left><a:right><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:right><a:top><a:lnRef idx="2"><a:schemeClr val="${a}"/></a:lnRef></a:top><a:bottom><a:lnRef idx="2"><a:schemeClr val="${a}"/></a:lnRef></a:bottom><a:insideH><a:ln><a:noFill/></a:ln></a:insideH><a:insideV><a:ln><a:noFill/></a:ln></a:insideV></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:lastRow>` +
	`<a:firstRow><a:tcTxStyle b="on"><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:left><a:right><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:right><a:top><a:lnRef idx="1"><a:schemeClr val="${a}"/></a:lnRef></a:top><a:bottom><a:lnRef idx="2"><a:schemeClr val="lt1"/></a:lnRef></a:bottom><a:insideH><a:ln><a:noFill/></a:ln></a:insideH><a:insideV><a:ln><a:noFill/></a:ln></a:insideV></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="${a}"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>`

const noGrid = (): string =>
	'<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef><a:schemeClr val="tx1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:ln><a:noFill/></a:ln></a:left><a:right><a:ln><a:noFill/></a:ln></a:right><a:top><a:ln><a:noFill/></a:ln></a:top><a:bottom><a:ln><a:noFill/></a:ln></a:bottom><a:insideH><a:ln><a:noFill/></a:ln></a:insideH><a:insideV><a:ln><a:noFill/></a:ln></a:insideV></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl>'

const tableGrid = (): string =>
	'<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:scrgbClr r="0" g="0" b="0"/></a:fontRef><a:schemeClr val="tx1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></a:left><a:right><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></a:right><a:top><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></a:top><a:bottom><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></a:bottom><a:insideH><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></a:insideH><a:insideV><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></a:insideV></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl>'

// Each family's children of a:tblStyle for an accent slot, and the slot its plain (accent-less) variant draws in.
const FAMILIES: Readonly<Record<BuiltinTableStyleFamily, { readonly markup: (slot: string) => string; readonly plain: string }>> = {
	"No Style, No Grid": { markup: noGrid, plain: "" },
	"No Style, Table Grid": { markup: tableGrid, plain: "" },
	"Themed Style 1": { markup: themedStyle1, plain: "" },
	"Light Style 1": { markup: lightStyle1, plain: "tx1" },
	"Light Style 2": { markup: lightStyle2, plain: "" },
	"Medium Style 1": { markup: mediumStyle1, plain: "dk1" },
	"Medium Style 2": { markup: mediumStyle2, plain: "dk1" },
	"Medium Style 4": { markup: mediumStyle4, plain: "dk1" }
}

// Built-in style id → its family and accent (0: the plain variant, or a family without accents). The ids PowerPoint
// assigns (learn.microsoft.com, "Programmatically Working with Table Styles in PowerPoint 2010").
const BUILTIN: Readonly<Record<string, readonly [BuiltinTableStyleFamily, number]>> = {
	"{2D5ABB26-0587-4C30-8999-92F81FD0307C}": ["No Style, No Grid", 0],
	"{5940675A-B579-460E-94D1-54222C63F5DA}": ["No Style, Table Grid", 0],
	"{3C2FFA5D-87B4-456A-9821-1D502468CF0F}": ["Themed Style 1", 1],
	"{284E427A-3D55-4303-BF80-6455036E1DE7}": ["Themed Style 1", 2],
	"{69C7853C-536D-4A76-A0AE-DD22124D55A5}": ["Themed Style 1", 3],
	"{775DCB02-9BB8-47FD-8907-85C794F793BA}": ["Themed Style 1", 4],
	"{35758FB7-9AC5-4552-8A53-C91805E547FA}": ["Themed Style 1", 5],
	"{08FB837D-C827-4EFA-A057-4D05807E0F7C}": ["Themed Style 1", 6],
	"{9D7B26C5-4107-4FEC-AEDC-1716B250A1EF}": ["Light Style 1", 0],
	"{3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5}": ["Light Style 1", 1],
	"{0E3FDE45-AF77-4B5C-9715-49D594BDF05E}": ["Light Style 1", 2],
	"{C083E6E3-FA7D-4D7B-A595-EF9225AFEA82}": ["Light Style 1", 3],
	"{D27102A9-8310-4765-A935-A1911B00CA55}": ["Light Style 1", 4],
	"{5FD0F851-EC5A-4D38-B0AD-8093EC10F338}": ["Light Style 1", 5],
	"{68D230F3-CF80-4859-8CE7-A43EE81993B5}": ["Light Style 1", 6],
	"{69012ECD-51FC-41F1-AA8D-1B2483CD663E}": ["Light Style 2", 1],
	"{72833802-FEF1-4C79-8D5D-14CF1EAF98D9}": ["Light Style 2", 2],
	"{F2DE63D5-997A-4646-A377-4702673A728D}": ["Light Style 2", 3],
	"{17292A2E-F333-43FB-9621-5CBBE7FDCDCB}": ["Light Style 2", 4],
	"{5A111915-BE36-4E01-A7E5-04B1672EAD32}": ["Light Style 2", 5],
	"{912C8C85-51F0-491E-9774-3900AFEF0FD7}": ["Light Style 2", 6],
	"{793D81CF-94F2-401A-BA57-92F5A7B2D0C5}": ["Medium Style 1", 0],
	"{B301B821-A1FF-4177-AEE7-76D212191A09}": ["Medium Style 1", 1],
	"{9DCAF9ED-07DC-4A11-8D7F-57B35C25682E}": ["Medium Style 1", 2],
	"{1FECB4D8-DB02-4DC6-A0A2-4F2EBAE1DC90}": ["Medium Style 1", 3],
	"{1E171933-4619-4E11-9A3F-F7608DF75F80}": ["Medium Style 1", 4],
	"{FABFCF23-3B69-468F-B69F-88F6DE6A72F2}": ["Medium Style 1", 5],
	"{10A1B5D5-9B99-4C35-A422-299274C87663}": ["Medium Style 1", 6],
	"{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}": ["Medium Style 2", 0],
	"{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}": ["Medium Style 2", 1],
	"{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}": ["Medium Style 2", 2],
	"{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}": ["Medium Style 2", 3],
	"{00A15C55-8517-42AA-B614-E9B94910E393}": ["Medium Style 2", 4],
	"{7DF18680-E054-41AD-8BC1-D1AEF772440D}": ["Medium Style 2", 5],
	"{93296810-A885-4BE3-A3E7-6D5BEEA58F35}": ["Medium Style 2", 6],
	"{D7AC3CCA-C797-4891-BE02-D94E43425B78}": ["Medium Style 4", 0],
	"{69CF1AB2-1976-4502-BF36-3FF5EA218861}": ["Medium Style 4", 1],
	"{8A107856-5554-42FB-B03E-39F5DBC370BA}": ["Medium Style 4", 2],
	"{0505E3EF-67EA-436B-97B2-0124C06EBD24}": ["Medium Style 4", 3],
	"{C4B1156A-380E-4F78-BDF5-A606A8083BF9}": ["Medium Style 4", 4],
	"{22838BEF-8BB2-4498-84A7-C5851F593DF1}": ["Medium Style 4", 5],
	"{16D9F66E-5EB9-4882-86FB-DCBF35E3C3E4}": ["Medium Style 4", 6]
}

// The family of the built-in style `id` names; undefined for ids not built in.
export function builtinTableStyleFamily(id: string): BuiltinTableStyleFamily | undefined {
	return Object.hasOwn(BUILTIN, id) ? BUILTIN[id]?.[0] : undefined
}

function mediumStyle2(accent: string): string {
	const color = (mods: string): string => `<a:solidFill><a:schemeClr val="${accent}">${mods}</a:schemeClr></a:solidFill>`
	const line = (width: number): string =>
		`<a:ln w="${String(width)}" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln>`
	const text = (bold: boolean, scheme: string): string =>
		`<a:tcTxStyle${bold ? ' b="on"' : ""}><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="${scheme}"/></a:tcTxStyle>`
	const edge = (side: string): string => `<a:${side}>${line(12700)}</a:${side}>`
	const band = `<a:tcStyle><a:tcBdr/><a:fill>${color('<a:tint val="40000"/>')}</a:fill></a:tcStyle>`
	const strong = (border: string): string =>
		`${text(true, "lt1")}<a:tcStyle><a:tcBdr>${border}</a:tcBdr><a:fill>${color("")}</a:fill></a:tcStyle>`

	return (
		`<a:wholeTbl>${text(false, "dk1")}<a:tcStyle><a:tcBdr>${["left", "right", "top", "bottom", "insideH", "insideV"].map(edge).join("")}</a:tcBdr>` +
		`<a:fill>${color('<a:tint val="20000"/>')}</a:fill></a:tcStyle></a:wholeTbl>` +
		`<a:band1H>${band}</a:band1H><a:band2H><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2H>` +
		`<a:band1V>${band}</a:band1V><a:band2V><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2V>` +
		`<a:lastCol>${strong("")}</a:lastCol><a:firstCol>${strong("")}</a:firstCol>` +
		`<a:lastRow>${strong(`<a:top>${line(38100)}</a:top>`)}</a:lastRow>` +
		`<a:firstRow>${strong(`<a:bottom>${line(38100)}</a:bottom>`)}</a:firstRow>`
	)
}

// The built-in style `id` names as the a:tblStyle markup a tableStyles part holds; undefined for ids not built in.
export function builtinTableStyleXml(id: string): string | undefined {
	const entry = Object.hasOwn(BUILTIN, id) ? BUILTIN[id] : undefined

	if (entry === undefined) return undefined

	const [family, accent] = entry
	const { markup, plain } = FAMILIES[family]
	// CT_TableStyle requires its name (§20.1.4.2.26).
	const name = accent === 0 ? family : `${family} - Accent ${String(accent)}`

	return (
		`<a:tblStyle xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" styleId="${id}" styleName="${name}">` +
		`${markup(accent === 0 ? plain : `accent${String(accent)}`)}</a:tblStyle>`
	)
}

const parsed = new Map<string, { readonly reader: DrawingReader; readonly node: number }>()

// The built-in style `id` names, as an a:tblStyle element; undefined for ids that are not built in.
export function builtinTableStyle(id: string): { readonly reader: DrawingReader; readonly node: number } | undefined {
	const known = parsed.get(id)

	if (known !== undefined) return known

	const markup = builtinTableStyleXml(id)

	if (markup === undefined) return undefined

	const document = parseXml(new TextEncoder().encode(markup))
	const style = { reader: drawingReader(document), node: document.documentElement() }

	parsed.set(id, style)

	return style
}
