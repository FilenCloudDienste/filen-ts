import { drawingReader, type DrawingReader } from "../../drawingml/reader"
import { parseXml } from "../../xml/index"

// PowerPoint's built-in table styles that a deck may name by id without writing them into its tableStyles part
// (a:tableStyleId, §21.1.3.12; the part holds only the styles PowerPoint chose to write). The definitions are the ones
// PowerPoint itself writes into tableStyles.xml when a deck uses the style (e.g. the corpus's MoCalFlow template), with
// the accent as a parameter: the Medium Style 2 family, PowerPoint's default for inserted tables.

const MEDIUM_STYLE_2: Readonly<Record<string, string>> = {
	"{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}": "dk1",
	"{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}": "accent1",
	"{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}": "accent2",
	"{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}": "accent3",
	"{00A15C55-8517-42AA-B614-E9B94910E393}": "accent4",
	"{7DF18680-E054-41AD-8BC1-D1AEF772440D}": "accent5",
	"{93296810-A885-4BE3-A3E7-6D5BEEA58F35}": "accent6"
}

function mediumStyle2(id: string, accent: string): string {
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
		`<a:tblStyle xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" styleId="${id}">` +
		`<a:wholeTbl>${text(false, "dk1")}<a:tcStyle><a:tcBdr>${["left", "right", "top", "bottom", "insideH", "insideV"].map(edge).join("")}</a:tcBdr>` +
		`<a:fill>${color('<a:tint val="20000"/>')}</a:fill></a:tcStyle></a:wholeTbl>` +
		`<a:band1H>${band}</a:band1H><a:band2H><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2H>` +
		`<a:band1V>${band}</a:band1V><a:band2V><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2V>` +
		`<a:lastCol>${strong("")}</a:lastCol><a:firstCol>${strong("")}</a:firstCol>` +
		`<a:lastRow>${strong(`<a:top>${line(38100)}</a:top>`)}</a:lastRow>` +
		`<a:firstRow>${strong(`<a:bottom>${line(38100)}</a:bottom>`)}</a:firstRow>` +
		"</a:tblStyle>"
	)
}

const parsed = new Map<string, { readonly reader: DrawingReader; readonly node: number }>()

// The built-in style `id` names, as an a:tblStyle element; undefined for ids that are not built in.
export function builtinTableStyle(id: string): { readonly reader: DrawingReader; readonly node: number } | undefined {
	const known = parsed.get(id)

	if (known !== undefined) return known

	const accent = Object.hasOwn(MEDIUM_STYLE_2, id) ? MEDIUM_STYLE_2[id] : undefined

	if (accent === undefined) return undefined

	const document = parseXml(new TextEncoder().encode(mediumStyle2(id, accent)))
	const style = { reader: drawingReader(document), node: document.documentElement() }

	parsed.set(id, style)

	return style
}
