import { chartOf, translateChart } from "../../ods/charts/read"
import { objectRows, rowsCells, rowsWorkbook } from "../../presentation/edit/apply/chart"
import type { Slicing } from "../../slicing"
import { refreshChartCaches } from "../../xlsx/charts/cache"
import { encodeUtf8, parseXml, XmlError } from "../../xml/index"

// An ODF chart object (ODF 1.3 Part 3 §11: office:chart reading its own table, §11.1) as a PresentationML chart part
// (ECMA-376 Part 1 §21.2) that PowerPoint draws and opens in Edit Data: the chart as the ODS chart translation writes
// it, its series reading the sheet its data is embedded as (the object's table as one sheet, cell for cell at the
// addresses the object reads), their caches (c:strCache, c:numCache §21.2.2.199, .120) filled from those cells, and
// c:externalData (§21.2.2.63) naming the workbook.

// The sheet the embedded workbook holds the object's table as (PowerPoint's own name for a chart's data).
export const CHART_SHEET = "Sheet1"
// The chart part's relationship to its workbook.
export const CHART_WORKBOOK_ID = "rId1"

export interface OdpChartPart {
	readonly chart: Uint8Array
	// The object's table as an .xlsx; undefined when it cannot be one (the chart is then drawn from its caches alone).
	readonly workbook: Uint8Array | undefined
	// The translation could not carry all the object holds (a trend line, a secondary axis…), or its data has no
	// workbook.
	readonly lost: boolean
}

// A sheet qualifier of a reference ("'local-table'!", "Table1!"), in a formula's text.
const QUALIFIER = /(?:'(?:[^']|'')*'|[^\s'!,():;]+)!/gu

// Every c:f's references made to name the embedded sheet.
function onChartSheet(markup: string): string {
	return markup.replace(
		/<c:f>([^<]*)<\/c:f>/gu,
		(_whole, formula: string) => `<c:f>${formula.replace(QUALIFIER, `${CHART_SHEET}!`)}</c:f>`
	)
}

// c:externalData in its place in c:chartSpace (after c:chart, c:spPr and c:txPr; before c:printSettings, c:userShapes
// and c:extLst).
function withExternalData(markup: string): string {
	const element = `<c:externalData r:id="${CHART_WORKBOOK_ID}"><c:autoUpdate val="0"/></c:externalData>`
	const end = markup.lastIndexOf("</c:chartSpace>")
	const after = ["<c:printSettings", "<c:userShapes", "<c:extLst"]
		.map(tag => markup.indexOf(tag, markup.lastIndexOf("</c:chart>")))
		.filter(at => at >= 0)
	const at = after.length === 0 ? end : Math.min(...after)

	return at < 0 ? markup : `${markup.slice(0, at)}${element}${markup.slice(at)}`
}

// The chart part of an object's content.xml; undefined when it holds no chart the translation reads.
export async function odpChartPart(object: Uint8Array, slicing?: Slicing): Promise<OdpChartPart | undefined> {
	let found: ReturnType<typeof chartOf>

	try {
		found = chartOf(parseXml(object))
	} catch (error) {
		if (error instanceof XmlError) return undefined

		throw error
	}

	if (found === null) return undefined

	const translated = translateChart(found.chart, found.styles)
	const lost = translated.refusal !== null || translated.issues.length > 0
	const rows = objectRows(object)

	if (!Array.isArray(rows)) return { chart: encodeUtf8(translated.markup), workbook: undefined, lost: true }

	const built = await rowsWorkbook(rows, CHART_SHEET, slicing)
	const workbook = built instanceof Uint8Array ? built : undefined
	const markup = onChartSheet(translated.markup)
	const chart = refreshChartCaches(
		encodeUtf8(workbook === undefined ? markup : withExternalData(markup)),
		rowsCells(rows, CHART_SHEET)
	).bytes

	return { chart, workbook, lost: lost || workbook === undefined }
}
